import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import mineflayer from "mineflayer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { startDiscordBot } from "./discord-bot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const MAX_SLOTS = 100;
const DATA_FILE = path.join(__dirname, "bot-slots.json");

// ─── Reconnect Config ────────────────────────────────────────────────────────
// Exponential backoff: 8s → 16s → 32s → 64s … max 5 min
const RECONNECT_BASE_MS = 8_000;
const RECONNECT_MAX_MS  = 5 * 60_000;   // 5 minutes ceiling
const GHOST_DELAY_MS    = 45_000;        // ghost session: wait 45s
const JITTER_MS         = 3_000;         // ±3s random jitter

// ─── Persistence ─────────────────────────────────────────────────────────────
function loadSlots() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {}
  return {};
}
function saveSlots(slots) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(slots, null, 2), "utf-8"); } catch {}
}

let slotsData = loadSlots();
function getSlotData(id)       { return slotsData[String(id)] ?? null; }
function setSlotData(id, data) { slotsData[String(id)] = data; saveSlots(slotsData); }
function deleteSlotData(id)    { delete slotsData[String(id)]; saveSlots(slotsData); }

// ─── Bot State ────────────────────────────────────────────────────────────────
const botStates = new Map();

function freshState(slotId) {
  return {
    slotId,
    bot: null,
    reconnectTimer: null,
    afkTimer: null,
    shouldReconnect: false,
    isReconnecting: false,
    destroyed: true,
    reconnectAttempts: 0,   // for exponential backoff
  };
}

function getState(slotId) {
  const id = String(slotId);
  if (!botStates.has(id)) botStates.set(id, freshState(id));
  return botStates.get(id);
}

function emitStatus(slotId) {
  const state  = getState(slotId);
  const data   = getSlotData(slotId);
  const status = {
    slotId: String(slotId),
    online: false,
    reconnecting: state.isReconnecting,
    playerCount: null,
    players: [],
    serverHost: data?.host ?? null,
  };
  if (state.bot?.entity) {
    const players       = Object.values(state.bot.players ?? {}).map(p => p.username);
    status.online       = true;
    status.reconnecting = false;
    status.playerCount  = players.length;
    status.players      = players;
  }
  io.emit("botStatus", status);
  return status;
}

function emitLog(slotId, sender, message) {
  io.emit("botLog", { slotId: String(slotId), sender, message, timestamp: new Date().toISOString() });
}

// ─── AFK helpers ──────────────────────────────────────────────────────────────
function stopAfk(state) {
  if (state.afkTimer) { clearInterval(state.afkTimer); state.afkTimer = null; }
}

function startAfk(state) {
  stopAfk(state);
  // FIX: every 30-40s (not 9-12s) — too-frequent moves cause "suspicious activity" kicks
  state.afkTimer = setInterval(() => {
    if (!state.bot?.entity) return;
    try {
      state.bot.look(
        state.bot.entity.yaw   + (Math.random() - 0.5) * 0.5,
        state.bot.entity.pitch + (Math.random() - 0.5) * 0.2,
        false
      );
      if (Math.random() < 0.25) {
        state.bot.setControlState("forward", true);
        setTimeout(() => state.bot?.setControlState("forward", false), 200);
      }
      if (Math.random() < 0.15) {
        state.bot.setControlState("jump", true);
        setTimeout(() => state.bot?.setControlState("jump", false), 350);
      }
    } catch {}
  }, 30_000 + Math.random() * 10_000);
}

// ─── Reconnect helpers ────────────────────────────────────────────────────────
function cancelReconnect(state) {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
}

function calcBackoff(attempts) {
  // 8s, 16s, 32s, 64s … capped at RECONNECT_MAX_MS
  const base   = Math.min(RECONNECT_BASE_MS * (2 ** attempts), RECONNECT_MAX_MS);
  const jitter = (Math.random() - 0.5) * 2 * JITTER_MS;
  return Math.max(RECONNECT_BASE_MS, base + jitter);
}

function destroyBot(state) {
  if (state.destroyed) return;
  state.destroyed = true;
  stopAfk(state);
  const b    = state.bot;
  state.bot  = null;
  emitStatus(state.slotId);
  try { b?.quit?.(); } catch {}
  try { b?.end?.(); }  catch {}
}

function scheduleReconnect(state, delayOverrideMs) {
  cancelReconnect(state);
  if (!state.shouldReconnect) return;

  state.isReconnecting = true;
  emitStatus(state.slotId);

  // Exponential backoff — each failed attempt waits longer
  const delay     = delayOverrideMs ?? calcBackoff(state.reconnectAttempts);
  const delaySec  = Math.round(delay / 1000);
  state.reconnectAttempts++;

  emitLog(state.slotId, "[System]", `🔄 Reconnect #${state.reconnectAttempts} in ${delaySec}s...`);

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (state.shouldReconnect) {
      const data = getSlotData(state.slotId);
      if (data) createMineflayerBot(state.slotId, data);
    }
  }, delay);
}

