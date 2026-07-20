import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, InteractionType,
  Events, ActivityType, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} from "discord.js";
import mineflayer from "mineflayer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "discord-slots.json");
const MAX_SLOTS_PER_USER = parseInt(process.env.MAX_SLOTS_PER_USER || "5");
const ADMIN_ID = process.env.DISCORD_ADMIN_ID || null;

// ─── Reconnect Config ─────────────────────────────────────────────────────────
const RECONNECT_BASE_MS = 8_000;
const RECONNECT_MAX_MS  = 5 * 60_000;
const GHOST_DELAY_MS    = 45_000;
const JITTER_MS         = 3_000;

// ─── Persistence ──────────────────────────────────────────────────────────────
function loadData() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")); } catch {}
  return {};
}
function saveData(d) { try { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); } catch {} }

let db = loadData();
function getUserSlots(userId)          { return db[userId] ?? {}; }
function getSlot(userId, slotNum)      { return db[userId]?.[String(slotNum)] ?? null; }
function setSlot(userId, slotNum, data) {
  if (!db[userId]) db[userId] = {};
  db[userId][String(slotNum)] = data;
  saveData(db);
}
function deleteSlot(userId, slotNum) {
  if (db[userId]) { delete db[userId][String(slotNum)]; if (!Object.keys(db[userId]).length) delete db[userId]; }
  saveData(db);
}
function getUserSlotCount(userId) { return Object.keys(db[userId] ?? {}).length; }
function getNextSlotNum(userId) {
  const slots = db[userId] ?? {};
  for (let i = 1; i <= 100; i++) { if (!slots[String(i)]) return i; }
  return null;
}

// ─── Bot Instances ─────────────────────────────────────────────────────────────
const bots = new Map();
function botKey(userId, slotNum) { return `${userId}_${slotNum}`; }

function freshState(userId, slotNum) {
  return {
    userId, slotNum,
    bot: null,
    reconnectTimer: null,
    afkTimer: null,
    shouldReconnect: false,
    isReconnecting: false,
    destroyed: true,
    reconnectAttempts: 0,   // exponential backoff
  };
}

function getState(userId, slotNum) {
  const key = botKey(userId, slotNum);
  if (!bots.has(key)) bots.set(key, freshState(userId, slotNum));
  return bots.get(key);
}

function isOnline(userId, slotNum) { return !!(getState(userId, slotNum).bot?.entity); }
function isRecon(userId, slotNum)  { return getState(userId, slotNum).isReconnecting; }

// ─── AFK helpers ──────────────────────────────────────────────────────────────
function stopAfk(state) {
  if (state.afkTimer) { clearInterval(state.afkTimer); state.afkTimer = null; }
}

function startAfk(state) {
  stopAfk(state);
  // FIX: every 30-40s (not 9-12s)
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

// ─── Reconnect helpers ─────────────────────────────────────────────────────────
function cancelReconnect(state) {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
}

function calcBackoff(attempts) {
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
  try { b?.quit?.(); } catch {}
  try { b?.end?.(); }  catch {}
}

function scheduleReconnect(state, client, delayOverrideMs) {
  cancelReconnect(state);
  if (!state.shouldReconnect) return;
  state.isReconnecting = true;
  const delay    = delayOverrideMs ?? calcBackoff(state.reconnectAttempts);
  const delaySec = Math.round(delay / 1000);
  state.reconnectAttempts++;
  if (client) dmUser(client, state.userId, `\`[Slot ${state.slotNum}]\` 🔄 Reconnect #${state.reconnectAttempts} in ${delaySec}s...`);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (state.shouldReconnect) {
      const d = getSlot(state.userId, state.slotNum);
      if (d) launchBot(state.userId, state.slotNum, d, client);
    }
  }, delay);
}

async function dmUser(client, userId, msg) {
  try {
    const u = await client.users.fetch(userId).catch(() => null);
    if (u) await u.send({ content: msg }).catch(() => {});
  } catch {}
}

