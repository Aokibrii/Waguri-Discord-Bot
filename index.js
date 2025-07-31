import { readFileSync, writeFileSync } from "fs";
import { URLSearchParams } from "url";
import { setTimeout as wait } from "timers/promises";
import os from "os";
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  Colors,
  PermissionFlagsBits,
  ApplicationCommandType,
  ActivityType,
  WebhookClient,
  version as djsVersion,
} from "discord.js";
import fetch from "node-fetch";

// — Constants & Config —
const EPHEMERAL = 1 << 6;
const PREFIX = "!";
const ITEMS_PER_PAGE = 10;
const WEBHOOK_AVATAR = "https://i.ibb.co/tPM4VQ8P/jpg.jpg";
const EMBED_IMAGE_URL = "https://i.postimg.cc/G485VPvY/IMG-1273.png";

// URL for dynamic weather icons
const WEATHER_IMAGE_API_URL = "https://api.joshlei.com/v2/growagarden/image";

// — JSON Helpers —
function loadJSON(path, def = {}) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return def;
  }
}
function saveJSON(path, data) {
  try {
    writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  } catch {}
}

// — Load Config & Data —
const cfg = loadJSON("./config.json");
const {
  DISCORD_BOT_TOKEN,
  STOCK_API_URL,
  WEATHER_API_URL,
  CALCULATE_API_URL,
  INFO_API_URL,
  CURRENT_EVENT_API_URL = "https://api.joshlei.com/v2/growagarden/currentevent",
  INVITE_URL,
  EMOJI_MAPPING_FILE,
  ROLE_CONFIG_FILE,
  STOCK_CATEGORY_FILE,
  COLOR_MAPPING_FILE,
  THUMBNAILS_FILE,
  CATEGORY_ROLE_FILE,
  ROLE_OP_DELAY = 1.0,
  MAX_ROLE_RETRIES = 3,
  WEBHOOK_USERNAMES = { Waguri: "Waguri Bot", default: "GAG Bot" },
  BOT_OWNER_ID = "965809871486353430",
} = cfg;

const ITEM_ROLES = loadJSON("./item_roles.json", []);
const EMOJI_MAP_RAW = loadJSON(EMOJI_MAPPING_FILE, {});
const ROLE_CONFIG = loadJSON(ROLE_CONFIG_FILE, {});
const STOCK_CATEGORY = loadJSON(STOCK_CATEGORY_FILE, {});
const COLOR_MAPPING_RAW = loadJSON(COLOR_MAPPING_FILE, {});
const THUMBNAILS = loadJSON(THUMBNAILS_FILE, {});
const CATEGORY_ROLE_MAP = loadJSON(CATEGORY_ROLE_FILE, {});

const CHANNELS_FILE = "channels.json";
const ROLES_FILE = "roles.json";
const LAST_STATE_FILE = "last_state.json";
const WEBHOOKS_FILE = "webhooks.json";
let channelsData = loadJSON(CHANNELS_FILE, {});
let rolesData = loadJSON(ROLES_FILE, {});
let lastState = loadJSON(LAST_STATE_FILE, {});
let webhooksData = loadJSON(WEBHOOKS_FILE, {});

function saveAll() {
  saveJSON(CHANNELS_FILE, channelsData);
  saveJSON(ROLES_FILE, rolesData);
  saveJSON(LAST_STATE_FILE, lastState);
  saveJSON(WEBHOOKS_FILE, webhooksData);
}

// — Discord Client —
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});
let isChecking = false;

// — Utilities —
function normalizeKey(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/(^_|_$)/g, "");
}
const EMOJI_MAPPING = Object.fromEntries(
  Object.entries(EMOJI_MAP_RAW).map(([rawName, emoji]) => {
    const key = normalizeKey(rawName.trim());
    return [key, emoji];
  })
);
function getEmojiByKey(key) {
  return EMOJI_MAPPING[key] || "";
}

function getWebhookUsername(type) {
  return WEBHOOK_USERNAMES[type] || WEBHOOK_USERNAMES.default || "GAG Bot";
}

function isOwner(userId) {
  return BOT_OWNER_ID && userId === BOT_OWNER_ID;
}

const COLOR_MAPPING = {};
for (const [k, v] of Object.entries(COLOR_MAPPING_RAW)) {
  if (typeof v === "string")
    COLOR_MAPPING[k] = parseInt(v.replace("#", ""), 16);
  else if (v?.r != null) COLOR_MAPPING[k] = (v.r << 16) | (v.g << 8) | v.b;
  else if (typeof v === "number") COLOR_MAPPING[k] = v;
  else COLOR_MAPPING[k] = Colors.White;
}

function logCommand(name, start) {
  console.log(
    `[${new Date().toISOString()}] ${name} responded in ${Date.now() - start}ms`
  );
}

function createInviteView() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Invite Bot")
      .setURL(INVITE_URL)
      .setStyle(ButtonStyle.Link)
  );
}

function relativeTimestampField() {
  const now = Math.floor(Date.now() / 1000);
  return { name: "\u200b", value: `<t:${now}:R>\n<t:${now}:f>`, inline: false };
}

// — Embed Creators —
function createStockEmbed(items, title) {
  const lines = items
    .map((i) => {
      const txt =
        i.quantity > 1 ? `${i.display_name} x${i.quantity}` : i.display_name;
      const emoji = getEmojiByKey(normalizeKey(i.display_name.trim()));
      return emoji ? `${emoji} ${txt}` : txt;
    })
    .join("\n");
  return new EmbedBuilder()
    .setTitle(`${title}`)
    .setDescription(lines)
    .setColor(COLOR_MAPPING[title] || Colors.White)
    .setThumbnail(THUMBNAILS[title] || null)
    .addFields(relativeTimestampField())
    .setImage(EMBED_IMAGE_URL);
}

function createEggEmbed(items, title) {
  const counts = items.reduce(
    (a, i) => (
      (a[i.display_name] = (a[i.display_name] || 0) + (i.quantity || 1)), a
    ),
    {}
  );
  const lines = Object.entries(counts)
    .map(([n, q]) => {
      const txt = q > 1 ? `${n} x${q}` : n;
      const emoji = getEmojiByKey(normalizeKey(n.trim()));
      return emoji ? `${emoji} ${txt}` : txt;
    })
    .join("\n");
  return new EmbedBuilder()
    .setTitle(`${title}`)
    .setDescription(lines)
    .setColor(COLOR_MAPPING[title] || Colors.White)
    .setThumbnail(THUMBNAILS[title] || null)
    .addFields(relativeTimestampField())
    .setImage(EMBED_IMAGE_URL);
}

function createAnnouncementEmbed(note) {
  return new EmbedBuilder()
    .setTitle(" Announcement")
    .setDescription(note.message || "")
    .setColor(COLOR_MAPPING["Announcement 📢"] || Colors.Blue)
    .setThumbnail(THUMBNAILS["Announcement 📢"] || null)
    .addFields(relativeTimestampField())
    .setImage(EMBED_IMAGE_URL);
}

