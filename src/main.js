import AgoraRTC from "agora-rtc-sdk-ng";

// ─── State ───────────────────────────────────────────────────────────
let client = null;
let localAudioTrack = null;
let isMuted = false;
let isJoined = false;

// Conversational AI agent state
let agentId = null;
let isAgentRunning = false;

// Single-agent lock key (shared across tabs via localStorage)
const AGENT_LOCK_KEY = "agora_agent_active";
const AGENT_ID_KEY = "agora_agent_id";
const AGENT_CHANNEL_KEY = "agora_agent_channel";

// Track remote users: { uid: { user, joinedAt } }
const remoteUsers = {};

// Connection parameters (loaded from .env via Vite)
const appId = import.meta.env.VITE_AGORA_APP_ID;
const token = import.meta.env.VITE_AGORA_TOKEN;

// Conversational AI Agent credentials
const AGENT_CUSTOMER_ID = import.meta.env.VITE_AGORA_CUSTOMER_ID;
const AGENT_CUSTOMER_SECRET = import.meta.env.VITE_AGORA_CUSTOMER_SECRET;
const AGENT_LLM_API_KEY = import.meta.env.VITE_LLM_API_KEY;
const AGENT_TTS_API_KEY = import.meta.env.VITE_TTS_API_KEY;
const AGENT_STT_API_KEY = import.meta.env.VITE_STT_API_KEY;
const AGENT_TTS_REGION = import.meta.env.VITE_TTS_REGION || "eastus";
const AGENT_SYSTEM_PROMPT = import.meta.env.VITE_AGENT_SYSTEM_PROMPT || "You are a helpful chatbot.";

// Generate a random UID so every tab is a different user
const uid = Math.floor(Math.random() * 100000);

// ─── DOM references ──────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── Helpers ─────────────────────────────────────────────────────────
function setStatus(text, type = "info") {
  const el = $("#status-text");
  el.textContent = text;
  el.className = `status-${type}`;
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function addLog(msg) {
  const log = $("#log-list");
  const li = document.createElement("li");
  li.textContent = `[${formatTime(new Date())}] ${msg}`;
  log.prepend(li);
  // keep max 50 entries
  while (log.children.length > 50) log.lastChild.remove();
}

// ─── UI updates ──────────────────────────────────────────────────────
function renderUsers() {
  const container = $("#users-list");
  container.innerHTML = "";

  // Local user card
  if (isJoined) {
    container.appendChild(createUserCard(uid, true));
  }

  // Remote user cards
  Object.keys(remoteUsers).forEach((rUid) => {
    container.appendChild(createUserCard(rUid, false));
  });

  // Update count badge
  const total = isJoined ? 1 + Object.keys(remoteUsers).length : 0;
  $("#user-count").textContent = total;
}

function createUserCard(id, isLocal) {
  const card = document.createElement("div");
  card.className = "user-card" + (isLocal ? " local" : "");

  const avatar = document.createElement("div");
  avatar.className = "user-avatar";
  avatar.textContent = isLocal ? "🎤" : "🔊";

  const info = document.createElement("div");
  info.className = "user-info";

  const name = document.createElement("div");
  name.className = "user-name";
  // Show "Agora Agent" for the agent's UID (agent_rtc_uid "0" resolves to 0)
  const isAgent = !isLocal && String(id) === "0";
  name.textContent = isLocal ? `You (UID: ${id})` : isAgent ? "🤖 Agora Agent" : `User ${id}`;

  const detail = document.createElement("div");
  detail.className = "user-detail";

  if (isLocal) {
    detail.textContent = isMuted ? "🔇 Muted" : "🎙️ Speaking";
  } else {
    const meta = remoteUsers[id];
    detail.textContent = meta
      ? `Joined ${formatTime(meta.joinedAt)} · 🔊 Audio`
      : "Connected";
  }

  info.appendChild(name);
  info.appendChild(detail);
  card.appendChild(avatar);
  card.appendChild(info);
  return card;
}

function updateControls() {
  $("#btn-join").disabled = isJoined;
  $("#btn-leave").disabled = !isJoined;
  $("#btn-mute").disabled = !isJoined;
  $("#btn-mute").textContent = isMuted ? "🔇 Unmute" : "🎙️ Mute";
  $("#btn-mute").classList.toggle("muted", isMuted);

  // Agent button – disable when another tab already started an agent
  const agentBtn = $("#btn-agent");
  const channel = $("#channel-input").value.trim() || "test";
  const otherTabHasAgent =
    !isAgentRunning &&
    localStorage.getItem(AGENT_LOCK_KEY) === "true" &&
    localStorage.getItem(AGENT_CHANNEL_KEY) === channel;

  agentBtn.disabled = !isJoined || otherTabHasAgent;

  if (isAgentRunning) {
    agentBtn.textContent = "🛑 Stop Agent";
    agentBtn.classList.add("agent-running");
  } else if (otherTabHasAgent) {
    agentBtn.textContent = "🤖 Agent Active";
    agentBtn.classList.remove("agent-running");
  } else {
    agentBtn.textContent = "🤖 Start Agent";
    agentBtn.classList.remove("agent-running");
  }
}

// ─── Agora logic ─────────────────────────────────────────────────────
function initializeClient() {
  client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });

  // Auto-subscribe to every remote user that publishes audio
  client.on("user-published", async (user, mediaType) => {
    await client.subscribe(user, mediaType);
    if (mediaType === "audio") {
      user.audioTrack.play();
    }
    remoteUsers[user.uid] = {
      user,
      joinedAt: remoteUsers[user.uid]?.joinedAt || new Date(),
    };
    addLog(`User ${user.uid} published ${mediaType}`);
    renderUsers();
  });

  client.on("user-joined", (user) => {
    if (!remoteUsers[user.uid]) {
      remoteUsers[user.uid] = { user, joinedAt: new Date() };
    }
    addLog(`User ${user.uid} joined the channel`);
    renderUsers();
  });

  client.on("user-left", (user) => {
    delete remoteUsers[user.uid];
    addLog(`User ${user.uid} left the channel`);
    renderUsers();
  });

  client.on("user-unpublished", (user, mediaType) => {
    if (mediaType === "audio" && remoteUsers[user.uid]) {
      addLog(`User ${user.uid} unpublished audio`);
    }
    renderUsers();
  });
}

