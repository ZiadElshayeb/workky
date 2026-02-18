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

// ─── Backend API base URL ────────────────────────────────────────────
const API_BASE = "";

// Connection parameters – fetched from backend at runtime
let appId = null;
let token = null;

// Generate a random UID
const uid = Math.floor(Math.random() * 100000);

// ─── DOM references ──────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ═════════════════════════════════════════════════════════════════════
// ONBOARDING WIZARD
// ═════════════════════════════════════════════════════════════════════

const TOTAL_STEPS = 6;
let currentStep = 1;
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

// ─── Barbershop defaults ─────────────────────────────────────────────
const DEFAULT_CONFIG = {
  businessInfo: {
    name: "Classic Cuts Barbershop",
    description: "A traditional barbershop offering premium haircuts, beard trims, and grooming services",
    phone: "+1 (555) 123-4567",
    email: "info@classiccuts.com",
    address: "123 Main Street, Downtown, New York, NY 10001",
  },
  services: [
    { name: "Classic Haircut",       duration: 30, price: 25,  description: "Traditional scissor or clipper cut with styling" },
    { name: "Beard Trim & Shape",    duration: 20, price: 15,  description: "Precision beard shaping and trimming" },
    { name: "Haircut & Beard Combo", duration: 45, price: 35,  description: "Full haircut plus beard trim package" },
    { name: "Kids Haircut",          duration: 20, price: 18,  description: "Haircut for children under 12" },
    { name: "Hot Towel Shave",       duration: 30, price: 30,  description: "Classic straight razor shave with hot towel treatment" },
    { name: "Hair Wash & Style",     duration: 20, price: 20,  description: "Shampoo, condition, blow-dry and style" },
  ],
  hours: {
    monday:    { enabled: true,  open: "09:00", close: "19:00" },
    tuesday:   { enabled: true,  open: "09:00", close: "19:00" },
    wednesday: { enabled: true,  open: "09:00", close: "19:00" },
    thursday:  { enabled: true,  open: "09:00", close: "19:00" },
    friday:    { enabled: true,  open: "09:00", close: "19:00" },
    saturday:  { enabled: true,  open: "10:00", close: "18:00" },
    sunday:    { enabled: false, open: "10:00", close: "16:00" },
  },
  bookingRules: {
    minNotice:       1,
    maxAdvance:      30,
    defaultDuration: 30,
    bufferTime:      5,
  },
  pricing: {
    currency: "USD",
    taxRate:  0,
  },
};

function applyDefaults() {
  const d = DEFAULT_CONFIG;

  // Business info
  $("#biz-name").value        = d.businessInfo.name;
  $("#biz-description").value = d.businessInfo.description;
  $("#biz-phone").value       = d.businessInfo.phone;
  $("#biz-email").value       = d.businessInfo.email;
  $("#biz-address").value     = d.businessInfo.address;

  // Services — clear the single empty row first, then add all defaults
  $("#services-list").innerHTML = "";
  serviceCounter = 0;
  d.services.forEach((svc) => addServiceRow(svc));

  // Hours
  DAYS.forEach((day) => {
    const h = d.hours[day];
    $(`input[type="checkbox"][data-day="${day}"]`).checked = h.enabled;
    $(`input[data-day="${day}"][data-role="open"]`).value  = h.open;
    $(`input[data-day="${day}"][data-role="close"]`).value = h.close;
  });

  // Booking rules
  $("#rule-min-notice").value = d.bookingRules.minNotice;
  $("#rule-max-advance").value = d.bookingRules.maxAdvance;
  $("#rule-duration").value   = d.bookingRules.defaultDuration;
  $("#rule-buffer").value     = d.bookingRules.bufferTime;

  // Pricing
  $("#pricing-currency").value = d.pricing.currency;
  $("#pricing-tax").value      = d.pricing.taxRate;
}

