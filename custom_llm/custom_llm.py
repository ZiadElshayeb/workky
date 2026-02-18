import base64
import os
import sys
import openai
import json
from openai import AsyncOpenAI
import traceback
import logging
import logging.config
import uvicorn
import aiofiles
import uuid
from typing import List, Union, Dict, Optional
from pydantic import BaseModel, HttpUrl

from fastapi.responses import JSONResponse, StreamingResponse
from fastapi import FastAPI, HTTPException, Request
import asyncio
import random
import datetime
from dotenv import load_dotenv

# Add parent directory to path so we can import from tools/
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from tools.google_calendar_tools import (
    ALL_CALENDAR_TOOLS,
    check_availability,
    book_appointment,
    delete_appointment,
)

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Chat Completion API",
    description="API for streaming chat completions with support for text, image, and audio content",
    version="1.0.0",
)

# Set your OpenAI API key
openai.api_key = os.getenv("YOUR_LLM_API_KEY")


class TextContent(BaseModel):
    type: str = "text"
    text: str


class ImageContent(BaseModel):
    type: str = "image"
    image_url: HttpUrl


class AudioContent(BaseModel):
    type: str = "input_audio"
    input_audio: Dict[str, str]


class ToolFunction(BaseModel):
    name: str
    description: Optional[str]
    parameters: Optional[Dict]
    strict: bool = False


class Tool(BaseModel):
    type: str = "function"
    function: ToolFunction


class ToolChoice(BaseModel):
    type: str = "function"
    function: Optional[Dict]


class ResponseFormat(BaseModel):
    type: str = "json_schema"
    json_schema: Optional[Dict[str, str]]


class SystemMessage(BaseModel):
    role: str = "system"
    content: Union[str, List[str]]


class UserMessage(BaseModel):
    role: str = "user"
    content: Union[str, List[Union[TextContent, ImageContent, AudioContent]]]


class AssistantMessage(BaseModel):
    role: str = "assistant"
    content: Union[str, List[TextContent]] = None
    audio: Optional[Dict[str, str]] = None
    tool_calls: Optional[List[Dict]] = None


class ToolMessage(BaseModel):
    role: str = "tool"
    content: Union[str, List[str]]
    tool_call_id: str


class ChatCompletionRequest(BaseModel):
    context: Optional[Dict] = None
    model: Optional[str] = None
    messages: List[Union[SystemMessage, UserMessage, AssistantMessage, ToolMessage]]
    response_format: Optional[ResponseFormat] = None
    modalities: List[str] = ["text"]
    audio: Optional[Dict[str, str]] = None
    tools: Optional[List[Tool]] = None
    tool_choice: Optional[Union[str, ToolChoice]] = None
    parallel_tool_calls: bool = True
    stream: bool = True
    stream_options: Optional[Dict] = None

# Topic-specific waiting messages keyed by tool name
WAITING_MESSAGES: dict[str, list[str]] = {
    "check_availability": [
        "Let me pull up the calendar for you, one moment.",
        "I'm checking the available slots right now.",
        "Give me just a second while I look at the schedule.",
        "Let me see what openings we have on that day.",
    ],
    "book_appointment": [
        "I'm booking that appointment for you now, just a moment.",
        "Let me get that scheduled for you, one second.",
        "I'm locking in your booking right now.",
        "Almost done, I'm confirming your appointment.",
    ],
    "delete_appointment": [
        "I'm looking up your appointment now, one moment.",
        "Let me pull that booking up and cancel it for you.",
        "I'm processing the cancellation, just a second.",
        "Give me a moment while I remove that appointment.",
    ],
    "_default": [
        "One moment while I look that up.",
        "Give me just a second.",
        "Let me check on that for you.",
    ],
}

def get_waiting_message(tool_name: str) -> str:
    """Return a contextually appropriate waiting message for the given tool."""
    messages = WAITING_MESSAGES.get(tool_name, WAITING_MESSAGES["_default"])
    return random.choice(messages)

# ── Agent log endpoint (best-effort, non-blocking) ───────────────────────────
AGENT_LOG_URL = os.getenv("AGENT_LOG_URL", "http://localhost:5000/api/agent-log")

async def post_agent_log(event_type: str, payload: dict):
    """Fire-and-forget POST to the Express server for frontend log display."""
    import aiohttp
    try:
        async with aiohttp.ClientSession() as session:
            await session.post(
                AGENT_LOG_URL,
                json={"type": event_type, **payload},
                timeout=aiohttp.ClientTimeout(total=2),
            )
    except Exception:
        pass  # Never let logging errors break the main flow


