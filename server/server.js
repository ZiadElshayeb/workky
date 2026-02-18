import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import crypto from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1); // Behind reverse proxy (nginx, Caddy, etc.)
const PORT = parseInt(process.env.PORT) || 5000;

// ─── Secrets (server-only, never exposed to client) ──────────────────
const AGORA_CUSTOMER_ID = process.env.AGORA_CUSTOMER_ID;
const AGORA_CUSTOMER_SECRET = process.env.AGORA_CUSTOMER_SECRET;
const AGORA_APP_ID = process.env.AGORA_APP_ID;
const AGORA_TOKEN = process.env.AGORA_TOKEN;
const LLM_API_KEY = process.env.LLM_API_KEY;
const TTS_API_KEY = process.env.TTS_API_KEY;
const STT_API_KEY = process.env.STT_API_KEY;
const TTS_REGION = process.env.TTS_REGION || "eastus";
const CUSTOM_LLM_URL = (process.env.CUSTOM_LLM_URL || "http://localhost:8000/chat/completions").trim();
// Public-facing URL of this server — used so Agora (external) can reach our LLM proxy
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim();

// ─── Google OAuth credentials ─────────────────────────────────────────
let GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
let GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
const GOOGLE_REDIRECT_URI = (process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/api/google/callback`).trim();

// Try loading from client_secret.json if env vars not set
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  const clientSecretPath = path.resolve(__dirname, "..", "tools", "client_secret.json");
  if (fs.existsSync(clientSecretPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(clientSecretPath, "utf8"));
      const info = data.installed || data.web;
      if (info) {
        GOOGLE_CLIENT_ID = info.client_id || "";
        GOOGLE_CLIENT_SECRET = info.client_secret || "";
        console.log("✅  Loaded Google OAuth credentials from client_secret.json");
      }
    } catch (e) {
      console.warn("⚠️  Could not parse client_secret.json:", e.message);
    }
  }
}

// ─── Business config & data paths ────────────────────────────────────
const DATA_DIR = path.resolve(__dirname, "..", "data");
const BUSINESS_CONFIG_FILE = path.join(DATA_DIR, "business_config.json");
// token.json lives in data/ so both Node and Python share it via the same Docker volume
const TOKEN_FILE = path.join(DATA_DIR, "token.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadBusinessConfig() {
  if (fs.existsSync(BUSINESS_CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(BUSINESS_CONFIG_FILE, "utf8"));
    } catch (e) {
      console.warn("Could not parse business config:", e.message);
    }
  }
  return null;
}

function buildSystemPrompt(config) {
  if (!config || !config.businessInfo?.name) {
    return process.env.AGENT_SYSTEM_PROMPT || "You are a helpful AI receptionist. You can check availability, book appointments, and cancel appointments.";
  }

  const biz       = config.businessInfo  || {};
  const services  = config.services       || [];
  const hours     = config.hours          || {};
  const rules     = config.bookingRules   || {};
  const pricing   = config.pricing        || {};
  const currency  = pricing.currency      || "USD";
  const taxRate   = pricing.taxRate       || 0;

  const dayNames  = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
  const openDays  = dayNames.filter(d => hours[d]?.enabled);
  const closedDays = dayNames.filter(d => !hours[d]?.enabled);

  // ── Current date ───────────────────────────────────────────────────
  const now = new Date();
  const currentDate = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const currentTime = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });

  // ── Identity ───────────────────────────────────────────────────────
  let p = `You are ${biz.name}'s AI receptionist. Your job is to answer questions about the business and manage appointments on the owner's behalf.`;
  if (biz.description) p += ` The business is: ${biz.description}.`;
  p += `\n\n## Current Date & Time\nToday is ${currentDate} and the current time is ${currentTime}. Always refer to today by its full name (e.g., "this Friday" or "today, Wednesday") when discussing dates with the caller. Use this when reasoning about appointment dates, availability, and scheduling.`;

  // ── Contact info ───────────────────────────────────────────────────
  p += `\n\n## Business Details`;
  p += `\n- Business name: ${biz.name}`;
  if (biz.phone)   p += `\n- Phone: ${biz.phone}`;
  if (biz.email)   p += `\n- Email: ${biz.email}`;
  if (biz.address) p += `\n- Address: ${biz.address}`;

  // ── Services & Pricing ─────────────────────────────────────────────
  if (services.length > 0) {
    p += `\n\n## Services & Pricing (currency: ${currency}${taxRate > 0 ? `, +${taxRate}% tax` : ""})`;
    services.forEach((s, i) => {
      p += `\n${i + 1}. ${s.name}`;
      if (s.duration)    p += ` — ${s.duration} minutes`;
      if (s.price > 0)   p += ` — ${currency} ${s.price}${taxRate > 0 ? ` (+ ${taxRate}% tax = ${currency} ${(s.price * (1 + taxRate / 100)).toFixed(2)} total)` : ""}`;
      if (s.description) p += `. ${s.description}`;
    });
  } else {
    p += `\n\n## Services\n- No specific services have been configured. Let the caller know and take a message.`;
  }

  // ── Working Hours ──────────────────────────────────────────────────
  if (openDays.length > 0) {
    p += `\n\n## Working Hours`;
    openDays.forEach(d => {
      const h = hours[d];
      p += `\n- ${d.charAt(0).toUpperCase() + d.slice(1)}: ${h.open} – ${h.close}`;
    });
    if (closedDays.length > 0) {
      p += `\n- Closed on: ${closedDays.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(", ")}`;
    }
  }

  // ── Booking Rules ──────────────────────────────────────────────────
  p += `\n\n## Appointment Rules`;
  p += `\n- Appointments must be booked at least ${rules.minNotice || 1} hour(s) in advance.`;
  p += `\n- Bookings are accepted up to ${rules.maxAdvance || 30} days in advance.`;
  p += `\n- Default appointment length is ${rules.defaultDuration || 30} minutes.`;
  if (rules.bufferTime > 0) p += `\n- There is a ${rules.bufferTime}-minute gap between appointments.`;

  // ── How to handle calls ────────────────────────────────────────────
  p += `\n\n## How to Handle Calls`;
  p += `\nAlways answer naturally as a human receptionist would. Never narrate or describe what you are doing internally.`;
  p += `\nNever say things like "let me check the calendar", "I am running a search", "I am calling a function", or describe any technical process.`;
  p += `\nWhen a caller wants to BOOK an appointment:`;
  p += `\n  1. Ask which service they want.`;
  p += `\n  2. Ask for their preferred date.`;
  p += `\n  3. Silently look up availability, then tell the caller which time slots are open.`;
  p += `\n  4. Confirm the chosen time with the caller.`;
  p += `\n  5. Ask for their full name and phone number.`;
  p += `\n  6. Silently create the booking, then confirm the appointment details to the caller.`;
  p += `\n  7. Read back the confirmed date, time, and service naturally — like "Perfect, you're all set for Tuesday the 24th at 10 AM for a Classic Haircut."`;
  p += `\nWhen a caller wants to CANCEL an appointment:`;
  p += `\n  1. Ask for their name and the date of the appointment.`;
  p += `\n  2. Silently find and remove it, then confirm the cancellation conversationally.`;
  p += `\nWhen a caller asks about PRICE, give the exact price from the services list above.`;
  p += `\nWhen a caller asks about HOURS, tell them the working hours above.`;
  p += `\nIf you do not know the answer, say you will pass the message to the team.`;

  // ── Voice style ────────────────────────────────────────────────────
  p += `\n\n## Response Style — CRITICAL RULES`;
  p += `\nThis is a live phone call. You are a warm, professional human receptionist. Follow these rules on every single reply:`;
  p += `\n- MAXIMUM 1-2 SHORT sentences per reply. Never more. If you have more to say, pause and let the customer respond first.`;
  p += `\n- Ask only ONE question at a time. Never stack multiple questions in one turn.`;
  p += `\n- Use everyday spoken language. Short words, short sentences. No formal or written-style phrasing.`;
  p += `\n- NEVER mention tools, functions, APIs, parameters, databases, or any technical term.`;
  p += `\n- NEVER say "I'm checking the system", "I'm running a query", "let me use the calendar tool", or anything similar.`;
  p += `\n- NEVER repeat back raw data like dates in ISO format or parameter names.`;
  p += `\n- NEVER describe your internal process. Speak only the outcome as a human would.`;
  p += `\n- Do NOT use bullet points, markdown, asterisks, or numbered lists.`;
  p += `\n- Do NOT say "As an AI", "Certainly!", "Absolutely!", "Of course!", or any robotic filler.`;
  p += `\n- Refer to yourself as "we" when speaking about the business, or just speak naturally without referencing yourself.`;
  p += `\n- When listing available times, read out a maximum of 4-5 options, naturally: "We have 10, 11, and 2 o'clock — which works for you?"`;
  p += `\n- Confirm bookings in one natural sentence: "Perfect, you're booked for Tuesday the 24th at 10 for a Classic Haircut — see you then!"`;
  p += `\n- Bad example: "I will now proceed to check availability for the date 2026-02-24 using our scheduling system."`;
  p += `\n- Good example: "Sure, what day works for you?"`;
  p += `\n- Bad example: "I have successfully booked an appointment with the following parameters: service=Haircut, date=2026-02-24."`;
  p += `\n- Good example: "Done! You're all set for Tuesday the 24th at 10 AM."`;
  p += `\nAlways sound like a real person who genuinely wants to help. Be warm but efficient.`;

  return p;
}

