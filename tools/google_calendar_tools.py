"""
Google Calendar tools for the Workky AI agent.

These functions are called by the custom LLM when the agent needs to
interact with Google Calendar during a voice call (check availability,
book appointments, cancel appointments).
"""

import os
import json
import datetime
from pathlib import Path

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

# ── Paths ─────────────────────────────────────────────────────────────────────────────
TOOLS_DIR = Path(__file__).parent.resolve()
DATA_DIR = TOOLS_DIR.parent / "data"
# Both token.json and business_config.json live in data/ — the shared Docker volume
TOKEN_FILE = DATA_DIR / "token.json"
BUSINESS_CONFIG_FILE = DATA_DIR / "business_config.json"

SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
]

# ═════════════════════════════════════════════════════════════════════════════
# TOOL DEFINITIONS (OpenAI function-calling schema)
# ═════════════════════════════════════════════════════════════════════════════

CHECK_AVAILABILITY_TOOL = {
    "type": "function",
    "function": {
        "name": "check_availability",
        "description": (
            "Check available appointment time slots for a given date. "
            "Returns a list of open slots based on business hours and existing calendar events. "
            "Use this when a customer asks about availability or wants to know open times."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "date": {
                    "type": "string",
                    "description": "The date to check availability for, in YYYY-MM-DD format.",
                },
                "service_name": {
                    "type": "string",
                    "description": "Optional service name to determine the appointment duration.",
                },
            },
            "required": ["date"],
        },
    },
}

BOOK_APPOINTMENT_TOOL = {
    "type": "function",
    "function": {
        "name": "book_appointment",
        "description": (
            "Book an appointment on Google Calendar for a customer. "
            "Requires date, time, service name, and customer name. "
            "Use this after confirming availability and collecting customer details."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "date": {
                    "type": "string",
                    "description": "Appointment date in YYYY-MM-DD format.",
                },
                "time": {
                    "type": "string",
                    "description": "Appointment start time in HH:MM 24-hour format.",
                },
                "service_name": {
                    "type": "string",
                    "description": "Name of the service being booked.",
                },
                "customer_name": {
                    "type": "string",
                    "description": "Full name of the customer.",
                },
                "customer_phone": {
                    "type": "string",
                    "description": "Customer phone number (optional).",
                },
                "customer_email": {
                    "type": "string",
                    "description": "Customer email address (optional).",
                },
                "notes": {
                    "type": "string",
                    "description": "Additional notes or special requests (optional).",
                },
            },
            "required": ["date", "time", "service_name", "customer_name"],
        },
    },
}

DELETE_APPOINTMENT_TOOL = {
    "type": "function",
    "function": {
        "name": "delete_appointment",
        "description": (
            "Cancel/delete an existing appointment from Google Calendar. "
            "Can search by event ID or by customer name. "
            "Use this when a customer wants to cancel their appointment."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "event_id": {
                    "type": "string",
                    "description": "The Google Calendar event ID if known.",
                },
                "customer_name": {
                    "type": "string",
                    "description": "Customer name to search for the appointment.",
                },
                "date": {
                    "type": "string",
                    "description": "Date of the appointment in YYYY-MM-DD format (helps narrow the search).",
                },
            },
            "required": [],
        },
    },
}

ALL_CALENDAR_TOOLS = [
    CHECK_AVAILABILITY_TOOL,
    BOOK_APPOINTMENT_TOOL,
    DELETE_APPOINTMENT_TOOL,
]

# ═════════════════════════════════════════════════════════════════════════════
# INTERNAL HELPERS
# ═════════════════════════════════════════════════════════════════════════════

def _get_calendar_service():
    """Build and return an authenticated Google Calendar service."""
    if not TOKEN_FILE.exists():
        return None, "Google Calendar is not connected. Please ask the business owner to connect their calendar."

    try:
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
            TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")
        if not creds or not creds.valid:
            return None, "Google Calendar credentials are invalid. Please reconnect your calendar."
        service = build("calendar", "v3", credentials=creds)
        return service, None
    except Exception as e:
        return None, f"Failed to connect to Google Calendar: {str(e)}"