def execute_tool(func_name: str, arguments: dict) -> str:
    """
    Execute a tool by name with the given arguments.
    Handles all Google Calendar tools.
    """
    if func_name == "check_availability":
        return check_availability(
            date=arguments.get("date", ""),
            service_name=arguments.get("service_name"),
        )
    elif func_name == "book_appointment":
        return book_appointment(
            date=arguments.get("date", ""),
            time=arguments.get("time", ""),
            service_name=arguments.get("service_name", ""),
            customer_name=arguments.get("customer_name", ""),
            customer_phone=arguments.get("customer_phone", ""),
            customer_email=arguments.get("customer_email", ""),
            notes=arguments.get("notes", ""),
        )
    elif func_name == "delete_appointment":
        return delete_appointment(
            event_id=arguments.get("event_id"),
            customer_name=arguments.get("customer_name"),
            date=arguments.get("date"),
        )
    else:
        return json.dumps({"error": f"Unknown tool: {func_name}"})

def create_waiting_chunk(message, model="llama-3.1-8b-instant"):
    """Create an SSE chunk that sends a waiting message as normal text content."""
    chunk = {
        "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object": "chat.completion.chunk",
        "created": int(datetime.datetime.now().timestamp()),
        "model": model,
        "choices": [{
            "index": 0,
            "delta": {"content": message},
            "finish_reason": None
        }]
    }
    return f"data: {json.dumps(chunk)}\n\n"

def create_stop_chunk(model="llama-3.1-8b-instant"):
    """Create a stop chunk to flush/commit the waiting message to TTS before sleeping."""
    chunk = {
        "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object": "chat.completion.chunk",
        "created": int(datetime.datetime.now().timestamp()),
        "model": model,
        "choices": [{
            "index": 0,
            "delta": {},
            "finish_reason": "stop"
        }]
    }
    return f"data: {json.dumps(chunk)}\n\n"

@app.post("/chat/completions")
async def create_chat_completion(request: ChatCompletionRequest):
    try:
        logger.info(f"Received request: {request.model_dump_json()}")

        if not request.stream:
            raise HTTPException(status_code=400, detail="chat completions require streaming")

        base_url = os.getenv("LLM_BASE_URL")
        api_key = os.getenv("LLM_API_KEY")
        if not api_key:
            raise HTTPException(status_code=500, detail="LLM_API_KEY not configured in .env")

        client = AsyncOpenAI(base_url=base_url, api_key=api_key)

        # Serialize Pydantic messages → plain dicts (required by the OpenAI client)
        serialized_messages = [msg.model_dump(exclude_none=True) for msg in request.messages]

        # Merge calendar tools with any tools passed in the request
        all_tools = list(ALL_CALENDAR_TOOLS)
        if request.tools:
            all_tools.extend([t.model_dump() for t in request.tools])

        response = await client.chat.completions.create(
            model=request.model,
            messages=serialized_messages,
            tools=all_tools,
            tool_choice="auto",
            stream=True,
        )

        async def generate():
            try:
                collected_tool_calls = {}
                is_tool_call = False
                waiting_message_sent = False
                # Buffer text chunks — only flush them once we know no tool call is coming.
                # If the model generates text BEFORE a tool call (narrating what it's about to do),
                # we discard that buffer so the customer never hears it.
                text_buffer = []

                async for chunk in response:
                    choices = chunk.choices
                    if not choices:
                        continue

                    delta = choices[0].delta
                    finish_reason = choices[0].finish_reason

                    if delta and delta.tool_calls:
                        # Accumulate streamed tool call fragments
                        is_tool_call = True
                        # Discard any buffered text — it was the model narrating the tool call
                        text_buffer.clear()

                        # Send waiting message immediately on the FIRST tool call fragment
                        if not waiting_message_sent:
                            waiting_message_sent = True
                            # Determine tool name from the first fragment that has it
                            first_tool_name = "_default"
                            for tc in delta.tool_calls:
                                if tc.function and tc.function.name:
                                    first_tool_name = tc.function.name
                                    break
                            yield create_waiting_chunk(get_waiting_message(first_tool_name), request.model)

                            yield create_stop_chunk(request.model)
                            # Wait long enough for Agora TTS to finish speaking the waiting message
                            # before the tool result arrives and triggers the next response.
                            # await asyncio.sleep(2)
                        for tc in delta.tool_calls:
                            idx = tc.index
                            if idx not in collected_tool_calls:
                                collected_tool_calls[idx] = {
                                    "id": "",
                                    "type": "function",
                                    "function": {"name": "", "arguments": ""}
                                }
                            if tc.id:
                                collected_tool_calls[idx]["id"] = tc.id
                            if tc.function:
                                if tc.function.name:
                                    collected_tool_calls[idx]["function"]["name"] += tc.function.name
                                if tc.function.arguments:
                                    collected_tool_calls[idx]["function"]["arguments"] += tc.function.arguments
                    elif not is_tool_call:
                        # Buffer regular text — don't yield yet
                        text_buffer.append(f"data: {json.dumps(chunk.to_dict())}\n\n")

                    if finish_reason == "stop" and not is_tool_call:
                        # Normal text response — flush the buffer now
                        for buffered in text_buffer:
                            yield buffered
                        text_buffer.clear()

                    if finish_reason == "tool_calls":
                        tool_calls_list = list(collected_tool_calls.values())

                        # Execute each tool
                        tool_result_messages = []
                        for tc in tool_calls_list:
                            func_name = tc["function"]["name"]
                            try:
                                arguments = json.loads(tc["function"]["arguments"])
                            except (json.JSONDecodeError, KeyError):
                                arguments = {}

                            # ── Log tool START to frontend ──────────────────
                            tool_label = {
                                "check_availability": "📅 Checking calendar availability",
                                "book_appointment": "📝 Booking appointment",
                                "delete_appointment": "🗑️ Cancelling appointment",
                            }.get(func_name, f"🔧 Running {func_name}")
                            await post_agent_log("tool_start", {
                                "tool": func_name,
                                "label": tool_label,
                                "args": arguments,
                            })

                            logger.info(f"Executing tool: {func_name} with args: {arguments}")
                            result = execute_tool(func_name, arguments)
                            logger.info(f"Tool result: {result[:200]}")

                            # ── Log tool RESULT to frontend ─────────────────
                            try:
                                result_data = json.loads(result)
                                if result_data.get("success"):
                                    outcome_label = result_data.get("message", "Done")
                                    outcome_type = "tool_success"
                                elif result_data.get("error"):
                                    outcome_label = f"Error: {result_data['error']}"
                                    outcome_type = "tool_error"
                                elif result_data.get("available") is not None:
                                    slots = result_data.get("total_slots", 0)
                                    outcome_label = f"Found {slots} available slot(s)"
                                    outcome_type = "tool_success"
                                else:
                                    outcome_label = "Completed"
                                    outcome_type = "tool_success"
                            except Exception:
                                outcome_label = "Completed"
                                outcome_type = "tool_success"

                            await post_agent_log(outcome_type, {
                                "tool": func_name,
                                "label": outcome_label,
                            })

                            tool_result_messages.append({
                                "role": "tool",
                                "tool_call_id": tc["id"],
                                "content": result,
                            })

                        # Rebuild full message history for the follow-up call
                        follow_up_messages = serialized_messages + [
                            {"role": "assistant", "content": None, "tool_calls": tool_calls_list}
                        ] + tool_result_messages

                        # Second call — plain text answer, no tools
                        second_response = await client.chat.completions.create(
                            model=request.model,
                            messages=follow_up_messages,
                            stream=True,
                        )
                        async for chunk2 in second_response:
                            yield f"data: {json.dumps(chunk2.to_dict())}\n\n"

                yield "data: [DONE]\n\n"
            except asyncio.CancelledError:
                logger.info("Request was cancelled")
                raise

        return StreamingResponse(generate(), media_type="text/event-stream")
    except asyncio.CancelledError:
        logger.info("Request was cancelled")
        raise HTTPException(status_code=499, detail="Request was cancelled")
    except Exception as e:
        traceback_str = "".join(traceback.format_tb(e.__traceback__))
        error_message = f"{str(e)}\n{traceback_str}"
        logger.error(error_message)
        raise HTTPException(status_code=500, detail=error_message)