function initOnboarding() {
  renderStepIndicators();
  renderHoursGrid();
  applyDefaults();   // pre-fill all fields with barbershop defaults
  updateWizardUI();

  $("#btn-next").onclick = nextStep;
  $("#btn-prev").onclick = prevStep;
  $("#btn-add-service").onclick = addServiceRow;
  $("#btn-connect-calendar").onclick = connectGoogleCalendar;

  // Check URL params for Google OAuth callback
  const params = new URLSearchParams(window.location.search);
  if (params.get("google_success") === "true") {
    const email = params.get("email") || "";
    setCalendarStatus(true, email);
    // Clean URL
    window.history.replaceState({}, "", "/");
  } else if (params.get("google_error")) {
    setCalendarStatus(false, "", params.get("google_error"));
    window.history.replaceState({}, "", "/");
  }

  // Check if calendar is already connected
  checkCalendarStatus();
}

function renderStepIndicators() {
  const container = $("#step-indicators");
  const labels = ["Business", "Services", "Hours", "Rules", "Pricing", "Calendar"];
  container.innerHTML = labels
    .map(
      (label, i) =>
        `<div class="step-indicator" data-step="${i + 1}">
          <div class="step-dot">${i + 1}</div>
          <span class="step-label">${label}</span>
        </div>`
    )
    .join("");
}

function renderHoursGrid() {
  const grid = $("#hours-grid");
  grid.innerHTML = DAYS.map((day) => {
    const def = DEFAULT_CONFIG.hours[day];
    return `
      <div class="hours-row">
        <label class="day-toggle">
          <input type="checkbox" data-day="${day}" ${def.enabled ? "checked" : ""} />
          <span class="day-name">${day.charAt(0).toUpperCase() + day.slice(1)}</span>
        </label>
        <div class="hours-times">
          <input type="time" data-day="${day}" data-role="open"  value="${def.open}" />
          <span class="hours-sep">to</span>
          <input type="time" data-day="${day}" data-role="close" value="${def.close}" />
        </div>
      </div>`;
  }).join("");
}

let serviceCounter = 0;
function addServiceRow(data = null) {
  serviceCounter++;
  const id = serviceCounter;
  const list = $("#services-list");
  const row = document.createElement("div");
  row.className = "service-row";
  row.dataset.id = id;
  row.innerHTML = `
    <div class="form-grid service-grid">
      <div class="form-field">
        <label>Service Name *</label>
        <input type="text" class="svc-name" placeholder="e.g. Haircut" value="${data?.name || ""}" />
      </div>
      <div class="form-field">
        <label>Duration (min)</label>
        <input type="number" class="svc-duration" value="${data?.duration || 30}" min="5" max="480" step="5" />
      </div>
      <div class="form-field">
        <label>Price</label>
        <input type="number" class="svc-price" value="${data?.price || ""}" min="0" step="0.01" placeholder="0.00" />
      </div>
      <div class="form-field">
        <label>Description</label>
        <input type="text" class="svc-desc" placeholder="Brief description" value="${data?.description || ""}" />
      </div>
    </div>
    <button type="button" class="btn-remove-service" onclick="this.closest('.service-row').remove()">✕</button>
  `;
  list.appendChild(row);
}

function collectFormData() {
  // Business info
  const businessInfo = {
    name: $("#biz-name").value.trim(),
    description: $("#biz-description").value.trim(),
    phone: $("#biz-phone").value.trim(),
    email: $("#biz-email").value.trim(),
    address: $("#biz-address").value.trim(),
  };

  // Services
  const services = [];
  $$(".service-row").forEach((row) => {
    const name = row.querySelector(".svc-name").value.trim();
    if (name) {
      services.push({
        name,
        duration: parseInt(row.querySelector(".svc-duration").value) || 30,
        price: parseFloat(row.querySelector(".svc-price").value) || 0,
        description: row.querySelector(".svc-desc").value.trim(),
      });
    }
  });

  // Hours
  const hours = {};
  DAYS.forEach((day) => {
    const enabled = $(`input[type="checkbox"][data-day="${day}"]`).checked;
    const open = $(`input[data-day="${day}"][data-role="open"]`).value || "09:00";
    const close = $(`input[data-day="${day}"][data-role="close"]`).value || "17:00";
    hours[day] = { enabled, open, close };
  });

  // Booking rules
  const bookingRules = {
    minNotice: parseInt($("#rule-min-notice").value) || 1,
    maxAdvance: parseInt($("#rule-max-advance").value) || 30,
    defaultDuration: parseInt($("#rule-duration").value) || 30,
    bufferTime: parseInt($("#rule-buffer").value) || 0,
  };

  // Pricing
  const pricing = {
    currency: $("#pricing-currency").value,
    taxRate: parseFloat($("#pricing-tax").value) || 0,
  };

  return { businessInfo, services, hours, bookingRules, pricing };
}

