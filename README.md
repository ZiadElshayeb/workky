# Agora Voice Call — Web Quickstart

A browser-based voice calling app using the [Agora Web SDK](https://docs.agora.io/en/voice-calling/overview/product-overview) with built-in **Conversational AI Agent** support.

## Features

- Join a voice channel with a random UID per tab
- See all participants in real time
- Mute / unmute your microphone
- Start / stop an AI conversational agent that joins the same channel
- Open multiple tabs to simulate multi-user calls

## Getting Started

### 1. Clone & install

```bash
git clone <your-repo-url>
cd agora_web_quickstart
npm install
```

### 2. Configure environment variables

Copy the example env file and fill in your credentials:

```bash
cp .env.example .env
```

Then edit `.env` with your values:

| Variable | Description |
|---|---|
| `VITE_AGORA_APP_ID` | Your Agora App ID from [Agora Console](https://console.agora.io/) |
| `VITE_AGORA_TOKEN` | A temporary RTC token for the channel |
| `VITE_AGORA_CUSTOMER_ID` | Agora Customer ID (for REST API auth) |
| `VITE_AGORA_CUSTOMER_SECRET` | Agora Customer Secret (for REST API auth) |
| `VITE_LLM_API_KEY` | OpenAI API key |
| `VITE_TTS_API_KEY` | Microsoft Azure Speech API key |
| `VITE_TTS_REGION` | Azure region (default: `eastus`) |
| `VITE_STT_API_KEY` | STT API key |
| `VITE_AGENT_SYSTEM_PROMPT` | System prompt for the AI agent |

### 3. Run the dev server

```bash
npm run dev
```

Open `http://localhost:5173` in your browser.

### 4. Test multi-user

Open the same URL in a second browser tab — each tab gets a unique UID and can hear the other.

## Tech Stack

- [Vite](https://vitejs.dev/)
- [Agora Web SDK (agora-rtc-sdk-ng)](https://www.npmjs.com/package/agora-rtc-sdk-ng)
- [Agora Conversational AI REST API](https://docs.agora.io/en/conversational-ai/get-started/quickstart)

## License

MIT