def _load_business_config() -> dict:
    """Load business configuration from disk."""
    if BUSINESS_CONFIG_FILE.exists():
        try:
            return json.loads(BUSINESS_CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


# ═════════════════════════════════════════════════════════════════════════════
# TOOL EXECUTION FUNCTIONS
# ═════════════════════════════════════════════════════════════════════════════

def check_availability(date: str, service_name: str = None) -> str:
    """
    Check available time slots for a given date.

    Args:
        date: Date string in YYYY-MM-DD format
        service_name: Optional service name to determine appointment duration

    Returns:
        JSON string with available time slots
    """
    cal_service, error = _get_calendar_service()
    if error:
        return json.dumps({"error": error})

    config = _load_business_config()
    hours = config.get("hours", {})
    services = config.get("services", [])
    booking_rules = config.get("bookingRules", {})

    # Parse the requested date
    try:
        requested_date = datetime.datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        return json.dumps({"error": f"Invalid date format: {date}. Please use YYYY-MM-DD."})

    # Determine the day of week
    day_names = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    day_name = day_names[requested_date.weekday()]

    day_hours = hours.get(day_name, {})
    if not day_hours.get("enabled", False):
        return json.dumps({
            "available": False,
            "message": f"The business is closed on {day_name.capitalize()}s.",
            "slots": [],
        })

    # Get service duration
    duration_minutes = int(booking_rules.get("defaultDuration", 30))
    if service_name:
        for svc in services:
            if svc.get("name", "").lower() == service_name.lower():
                duration_minutes = int(svc.get("duration", duration_minutes))
                break

    # Parse business hours
    open_time_str = day_hours.get("open", "09:00")
    close_time_str = day_hours.get("close", "17:00")
    open_hour, open_min = map(int, open_time_str.split(":"))
    close_hour, close_min = map(int, close_time_str.split(":"))

    # Use local timezone so calendar queries and slot times match business hours
    LOCAL_UTC_OFFSET_HOURS = int(os.getenv("LOCAL_UTC_OFFSET_HOURS", "2"))
    tz = datetime.timezone(datetime.timedelta(hours=LOCAL_UTC_OFFSET_HOURS))
    day_start = requested_date.replace(hour=open_hour, minute=open_min, tzinfo=tz)
    day_end = requested_date.replace(hour=close_hour, minute=close_min, tzinfo=tz)

    # Fetch existing events for this day
    try:
        events_result = (
            cal_service.events()
            .list(
                calendarId="primary",
                timeMin=day_start.isoformat(),
                timeMax=day_end.isoformat(),
                singleEvents=True,
                orderBy="startTime",
            )
            .execute()
        )
        existing_events = events_result.get("items", [])
    except HttpError as e:
        return json.dumps({"error": f"Failed to fetch calendar events: {str(e)}"})

    # Parse busy periods
    busy_periods = []
    for evt in existing_events:
        evt_start = evt["start"].get("dateTime")
        evt_end = evt["end"].get("dateTime")
        if evt_start and evt_end:
            busy_periods.append((
                datetime.datetime.fromisoformat(evt_start),
                datetime.datetime.fromisoformat(evt_end),
            ))

    # Generate available slots (15-minute intervals)
    buffer_minutes = int(booking_rules.get("bufferTime", 0))
    available_slots = []
    slot_start = day_start
    slot_duration = datetime.timedelta(minutes=duration_minutes)
    buffer = datetime.timedelta(minutes=buffer_minutes)

    while slot_start + slot_duration <= day_end:
        slot_end = slot_start + slot_duration
        is_available = True

        for busy_start, busy_end in busy_periods:
            buffered_busy_start = busy_start - buffer
            buffered_busy_end = busy_end + buffer
            if slot_start < buffered_busy_end and slot_end > buffered_busy_start:
                is_available = False
                break

        if is_available:
            available_slots.append({
                "start": slot_start.strftime("%H:%M"),
                "end": slot_end.strftime("%H:%M"),
            })

        slot_start += datetime.timedelta(minutes=15)

    return json.dumps({
        "available": len(available_slots) > 0,
        "date": date,
        "day": day_name.capitalize(),
        "business_hours": f"{open_time_str} - {close_time_str}",
        "service_duration_minutes": duration_minutes,
        "total_slots": len(available_slots),
        "slots": available_slots,
        "message": f"Found {len(available_slots)} available slot(s) on {day_name.capitalize()}, {date}.",
    })


def book_appointment(
    date: str,
    time: str,
    service_name: str,
    customer_name: str,
    customer_phone: str = "",
    customer_email: str = "",
    notes: str = "",
) -> str:
    """
    Book an appointment on Google Calendar.

    Args:
        date: Date in YYYY-MM-DD format
        time: Time in HH:MM format (24-hour)
        service_name: Name of the service
        customer_name: Customer's full name
        customer_phone: Customer's phone (optional)
        customer_email: Customer's email (optional)
        notes: Additional notes (optional)

    Returns:
        JSON string with booking confirmation
    """
    cal_service, error = _get_calendar_service()
    if error:
        return json.dumps({"error": error})

    config = _load_business_config()
    services = config.get("services", [])
    business_info = config.get("businessInfo", {})
    booking_rules = config.get("bookingRules", {})

    # Find service details
    service_details = None
    for svc in services:
        if svc.get("name", "").lower() == service_name.lower():
            service_details = svc
            break

    duration_minutes = int(
        service_details.get("duration", booking_rules.get("defaultDuration", 30))
        if service_details
        else booking_rules.get("defaultDuration", 30)
    )
    price = service_details.get("price", "N/A") if service_details else "N/A"

    # Parse date and time.
    # The agent receives times in local business time (UTC+2).
    # We convert to UTC by subtracting the UTC offset before storing on Google Calendar.
    LOCAL_UTC_OFFSET_HOURS = int(os.getenv("LOCAL_UTC_OFFSET_HOURS", "2"))
    try:
        local_tz = datetime.timezone(datetime.timedelta(hours=LOCAL_UTC_OFFSET_HOURS))
        start_dt = datetime.datetime.strptime(f"{date} {time}", "%Y-%m-%d %H:%M")
        start_dt = start_dt.replace(tzinfo=local_tz)
        end_dt = start_dt + datetime.timedelta(minutes=duration_minutes)
    except ValueError:
        return json.dumps({
            "error": "Invalid date/time format. Use YYYY-MM-DD for date and HH:MM for time.",
        })

    # Check minimum notice
    min_notice_hours = int(booking_rules.get("minNotice", 1))
    now = datetime.datetime.now(datetime.timezone.utc)
    if start_dt < now + datetime.timedelta(hours=min_notice_hours):
        return json.dumps({
            "error": f"Appointments must be booked at least {min_notice_hours} hour(s) in advance.",
        })

    # Check max advance booking
    max_advance_days = int(booking_rules.get("maxAdvance", 30))
    if start_dt > now + datetime.timedelta(days=max_advance_days):
        return json.dumps({
            "error": f"Appointments can only be booked up to {max_advance_days} days in advance.",
        })

    # Build event description
    description_parts = [
        f"Service: {service_name}",
        f"Duration: {duration_minutes} minutes",
        f"Customer: {customer_name}",
    ]
    if customer_phone:
        description_parts.append(f"Phone: {customer_phone}")
    if customer_email:
        description_parts.append(f"Email: {customer_email}")
    if price != "N/A":
        description_parts.append(f"Price: ${price}")
    if notes:
        description_parts.append(f"Notes: {notes}")
    description_parts.append(
        f"\nBooked via {business_info.get('name', 'Workky')} AI Assistant"
    )

    event_body = {
        "summary": f"{service_name} - {customer_name}",
        "description": "\n".join(description_parts),
        "start": {
            "dateTime": start_dt.isoformat(),
            "timeZone": "UTC",
        },
        "end": {
            "dateTime": end_dt.isoformat(),
            "timeZone": "UTC",
        },
    }

    if customer_email:
        event_body["attendees"] = [{"email": customer_email}]

    try:
        created = (
            cal_service.events()
            .insert(calendarId="primary", body=event_body)
            .execute()
        )
        return json.dumps({
            "success": True,
            "event_id": created.get("id"),
            "summary": created.get("summary"),
            "start": start_dt.strftime("%Y-%m-%d %H:%M"),
            "end": end_dt.strftime("%Y-%m-%d %H:%M"),
            "duration_minutes": duration_minutes,
            "price": str(price),
            "link": created.get("htmlLink", ""),
            "message": (
                f"Appointment booked successfully! "
                f"{service_name} for {customer_name} on {date} at {time}."
            ),
        })
    except HttpError as e:
        return json.dumps({"error": f"Failed to create appointment: {str(e)}"})


def delete_appointment(
    event_id: str = None,
    customer_name: str = None,
    date: str = None,
) -> str:
    """
    Delete/cancel an appointment from Google Calendar.

    Args:
        event_id: The Google Calendar event ID (if known)
        customer_name: Customer name to search for (if event_id not known)
        date: Date to narrow the search (YYYY-MM-DD)

    Returns:
        JSON string with deletion confirmation
    """
    cal_service, error = _get_calendar_service()
    if error:
        return json.dumps({"error": error})

    # ── Delete by event ID ────────────────────────────────────────────────
    if event_id:
        try:
            event = (
                cal_service.events()
                .get(calendarId="primary", eventId=event_id)
                .execute()
            )
            summary = event.get("summary", "Unknown")
            cal_service.events().delete(
                calendarId="primary", eventId=event_id
            ).execute()
            return json.dumps({
                "success": True,
                "message": f"Appointment '{summary}' has been cancelled successfully.",
                "event_id": event_id,
            })
        except HttpError as e:
            return json.dumps({"error": f"Failed to delete appointment: {str(e)}"})

    # ── Search by customer name ───────────────────────────────────────────
    if customer_name:
        try:
            tz = datetime.timezone.utc
            if date:
                search_date = datetime.datetime.strptime(date, "%Y-%m-%d")
                time_min = search_date.replace(
                    hour=0, minute=0, second=0, tzinfo=tz
                ).isoformat()
                time_max = search_date.replace(
                    hour=23, minute=59, second=59, tzinfo=tz
                ).isoformat()
            else:
                now = datetime.datetime.now(tz)
                time_min = now.isoformat()
                time_max = (now + datetime.timedelta(days=60)).isoformat()

            events_result = (
                cal_service.events()
                .list(
                    calendarId="primary",
                    timeMin=time_min,
                    timeMax=time_max,
                    singleEvents=True,
                    orderBy="startTime",
                    q=customer_name,
                )
                .execute()
            )
            events = events_result.get("items", [])

            if not events:
                return json.dumps({
                    "error": f"No appointments found for '{customer_name}'.",
                })

            if len(events) == 1:
                evt = events[0]
                cal_service.events().delete(
                    calendarId="primary", eventId=evt["id"]
                ).execute()
                return json.dumps({
                    "success": True,
                    "message": (
                        f"Appointment '{evt.get('summary', 'Unknown')}' "
                        f"has been cancelled successfully."
                    ),
                    "event_id": evt["id"],
                })
            else:
                matches = []
                for evt in events:
                    start = evt["start"].get(
                        "dateTime", evt["start"].get("date", "?")
                    )
                    matches.append({
                        "event_id": evt["id"],
                        "summary": evt.get("summary", "Unknown"),
                        "start": start,
                    })
                return json.dumps({
                    "multiple_matches": True,
                    "message": (
                        f"Found {len(events)} appointments matching "
                        f"'{customer_name}'. Please specify which one to cancel."
                    ),
                    "appointments": matches,
                })
        except HttpError as e:
            return json.dumps({
                "error": f"Failed to search for appointments: {str(e)}",
            })

    return json.dumps({
        "error": (
            "Please provide either an event_id or customer_name "
            "to cancel an appointment."
        ),
    })