function updateWizardUI() {
  // Show/hide steps
  $$(".wizard-step").forEach((el) => {
    const step = parseInt(el.dataset.step);
    el.classList.toggle("active", step === currentStep);
  });

  // Update progress bar
  const pct = ((currentStep - 1) / (TOTAL_STEPS - 1)) * 100;
  $("#progress-fill").style.width = `${pct}%`;

  // Update step indicators
  $$(".step-indicator").forEach((el) => {
    const step = parseInt(el.dataset.step);
    el.classList.toggle("completed", step < currentStep);
    el.classList.toggle("active", step === currentStep);
  });

  // Navigation buttons
  $("#btn-prev").disabled = currentStep === 1;
  const isLast = currentStep === TOTAL_STEPS;
  $("#btn-next").textContent = isLast ? "✅ Finish Setup" : "Next →";
  $("#btn-next").classList.toggle("btn-success", isLast);
}

function nextStep() {
  if (currentStep === 1) {
    // Validate business name
    const name = $("#biz-name").value.trim();
    if (!name) {
      $("#biz-name").focus();
      $("#biz-name").classList.add("input-error");
      setTimeout(() => $("#biz-name").classList.remove("input-error"), 2000);
      return;
    }
  }

  if (currentStep < TOTAL_STEPS) {
    currentStep++;
    updateWizardUI();
  } else {
    finishOnboarding();
  }
}

function prevStep() {
  if (currentStep > 1) {
    currentStep--;
    updateWizardUI();
  }
}

async function finishOnboarding() {
  const config = collectFormData();

  $("#btn-next").disabled = true;
  $("#btn-next").textContent = "Saving…";

  // Always persist to localStorage so the agent page has the config
  localStorage.setItem("workky_onboarded", "true");
  localStorage.setItem("workky_config", JSON.stringify(config));

  // Try to save to server (non-blocking — don't gate navigation on this)
  try {
    const res = await fetch(`${API_BASE}/api/business/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    if (!res.ok) console.warn("Server save returned", res.status);
    else console.log("✅ Config saved to server");
  } catch (err) {
    console.warn("Could not save config to server (will use local copy):", err.message);
  }

  // Always navigate to the agent page
  showAgentPage(config);
}

async function connectGoogleCalendar() {
  try {
    $("#btn-connect-calendar").disabled = true;
    $("#btn-connect-calendar").textContent = "Connecting…";

    const res = await fetch(`${API_BASE}/api/google/auth-url`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Failed to get auth URL");
    }

    const { url } = await res.json();
    // Save current form data before redirect
    localStorage.setItem("workky_onboarding_draft", JSON.stringify(collectFormData()));
    localStorage.setItem("workky_onboarding_step", currentStep.toString());

    window.location.href = url;
  } catch (err) {
    console.error("Calendar connect error:", err);
    alert("Failed to connect Google Calendar: " + err.message);
    $("#btn-connect-calendar").disabled = false;
    $("#btn-connect-calendar").textContent = "Connect Google Calendar";
  }
}

async function checkCalendarStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/google/status`);
    if (res.ok) {
      const { connected, email } = await res.json();
      if (connected) {
        setCalendarStatus(true, email);
      }
    }
  } catch (e) {
    // ignore
  }
}

function setCalendarStatus(connected, email = "", error = "") {
  const statusText = $("#calendar-status-text");
  const btn = $("#btn-connect-calendar");

  if (connected) {
    statusText.textContent = `✅ Connected${email ? ` (${email})` : ""}`;
    statusText.classList.add("connected");
    btn.textContent = "✅ Calendar Connected";
    btn.disabled = true;
    btn.classList.add("btn-connected");
  } else if (error) {
    statusText.textContent = `❌ Connection failed: ${error}`;
    statusText.classList.add("error");
    btn.disabled = false;
    btn.textContent = "Retry Connection";
  }
}

