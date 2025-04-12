require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, 'bossDeaths.json');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const bossConfigs = {
  qa: { timer: 24 * 60 * 60 * 1000, window: 4 },
  core: { timer: 48 * 60 * 60 * 1000, window: 4 },
  orfen: { timer: 33 * 60 * 60 * 1000, window: 4 },
  zaken: { timer: 45 * 60 * 60 * 1000, window: 4 },
  baium: { timer: 125 * 60 * 60 * 1000, window: 4 },
  antharas: { timer: 192 * 60 * 60 * 1000, window: 4 },
  valakas: { timer: 264 * 60 * 60 * 1000, window: 4 },
  cabrio: { timer: 12 * 60 * 60 * 1000, window: 9 },
  hallate: { timer: 12 * 60 * 60 * 1000, window: 9 },
  kernon: { timer: 12 * 60 * 60 * 1000, window: 9 },
  golkonda: { timer: 12 * 60 * 60 * 1000, window: 9 },
};

// Load bossDeaths from file if exists
let bossDeaths = {};
if (fs.existsSync(DATA_PATH)) {
  try {
    const raw = fs.readFileSync(DATA_PATH);
    const parsed = JSON.parse(raw);
    // Convert ISO strings to Date objects
    for (const boss in parsed) {
      parsed[boss].time = new Date(parsed[boss].time);
    }
    bossDeaths = parsed;
    console.log('Boss death data loaded.');
  } catch (err) {
    console.error('Failed to load saved boss data:', err);
  }
}

// Save bossDeaths to file
function saveBossDeaths() {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify(bossDeaths, null, 2));
  } catch (err) {
    console.error('Failed to save boss death data:', err);
  }
}

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();
  const args = content.split(/\s+/);
  const command = args.shift().toLowerCase();

  // !dead <boss>
  if (command === "!dead") {
    const boss = args[0]?.toLowerCase();
    const config = bossConfigs[boss];
    if (!config) {
      return message.reply("Unknown boss. Please use a valid name.");
    }

    const now = new Date();
    bossDeaths[boss] = {
      time: now,
      user: message.author.username,
    };

    saveBossDeaths();

    const respawnStart = new Date(now.getTime() + config.timer);
    return message.reply(
      `${capitalize(boss)} marked as dead at <t:${Math.floor(now.getTime() / 1000)}:F>, respawn window will start at <t:${Math.floor(respawnStart.getTime() / 1000)}:F>.`
    );
  }

  // !tracked
  if (command === '!tracked') {
    if (Object.keys(bossDeaths).length === 0) {
      return message.reply("No bosses are being tracked yet.");
    }

    let reply = "**Tracked Bosses:**\n";
    for (const [boss, data] of Object.entries(bossDeaths)) {
      const config = bossConfigs[boss];
      const deathTime = `<t:${Math.floor(new Date(data.time).getTime() / 1000)}:F>`;
      const respawnStart = `<t:${Math.floor(new Date(data.time).getTime() / 1000 + config.timer / 1000)}:F>`;
      reply += `**${capitalize(boss)}** - Died at ${deathTime}, respawn starts at ${respawnStart}. Updated by ${data.user}\n`;
    }

    return message.reply(reply);
  }

  // !update <boss> <YYYY-MM-DD HH:MM>
  if (command === '!update') {
    const boss = args[0]?.toLowerCase();
    const dateString = args.slice(1).join(" ");
    const config = bossConfigs[boss];

    if (!boss || !config) {
      return message.reply("Unknown boss. Use a valid boss name.");
    }

    const newTime = new Date(dateString);
    if (isNaN(newTime.getTime())) {
      return message.reply("Invalid date/time format. Use something like `!update core 2025-04-12 15:45`");
    }

    bossDeaths[boss] = {
      time: newTime,
      user: message.author.username,
    };

    saveBossDeaths();

    const respawnStart = new Date(newTime.getTime() + config.timer);
    return message.reply(
      `${capitalize(boss)} updated: death time set to <t:${Math.floor(newTime.getTime() / 1000)}:F>, respawn starts at <t:${Math.floor(respawnStart.getTime() / 1000)}:F>.`
    );
  }

  // !<boss>
  const boss = command.replace("!", "").toLowerCase();
  const config = bossConfigs[boss];
  if (config) {
    const deathInfo = bossDeaths[boss];
    if (!deathInfo) {
      return message.reply(`No death record found for ${capitalize(boss)}.`);
    }

    const respawnStart = new Date(deathInfo.time.getTime() + config.timer);
    const now = new Date();
    const windowHours = config.window;
    const respawnEnd = new Date(respawnStart.getTime() + windowHours * 60 * 60 * 1000);

    let statusMessage = '';
    if (now < respawnStart) {
      statusMessage = `${capitalize(boss)} window starts at <t:${Math.floor(respawnStart.getTime() / 1000)}:F> and will last for ${windowHours} hours. Last updated by ${deathInfo.user}.`;
    } else if (now >= respawnStart && now <= respawnEnd) {
      const timeLeftMs = respawnEnd.getTime() - now.getTime();
      const minutes = Math.floor((timeLeftMs / 1000) / 60);
      const hours = Math.floor(minutes / 60);
      const remaining = `${hours} hour${hours !== 1 ? 's' : ''} and ${minutes % 60} minute${(minutes % 60 !== 1 ? 's' : '')}`;
      statusMessage = `${capitalize(boss)} window is currently OPEN. ${remaining} left. Last updated by ${deathInfo.user}.`;
    } else {
      statusMessage = `${capitalize(boss)} window has ended. Last updated by ${deathInfo.user}.`;
    }

    return message.reply(statusMessage);
  }
});

client.login(process.env.DISCORD_TOKEN);

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