// ─── Launch Bot ────────────────────────────────────────────────────────────────
function launchBot(userId, slotNum, cfg, client) {
  const state     = getState(userId, slotNum);
  state.destroyed = false;

  const b = mineflayer.createBot({
    host:    cfg.host,
    port:    Number(cfg.port) || 25565,
    username: cfg.username,

    // FIX 1: auto-detect version — hardcoded "1.21" causes instant kicks
    version: cfg.version && cfg.version !== "auto" ? cfg.version : false,

    auth: "offline",

    // FIX 2: hide internal errors → no crash from unhandled rejections
    hideErrors: true,

    // FIX 3: no physics lag → won't get kicked for "moving too fast"
    physicsEnabled: false,

    // FIX 4: longer keepalive timeout
    checkTimeoutInterval: 30_000,
  });

  state.bot = b;

  b.once("spawn", () => {
    if (b !== state.bot) return;
    // FIX 5: reset backoff on successful connect
    state.reconnectAttempts = 0;
    state.isReconnecting    = false;
    if (client) dmUser(client, userId, `\`[Slot ${slotNum}]\` ✅ **${cfg.username}** joined **${cfg.host}:${cfg.port || 25565}**`);
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
    if (client) dmUser(client, userId, `\`[Slot ${slotNum}]\` 💬 **${username}**: ${message}`);
  });

  b.on("message", (jsonMsg) => {
    if (b !== state.bot) return;
    const raw   = jsonMsg.toString();
    const lower = raw.toLowerCase();
    if (cfg.password) {
      if (lower.includes("/register") || lower.includes("please register")) {
        setTimeout(() => { if (b !== state.bot) return; try { b.chat(`/register ${cfg.password} ${cfg.password}`); } catch {} }, 800);
        return;
      }
      if (lower.includes("/login") || lower.includes("please login")) {
        setTimeout(() => { if (b !== state.bot) return; try { b.chat(`/login ${cfg.password}`); } catch {} }, 800);
        return;
      }
    }
  });

  // FIX 6: only log errors — do NOT reconnect on error
  //         The "end" event fires after error anyway and handles reconnect
  b.on("error", (err) => {
    if (b !== state.bot) return;
    if (client) dmUser(client, userId, `\`[Slot ${slotNum}]\` ⚠️ ${err.message}`);
  });

  b.on("kicked", (reason) => {
    if (b !== state.bot) return;
    let msg = reason;
    try { msg = JSON.parse(reason)?.text ?? reason; } catch {}
    if (client) dmUser(client, userId, `\`[Slot ${slotNum}]\` ❌ Kicked: ${msg}`);
    destroyBot(state);
    // FIX 7: ghost session → 45s wait
    const isGhost = msg.toLowerCase().includes("already online") ||
                    msg.toLowerCase().includes("already connected") ||
                    msg.toLowerCase().includes("logged in from another location");
    scheduleReconnect(state, client, isGhost ? GHOST_DELAY_MS : undefined);
  });

  b.on("end", (reason) => {
    if (b !== state.bot) return;
    if (client) dmUser(client, userId, `\`[Slot ${slotNum}]\` 🔌 Disconnected. Reconnecting...`);
    destroyBot(state);
    scheduleReconnect(state, client);
  });
}

function startBot(userId, slotNum, client) {
  const d = getSlot(userId, slotNum);
  if (!d?.registered || !d?.host) return false;
  const state = getState(userId, slotNum);
  state.shouldReconnect   = false;
  cancelReconnect(state);
  destroyBot(state);
  state.reconnectAttempts = 0;   // reset backoff on manual start
  state.shouldReconnect   = true;
  state.isReconnecting    = false;
  state.destroyed         = false;
  launchBot(userId, slotNum, d, client);
  return true;
}

function stopBot(userId, slotNum) {
  const state = getState(userId, slotNum);
  state.shouldReconnect   = false;
  state.isReconnecting    = false;
  state.reconnectAttempts = 0;
  cancelReconnect(state);
  destroyBot(state);
}

function restartBot(userId, slotNum, client) {
  stopBot(userId, slotNum);
  setTimeout(() => startBot(userId, slotNum, client), 2_000);
}

// ─── Embed Builders ────────────────────────────────────────────────────────────
function buildMainEmbed() {
  let totalOnline = 0, totalSlots = 0;
  for (const [, state] of bots) { if (state.bot?.entity) totalOnline++; }
  for (const uid of Object.keys(db)) { totalSlots += Object.keys(db[uid]).length; }
  return new EmbedBuilder()
    .setTitle("🎮 MC AFK Bot Control Panel")
    .setDescription("Manage your personal Minecraft AFK bots!\n\n• Multiple bot slots per user\n• Auto reconnect support\n• Live DM updates\n• Secure — only you control your bots")
    .addFields(
      { name: "System Status 📊", value: "🟢 Online",       inline: true },
      { name: "Active Bots 🤖",   value: String(totalOnline), inline: true },
      { name: "Total Slots 🔌",   value: String(totalSlots),  inline: true },
    )
    .setColor(0x5865F2)
    .setFooter({ text: "MC AFK Bot Panel • Made by King Khizar" })
    .setTimestamp();
}