async function joinChannel() {
  const channel = $("#channel-input").value.trim() || "test";
  try {
    setStatus("Connecting…", "warn");
    addLog(`Joining channel "${channel}" as UID ${uid}…`);

    await client.join(appId, channel, token, uid);
    localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack();
    await client.publish([localAudioTrack]);

    isJoined = true;
    isMuted = false;
    setStatus(`Connected to "${channel}"`, "success");
    addLog("Joined and publishing audio");
    updateControls();
    renderUsers();
  } catch (err) {
    setStatus("Failed to join", "error");
    addLog(`Error: ${err.message}`);
    console.error(err);
  }
}

async function leaveChannel() {
  try {
    if (localAudioTrack) {
      localAudioTrack.stop();
      localAudioTrack.close();
      localAudioTrack = null;
    }
    await client.leave();
    // Stop agent if running before leaving
    if (isAgentRunning) {
      await stopAgent();
    }
    isJoined = false;
    isMuted = false;
    // Clear remote users
    Object.keys(remoteUsers).forEach((k) => delete remoteUsers[k]);
    setStatus("Disconnected", "info");
    addLog("Left the channel");
    updateControls();
    renderUsers();
  } catch (err) {
    addLog(`Error leaving: ${err.message}`);
    console.error(err);
  }
}

function toggleMute() {
  if (!localAudioTrack) return;
  isMuted = !isMuted;
  localAudioTrack.setEnabled(!isMuted);
  addLog(isMuted ? "Microphone muted" : "Microphone unmuted");
  updateControls();
  renderUsers();
}

// ─── Conversational AI Agent ─────────────────────────────────────────
function getAgentConfig() {
  return {
    customerId: AGENT_CUSTOMER_ID,
    customerSecret: AGENT_CUSTOMER_SECRET,
    asrApiKey: AGENT_STT_API_KEY,
    llmApiKey: AGENT_LLM_API_KEY,
    ttsApiKey: AGENT_TTS_API_KEY,
    ttsRegion: AGENT_TTS_REGION,
    systemPrompt: AGENT_SYSTEM_PROMPT,
  };
}