function buildGreeting(config) {
  const name = config?.businessInfo?.name;
  if (name) return `Thank you for calling ${name}, how can I help you today?`;
  return "Hello, how can I assist you today?";
}

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

// ─── Custom LLM proxy — Agora calls this public endpoint, we forward internally ─
app.post("/api/llm/chat/completions", async (req, res) => {
  try {
    const upstream = await fetch(CUSTOM_LLM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(req.headers["authorization"] ? { Authorization: req.headers["authorization"] } : {}),
      },
      body: JSON.stringify(req.body),
    });
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (!["content-encoding", "transfer-encoding", "connection"].includes(k.toLowerCase())) {
        res.setHeader(k, v);
      }
    });
    if (upstream.body) {
      const { Readable } = await import("stream");
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    console.error("LLM proxy error:", err.message);
    res.status(502).json({ error: "LLM proxy failed", detail: err.message });
  }
});

// ─── Agent event log (SSE broadcast to frontend) ─────────────────────
const agentLogClients = new Set();
const agentLogBuffer = []; // Last 50 events for late-joiners

function broadcastAgentLog(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  agentLogClients.forEach((res) => {
    try { res.write(payload); } catch (_) {}
  });
  agentLogBuffer.push(event);
  if (agentLogBuffer.length > 50) agentLogBuffer.shift();
}