function buildSlotsEmbed(userId) {
  const slots   = getUserSlots(userId);
  const entries = Object.entries(slots);
  const embed   = new EmbedBuilder()
    .setTitle("⛏ Your Bot Slots")
    .setColor(0x5865F2)
    .setFooter({ text: `${entries.length}/${MAX_SLOTS_PER_USER} slots used • Made by King Khizar` })
    .setTimestamp();
  if (!entries.length) {
    embed.setDescription("You have no slots yet!\nClick **➕ New Slot** to create your first bot.");
  } else {
    const lines = entries.map(([num, d]) => {
      const online = isOnline(userId, num);
      const recon  = isRecon(userId, num);
      const status = online ? "🟢" : recon ? "🟡" : "🔴";
      return `${status} **Slot ${num}** — \`${d.username}\` @ \`${d.host}:${d.port || 25565}\``;
    });
    embed.setDescription(lines.join("\n"));
  }
  return embed;
}

function buildSlotEmbed(userId, slotNum) {
  const d       = getSlot(userId, slotNum);
  const online  = isOnline(userId, slotNum);
  const recon   = isRecon(userId, slotNum);
  const state   = getState(userId, slotNum);
  const players = online ? Object.values(state.bot?.players ?? {}).map(p => p.username) : [];
  const statusStr = online ? "🟢 Online" : recon ? "🟡 Reconnecting..." : "🔴 Offline";
  const embed   = new EmbedBuilder()
    .setTitle(`⛏ Slot ${slotNum} Control Panel`)
    .setColor(online ? 0x3ba55c : recon ? 0xfaa81a : 0xed4245)
    .setFooter({ text: "MC AFK Bot Panel • Made by King Khizar" })
    .setTimestamp();
  if (d?.registered) {
    embed.addFields(
      { name: "Status",        value: statusStr,                inline: true },
      { name: "Players",       value: online ? String(players.length) : "—", inline: true },
      { name: "Server",        value: `${d.host}:${d.port || 25565}`, inline: true },
      { name: "Username",      value: d.username,              inline: true },
      { name: "Version",       value: d.version || "auto",     inline: true },
      { name: "Auth",          value: d.password ? "AuthMe ✅" : "None", inline: true },
    );
    if (online && players.length) embed.addFields({ name: "Online Players", value: players.slice(0, 15).join(", "), inline: false });
  } else {
    embed.setDescription("This slot is not configured.\nClick **📝 Register** to set it up.");
  }
  return embed;
}

function mainRow(userId) {
  const count  = getUserSlotCount(userId);
  const canAdd = count < MAX_SLOTS_PER_USER;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`newslot_${userId}`).setLabel("➕ New Slot").setStyle(ButtonStyle.Success).setDisabled(!canAdd),
    new ButtonBuilder().setCustomId(`myslots_${userId}`).setLabel("📋 My Slots").setStyle(ButtonStyle.Primary),
  );
}

function slotsSelectMenu(userId) {
  const slots   = getUserSlots(userId);
  const entries = Object.entries(slots);
  if (!entries.length) return null;
  const options = entries.map(([num, d]) => {
    const online = isOnline(userId, num);
    const recon  = isRecon(userId, num);
    const emoji  = online ? "🟢" : recon ? "🟡" : "🔴";
    return new StringSelectMenuOptionBuilder()
      .setLabel(`Slot ${num} — ${d.username}`)
      .setDescription(`${d.host}:${d.port || 25565} | ${online ? "Online" : recon ? "Reconnecting" : "Offline"}`)
      .setValue(`selectslot_${userId}_${num}`)
      .setEmoji(emoji);
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`slotmenu_${userId}`)
    .setPlaceholder("Select a slot to manage...")
    .addOptions(options);
  return new ActionRowBuilder().addComponents(menu);
}

function slotControlRow1(userId, slotNum) {
  const d          = getSlot(userId, slotNum);
  const online     = isOnline(userId, slotNum);
  const registered = d?.registered ?? false;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`reg_${userId}_${slotNum}`).setLabel("📝 Register").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`startbot_${userId}_${slotNum}`).setLabel("▶ Start").setStyle(ButtonStyle.Success).setDisabled(!registered),
    new ButtonBuilder().setCustomId(`stopbot_${userId}_${slotNum}`).setLabel("⏹ Stop").setStyle(ButtonStyle.Danger).setDisabled(!online),
  );
}