function restoreOnboardingDraft() {
  const draft = localStorage.getItem("workky_onboarding_draft");
  const step = localStorage.getItem("workky_onboarding_step");
  if (draft) {
    try {
      const config = JSON.parse(draft);

      // Restore business info
      if (config.businessInfo) {
        $("#biz-name").value = config.businessInfo.name || "";
        $("#biz-description").value = config.businessInfo.description || "";
        $("#biz-phone").value = config.businessInfo.phone || "";
        $("#biz-email").value = config.businessInfo.email || "";
        $("#biz-address").value = config.businessInfo.address || "";
      }

      // Restore services
      if (config.services?.length > 0) {
        $("#services-list").innerHTML = "";
        serviceCounter = 0;
        config.services.forEach((svc) => addServiceRow(svc));
      }

      // Restore hours
      if (config.hours) {
        DAYS.forEach((day) => {
          const h = config.hours[day];
          if (h) {
            $(`input[type="checkbox"][data-day="${day}"]`).checked = h.enabled;
            $(`input[data-day="${day}"][data-role="open"]`).value = h.open || "09:00";
            $(`input[data-day="${day}"][data-role="close"]`).value = h.close || "17:00";
          }
        });
      }

      // Restore booking rules
      if (config.bookingRules) {
        $("#rule-min-notice").value = config.bookingRules.minNotice ?? 1;
        $("#rule-max-advance").value = config.bookingRules.maxAdvance ?? 30;
        $("#rule-duration").value = config.bookingRules.defaultDuration ?? 30;
        $("#rule-buffer").value = config.bookingRules.bufferTime ?? 0;
      }

      // Restore pricing
      if (config.pricing) {
        $("#pricing-currency").value = config.pricing.currency || "USD";
        $("#pricing-tax").value = config.pricing.taxRate ?? 0;
      }

      // Restore step (go to Calendar step after OAuth redirect)
      if (step) {
        currentStep = parseInt(step) || 6;
        updateWizardUI();
      }

      localStorage.removeItem("workky_onboarding_draft");
      localStorage.removeItem("workky_onboarding_step");
    } catch (e) {
      console.warn("Could not restore draft:", e);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════
// PAGE NAVIGATION
// ═════════════════════════════════════════════════════════════════════

function showOnboardingPage() {
  $("#onboarding-page").style.display = "";
  $("#agent-page").style.display = "none";
}

function showAgentPage(config = null) {
  $("#onboarding-page").style.display = "none";
  $("#agent-page").style.display = "";

  if (config?.businessInfo?.name) {
    $("#biz-name-display").textContent = config.businessInfo.name;
  }

  initAgentPage();
}

// ═════════════════════════════════════════════════════════════════════
// AGENT / VOICE CALL PAGE (original logic)
// ═════════════════════════════════════════════════════════════════════

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
  while (log.children.length > 50) log.lastChild.remove();
}

function renderUsers() {
  const container = $("#users-list");
  container.innerHTML = "";
  if (isJoined) container.appendChild(createUserCard(uid, true));
  Object.keys(remoteUsers).forEach((rUid) => {
    container.appendChild(createUserCard(rUid, false));
  });
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
  const isAgent = !isLocal && String(id) === "0";
  name.textContent = isLocal ? `You (UID: ${id})` : isAgent ? "🤖 AI Receptionist" : `User ${id}`;

  const detail = document.createElement("div");
  detail.className = "user-detail";

  if (isLocal) {
    detail.textContent = isMuted ? "🔇 Muted" : "🎙️ Speaking";
  } else {
    const meta = remoteUsers[id];
    detail.textContent = meta ? `Joined ${formatTime(meta.joinedAt)} · 🔊 Audio` : "Connected";
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

function initializeClient() {
  client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });

  client.on("user-published", async (user, mediaType) => {
    await client.subscribe(user, mediaType);
    if (mediaType === "audio") user.audioTrack.play();
    remoteUsers[user.uid] = {
      user,
      joinedAt: remoteUsers[user.uid]?.joinedAt || new Date(),
    };
    addLog(`User ${user.uid} published ${mediaType}`);
    renderUsers();
  });

  client.on("user-joined", (user) => {
    if (!remoteUsers[user.uid]) remoteUsers[user.uid] = { user, joinedAt: new Date() };
    addLog(`User ${user.uid} joined the channel`);
    renderUsers();
  });

  client.on("user-left", (user) => {
    delete remoteUsers[user.uid];
    addLog(`User ${user.uid} left the channel`);
    renderUsers();
  });

  client.on("user-unpublished", (user, mediaType) => {
    if (mediaType === "audio" && remoteUsers[user.uid]) addLog(`User ${user.uid} unpublished audio`);
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
    if (isAgentRunning) await stopAgent();
    isJoined = false;
    isMuted = false;
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

async function startAgent() {
  const channel = $("#channel-input").value.trim() || "test";
  const existingLock = localStorage.getItem(AGENT_LOCK_KEY);
  const existingChannel = localStorage.getItem(AGENT_CHANNEL_KEY);
  if (existingLock === "true" && existingChannel === channel) {
    addLog("⚠️ An agent is already active in this channel.");
    return;
  }
  try {
    addLog("Starting AI receptionist…");
    const res = await fetch(`${API_BASE}/api/start-agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, uid, remoteUids: Object.keys(remoteUsers) }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `HTTP ${res.status}`);
    }
    const json = await res.json();
    agentId = json.agent_id;
    isAgentRunning = true;
    localStorage.setItem(AGENT_LOCK_KEY, "true");
    localStorage.setItem(AGENT_ID_KEY, agentId);
    localStorage.setItem(AGENT_CHANNEL_KEY, channel);
    addLog(`AI Receptionist started (ID: ${agentId})`);
    updateControls();
  } catch (err) {
    addLog(`❌ Agent start failed: ${err.message}`);
    console.error(err);
  }
}

async function stopAgent() {
  if (!agentId) return;
  try {
    addLog("Stopping AI receptionist…");
    const res = await fetch(`${API_BASE}/api/stop-agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `HTTP ${res.status}`);
    }
    addLog(`AI Receptionist stopped (ID: ${agentId})`);
    agentId = null;
    isAgentRunning = false;
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
  if (isAgentRunning) await stopAgent();
  else await startAgent();
}

// ─── Agent page initialization ───────────────────────────────────────
let agentPageInitialized = false;

async function initAgentPage() {
  if (agentPageInitialized) return;
  agentPageInitialized = true;

  // Clear stale agent locks
  localStorage.removeItem(AGENT_LOCK_KEY);
  localStorage.removeItem(AGENT_ID_KEY);
  localStorage.removeItem(AGENT_CHANNEL_KEY);

  // Fetch session config
  try {
    const res = await fetch(`${API_BASE}/api/session`, { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const session = await res.json();
    appId = session.appId;
    token = session.token;
  } catch (err) {
    setStatus("Cannot reach backend", "error");
    addLog(`❌ Backend unreachable: ${err.message}`);
    console.error(err);
    return;
  }

  initializeClient();
  $("#local-uid").textContent = uid;
  $("#btn-join").onclick = joinChannel;
  $("#btn-leave").onclick = leaveChannel;
  $("#btn-mute").onclick = toggleMute;
  $("#btn-agent").onclick = toggleAgent;
  $("#btn-edit-config").onclick = () => {
    localStorage.removeItem("workky_onboarded");
    showOnboardingPage();
    loadExistingConfig();
  };

  window.addEventListener("storage", (e) => {
    if (e.key === AGENT_LOCK_KEY || e.key === AGENT_CHANNEL_KEY) updateControls();
  });

  window.addEventListener("beforeunload", () => {
    if (isAgentRunning) {
      localStorage.removeItem(AGENT_LOCK_KEY);
      localStorage.removeItem(AGENT_ID_KEY);
      localStorage.removeItem(AGENT_CHANNEL_KEY);
    }
  });

  // Subscribe to agent tool-call events from the backend
  subscribeAgentEvents();

  updateControls();
  renderUsers();
  addLog("App ready — click Join to connect");
}

// ─── Agent event log (SSE) ───────────────────────────────────────────
let agentEventSource = null;

function subscribeAgentEvents() {
  if (agentEventSource) return; // already connected
  agentEventSource = new EventSource(`${API_BASE}/api/agent-events`);

  agentEventSource.onmessage = (e) => {
    try {
      const evt = JSON.parse(e.data);
      handleAgentEvent(evt);
    } catch (_) {}
  };

  agentEventSource.onerror = () => {
    // Reconnect silently; EventSource does this automatically
  };
}

function handleAgentEvent(evt) {
  const { type, tool, label } = evt;

  const icons = {
    check_availability: "📅",
    book_appointment: "📝",
    delete_appointment: "🗑️",
  };
  const icon = icons[tool] || "🔧";

  if (type === "tool_start") {
    addLog(`${icon} Agent: ${label}…`);
  } else if (type === "tool_success") {
    addLog(`✅ ${label}`);
  } else if (type === "tool_error") {
    addLog(`❌ ${label}`);
  }
}

async function loadExistingConfig() {
  try {
    const res = await fetch(`${API_BASE}/api/business/load`);
    if (!res.ok) return;
    const config = await res.json();
    if (!config) return;

    // Populate form with existing data
    if (config.businessInfo) {
      $("#biz-name").value = config.businessInfo.name || "";
      $("#biz-description").value = config.businessInfo.description || "";
      $("#biz-phone").value = config.businessInfo.phone || "";
      $("#biz-email").value = config.businessInfo.email || "";
      $("#biz-address").value = config.businessInfo.address || "";
    }
    if (config.services?.length > 0) {
      $("#services-list").innerHTML = "";
      serviceCounter = 0;
      config.services.forEach((svc) => addServiceRow(svc));
    }
    if (config.hours) {
      DAYS.forEach((day) => {
        const h = config.hours[day];
        if (h) {
          $(`input[type="checkbox"][data-day="${day}"]`).checked = h.enabled;
          $(`input[data-day="${day}"][data-role="open"]`).value = h.open || "09:00";
          $(`input[data-day="${day}"][data-role="close"]`).value = h.close || "17:00";
        }
      });
    }
    if (config.bookingRules) {
      $("#rule-min-notice").value = config.bookingRules.minNotice ?? 1;
      $("#rule-max-advance").value = config.bookingRules.maxAdvance ?? 30;
      $("#rule-duration").value = config.bookingRules.defaultDuration ?? 30;
      $("#rule-buffer").value = config.bookingRules.bufferTime ?? 0;
    }
    if (config.pricing) {
      $("#pricing-currency").value = config.pricing.currency || "USD";
      $("#pricing-tax").value = config.pricing.taxRate ?? 0;
    }
  } catch (e) {
    console.warn("Could not load existing config:", e);
  }
}

// ═════════════════════════════════════════════════════════════════════
// BOOTSTRAP
// ═════════════════════════════════════════════════════════════════════

async function startApp() {
  initOnboarding();
  restoreOnboardingDraft();

  // Check if onboarding was already completed
  const onboarded = localStorage.getItem("workky_onboarded") === "true";

  // Also check URL params (returning from Google OAuth)
  const params = new URLSearchParams(window.location.search);
  const returningFromOAuth = params.has("google_success") || params.has("google_error");

  if (onboarded && !returningFromOAuth) {
    // Load config from server, fall back to localStorage
    let config = null;
    try {
      const res = await fetch(`${API_BASE}/api/business/load`);
      if (res.ok) config = await res.json();
    } catch (e) {
      console.warn("Could not load config from server, trying localStorage:", e);
    }
    if (!config) {
      const local = localStorage.getItem("workky_config");
      if (local) try { config = JSON.parse(local); } catch {}
    }
    if (config) {
      showAgentPage(config);
      return;
    }
  }

  // Show onboarding
  showOnboardingPage();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startApp);
} else {
  startApp();
}