function createWeatherEmbed(w, desc) {
  const key = normalizeKey(w.weather_name.trim());
  const emoji = getEmojiByKey(key);
  const nowTs = Math.floor(Date.now() / 1000);
  const endTs = (w.start_duration_unix || nowTs) + w.duration;
  return new EmbedBuilder()
    .setTitle(`${emoji} ${w.weather_name}`)
    .setDescription(`Status: Active\n${desc}`)
    .setColor(COLOR_MAPPING.Weather || Colors.Blue)
    .setThumbnail(
      `${WEATHER_IMAGE_API_URL}/${encodeURIComponent(w.weather_id)}`
    )
    .addFields(
      {
        name: "\u200b",
        value: `<t:${nowTs}:R>\n<t:${nowTs}:f>`,
        inline: false,
      },
      { name: "Duration", value: `ends <t:${endTs}:R>`, inline: false }
    )
    .setImage(EMBED_IMAGE_URL);
}

function createCurrentEventEmbed(curr) {
  const now = new Date();
  let d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(curr.start.minute);
  if (d < now) d.setHours(d.getHours() + 1);
  const unix = Math.floor(d.getTime() / 1000);
  return new EmbedBuilder()
    .setTitle(`🌟 Event: ${curr.name}`)
    .setDescription(`**Starts:** <t:${unix}:R>`)
    .setColor(Colors.Gold)
    .setThumbnail(curr.icon || EMBED_IMAGE_URL)
    .addFields(relativeTimestampField())
    .setImage(EMBED_IMAGE_URL);
}

function createMerchantEmbed(merchantName, items) {
  const lines = items
    .map((i) => {
      const txt =
        i.quantity > 1 ? `${i.display_name} x${i.quantity}` : i.display_name;
      const emoji = getEmojiByKey(normalizeKey(i.display_name.trim()));
      return emoji ? `${emoji} ${txt}` : txt;
    })
    .join("\n");
  return new EmbedBuilder()
    .setTitle(` ${merchantName}`)
    .setDescription(lines)
    .setColor(COLOR_MAPPING["Jandel Announcement"] || Colors.Orange)
    .setThumbnail(THUMBNAILS["Jandel Announcement"] || null)
    .addFields(relativeTimestampField())
    .setImage(EMBED_IMAGE_URL);
}

// — Fetch Helpers —
async function fetchJson(url, params = null, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const headers = {
        "Jstudio-key":
          "js_4b95c27582b5bd6b6b2f286ca492cd0be41ec64823caa55a107d574e133c92cb",
      };
      const opts = { method: params ? "POST" : "GET", headers };
      if (params) {
        headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(params);
      }
      const res = await fetch(url, opts);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      if (i < retries - 1) await wait(2000 * (i + 1));
    }
  }
  return null;
}

const fetchStockData = () => fetchJson(STOCK_API_URL);
const fetchWeatherData = () => fetchJson(WEATHER_API_URL);
const fetchInfoData = () => fetchJson(INFO_API_URL);
const fetchEventData = () => fetchJson(CURRENT_EVENT_API_URL);
async function fetchCalculate(params) {
  try {
    const qs = new URLSearchParams();
    if (params.Name) qs.set("Name", params.Name);
    if (params.Weight != null) qs.set("Weight", params.Weight);
    if (params.Variant) qs.set("Variant", params.Variant);
    if (params.Mutation) qs.set("Mutation", params.Mutation);
    const res = await fetch(
      CALCULATE_API_URL + (qs.toString() ? `?${qs}` : ""),
      {
        headers: {
          "JStudio-key":
            "js_4b95c27582b5bd6b6b2f286ca492cd0be41ec64823caa55a107d574e133c92cb",
        },
      }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// — Role Creation Retry —
async function createRoleWithRetry(guild, { name, color, skipDelay = false }) {
  for (let attempt = 1; attempt <= MAX_ROLE_RETRIES; attempt++) {
    try {
      if (!skipDelay) await wait(ROLE_OP_DELAY * 1000 * (Math.random() + 0.5));
      const resolved =
        typeof color === "string"
          ? parseInt(color.replace("#", ""), 16)
          : color?.r != null
          ? (color.r << 16) | (color.g << 8) | color.b
          : typeof color === "number"
          ? color
          : Colors.Blurple;
      return await guild.roles.create({
        name,
        color: resolved,
        mentionable: true,
        reason: "Setup",
      });
    } catch (err) {
      if (err.code === 50035 && attempt < MAX_ROLE_RETRIES) {
        await wait(2 ** attempt * 1000 + Math.random() * 1000);
      }
    }
  }
  return null;
}

// — Role panel paging —
const rolePanelPages = {};

// — MessageCreate: prefix commands —
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;
  const lc = msg.content.trim().toLowerCase();

  // — Manual push for Current Event —
  if (lc === `${PREFIX}setcurrentevent`) {
    if (!msg.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return msg.reply({ content: "🚫 Admin only.", flags: EPHEMERAL });
    }
    const ev = await fetchEventData();
    if (!ev?.current) {
      return msg.reply({ content: "❌ Could not fetch current event." });
    }
    const embed = createCurrentEventEmbed(ev.current);
    await msg.channel.send({
      embeds: [embed],
      components: [createInviteView()],
    });
    lastState.currentEvent = JSON.stringify(ev.current);
    saveAll();
    return;
  }

  // — Improved !stats command (Owner Only) —
  if (lc === `${PREFIX}stats`) {
    if (!isOwner(msg.author.id)) {
      return msg.reply({ content: "🚫 Owner only command.", flags: EPHEMERAL });
    }
    const start = Date.now();
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const uptimeSec = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSec / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const seconds = uptimeSec % 60;

    const embed = new EmbedBuilder()
      .setTitle("🔧 Bot Statistics")
      .setColor(Colors.Blurple)
      .addFields(
        {
          name: "🧠 Memory Usage",
          value: `RSS: ${(mem.rss / 1024 / 1024).toFixed(2)} MB\nHeap: ${(
            mem.heapUsed /
            1024 /
            1024
          ).toFixed(2)} / ${(mem.heapTotal / 1024 / 1024).toFixed(2)} MB`,
          inline: true,
        },
        {
          name: "💾 CPU Usage",
          value: `User: ${(cpu.user / 1000).toFixed(2)} ms\nSystem: ${(
            cpu.system / 1000
          ).toFixed(2)} ms`,
          inline: true,
        },
        {
          name: "⏱️ Uptime",
          value: `${hours}h ${minutes}m ${seconds}s`,
          inline: true,
        },
        {
          name: "📶 WS Ping",
          value: `${Math.round(client.ws.ping)} ms`,
          inline: true,
        },
        {
          name: "📍 Platform",
          value: `${os.type()} ${os.platform()} ${os.arch()}`,
          inline: true,
        },
        {
          name: "🤖 Servers",
          value: `${client.guilds.cache.size}`,
          inline: true,
        },
        {
          name: "⚙️ Versions",
          value: `Node.js ${process.version}\ndiscord.js ${djsVersion}`,
          inline: true,
        },
        {
          name: "👤 Owner",
          value: `<@${BOT_OWNER_ID}>`,
          inline: true,
        }
      )
      .setTimestamp();

    await msg.reply({ embeds: [embed] });
    logCommand("!stats", start);
    return;
  }

  if (lc === `${PREFIX}ping`) {
    if (!isOwner(msg.author.id)) {
      return msg.reply({ content: "🚫 Owner only command.", flags: EPHEMERAL });
    }
    const start = Date.now();
    await msg.reply(`🏓 Pong! WS ping: ${Math.round(client.ws.ping)}ms`);
    logCommand("!ping", start);
    return;
  }

  if (lc === `${PREFIX}shutdown`) {
    if (!isOwner(msg.author.id)) {
      return msg.reply({ content: "🚫 Owner only command.", flags: EPHEMERAL });
    }
    await msg.reply("🔌 Shutting down bot...");
    console.log(`Bot shutdown initiated by owner: ${msg.author.tag}`);
    process.exit(0);
  }

  if (lc === `${PREFIX}help`) {
    const embed = new EmbedBuilder()
      .setTitle("🤖 Bot Commands")
      .setColor(Colors.Blurple)
      .addFields(
        {
          name: "🔧 Owner/Debug Commands",
          value:
            "`!ping` - Check bot ping (Owner)\n`!stats` - Bot statistics (Owner)\n`!shutdown` - Shutdown bot (Owner)\n`!help` - Show this help menu",
          inline: true,
        },
        {
          name: "🌟 Public Commands",
          value:
            "`/guilds` - Server count\n`/calculate` - Calculate fruit prices",
          inline: true,
        },
        {
          name: "🎯 Role Management",
          value: "`!rolepanel` - Interactive role panel",
          inline: true,
        },
        {
          name: "⚙️ Initial Setup (Admin)",
          value:
            "`/setup-roles` - Create notification roles\n`/setup-webhook` - Configure webhooks",
          inline: true,
        },
        {
          name: "📡 Channel Setup",
          value:
            "`/setseed` `/setgear` `/setcosmetic`\n`/seteventstock` `/setegg` `/setannounce`\n`/setweather` `/setmerchant` `/setcurrentevent`",
          inline: true,
        },
        {
          name: "🔧 Advanced Admin",
          value:
            "`/edit-webhook` - Edit webhook properties\n`/set-bot-name` - Change bot display names\n`/ping-role` - Ping specific item roles\n`/list-items` - Show available items\n`/remove-roles` - Remove created roles",
          inline: true,
        }
      )
      .setFooter({ text: "Waguri • Bot | Grow A Garden Notifications" })
      .setTimestamp();

    await msg.reply({ embeds: [embed] });
    return;
  }

  if (lc === `${PREFIX}rolepanel`) {
    if (!msg.member.permissions.has(PermissionFlagsBits.Administrator))
      return msg.reply({ content: "🚫 Admin only.", flags: EPHEMERAL });
    await msg.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("🎉 Role Panel")
          .setDescription('Click "Get Role"')
          .setColor(Colors.Blurple),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("open_role_panel")
            .setLabel("Get Role")
            .setStyle(ButtonStyle.Primary)
        ),
      ],
    });
    return;
  }
});

