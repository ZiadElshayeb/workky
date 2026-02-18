import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1); // Behind reverse proxy (nginx, Caddy, etc.)
const PORT = process.env.PORT || 5000;

// ─── Secrets (server-only, never exposed to client) ──────────────────
const AGORA_CUSTOMER_ID = process.env.AGORA_CUSTOMER_ID;
const AGORA_CUSTOMER_SECRET = process.env.AGORA_CUSTOMER_SECRET;
const AGORA_APP_ID = process.env.AGORA_APP_ID;
const AGORA_TOKEN = process.env.AGORA_TOKEN;
const LLM_API_KEY = process.env.LLM_API_KEY;
const TTS_API_KEY = process.env.TTS_API_KEY;
const STT_API_KEY = process.env.STT_API_KEY;
const TTS_REGION = process.env.TTS_REGION || "eastus";
const AGENT_SYSTEM_PROMPT =
  process.env.AGENT_SYSTEM_PROMPT || "You are a helpful chatbot.";

// ─── Validate required secrets at startup ────────────────────────────
const REQUIRED = {
  AGORA_CUSTOMER_ID,
  AGORA_CUSTOMER_SECRET,
  AGORA_APP_ID,
  LLM_API_KEY,
  TTS_API_KEY,
  STT_API_KEY,
};

const missing = Object.entries(REQUIRED)
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length) {
  console.error(`❌  Missing required env vars: ${missing.join(", ")}`);
  console.error("   Copy .env.example → .env and fill in values.");
  process.exit(1);
}

// ─── Middleware ───────────────────────────────────────────────────────
// Request logging FIRST – so we see every incoming request
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path} origin=${req.headers.origin || 'none'}`);
  next();
});

// CORS – in production the frontend is served from the same origin
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",")
  : [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5173",
    "http://localhost:5001",  // Docker local access
  ];

app.use(
  cors({
    origin(origin, cb) {
      // Allow requests with no origin (same-origin, curl, Postman, etc.)
      if (!origin) return cb(null, true);

      // Allow whitelisted origins
      if (allowedOrigins.includes(origin)) return cb(null, true);

      // In production, when serving from same origin, allow it
      // (This should not happen if !origin works, but as fallback)
      cb(null, true);
    },
  })
);

app.use(express.json({ limit: "64kb" }));

// Rate limiting – 30 requests per minute per IP for API routes
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, try again later." },
});
app.use("/api", apiLimiter);

// ─── Health check ────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});
// ─── Debug: List dist files (remove in production) ──────────────────
app.get("/api/debug/files", (_req, res) => {
  const distPath = path.resolve(__dirname, "..", "dist");
  try {
    const files = fs.readdirSync(distPath, { recursive: true });
    res.json({
      distPath,
      files: files.slice(0, 20), // limit to 20 files
      count: files.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ─── POST /api/session ───────────────────────────────────────────────
// Returns non-secret config the frontend needs to initialize Agora RTC.
app.post("/api/session", (_req, res) => {
  res.json({
    appId: AGORA_APP_ID,
    token: AGORA_TOKEN || null, // token may be empty for testing mode
  });
});

// ─── POST /api/start-agent ───────────────────────────────────────────
app.post("/api/start-agent", async (req, res) => {
  try {
    const { channel, uid, remoteUids } = req.body;

    // Input validation
    if (!channel || typeof channel !== "string" || channel.length > 64) {
      return res.status(400).json({ error: "Invalid channel name." });
    }
    if (uid === undefined || uid === null) {
      return res.status(400).json({ error: "Missing uid." });
    }
    if (remoteUids && !Array.isArray(remoteUids)) {
      return res.status(400).json({ error: "remoteUids must be an array." });
    }

    const base64Creds = Buffer.from(
      `${AGORA_CUSTOMER_ID}:${AGORA_CUSTOMER_SECRET}`
    ).toString("base64");

    const body = {
      name: "Agora Agent",
      properties: {
        channel,
        token: AGORA_TOKEN || "",
        agent_rtc_uid: "0",
        remote_rtc_uids: [
          String(uid),
          ...(remoteUids || []).map(String),
        ],
        enable_string_uid: false,
        idle_timeout: 120,
        llm: {
          url: "https://api.groq.com/openai/v1/chat/completions",
          api_key: LLM_API_KEY,
          system_messages: [
            { role: "system", content: AGENT_SYSTEM_PROMPT },
          ],
          max_history: 32,
          greeting_message: "Hello, how can I assist you?",
          failure_message: "Please hold on a second.",
          params: { model: "llama-3.1-8b-instant" },
        },
        asr: {
          vendor: "deepgram",
          params: {
            url: "wss://api.deepgram.com/v1/listen",
            key: STT_API_KEY,
            model: "nova-3",
            language: "en",
            keyterm: "term1%20term2",
          },
        },
        "tts": {
          "vendor": "openai",
          "params": {
            "base_url": "https://api.openai.com/v1",
            "api_key": TTS_API_KEY,
            "model": "tts-1",
            "voice": "coral",
            "instructions": "Please use standard American English, natural tone, moderate pace, and steady intonation",
            "speed": 1
          }
        },
      },
    };

    // Helper: call Agora join API
    async function callAgoraJoin() {
      return fetch(
        `https://api.agora.io/api/conversational-ai-agent/v2/projects/${AGORA_APP_ID}/join`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${base64Creds}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }
      );
    }

    let agoraRes = await callAgoraJoin();

    // ── Handle 409 TaskConflict: stop the stale agent, then retry ──
    if (agoraRes.status === 409) {
      const errBody = await agoraRes.json().catch(() => ({}));
      const staleAgentId = errBody.agent_id;
      console.log(`409 TaskConflict – stopping stale agent ${staleAgentId} then retrying…`);

      if (staleAgentId) {
        // Attempt to stop the conflicting agent
        try {
          const stopRes = await fetch(
            `https://api.agora.io/api/conversational-ai-agent/v2/projects/${AGORA_APP_ID}/agents/${encodeURIComponent(staleAgentId)}/leave`,
            {
              method: "POST",
              headers: {
                Authorization: `Basic ${base64Creds}`,
                "Content-Type": "application/json",
              },
            }
          );
          console.log(`Stale agent stop responded with ${stopRes.status}`);
          // Small delay to let Agora clean up
          await new Promise((r) => setTimeout(r, 1500));
        } catch (stopErr) {
          console.error("Failed to stop stale agent:", stopErr.message);
        }
      }

      // Retry the join once
      agoraRes = await callAgoraJoin();
    }

    if (!agoraRes.ok) {
      const errText = await agoraRes.text();
      console.error(`Agora API error ${agoraRes.status}: ${errText}`);
      return res
        .status(agoraRes.status)
        .json({ error: `Agora API error: ${agoraRes.status}` });
    }

    const json = await agoraRes.json();
    // Only return the agent_id – no secrets
    res.json({ agent_id: json.agent_id });
  } catch (err) {
    console.error("start-agent error:", err.message);
    res.status(500).json({ error: "Internal server error." });
  }
});

