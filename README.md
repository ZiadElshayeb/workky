# Agora Voice Call — Secure Backend + Frontend

A browser-based voice calling app using the [Agora Web SDK](https://docs.agora.io/en/voice-calling/overview/product-overview) with **Conversational AI Agent** support and a secure Express backend.

## 🔒 Security Architecture

- **All API keys stay server-side** — never exposed to the browser
- No secrets in the frontend bundle (verified with `npm run check-leaks`)
- Backend handles all authenticated API calls (LLM, TTS, STT, Agora Agent)
- CORS protection, rate limiting, input validation
- Environment variables loaded at runtime (not baked into Docker images)

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
| `AGORA_APP_ID` | Your Agora App ID from [Agora Console](https://console.agora.io/) |
| `AGORA_TOKEN` | A temporary RTC token for the channel (optional for testing) |
| `AGORA_CUSTOMER_ID` | Agora Customer ID (for REST API auth) |
| `AGORA_CUSTOMER_SECRET` | Agora Customer Secret (for REST API auth) |
| `LLM_API_KEY` | Groq API key |
| `TTS_API_KEY` | ElevenLabs API key |
| `STT_API_KEY` | Deepgram API key |
| `AGENT_SYSTEM_PROMPT` | System prompt for the AI agent |
| `PORT` | Backend server port (default: 5000) |

### 3. Development

Run both frontend (Vite) and backend concurrently:

```bash
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:5000`
- Vite proxies `/api/*` requests to the backend automatically

### 4. Production Deployment

#### Option A: Direct Node.js

```bash
# Build the frontend
npm run build

# Start the backend (serves frontend + API)
npm start
```

The server will:
- Serve the static frontend from `dist/` on port 5000
- Expose API endpoints at `/api/*`
- Load secrets from `.env` file

Access at `http://your-server:5000`

#### Option B: Docker Compose

```bash
# Build and start the container
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

Access at `http://your-server:5001`

**Important**: Make sure your `.env` file is on the server. The Dockerfile doesn't copy it (it's in `.dockerignore`), but `docker-compose.yml` injects environment variables from `.env` at runtime.

### 5. Verify Security

After building, verify no secrets leaked into the frontend:

```bash
npm run check-leaks
```

Should output: `✅ No secrets found in dist/ — safe to deploy.`

## Troubleshooting

### Frontend loads but can't connect

**Symptom**: Page loads, but "Your UID" shows `—` and status is "Disconnected"

**Cause**: Backend can't access environment variables

**Solution**:
- If using `npm start`: Make sure `.env` file exists and contains all required variables
- If using Docker: Make sure `.env` file is in the same directory as `docker-compose.yml`
- Check backend logs for missing env var errors

### CORS errors in development

**Symptom**: Console shows CORS policy errors

**Solution**: The Vite dev server (`:5173`) proxies `/api` to backend (`:5000`) automatically. Make sure both are running with `npm run dev`.

### Agent fails to start

**Symptom**: "Agent start failed" in event log

**Solution**:
- Check backend logs for Agora API errors
- Verify all API keys are correct in `.env`
- Ensure `AGORA_CUSTOMER_ID` and `AGORA_CUSTOMER_SECRET` are valid
- Test individual APIs with test scripts (see below)

## Testing API Keys

Test your API keys individually before deploying:

```bash
# Test all APIs (LLM, TTS, STT)
node --env-file=.env -e "fetch('http://localhost:5000/api/health').then(r=>r.json()).then(console.log)"
```

Or create a temporary test script to verify your keys work with each service.

## Tech Stack

- **Frontend**: [Vite](https://vitejs.dev/), [Agora Web SDK](https://www.npmjs.com/package/agora-rtc-sdk-ng)
- **Backend**: [Express](https://expressjs.com/), CORS, rate limiting
- **APIs**: Agora RTC & Conversational AI, Groq (LLM), ElevenLabs (TTS), Deepgram (STT)
- **Deployment**: Docker, Node.js 20+

## File Structure

```
├── server/
│   └── server.js          ← Express backend (all secrets here)
├── src/
│   ├── main.js            ← Frontend (no secrets)
│   └── style.css
├── scripts/
│   └── check-leaks.js     ← Verify no secrets in build
├── .env                   ← Your secrets (never commit!)
├── .env.example           ← Template
├── Dockerfile             ← Multi-stage build
├── docker-compose.yml     ← Production deployment
└── package.json
```

## License

MIT