// — Main checkAll() (no current-event) —
async function checkAll() {
  if (isChecking) return;
  isChecking = true;
  try {
    const [stockAll, wd, infoData] = await Promise.all([
      fetchStockData(),
      fetchWeatherData(),
      fetchInfoData(),
    ]);

    // — Stock & Announcement notifications —
    if (stockAll) {
      const nowTs = Math.floor(Date.now() / 1000);

      for (const [key, [apiKey, title]] of Object.entries(STOCK_CATEGORY)) {
        const items = stockAll[apiKey] || [];
        const json = JSON.stringify(items);
        if (json === lastState[apiKey]) continue;
        lastState[apiKey] = json;
        if (!items.length) continue;

        // skip if expired (for stock types)
        if (key !== "announcement") {
          const et = Math.max(...items.map((i) => i.end_date_unix || 0));
          if (et < nowTs) continue;
        }

        // choose embed
        let embed;
        if (key === "egg") {
          embed = createEggEmbed(items, title);
        } else if (key === "announcement") {
          embed = createAnnouncementEmbed(items[0]);
        } else {
          embed = createStockEmbed(items, title);
        }

        for (const [gId, chs] of Object.entries(channelsData)) {
          const channelId = chs[`${key}_channel_id`];
          const ch = client.channels.cache.get(channelId);
          if (!ch) continue;

          // category role ping
          const pings = [];
          if (rolesData[gId]?.[key]) {
            pings.push(`<@&${rolesData[gId][key]}>`);
          }
          // item-specific role pings
          for (const item of items) {
            const iKey = normalizeKey(item.display_name.trim());
            if (rolesData[gId]?.[iKey]) {
              pings.push(`<@&${rolesData[gId][iKey]}>`);
            }
          }

          const content = pings.length ? pings.join(" ") : undefined;
          const hook = webhooksData[gId]?.[key];
          const payload = {
            content,
            embeds: [embed],
            components: [createInviteView()],
            username: getWebhookUsername(key),
            avatarURL: WEBHOOK_AVATAR,
            allowedMentions: { parse: ["roles"] },
          };

          if (hook) {
            await new WebhookClient(hook).send(payload);
          } else {
            await ch.send(payload);
          }
        }
      }
    }

    // — Weather —
    if (wd?.weather) {
      const active = wd.weather.filter((w) => w.active);
      const json = JSON.stringify(active);
      if (json !== lastState.weather) {
        lastState.weather = json;
        const nowTs = Math.floor(Date.now() / 1000);
        for (const w of active) {
          const et = w.end_duration_unix || w.start_duration_unix + w.duration;
          if (et < nowTs) continue;
          const desc =
            infoData.find((i) => i.item_id === w.weather_id)?.description ||
            "No description";
          const eb = createWeatherEmbed(w, desc);

          for (const [gId, chs] of Object.entries(channelsData)) {
            const ch = client.channels.cache.get(chs.weather_channel_id);
            if (!ch) continue;

            const pings = [];
            if (rolesData[gId]?.weather)
              pings.push(`<@&${rolesData[gId].weather}>`);
            const wid = normalizeKey(w.weather_name.trim());
            if (rolesData[gId]?.[wid]) pings.push(`<@&${rolesData[gId][wid]}>`);
            const content = pings.join(" ") || undefined;
            const hook = webhooksData[gId]?.weather;
            const payload = {
              content,
              embeds: [eb],
              components: [createInviteView()],
              username: getWebhookUsername("weather"),
              avatarURL: WEBHOOK_AVATAR,
              allowedMentions: { parse: ["roles"] },
            };

            if (hook) {
              await new WebhookClient(hook).send(payload);
            } else {
              await ch.send(payload);
            }
          }
        }
      }
    }

    // — Traveling Merchant —
    if (stockAll?.travelingmerchant_stock?.stock.length) {
      const tm = stockAll.travelingmerchant_stock;
      const json = JSON.stringify(tm);
      if (json !== lastState.tm) {
        lastState.tm = json;
        const nowTs = Math.floor(Date.now() / 1000);
        const items = tm.stock;
        const et = Math.max(...items.map((i) => i.end_date_unix || 0));
        if (et >= nowTs) {
          const eb = createMerchantEmbed(tm.merchantName, items);

          for (const [gId, chs] of Object.entries(channelsData)) {
            const ch = client.channels.cache.get(chs.merchant_channel_id);
            if (!ch) continue;

            const pings = [];
            if (rolesData[gId]?.jandel)
              pings.push(`<@&${rolesData[gId].jandel}>`);
            for (const item of items) {
              const iKey = normalizeKey(item.display_name.trim());
              if (rolesData[gId]?.[iKey]) {
                pings.push(`<@&${rolesData[gId][iKey]}>`);
              }
            }

            const content = pings.length ? pings.join(" ") : undefined;
            const hook = webhooksData[gId]?.jandel;
            const payload = {
              content,
              embeds: [eb],
              components: [createInviteView()],
              username: getWebhookUsername("jandel"),
              avatarURL: WEBHOOK_AVATAR,
              allowedMentions: { parse: ["roles"] },
            };

            if (hook) {
              await new WebhookClient(hook).send(payload);
            } else {
              await ch.send(payload);
            }
          }
        }
      }
    }

    saveAll();
  } catch (err) {
    console.error("checkAll error:", err);
  } finally {
    isChecking = false;
  }
}