async function startAgent() {
  const cfg = getAgentConfig();

  if (!cfg.customerId || !cfg.customerSecret) {
    addLog("❌ Missing Agora Customer ID / Secret — expand AI Agent Configuration");
    return;
  }
  if (!cfg.llmApiKey) {
    addLog("❌ Missing LLM API Key — expand AI Agent Configuration");
    return;
  }
  if (!cfg.ttsApiKey) {
    addLog("❌ Missing TTS API Key — expand AI Agent Configuration");
    return;
  }

  const channel = $("#channel-input").value.trim() || "test";

  // ── Single-agent guard: prevent duplicate agents ──
  const existingLock = localStorage.getItem(AGENT_LOCK_KEY);
  const existingChannel = localStorage.getItem(AGENT_CHANNEL_KEY);
  if (existingLock === "true" && existingChannel === channel) {
    addLog("⚠️ An Agora Agent is already active in this channel.");
    return;
  }

  const base64Creds = btoa(`${cfg.customerId}:${cfg.customerSecret}`);

  const body = {
    name: "Agora Agent",
    properties: {
      channel,
      token,
      agent_rtc_uid: "0",
      remote_rtc_uids: [String(uid), ...Object.keys(remoteUsers)],
      enable_string_uid: false,
      idle_timeout: 120,
      llm: {
        url: "https://api.openai.com/v1/chat/completions",
        api_key: cfg.llmApiKey,
        system_messages: [
          { role: "system", content: cfg.systemPrompt },
        ],
        greeting_message: "Hello, how can I help you?",
        failure_message: "Sorry, I don't know how to answer this question.",
        max_history: 10,
        params: { model: "gpt-4o-mini" },
      },
      asr: {
          "vendor": "deepgram",
          "params": {
            "url": "wss://api.deepgram.com/v1/listen",
            "key": cfg.asrApiKey,
            "model": "nova-3",
            "language": "en",
            "keyterm": "term1%20term2"
          }
      }
,
      tts: {
        "vendor": "openai",
        "params": {
          "base_url": "https://api.openai.com/v1",
          "api_key": cfg.ttsApiKey,
          "model": "tts-1",
          "voice": "coral",
          "instructions": "Please use standard American English, natural tone, moderate pace, and steady intonation",
          "speed": 1
        }
      }
    }
  };

  try {
    addLog("Starting AI agent…");
    const res = await fetch(
      `https://api.agora.io/api/conversational-ai-agent/v2/projects/${appId}/join`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${base64Creds}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    const json = await res.json();
    agentId = json.agent_id;
    isAgentRunning = true;

    // Persist the lock so other tabs / users see the agent is active
    localStorage.setItem(AGENT_LOCK_KEY, "true");
    localStorage.setItem(AGENT_ID_KEY, agentId);
    localStorage.setItem(AGENT_CHANNEL_KEY, channel);

    addLog(`Agora Agent started (ID: ${agentId})`);
    updateControls();
  } catch (err) {
    addLog(`❌ Agent start failed: ${err.message}`);
    console.error(err);
  }
}

async function stopAgent() {
  if (!agentId) return;

  const cfg = getAgentConfig();
  const base64Creds = btoa(`${cfg.customerId}:${cfg.customerSecret}`);

  try {
    addLog("Stopping AI agent…");
    const res = await fetch(
      `https://api.agora.io/api/conversational-ai-agent/v2/projects/${appId}/agents/${agentId}/leave`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${base64Creds}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    addLog(`Agora Agent stopped (ID: ${agentId})`);
    agentId = null;
    isAgentRunning = false;

    // Release the global lock
    localStorage.removeItem(AGENT_LOCK_KEY);
    localStorage.removeItem(AGENT_ID_KEY);
    localStorage.removeItem(AGENT_CHANNEL_KEY);

    updateControls();
  } catch (err) {
    addLog(`❌ Agent stop failed: ${err.message}`);
    console.error(err);
  }
}

async function toggleAgent() {
  if (isAgentRunning) {
    await stopAgent();
  } else {
    await startAgent();
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────
function startApp() {
  initializeClient();

  // Show the random UID in the header
  $("#local-uid").textContent = uid;

  // Wire up buttons
  $("#btn-join").onclick = joinChannel;
  $("#btn-leave").onclick = leaveChannel;
  $("#btn-mute").onclick = toggleMute;
  $("#btn-agent").onclick = toggleAgent;

  // Listen for lock changes from other tabs
  window.addEventListener("storage", (e) => {
    if (e.key === AGENT_LOCK_KEY || e.key === AGENT_CHANNEL_KEY) {
      updateControls();
    }
  });

  updateControls();
  renderUsers();

  addLog("App ready — click Join to connect");
}

// Wait for DOM
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startApp);
} else {
  startApp();
}