// ─── Core bot factory ─────────────────────────────────────────────────────────
function createMineflayerBot(slotId, cfg) {
  const state  = getState(slotId);
  state.destroyed = false;

  const b = mineflayer.createBot({
    host:    cfg.host,
    port:    Number(cfg.port) || 25565,
    username: cfg.username,

    // FIX 1: auto-detect MC version — hardcoded "1.21" causes instant kicks on
    //         servers running 1.20.x, 1.19.x, Paper, etc.
    version: cfg.version && cfg.version !== "auto" ? cfg.version : false,

    auth: "offline",

    // FIX 2: suppress internal mineflayer errors → no unhandled rejections
    hideErrors: true,

    // FIX 3: physics=false → no physics lag → server won't kick for "moving too fast"
    physicsEnabled: false,

    // FIX 4: 30s timeout before disconnect (default is much shorter)
    checkTimeoutInterval: 30_000,
  });

  state.bot = b;

  // ── Spawn ──
  b.once("spawn", () => {
    if (b !== state.bot) return;
    // FIX 5: reset backoff counter on successful connect
    state.reconnectAttempts = 0;
    state.isReconnecting    = false;
    emitStatus(slotId);
    emitLog(slotId, "[System]", `✅ Joined ${cfg.host}:${cfg.port || 25565} as ${cfg.username}`);
    startAfk(state);
    if (cfg.password) {
      setTimeout(() => {
        if (b !== state.bot) return;
        try { b.chat(`/login ${cfg.password}`); } catch {}
      }, 1_500);
    }
  });

  b.on("chat", (username, message) => {
    if (b !== state.bot || username === b.username) return;
    emitLog(slotId, username, message);
  });

  b.on("message", (jsonMsg) => {
    if (b !== state.bot) return;
    const raw   = jsonMsg.toString();
    const lower = raw.toLowerCase();
    if (cfg.password) {
      if (lower.includes("/register") || lower.includes("please register") || lower.includes("register with")) {
        setTimeout(() => { if (b !== state.bot) return; try { b.chat(`/register ${cfg.password} ${cfg.password}`); } catch {} }, 800);
        return;
      }
      if (lower.includes("/login") || lower.includes("please login") || lower.includes("log in")) {
        setTimeout(() => { if (b !== state.bot) return; try { b.chat(`/login ${cfg.password}`); } catch {} }, 800);
        return;
      }
    }
    if (raw.trim()) emitLog(slotId, "[Server]", raw);
  });

  b.on("playerJoined", () => { if (b === state.bot) emitStatus(slotId); });
  b.on("playerLeft",   () => { if (b === state.bot) emitStatus(slotId); });

  // FIX 6: do NOT reconnect on "error" — just log it
  //         Calling scheduleReconnect here causes the rapid-reconnect loop
  //         The "end" event will fire after an error anyway
  b.on("error", (err) => {
    if (b !== state.bot) return;
    emitLog(slotId, "[Error]", err.message);
  });

  // ── Kicked ──
  b.on("kicked", (reason) => {
    if (b !== state.bot) return;
    let msg = reason;
    try { msg = JSON.parse(reason)?.text ?? reason; } catch {}
    emitLog(slotId, "[System]", `❌ Kicked: ${msg}`);
    destroyBot(state);

    // FIX 7: ghost session → wait 45s (not 30s) before reconnecting
    //         server needs time to clear the old session from its list
    const isGhost = msg.toLowerCase().includes("already online") ||
                    msg.toLowerCase().includes("already connected") ||
                    msg.toLowerCase().includes("logged in from another location");
    scheduleReconnect(state, isGhost ? GHOST_DELAY_MS : undefined);
  });

  // ── End ──
  b.on("end", (reason) => {
    if (b !== state.bot) return;
    emitLog(slotId, "[System]", `🔌 Disconnected: ${reason ?? "unknown"}`);
    destroyBot(state);
    scheduleReconnect(state);
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────
function startSlot(slotId) {
  const data = getSlotData(slotId);
  if (!data?.registered) return { ok: false, error: "Slot not registered" };
  if (!data.host)         return { ok: false, error: "No host configured" };
  const state = getState(slotId);
  state.shouldReconnect   = false;
  cancelReconnect(state);
  destroyBot(state);
  state.reconnectAttempts = 0;   // reset backoff on manual start
  state.shouldReconnect   = true;
  state.isReconnecting    = false;
  state.destroyed         = false;
  createMineflayerBot(slotId, data);
  return { ok: true };
}

function stopSlot(slotId) {
  const state = getState(slotId);
  state.shouldReconnect   = false;
  state.isReconnecting    = false;
  state.reconnectAttempts = 0;
  cancelReconnect(state);
  destroyBot(state);
  emitStatus(slotId);
  return { ok: true };
}

function restartSlot(slotId) {
  stopSlot(slotId);
  setTimeout(() => startSlot(slotId), 2_000);
  return { ok: true };
}

// ─── Express ─────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/slots", (_req, res) => {
  const result = {};
  for (let i = 1; i <= MAX_SLOTS; i++) {
    const id    = String(i);
    const data  = slotsData[id] ?? null;
    const state = getState(id);
    result[id]  = {
      registered:   data?.registered ?? false,
      username:     data?.username   ?? null,
      host:         data?.host       ?? null,
      online:       !!(state.bot?.entity),
      reconnecting: state.isReconnecting,
    };
  }
  res.json(result);
});

app.get("/api/slot/:id/status", (req, res) => {
  const id      = req.params.id;
  const state   = getState(id);
  const data    = getSlotData(id);
  const online  = !!(state.bot?.entity);
  const players = online ? Object.values(state.bot.players ?? {}).map(p => p.username) : [];
  res.json({ slotId: id, registered: data?.registered ?? false, online, reconnecting: state.isReconnecting, playerCount: players.length, players, host: data?.host ?? null, username: data?.username ?? null });
});

app.post("/api/slot/:id/register", (req, res) => {
  const id  = req.params.id;
  const num = Number(id);
  if (!num || num < 1 || num > MAX_SLOTS) { res.status(400).json({ error: "Invalid slot ID (1-100)" }); return; }
  const { host, port, version, username, password } = req.body;
  if (!host || !username) { res.status(400).json({ error: "host and username required" }); return; }
  const existing = getSlotData(id) ?? {};
  setSlotData(id, {
    ...existing,
    host,
    port:       Number(port) || 25565,
    version:    version || "auto",   // "auto" → mineflayer auto-detects
    username,
    password:   password || null,
    registered: true,
  });
  emitLog(id, "[System]", `📝 Slot ${id} registered: ${username} @ ${host}`);
  res.json({ ok: true });
});

app.post("/api/slot/:id/start",   (req, res) => {
  const result = startSlot(req.params.id);
  if (!result.ok) { res.status(400).json(result); return; }
  emitLog(req.params.id, "[System]", "🚀 Bot starting...");
  res.json(result);
});

app.post("/api/slot/:id/stop",    (req, res) => {
  res.json(stopSlot(req.params.id));
  emitLog(req.params.id, "[System]", "⏹ Bot stopped.");
});

app.post("/api/slot/:id/restart", (req, res) => {
  res.json(restartSlot(req.params.id));
  emitLog(req.params.id, "[System]", "🔄 Restarting bot...");
});

app.post("/api/slot/:id/chat", (req, res) => {
  const state = getState(req.params.id);
  const { message } = req.body;
  if (!message)           { res.status(400).json({ error: "message required" }); return; }
  if (!state.bot?.entity) { res.status(400).json({ error: "Bot not online" });   return; }
  try { state.bot.chat(message); res.json({ ok: true }); }
  catch { res.status(500).json({ error: "Failed to send" }); }
});

app.delete("/api/slot/:id", (req, res) => {
  const id = req.params.id;
  stopSlot(id);
  deleteSlotData(id);
  emitLog(id, "[System]", `🗑 Slot ${id} deleted.`);
  io.emit("slotDeleted", { slotId: id });
  res.json({ ok: true });
});

app.get("/api/slot/:id/settings", (req, res) => { res.json(getSlotData(req.params.id) ?? {}); });
app.get("/api/healthz", (_req, res) => res.json({
  status:     "ok",
  activeBots: [...botStates.values()].filter(s => s.bot?.entity).length,
}));

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("[WS] Client connected:", socket.id);
  for (let i = 1; i <= MAX_SLOTS; i++) emitStatus(String(i));
  socket.on("disconnect", () => console.log("[WS] Client disconnected:", socket.id));
});

// ─── Auto-start previously registered slots ────────────────────────────────────
for (const [id, data] of Object.entries(slotsData)) {
  if (data?.registered && data?.host) {
    console.log(`[Boot] Auto-starting slot ${id}...`);
    // stagger: 3s base + 300ms per slot — avoids hammering servers
    setTimeout(() => startSlot(id), 3_000 + Number(id) * 300);
  }
}

// ─── Self-ping keep-alive ─────────────────────────────────────────────────────
const domains = process.env.RENDER_EXTERNAL_URL || process.env.REPLIT_DOMAINS;
if (domains) {
  const selfUrl = domains.startsWith("http")
    ? `${domains}/api/healthz`
    : `https://${domains.split(",")[0]}/api/healthz`;
  setInterval(async () => { try { await fetch(selfUrl); } catch {} }, 4 * 60_000);
  console.log("[KeepAlive] Pinging:", selfUrl);
}

httpServer.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));

// ─── Discord Bot ──────────────────────────────────────────────────────────────
startDiscordBot().catch(e => console.error("[Discord] Fatal:", e.message));