// POST /api/agent-log — called by custom_llm.py
app.post("/api/agent-log", (req, res) => {
  const { type, tool, label, args } = req.body || {};
  if (!type) return res.status(400).json({ error: "missing type" });
  broadcastAgentLog({ type, tool, label, args, ts: Date.now() });
  res.json({ ok: true });
});

// GET /api/agent-events — SSE stream consumed by the browser
app.get("/api/agent-events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Replay recent events so a fresh page-load catches up
  agentLogBuffer.forEach((evt) => {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  });

  agentLogClients.add(res);
  req.on("close", () => agentLogClients.delete(res));
});

// ─── POST /api/business/save ─────────────────────────────────────────
app.post("/api/business/save", (req, res) => {
  try {
    const config = req.body;
    if (!config || typeof config !== "object") {
      return res.status(400).json({ error: "Invalid config data." });
    }
    fs.writeFileSync(BUSINESS_CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
    console.log("✅  Business config saved.");
    res.json({ ok: true });
  } catch (err) {
    console.error("save-config error:", err.message);
    res.status(500).json({ error: "Failed to save config." });
  }
});

// ─── GET /api/business/load ──────────────────────────────────────────
app.get("/api/business/load", (_req, res) => {
  const config = loadBusinessConfig();
  if (config) {
    res.json(config);
  } else {
    res.json(null);
  }
});

// ─── GET /api/google/auth-url ────────────────────────────────────────
app.get("/api/google/auth-url", (_req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(500).json({ error: "Google OAuth credentials not configured." });
  }
  const scopes = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/userinfo.email",
    "openid",
  ];
  const state = crypto.randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  res.json({ url, state });
});

// ─── GET /api/google/callback ───────────────────────────────────────
app.get("/api/google/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    return res.redirect(`/?google_error=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return res.redirect("/?google_error=no_code");
  }
  try {
    // Exchange code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("Google token exchange failed:", errText);
      return res.redirect("/?google_error=token_exchange_failed");
    }
    const tokens = await tokenRes.json();

    // Fetch user email
    let email = "";
    try {
      const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (userInfoRes.ok) {
        const userInfo = await userInfoRes.json();
        email = userInfo.email || "";
      }
    } catch (e) {
      console.warn("Could not fetch user email:", e.message);
    }

    // Save token in the format google-auth library expects
    const tokenData = {
      token: tokens.access_token,
      refresh_token: tokens.refresh_token || "",
      token_uri: "https://oauth2.googleapis.com/token",
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      scopes: [
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/userinfo.email",
        "openid",
      ],
      expiry: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
    };
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2), "utf8");
    console.log(`✅  Google Calendar connected for ${email || "(unknown email)"}`);

    // Update business config with calendar status
    const config = loadBusinessConfig() || {};
    config.calendarConnected = true;
    config.calendarEmail = email;
    fs.writeFileSync(BUSINESS_CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");

    res.redirect(`/?google_success=true&email=${encodeURIComponent(email)}`);
  } catch (err) {
    console.error("Google OAuth callback error:", err.message);
    res.redirect("/?google_error=server_error");
  }
});

// ─── GET /api/google/status ─────────────────────────────────────────
app.get("/api/google/status", (_req, res) => {
  const connected = fs.existsSync(TOKEN_FILE);
  const config = loadBusinessConfig() || {};
  res.json({
    connected,
    email: config.calendarEmail || "",
  });
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
          url: PUBLIC_URL ? `${PUBLIC_URL}/api/llm/chat/completions` : CUSTOM_LLM_URL,
          api_key: LLM_API_KEY,
          system_messages: [
            { role: "system", content: buildSystemPrompt(loadBusinessConfig()) },
          ],
          max_history: 32,
          greeting_message: buildGreeting(loadBusinessConfig()),
          failure_message: "Please hold on a second.",
          params: { model: "gemini-2.5-flash" },
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