###########################################################################################

# @app.post("/chat/completions")
# async def create_chat_completion(request: ChatCompletionRequest):
#     try:
#         logger.info(f"Received request: {request.model_dump_json()}")

#         if not request.stream:
#             raise HTTPException(status_code=400, detail="chat completions require streaming")

#         base_url = os.getenv("LLM_BASE_URL")
#         api_key = os.getenv("LLM_API_KEY")
#         client = AsyncOpenAI(base_url=base_url, api_key=api_key)

#         # Serialize Pydantic messages to plain dicts — required by the OpenAI client
#         serialized_messages = [msg.model_dump(exclude_none=True) for msg in request.messages]

#         # Build params dict, only including optional fields when they have actual values
#         params = {
#             "model": request.model,
#             "messages": serialized_messages,
#             "stream": True,
#         }
#         if request.tools:
#             params["tools"] = [t.model_dump() for t in request.tools]
#             if request.tool_choice:
#                 params["tool_choice"] = request.tool_choice if isinstance(request.tool_choice, str) else request.tool_choice.model_dump()
#         if request.response_format:
#             params["response_format"] = request.response_format.model_dump()
#         if request.stream_options:
#             params["stream_options"] = request.stream_options
#         if request.audio:
#             params["audio"] = request.audio
#             params["modalities"] = request.modalities

#         response = await client.chat.completions.create(**params)

#         async def generate():
#             try:
#                 async for chunk in response:
#                     logger.debug(f"Received chunk: {chunk}")
#                     yield f"data: {json.dumps(chunk.to_dict())}\n\n"
#                 yield "data: [DONE]\n\n"
#             except asyncio.CancelledError:
#                 logger.info("Request was cancelled")
#                 raise

#         return StreamingResponse(generate(), media_type="text/event-stream")
#     except asyncio.CancelledError:
#         logger.info("Request was cancelled")
#         raise HTTPException(status_code=499, detail="Request was cancelled")
#     except Exception as e:
#         traceback_str = "".join(traceback.format_tb(e.__traceback__))
#         error_message = f"{str(e)}\n{traceback_str}"
#         logger.error(error_message)
#         raise HTTPException(status_code=500, detail=error_message)

###########################################################################################

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