function slotControlRow2(userId, slotNum) {
  const registered = getSlot(userId, slotNum)?.registered ?? false;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`restartbot_${userId}_${slotNum}`).setLabel("🔄 Restart").setStyle(ButtonStyle.Secondary).setDisabled(!registered),
    new ButtonBuilder().setCustomId(`statusbot_${userId}_${slotNum}`).setLabel("📊 Status").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`delslot_${userId}_${slotNum}`).setLabel("🗑 Delete Slot").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`myslots_${userId}`).setLabel("◀ Back").setStyle(ButtonStyle.Secondary),
  );
}

function openPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("open_panel").setLabel("PANEL").setStyle(ButtonStyle.Primary).setEmoji("🎮"),
  );
}

// ─── Export ────────────────────────────────────────────────────────────────────
export async function startDiscordBot() {
  const token    = process.env.DISCORD_BOT_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId  = process.env.DISCORD_GUILD_ID;

  if (!token || !clientId) { console.log("[Discord] Missing token/clientId — disabled."); return; }

  const rest     = new REST().setToken(token);
  const commands = [
    new SlashCommandBuilder().setName("panel").setDescription("Open the AFK Bot Control Panel").toJSON(),
    new SlashCommandBuilder().setName("slots").setDescription("See all your bot slots").toJSON(),
    new SlashCommandBuilder().setName("start").setDescription("Start a bot slot").addIntegerOption(o => o.setName("slot").setDescription("Slot number").setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName("stop").setDescription("Stop a bot slot").addIntegerOption(o => o.setName("slot").setDescription("Slot number").setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName("restart").setDescription("Restart a bot slot").addIntegerOption(o => o.setName("slot").setDescription("Slot number").setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName("status").setDescription("Status of a bot slot").addIntegerOption(o => o.setName("slot").setDescription("Slot number (default: all)").setRequired(false)).toJSON(),
    new SlashCommandBuilder().setName("startall").setDescription("Start ALL your registered slots").toJSON(),
    new SlashCommandBuilder().setName("stopall").setDescription("Stop ALL your running slots").toJSON(),
    new SlashCommandBuilder().setName("admin_list").setDescription("[Admin] List all bots").toJSON(),
  ];

  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log("[Discord] Guild commands registered.");
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log("[Discord] Global commands registered.");
    }
  } catch (e) { console.error("[Discord] Command reg failed:", e.message); }

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

  client.once(Events.ClientReady, () => {
    console.log(`[Discord] Logged in as ${client.user.tag}`);
    client.user.setActivity("100 Minecraft Bots", { type: ActivityType.Watching });
    // Auto-start saved slots with stagger
    for (const [uid, slots] of Object.entries(db)) {
      for (const [num, d] of Object.entries(slots)) {
        if (d?.registered && d?.host) {
          console.log(`[Discord] Auto-starting slot ${num} for user ${uid}`);
          setTimeout(() => startBot(uid, num, client), 4_000 + Math.random() * 6_000);
        }
      }
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    // ── SLASH COMMANDS ──────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      const userId = interaction.user.id;
      const cmd    = interaction.commandName;

      if (cmd === "panel") {
        await interaction.reply({ embeds: [buildMainEmbed()], components: [openPanelRow()] });
        return;
      }
      if (cmd === "slots") {
        const rows = [mainRow(userId)];
        const menu = slotsSelectMenu(userId);
        if (menu) rows.push(menu);
        await interaction.reply({ embeds: [buildSlotsEmbed(userId)], components: rows, ephemeral: true });
        return;
      }
      if (cmd === "start") {
        const num = interaction.options.getInteger("slot");
        const d   = getSlot(userId, num);
        if (!d?.registered) { await interaction.reply({ content: `❌ Slot ${num} not registered!`, ephemeral: true }); return; }
        startBot(userId, num, client);
        await interaction.reply({ content: `🚀 Slot **${num}** (${d.username}) starting...`, ephemeral: true });
        return;
      }
      if (cmd === "stop") {
        const num = interaction.options.getInteger("slot");
        stopBot(userId, num);
        await interaction.reply({ content: `⏹ Slot **${num}** stopped.`, ephemeral: true });
        return;
      }
      if (cmd === "restart") {
        const num = interaction.options.getInteger("slot");
        const d   = getSlot(userId, num);
        if (!d?.registered) { await interaction.reply({ content: `❌ Slot ${num} not found!`, ephemeral: true }); return; }
        restartBot(userId, num, client);
        await interaction.reply({ content: `🔄 Slot **${num}** restarting...`, ephemeral: true });
        return;
      }
      if (cmd === "status") {
        const num = interaction.options.getInteger("slot");
        if (num) {
          await interaction.reply({ embeds: [buildSlotEmbed(userId, num)], ephemeral: true });
        } else {
          const rows = [mainRow(userId)];
          const menu = slotsSelectMenu(userId);
          if (menu) rows.push(menu);
          await interaction.reply({ embeds: [buildSlotsEmbed(userId)], components: rows, ephemeral: true });
        }
        return;
      }
      if (cmd === "startall") {
        const slots = getUserSlots(userId);
        let count = 0;
        for (const [num, d] of Object.entries(slots)) {
          if (d?.registered && d?.host) { startBot(userId, num, client); count++; await new Promise(r => setTimeout(r, 500)); }
        }
        await interaction.reply({ content: `🚀 Starting **${count}** slots...`, ephemeral: true });
        return;
      }
      if (cmd === "stopall") {
        const slots = getUserSlots(userId);
        let count = 0;
        for (const [num] of Object.entries(slots)) { stopBot(userId, num); count++; }
        await interaction.reply({ content: `⏹ Stopped **${count}** slots.`, ephemeral: true });
        return;
      }
      if (cmd === "admin_list") {
        if (ADMIN_ID && userId !== ADMIN_ID) { await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return; }
        const lines = [];
        for (const [uid, slots] of Object.entries(db)) {
          for (const [num, d] of Object.entries(slots)) {
            const online = isOnline(uid, num);
            const recon  = isRecon(uid, num);
            lines.push(`${online ? "🟢" : recon ? "🟡" : "🔴"} <@${uid}> Slot ${num} — **${d.username}** @ ${d.host}`);
          }
        }
        const embed = new EmbedBuilder().setTitle("📋 All Bot Slots").setDescription(lines.length ? lines.join("\n") : "No slots registered").setColor(0x5865F2);
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }
    }

    // ── BUTTONS ──────────────────────────────────────────────────────────────────
    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id === "open_panel") {
        const userId = interaction.user.id;
        const rows   = [mainRow(userId)];
        const menu   = slotsSelectMenu(userId);
        if (menu) rows.push(menu);
        await interaction.reply({ embeds: [buildSlotsEmbed(userId)], components: rows, ephemeral: true });
        return;
      }

      const parts      = id.split("_");
      const action     = parts[0];
      const targetId   = parts[1];
      const slotNum    = parts[2] ?? null;

      if (targetId !== interaction.user.id) { await interaction.reply({ content: "❌ Not your panel!", ephemeral: true }); return; }
      const userId = targetId;

      if (action === "myslots") {
        const rows = [mainRow(userId)];
        const menu = slotsSelectMenu(userId);
        if (menu) rows.push(menu);
        await interaction.update({ embeds: [buildSlotsEmbed(userId)], components: rows });
        return;
      }
      if (action === "newslot") {
        const count = getUserSlotCount(userId);
        if (count >= MAX_SLOTS_PER_USER) { await interaction.reply({ content: `❌ Max **${MAX_SLOTS_PER_USER}** slots!`, ephemeral: true }); return; }
        const newNum = getNextSlotNum(userId);
        setSlot(userId, newNum, { registered: false });
        const rows = [slotControlRow1(userId, newNum), slotControlRow2(userId, newNum)];
        await interaction.update({ embeds: [buildSlotEmbed(userId, newNum)], components: rows });
        return;
      }
      if (action === "reg") {
        const d     = getSlot(userId, slotNum) ?? {};
        const modal = new ModalBuilder().setCustomId(`modal_${userId}_${slotNum}`).setTitle(`Register Slot ${slotNum}`);
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("host").setLabel("Server IP / Host").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("play.example.com").setValue(d?.host ?? "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("25565").setValue(String(d?.port ?? 25565))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("version").setLabel("MC Version (leave blank = auto-detect)").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("auto").setValue(d?.version ?? "auto")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("username").setLabel("Bot Username").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("AFKBot").setValue(d?.username ?? "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("password").setLabel("AuthMe Password (blank if not needed)").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("Leave blank if not needed")),
        );
        await interaction.showModal(modal);
        return;
      }
      if (action === "startbot") {
        const d = getSlot(userId, slotNum);
        if (!d?.registered) { await interaction.reply({ content: "❌ Register first!", ephemeral: true }); return; }
        startBot(userId, slotNum, client);
        await interaction.update({ embeds: [buildSlotEmbed(userId, slotNum)], components: [slotControlRow1(userId, slotNum), slotControlRow2(userId, slotNum)] });
        await interaction.followUp({ content: `🚀 Slot ${slotNum} starting! You'll get a DM when it joins.`, ephemeral: true });
        return;
      }
      if (action === "stopbot") {
        stopBot(userId, slotNum);
        await interaction.update({ embeds: [buildSlotEmbed(userId, slotNum)], components: [slotControlRow1(userId, slotNum), slotControlRow2(userId, slotNum)] });
        return;
      }
      if (action === "restartbot") {
        restartBot(userId, slotNum, client);
        await interaction.update({ embeds: [buildSlotEmbed(userId, slotNum)], components: [slotControlRow1(userId, slotNum), slotControlRow2(userId, slotNum)] });
        await interaction.followUp({ content: `🔄 Slot ${slotNum} restarting...`, ephemeral: true });
        return;
      }
      if (action === "statusbot") {
        await interaction.update({ embeds: [buildSlotEmbed(userId, slotNum)], components: [slotControlRow1(userId, slotNum), slotControlRow2(userId, slotNum)] });
        return;
      }
      if (action === "delslot") {
        stopBot(userId, slotNum);
        deleteSlot(userId, slotNum);
        const rows = [mainRow(userId)];
        const menu = slotsSelectMenu(userId);
        if (menu) rows.push(menu);
        await interaction.update({ embeds: [buildSlotsEmbed(userId)], components: rows });
        await interaction.followUp({ content: `🗑 Slot ${slotNum} deleted.`, ephemeral: true });
        return;
      }
    }

    // ── SELECT MENU ──────────────────────────────────────────────────────────────
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith("slotmenu_")) {
        const userId  = interaction.customId.replace("slotmenu_", "");
        if (userId !== interaction.user.id) { await interaction.reply({ content: "❌ Not your panel!", ephemeral: true }); return; }
        const value   = interaction.values[0];
        const slotNum = value.split("_")[2];
        await interaction.update({ embeds: [buildSlotEmbed(userId, slotNum)], components: [slotControlRow1(userId, slotNum), slotControlRow2(userId, slotNum)] });
        return;
      }
    }

    // ── MODALS ───────────────────────────────────────────────────────────────────
    if (interaction.type === InteractionType.ModalSubmit) {
      if (interaction.customId.startsWith("modal_")) {
        const [, userId, slotNum] = interaction.customId.split("_");
        if (userId !== interaction.user.id) { await interaction.reply({ content: "❌ Not your panel!", ephemeral: true }); return; }
        const host     = interaction.fields.getTextInputValue("host").trim();
        const port     = parseInt(interaction.fields.getTextInputValue("port").trim() || "25565");
        const version  = interaction.fields.getTextInputValue("version").trim() || "auto";
        const username = interaction.fields.getTextInputValue("username").trim();
        const password = interaction.fields.getTextInputValue("password").trim() || null;
        if (!host || !username) { await interaction.reply({ content: "❌ Host and Username required!", ephemeral: true }); return; }
        setSlot(userId, slotNum, { host, port, version, username, password, registered: true, discordTag: interaction.user.tag });
        await interaction.reply({
          content: `✅ **Slot ${slotNum} Registered!**\n\n🖥 \`${host}:${port}\` | 👤 \`${username}\` | 📌 \`${version === "auto" ? "auto-detect" : version}\`\n\nClick **▶ Start** to launch!`,
          embeds: [buildSlotEmbed(userId, slotNum)],
          components: [slotControlRow1(userId, slotNum), slotControlRow2(userId, slotNum)],
          ephemeral: true,
        });
        return;
      }
    }
  });

  await client.login(token);
}