// — Current Event Scheduler —
let nextEventTs = null;

async function checkCurrentEvent() {
  const nowTs = Math.floor(Date.now() / 1000);

  if (nextEventTs === null) {
    const ev = await fetchEventData();
    if (ev?.current) {
      const now = new Date();
      let d = new Date(now);
      d.setSeconds(0, 0);
      d.setMinutes(ev.current.start.minute);
      if (d < now) d.setHours(d.getHours() + 1);
      nextEventTs = Math.floor(d.getTime() / 1000);
    }
    return;
  }

  if (nowTs >= nextEventTs) {
    const ev = await fetchEventData();
    if (ev?.current) {
      const embed = createCurrentEventEmbed(ev.current);
      for (const [gId, chs] of Object.entries(channelsData)) {
        const ch = client.channels.cache.get(chs.current_event_channel_id);
        if (!ch) continue;
        const hook = webhooksData[gId]?.currentevent;
        const payload = {
          embeds: [embed],
          components: [createInviteView()],
          username: getWebhookUsername("currentevent"),
          avatarURL: WEBHOOK_AVATAR,
          allowedMentions: { parse: ["roles"] },
        };
        if (hook) {
          await new WebhookClient(hook).send(payload);
        } else {
          await ch.send(payload);
        }
      }
      const now = new Date();
      let d = new Date(now);
      d.setSeconds(0, 0);
      d.setMinutes(ev.current.start.minute);
      if (d < now) d.setHours(d.getHours() + 1);
      nextEventTs = Math.floor(d.getTime() / 1000);
    }
  }
}