// ─── POST /api/stop-agent ────────────────────────────────────────────
app.post("/api/stop-agent", async (req, res) => {
  try {
    const { agentId } = req.body;

    if (!agentId || typeof agentId !== "string" || agentId.length > 128) {
      return res.status(400).json({ error: "Invalid agentId." });
    }

    const base64Creds = Buffer.from(
      `${AGORA_CUSTOMER_ID}:${AGORA_CUSTOMER_SECRET}`
    ).toString("base64");

    const agoraRes = await fetch(
      `https://api.agora.io/api/conversational-ai-agent/v2/projects/${AGORA_APP_ID}/agents/${encodeURIComponent(agentId)}/leave`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${base64Creds}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!agoraRes.ok) {
      const errText = await agoraRes.text();
      console.error(`Agora API error ${agoraRes.status}: ${errText}`);
      return res
        .status(agoraRes.status)
        .json({ error: `Agora API error: ${agoraRes.status}` });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("stop-agent error:", err.message);
    res.status(500).json({ error: "Internal server error." });
  }
});

// ─── Serve frontend static files (production) ───────────────────────
const distPath = path.resolve(__dirname, "..", "dist");

// Check if dist folder exists with built files
if (!fs.existsSync(distPath)) {
  console.error("❌  dist/ folder not found!");
  console.error("   Run 'npm run build' first to build the frontend.");
  process.exit(1);
}

const distIndexPath = path.join(distPath, "index.html");
if (!fs.existsSync(distIndexPath)) {
  console.error("❌  dist/index.html not found!");
  console.error("   Run 'npm run build' first to build the frontend.");
  process.exit(1);
}

// Serve static files with proper error handling
app.use(express.static(distPath, {
  setHeaders: (res, filePath) => {
    // Set proper MIME types
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
    } else if (filePath.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css');
    }
  }
}));

// SPA fallback – serve index.html for any non-API route
// This must come AFTER static files middleware
app.get("*", (_req, res) => {
  res.sendFile(distIndexPath);
});

// ─── Error handler (must be last) ───────────────────────────────────
app.use((err, req, res, next) => {
  console.error(`❌ Error on ${req.method} ${req.path}:`, err.message);
  console.error(err.stack);
  res.status(500).json({ error: "Internal server error" });
});

// ─── Start ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  Backend listening on http://localhost:${PORT}`);
  console.log(`   Serving static files from ${distPath}`);
});