// — Interaction Handler —
async function interactionHandler(i) {
  try {
    if (i.isChatInputCommand()) {
      const start = Date.now(),
        guild = i.guild;
      if (!guild)
        return i.reply({ content: "💥 Must be in a guild.", flags: EPHEMERAL });

      // /setup-roles
      if (i.commandName === "setup-roles") {
        if (!i.member.permissions.has(PermissionFlagsBits.Administrator))
          return i.reply({ content: "🚫 Admin only.", flags: EPHEMERAL });
        await i.deferReply({ flags: EPHEMERAL });
        const gid = guild.id;
        rolesData[gid] = rolesData[gid] || {};
        const createdN = [],
          existedN = [];
        for (const [key, name] of Object.entries(ROLE_CONFIG)) {
          const dn = typeof name === "object" && name.name ? name.name : name;
          if (rolesData[gid][key]) existedN.push(dn);
          else {
            const r = await createRoleWithRetry(guild, {
              name: dn,
              color: Colors.Blurple,
            });
            if (r) {
              rolesData[gid][key] = r.id;
              createdN.push(dn);
            }
          }
        }
        const createdI = [],
          existedI = [];
        for (const item of ITEM_ROLES) {
          const key = normalizeKey(item.trim());
          if (rolesData[gid][key]) existedI.push(item);
          else {
            const r = await createRoleWithRetry(guild, {
              name: item,
              color: Colors.Green,
            });
            if (r) {
              rolesData[gid][key] = r.id;
              createdI.push(item);
            }
          }
        }
        saveAll();
        const em = new EmbedBuilder()
          .setTitle("Setup Roles")
          .setColor(Colors.Green);
        if (createdN.length)
          em.addFields({
            name: "✅ Notification Roles Created",
            value: createdN.join("\n"),
          });
        if (existedN.length)
          em.addFields({
            name: "ℹ️ Notification Roles Already Existed",
            value: existedN.join("\n"),
          });
        if (createdI.length)
          em.addFields({
            name: "✅ Item Roles Created",
            value: createdI.join("\n"),
          });
        if (existedI.length)
          em.addFields({
            name: "ℹ️ Item Roles Already Existed",
            value: existedI.join("\n"),
          });
        if (
          !createdN.length &&
          !existedN.length &&
          !createdI.length &&
          !existedI.length
        )
          em.setDescription("⚠️ No roles to create.");
        await i.editReply({ embeds: [em] });
        logCommand("/setup-roles", start);
        return;
      }

      // /guilds
      if (i.commandName === "guilds") {
        await i.reply({
          content: `🤖 I'm in ${client.guilds.cache.size} servers!`,
          flags: EPHEMERAL,
        });
        logCommand("/guilds", start);
        return;
      }

      // /calculate
      if (i.commandName === "calculate") {
        const params = {};
        if (i.options.get("name")) params.Name = i.options.getString("name");
        if (i.options.get("weight"))
          params.Weight = i.options.getNumber("weight");
        if (i.options.get("variant"))
          params.Variant = i.options.getString("variant");
        if (i.options.get("mutation"))
          params.Mutation = i.options.getString("mutation");
        await i.deferReply();
        const res = await fetchCalculate(params);
        const fruit = params.Name || "Fruit";
        const fKey = normalizeKey(fruit.trim());
        const fEmoji = getEmojiByKey(fKey) || "";
        const em = new EmbedBuilder()
          .setTitle(`${fEmoji} ${fruit}`)
          .setColor(Colors.Gold);
        if (res && typeof res === "object") {
          em.addFields(
            { name: "Name", value: params.Name || "N/A", inline: true },
            {
              name: "⚖️ Weight",
              value: `${params.Weight || 0} kg`,
              inline: true,
            },
            { name: "✨ Variant", value: res.Variant || "N/A", inline: true },
            { name: "🦠 Mutation", value: res.Mutation || "N/A", inline: true },
            {
              name: "🪙 Value",
              value: res.value != null ? res.value.toLocaleString() : "N/A",
              inline: true,
            }
          );
        } else {
          em.setDescription("❌ Calculation failed.");
        }
        await i.editReply({ embeds: [em] });
        logCommand("/calculate", start);
        return;
      }

      // /setup-webhook
      if (i.commandName === "setup-webhook") {
        if (!i.member.permissions.has(PermissionFlagsBits.Administrator))
          return i.reply({ content: "🚫 Admin only.", flags: EPHEMERAL });
        await i.deferReply({ flags: EPHEMERAL });
        const em = new EmbedBuilder()
          .setTitle("Channel Configuration")
          .setColor(Colors.Blurple)
          .addFields(
            {
              name: "Seed Stock",
              value: webhooksData[i.guild.id]?.seed ? "✅ Set" : "❌ Not Set",
              inline: true,
            },
            {
              name: "Gear Stock",
              value: webhooksData[i.guild.id]?.gear ? "✅ Set" : "❌ Not Set",
              inline: true,
            },
            {
              name: "Cosmetic Stock",
              value: webhooksData[i.guild.id]?.cosmetic
                ? "✅ Set"
                : "❌ Not Set",
              inline: true,
            },
            {
              name: "Egg Stock",
              value: webhooksData[i.guild.id]?.egg ? "✅ Set" : "❌ Not Set",
              inline: true,
            },
            {
              name: "Event Shop",
              value: webhooksData[i.guild.id]?.eventshop
                ? "✅ Set"
                : "❌ Not Set",
              inline: true,
            },
            {
              name: "Announcement",
              value: webhooksData[i.guild.id]?.announcement
                ? "✅ Set"
                : "❌ Not Set",
              inline: true,
            },
            {
              name: "Weather Change",
              value: webhooksData[i.guild.id]?.weather
                ? "✅ Set"
                : "❌ Not Set",
              inline: true,
            },
            {
              name: "Merchant Notification",
              value: webhooksData[i.guild.id]?.jandel ? "✅ Set" : "❌ Not Set",
              inline: true,
            }
          );
        const row1 = new ActionRowBuilder().addComponents(
          ["seed", "gear", "cosmetic", "eventshop", "egg"].map((type) =>
            new ButtonBuilder()
              .setCustomId(`setup_webhook:${type}`)
              .setLabel(type.charAt(0).toUpperCase() + type.slice(1))
              .setStyle(ButtonStyle.Primary)
          )
        );
        const row2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("setup_webhook:announcement")
            .setLabel("Announcement")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId("setup_webhook:weather")
            .setLabel("Weather")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId("setup_webhook:jandel")
            .setLabel("Merchant")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId("remove_all_webhooks")
            .setLabel("Remove All")
            .setStyle(ButtonStyle.Danger)
        );
        await i.editReply({ embeds: [em], components: [row1, row2] });
        logCommand("/setup-webhook", start);
        return;
      }

      // Channel setup slash commands
      const channelSetupCommands = {
        setseed: "seed_channel_id",
        setgear: "gear_channel_id",
        setcosmetic: "cosmetic_channel_id",
        seteventstock: "eventshop_channel_id",
        setegg: "egg_channel_id",
        setweather: "weather_channel_id",
        setmerchant: "merchant_channel_id",
        setannounce: "announcement_channel_id",
        setcurrentevent: "current_event_channel_id",
      };

      if (channelSetupCommands[i.commandName]) {
        const channelType = channelSetupCommands[i.commandName];
        channelsData[i.guild.id] = channelsData[i.guild.id] || {};
        channelsData[i.guild.id][channelType] = i.channel.id;
        saveAll();
        await i.reply({
          content: `✅ Channel set to <#${i.channel.id}>`,
          flags: EPHEMERAL,
        });
        await checkAll();
        return;
      }

      // /edit-webhook
      if (i.commandName === "edit-webhook") {
        if (!i.member.permissions.has(PermissionFlagsBits.Administrator))
          return i.reply({ content: "🚫 Admin only.", flags: EPHEMERAL });

        const type = i.options.getString("type");
        const newName = i.options.getString("name");
        const newAvatar = i.options.getString("avatar");
        const newChannel = i.options.getChannel("channel");

        if (!webhooksData[i.guild.id]?.[type]) {
          return i.reply({
            content: `❌ No webhook found for ${type}. Use /setup-webhook first.`,
            flags: EPHEMERAL,
          });
        }

        await i.deferReply({ flags: EPHEMERAL });

        try {
          const webhookData = webhooksData[i.guild.id][type];
          const webhook = new WebhookClient({
            id: webhookData.id,
            token: webhookData.token,
          });

          const updateData = {};

          if (newName) updateData.name = newName;
          if (newChannel) updateData.channel = newChannel.id;

          // Handle avatar - fetch the image if URL provided
          if (newAvatar) {
            try {
              const response = await fetch(newAvatar);
              if (response.ok) {
                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                updateData.avatar = buffer;
              } else {
                return i.editReply({
                  content:
                    "❌ Failed to fetch avatar image. Please check the URL.",
                });
              }
            } catch {
              return i.editReply({ content: "❌ Invalid avatar URL." });
            }
          }

          if (Object.keys(updateData).length === 0) {
            return i.editReply({
              content:
                "❌ Please specify at least one property to edit (name, avatar, or channel).",
            });
          }

          const editedWebhook = await webhook.edit(updateData);

          // Update stored data if channel changed
          if (newChannel) {
            webhooksData[i.guild.id][type].channelId = newChannel.id;
            saveAll();
          }

          let changes = [];
          if (newName) changes.push(`Name: ${newName}`);
          if (newAvatar) changes.push(`Avatar: Updated`);
          if (newChannel) changes.push(`Channel: <#${newChannel.id}>`);

          await i.editReply({
            content: `✅ Webhook for **${type}** updated successfully!\n${changes.join(
              "\n"
            )}`,
          });
        } catch (error) {
          console.error("Webhook edit error:", error);
          await i.editReply({
            content:
              "❌ Failed to edit webhook. Please check permissions and try again.",
          });
        }

        return;
      }

      // /set-bot-name
      if (i.commandName === "set-bot-name") {
        if (!i.member.permissions.has(PermissionFlagsBits.Administrator))
          return i.reply({ content: "🚫 Admin only.", flags: EPHEMERAL });

        const type = i.options.getString("type");
        const newName = i.options.getString("name");

        // Update the runtime config
        WEBHOOK_USERNAMES[type] = newName;

        // Save to config file
        const currentConfig = loadJSON("./config.json", {});
        currentConfig.WEBHOOK_USERNAMES = currentConfig.WEBHOOK_USERNAMES || {};
        currentConfig.WEBHOOK_USERNAMES[type] = newName;
        saveJSON("./config.json", currentConfig);

        await i.reply({
          content: `✅ Bot name for **${type}** notifications set to: **${newName}**`,
          flags: EPHEMERAL,
        });

        return;
      }

      // /ping-role
      if (i.commandName === "ping-role") {
        if (!i.member.permissions.has(PermissionFlagsBits.Administrator))
          return i.reply({ content: "🚫 Admin only.", flags: EPHEMERAL });

        const itemName = i.options.getString("item").toLowerCase().trim();
        const message = i.options.getString("message");

        // Normalize the item name to match our key format
        const itemKey = normalizeKey(itemName);

        // Check if the item exists in our ITEM_ROLES list
        const itemExists = ITEM_ROLES.some(
          (item) => normalizeKey(item) === itemKey
        );

        if (!itemExists) {
          return i.reply({
            content: `❌ Item "${itemName}" not found in the item roles list.\n\n**Available items:** ${ITEM_ROLES.slice(
              0,
              10
            ).join(", ")}${
              ITEM_ROLES.length > 10
                ? `, and ${ITEM_ROLES.length - 10} more...`
                : ""
            }`,
            flags: EPHEMERAL,
          });
        }

        // Get the role ID for this item in this guild
        const roleId = rolesData[i.guild.id]?.[itemKey];

        if (!roleId) {
          return i.reply({
            content: `❌ Role for "${itemName}" not found. Use \`/setup-roles\` first to create item roles.`,
            flags: EPHEMERAL,
          });
        }

        // Check if the role exists in Discord
        const role = i.guild.roles.cache.get(roleId);

        if (!role) {
          return i.reply({
            content: `❌ Role for "${itemName}" no longer exists in Discord. Use \`/setup-roles\` to recreate it.`,
            flags: EPHEMERAL,
          });
        }

        // Get emoji for the item
        const emoji = getEmojiByKey(itemKey);

        // Create the ping message
        let pingContent = `${emoji} <@&${roleId}>`;
        if (message) {
          pingContent += `\n**Message:** ${message}`;
        }

        // Send the ping
        await i.reply({
          content: `✅ Pinging ${role.name} role...`,
          flags: EPHEMERAL,
        });

        await i.followUp({
          content: pingContent,
          allowedMentions: { parse: ["roles"] },
        });

        return;
      }

      // /list-items
      if (i.commandName === "list-items") {
        if (!i.member.permissions.has(PermissionFlagsBits.Administrator))
          return i.reply({ content: "🚫 Admin only.", flags: EPHEMERAL });

        const category = i.options.getString("category") || "all";

        // Define categories
        const seeds = ITEM_ROLES.slice(0, 18); // watermelon to elderstrawberry
        const gear = ITEM_ROLES.slice(18, 33); // mastersprinkler to leveluplollipop
        const eggs = ITEM_ROLES.slice(33, 44); // common_egg to bee_egg
        const weather = ITEM_ROLES.slice(44); // meteorshower onwards

        let items = [];
        let title = "";
        let color = Colors.Blurple;

        switch (category) {
          case "seeds":
            items = seeds;
            title = "🌱 Seeds/Plants";
            color = Colors.Green;
            break;
          case "gear":
            items = gear;
            title = "⚙️ Gear/Tools";
            color = Colors.Blue;
            break;
          case "eggs":
            items = eggs;
            title = "🥚 Eggs";
            color = Colors.Yellow;
            break;
          case "weather":
            items = weather;
            title = "🌦️ Weather Events";
            color = Colors.Purple;
            break;
          default:
            items = ITEM_ROLES;
            title = "📋 All Available Items";
            color = Colors.Blurple;
        }

        const embed = new EmbedBuilder()
          .setTitle(title)
          .setColor(color)
          .setDescription(
            `**Total: ${items.length} items**\n\nUse \`/ping-role item:itemname\` to ping any of these roles.`
          )
          .setFooter({ text: `Page 1 of ${Math.ceil(items.length / 20)}` })
          .setTimestamp();

        // Split items into chunks of 20 for fields
        const chunks = [];
        for (let i = 0; i < items.length; i += 20) {
          chunks.push(items.slice(i, i + 20));
        }

        // Add first chunk as fields (max 3 fields to stay within Discord limits)
        const fieldsToShow = Math.min(chunks.length, 3);
        for (let i = 0; i < fieldsToShow; i++) {
          const chunk = chunks[i];
          const fieldItems = chunk
            .map((item) => {
              const emoji = getEmojiByKey(normalizeKey(item));
              return emoji ? `${emoji} ${item}` : item;
            })
            .join("\n");

          embed.addFields({
            name: `Items ${i * 20 + 1}-${Math.min((i + 1) * 20, items.length)}`,
            value: fieldItems || "None",
            inline: true,
          });
        }

        // If there are more items, add a note
        if (items.length > 60) {
          embed.addFields({
            name: "\u200b",
            value: `*...and ${
              items.length - 60
            } more items. Use category filters to see specific groups.*`,
            inline: false,
          });
        }

        await i.reply({ embeds: [embed], flags: EPHEMERAL });
        return;
      }

      // /remove-roles
      if (i.commandName === "remove-roles") {
        if (!i.member.permissions.has(PermissionFlagsBits.Administrator))
          return i.reply({ content: "🚫 Admin only.", flags: EPHEMERAL });

        const type = i.options.getString("type");
        const confirm = i.options.getBoolean("confirm");

        if (!confirm) {
          return i.reply({
            content:
              "❌ You must set `confirm:True` to proceed with role deletion.",
            flags: EPHEMERAL,
          });
        }

        await i.deferReply({ flags: EPHEMERAL });

        const guild = i.guild;
        const guildRoles = rolesData[guild.id] || {};

        let deletedCount = 0;
        let errorCount = 0;
        let deletedRoles = [];
        let errorRoles = [];

        try {
          if (type === "notification" || type === "all") {
            // Remove notification roles
            for (const [key, roleData] of Object.entries(ROLE_CONFIG)) {
              const roleId = guildRoles[key];
              if (roleId) {
                try {
                  const role = guild.roles.cache.get(roleId);
                  if (role) {
                    await role.delete("Removed via /remove-roles command");
                    const roleName =
                      typeof roleData === "object" && roleData.name
                        ? roleData.name
                        : roleData;
                    deletedRoles.push(roleName);
                    deletedCount++;
                  }
                  delete rolesData[guild.id][key];
                } catch (error) {
                  errorCount++;
                  const roleName =
                    typeof roleData === "object" && roleData.name
                      ? roleData.name
                      : roleData;
                  errorRoles.push(roleName);
                }
                // Add delay to avoid rate limits
                await wait(ROLE_OP_DELAY * 500);
              }
            }
          }

          if (type === "item" || type === "all") {
            // Remove item roles
            for (const item of ITEM_ROLES) {
              const key = normalizeKey(item.trim());
              const roleId = guildRoles[key];
              if (roleId) {
                try {
                  const role = guild.roles.cache.get(roleId);
                  if (role) {
                    await role.delete("Removed via /remove-roles command");
                    deletedRoles.push(item);
                    deletedCount++;
                  }
                  delete rolesData[guild.id][key];
                } catch (error) {
                  errorCount++;
                  errorRoles.push(item);
                }
                // Add delay to avoid rate limits
                await wait(ROLE_OP_DELAY * 500);
              }
            }
          }

          saveAll();

          const embed = new EmbedBuilder()
            .setTitle("🗑️ Role Removal Complete")
            .setColor(deletedCount > 0 ? Colors.Green : Colors.Red)
            .setTimestamp();

          if (deletedCount > 0) {
            embed.addFields({
              name: `✅ Successfully Deleted (${deletedCount})`,
              value:
                deletedRoles.length > 20
                  ? `${deletedRoles.slice(0, 20).join(", ")}... and ${
                      deletedRoles.length - 20
                    } more`
                  : deletedRoles.join(", ") || "None",
              inline: false,
            });
          }

          if (errorCount > 0) {
            embed.addFields({
              name: `❌ Failed to Delete (${errorCount})`,
              value:
                errorRoles.length > 20
                  ? `${errorRoles.slice(0, 20).join(", ")}... and ${
                      errorRoles.length - 20
                    } more`
                  : errorRoles.join(", ") || "None",
              inline: false,
            });
          }

          if (deletedCount === 0 && errorCount === 0) {
            embed.setDescription(
              "ℹ️ No roles found to delete. They may have already been removed or never created."
            );
          }

          await i.editReply({ embeds: [embed] });
        } catch (error) {
          console.error("Error in remove-roles command:", error);
          await i.editReply({
            content:
              "❌ An error occurred while removing roles. Check console for details.",
          });
        }

        return;
      }
    }

    // — Button & Menu Handlers — (unchanged)
    if (i.isButton() && i.customId.startsWith("setup_webhook:")) {
      const [, type] = i.customId.split(":");
      const menu = new ChannelSelectMenuBuilder()
        .setCustomId(`select_webhook_channel:${type}`)
        .setPlaceholder(`Select a text channel for ${type}…`)
        .addChannelTypes(ChannelType.GuildText)
        .setMinValues(1)
        .setMaxValues(1);
      await i.update({
        content: `📡 Which channel for **${type}**?`,
        embeds: [],
        components: [new ActionRowBuilder().addComponents(menu)],
        ephemeral: true,
      });
      return;
    }
    if (
      i.isChannelSelectMenu() &&
      i.customId.startsWith("select_webhook_channel:")
    ) {
      const [, type] = i.customId.split(":");
      const channelId = i.values[0];
      const channel = i.guild.channels.cache.get(channelId);
      if (!channel?.isTextBased()) {
        return i.update({
          content: "❌ Please select a text channel.",
          components: [],
          ephemeral: true,
        });
      }
      const labels = {
        seed: "Seed Stock",
        gear: "Gear Stock",
        cosmetic: "Cosmetic Stock",
        eventshop: "Event Shop",
        egg: "Egg Stock",
        announcement: "Announcement",
        weather: "Weather Change",
        jandel: "Merchant Notification",
      };
      let hook;
      try {
        hook = await channel.createWebhook({
          name: labels[type],
          reason: "Via /setup-webhook",
        });
      } catch {
        return i.update({
          content: "❌ Failed to create webhook. Check permissions.",
          components: [],
          ephemeral: true,
        });
      }
      webhooksData[i.guild.id] = webhooksData[i.guild.id] || {};
      webhooksData[i.guild.id][type] = {
        id: hook.id,
        token: hook.token,
        channelId,
      };
      saveAll();
      await i.update({
        content: `✅ Webhook for **${labels[type]}** created in <#${channelId}>.`,
        components: [],
        ephemeral: true,
      });
      await checkAll();
      return;
    }
    if (i.isButton() && i.customId === "remove_all_webhooks") {
      delete webhooksData[i.guild.id];
      saveAll();
      await i.update({
        content: "🗑️ All webhook settings removed.",
        components: [],
        ephemeral: true,
      });
      await checkAll();
      return;
    }
    if (i.isButton() && i.customId === "open_role_panel") {
      const userId = i.user.id;
      rolePanelPages[userId] = 0;
      const slice = ITEM_ROLES.slice(0, ITEMS_PER_PAGE);
      const menu = new StringSelectMenuBuilder()
        .setCustomId("select_roles")
        .setPlaceholder("Choose your roles…")
        .setMinValues(0)
        .setMaxValues(slice.length)
        .addOptions(
          slice.map((name) => {
            const key = normalizeKey(name.trim());
            const raw = getEmojiByKey(key);
            let emoji;
            if (raw) {
              const m = raw.match(/^<a?:(\w+):(\d+)>$/);
              if (m)
                emoji = {
                  name: m[1],
                  id: m[2],
                  animated: raw.startsWith("<a:"),
                };
              else emoji = { name: raw };
            }
            return { label: name, value: key, emoji };
          })
        );
      const row1 = new ActionRowBuilder().addComponents(menu);
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("role_prev")
          .setLabel("⬅️ Prev")
          .setDisabled(true)
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("role_next")
          .setLabel("Next ➡️")
          .setDisabled(slice.length < ITEMS_PER_PAGE)
          .setStyle(ButtonStyle.Secondary)
      );
      await i.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🎨 Pick Item Roles")
            .setDescription(
              `Page 1 of ${Math.ceil(ITEM_ROLES.length / ITEMS_PER_PAGE)}`
            )
            .setColor(Colors.Blurple),
        ],
        components: [row1, row2],
        flags: EPHEMERAL,
      });
      return;
    }
    if (i.isButton() && ["role_prev", "role_next"].includes(i.customId)) {
      const userId = i.user.id;
      let page = rolePanelPages[userId] || 0;
      page += i.customId === "role_next" ? 1 : -1;
      rolePanelPages[userId] = page;
      const startIdx = page * ITEMS_PER_PAGE;
      const slice = ITEM_ROLES.slice(startIdx, startIdx + ITEMS_PER_PAGE);
      const menu = new StringSelectMenuBuilder()
        .setCustomId("select_roles")
        .setPlaceholder("Choose your roles…")
        .setMinValues(0)
        .setMaxValues(slice.length)
        .addOptions(
          slice.map((name) => {
            const key = normalizeKey(name.trim());
            const raw = getEmojiByKey(key);
            let emoji;
            if (raw) {
              const m = raw.match(/^<a?:(\w+):(\d+)>$/);
              if (m)
                emoji = {
                  name: m[1],
                  id: m[2],
                  animated: raw.startsWith("<a:"),
                };
              else emoji = { name: raw };
            }
            return { label: name, value: key, emoji };
          })
        );
      const row1 = new ActionRowBuilder().addComponents(menu);
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("role_prev")
          .setLabel("⬅️ Prev")
          .setDisabled(page === 0)
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("role_next")
          .setLabel("Next ➡️")
          .setDisabled(startIdx + ITEMS_PER_PAGE >= ITEM_ROLES.length)
          .setStyle(ButtonStyle.Secondary)
      );
      await i.update({
        embeds: [
          new EmbedBuilder()
            .setTitle("🎨 Pick Item Roles")
            .setDescription(
              `Page ${page + 1} of ${Math.ceil(
                ITEM_ROLES.length / ITEMS_PER_PAGE
              )}`
            )
            .setColor(Colors.Blurple),
        ],
        components: [row1, row2],
      });
      return;
    }
    if (i.isStringSelectMenu() && i.customId === "select_roles") {
      const selected = i.values;
      const member = i.member;
      const userId = i.user.id;
      const page = rolePanelPages[userId] || 0;
      const slice = ITEM_ROLES.slice(
        page * ITEMS_PER_PAGE,
        page * ITEMS_PER_PAGE + ITEMS_PER_PAGE
      );
      for (const name of slice) {
        const key = normalizeKey(name.trim());
        const roleId = rolesData[i.guild.id]?.[key];
        if (!roleId) continue;
        const role = i.guild.roles.cache.get(roleId);
        if (!role) continue;
        if (selected.includes(key)) {
          if (!member.roles.cache.has(roleId)) await member.roles.add(role);
        } else {
          if (member.roles.cache.has(roleId)) await member.roles.remove(role);
        }
      }
      await i.reply({
        content: `✅ Updated your roles for page ${page + 1}.`,
        flags: EPHEMERAL,
      });
      return;
    }
  } catch (err) {
    console.error("[interactionHandler]", err);
    if (i.replied || i.deferred)
      i.followUp({ content: "💥 Something went wrong.", flags: EPHEMERAL });
    else i.reply({ content: "💥 Something went wrong.", flags: EPHEMERAL });
  }
}
client.on(Events.InteractionCreate, interactionHandler);

// — Ready & Command Registration —
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // set a "Watching Grow A Garden" status
  client.user.setPresence({
    activities: [{ name: "Stocks & Weathers", type: ActivityType.Watching }],
    status: "online",
  });

  await client.application.commands.set([
    // Public Commands
    {
      name: "guilds",
      description: "Show bot/server stats",
      type: ApplicationCommandType.ChatInput,
    },
    {
      name: "calculate",
      description: "Calculate fruit prices",
      type: ApplicationCommandType.ChatInput,
      options: [
        { name: "name", type: 3, description: "Fruit name", required: false },
        { name: "weight", type: 10, description: "Weight", required: false },
        { name: "variant", type: 3, description: "Variant", required: false },
        { name: "mutation", type: 3, description: "Mutation", required: false },
      ],
    },

    // Initial Setup Commands (Admin)
    {
      name: "setup-roles",
      description: "Create notification + item roles",
      type: ApplicationCommandType.ChatInput,
      defaultMemberPermissions: PermissionFlagsBits.Administrator,
    },
    {
      name: "setup-webhook",
      description: "Interactively set up webhooks",
      type: ApplicationCommandType.ChatInput,
      defaultMemberPermissions: PermissionFlagsBits.Administrator,
    },

    // Channel Setup Commands
    {
      name: "setseed",
      description: "Set seed stock notification channel",
      type: ApplicationCommandType.ChatInput,
    },
    {
      name: "setgear",
      description: "Set gear stock notification channel",
      type: ApplicationCommandType.ChatInput,
    },
    {
      name: "setcosmetic",
      description: "Set cosmetic stock notification channel",
      type: ApplicationCommandType.ChatInput,
    },
    {
      name: "seteventstock",
      description: "Set event stock notification channel",
      type: ApplicationCommandType.ChatInput,
    },
    {
      name: "setegg",
      description: "Set egg stock notification channel",
      type: ApplicationCommandType.ChatInput,
    },
    {
      name: "setannounce",
      description: "Set announcement notification channel",
      type: ApplicationCommandType.ChatInput,
    },
    {
      name: "setweather",
      description: "Set weather notification channel",
      type: ApplicationCommandType.ChatInput,
    },
    {
      name: "setmerchant",
      description: "Set traveling merchant notification channel",
      type: ApplicationCommandType.ChatInput,
    },
    {
      name: "setcurrentevent",
      description: "Set current event notification channel",
      type: ApplicationCommandType.ChatInput,
    },

    // Advanced Admin Commands
    {
      name: "edit-webhook",
      description: "Edit existing webhook properties",
      type: ApplicationCommandType.ChatInput,
      defaultMemberPermissions: PermissionFlagsBits.Administrator,
      options: [
        {
          name: "type",
          type: 3,
          description: "Webhook type to edit",
          required: true,
          choices: [
            { name: "Seed Stock", value: "seed" },
            { name: "Gear Stock", value: "gear" },
            { name: "Cosmetic Stock", value: "cosmetic" },
            { name: "Event Stock", value: "eventshop" },
            { name: "Egg Stock", value: "egg" },
            { name: "Announcement", value: "announcement" },
            { name: "Weather", value: "weather" },
            { name: "Merchant", value: "jandel" },
          ],
        },
        {
          name: "name",
          type: 3,
          description: "New webhook name (optional)",
          required: false,
        },
        {
          name: "avatar",
          type: 3,
          description: "New webhook avatar URL (optional)",
          required: false,
        },
        {
          name: "channel",
          type: 7,
          description: "Move webhook to different channel (optional)",
          required: false,
          channel_types: [0],
        },
      ],
    },
    {
      name: "set-bot-name",
      description: "Change bot display name for webhook messages",
      type: ApplicationCommandType.ChatInput,
      defaultMemberPermissions: PermissionFlagsBits.Administrator,
      options: [
        {
          name: "type",
          type: 3,
          description: "Notification type",
          required: true,
          choices: [
            { name: "Seed Stock", value: "seed" },
            { name: "Gear Stock", value: "gear" },
            { name: "Cosmetic Stock", value: "cosmetic" },
            { name: "Event Stock", value: "eventshop" },
            { name: "Egg Stock", value: "egg" },
            { name: "Announcement", value: "announcement" },
            { name: "Weather", value: "weather" },
            { name: "Merchant", value: "jandel" },
            { name: "Current Event", value: "currentevent" },
            { name: "Default", value: "default" },
          ],
        },
        {
          name: "name",
          type: 3,
          description: "New bot display name",
          required: true,
        },
      ],
    },
    {
      name: "ping-role",
      description: "Ping a specific item role by name",
      type: ApplicationCommandType.ChatInput,
      defaultMemberPermissions: PermissionFlagsBits.Administrator,
      options: [
        {
          name: "item",
          type: 3,
          description:
            "Item name to ping (e.g., watermelon, mastersprinkler, meteorshower)",
          required: true,
        },
        {
          name: "message",
          type: 3,
          description: "Optional message to send with the ping",
          required: false,
        },
      ],
    },
    {
      name: "list-items",
      description: "Show all available items for role pinging",
      type: ApplicationCommandType.ChatInput,
      defaultMemberPermissions: PermissionFlagsBits.Administrator,
      options: [
        {
          name: "category",
          type: 3,
          description: "Filter by category",
          required: false,
          choices: [
            { name: "Seeds/Plants", value: "seeds" },
            { name: "Gear/Tools", value: "gear" },
            { name: "Eggs", value: "eggs" },
            { name: "Weather", value: "weather" },
            { name: "All", value: "all" },
          ],
        },
      ],
    },
    {
      name: "remove-roles",
      description: "Remove roles created by setup-roles command",
      type: ApplicationCommandType.ChatInput,
      defaultMemberPermissions: PermissionFlagsBits.Administrator,
      options: [
        {
          name: "type",
          type: 3,
          description: "Which roles to remove",
          required: true,
          choices: [
            { name: "Notification Roles Only", value: "notification" },
            { name: "Item Roles Only", value: "item" },
            { name: "All Roles", value: "all" },
          ],
        },
        {
          name: "confirm",
          type: 5,
          description: "Confirm deletion (required to prevent accidents)",
          required: true,
        },
      ],
    },
  ]);

  // Poll stock/weather every 10s
  setInterval(() => checkAll().catch(console.error), 10_000);

  // Poll current-event countdown every 1s
  setInterval(() => checkCurrentEvent().catch(console.error), 1_000);

  // initial run
  await checkAll();
  await checkCurrentEvent();
});

// — Global Errors & Login —
client.on("error", (err) => console.error("[Global Error]", err));
client.on("unhandledRejection", (err) =>
  console.error("[Unhandled Rejection]", err)
);
client
  .login(DISCORD_BOT_TOKEN)
  .catch((err) => console.error("Login failed", err));
