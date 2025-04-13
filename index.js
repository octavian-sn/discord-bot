require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const db = require('./utils/db');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  const content = message.content.trim();
  const args = content.split(/\s+/);
  const command = args.shift().toLowerCase();
  const serverId = message.guild.id;

  // !dead <boss>
  if (command === "!dead") {
    const boss = args[0]?.toLowerCase();
    const catalog = await db.query('SELECT * FROM raid_boss_catalog WHERE raid_name = $1', [boss]);
    if (catalog.rowCount === 0) {
      return message.reply("Unknown boss. Please use a valid name.");
    }

    const now = new Date();
    const user = message.author.username;

    await db.query(`
      INSERT INTO raid_boss (raid_name, server_id, death_time, user_name)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (raid_name, server_id)
      DO UPDATE SET death_time = $3, user_name = $4, updated_at = NOW()
    `, [boss, serverId, now, user]);

    const respawnStart = new Date(now.getTime() + catalog.rows[0].timer_ms);

    return message.reply(
      `${capitalize(boss)} marked as dead at <t:${Math.floor(now.getTime() / 1000)}:F>, respawn window will start at <t:${Math.floor(respawnStart.getTime() / 1000)}:F>.`
    );
  }

  // !update <boss> <YYYY-MM-DD HH:MM>
  if (command === '!update') {
    const boss = args[0]?.toLowerCase();
    const dateString = args.slice(1).join(" ");
    const catalog = await db.query('SELECT * FROM raid_boss_catalog WHERE raid_name = $1', [boss]);
    if (!boss || catalog.rowCount === 0) {
      return message.reply("Unknown boss. Use a valid boss name.");
    }

    const newTime = new Date(dateString);
    if (isNaN(newTime.getTime())) {
      return message.reply("Invalid date/time format. Use something like `!update core 2025-04-12 15:45`");
    }

    const user = message.author.username;

    await db.query(`
      INSERT INTO raid_boss (raid_name, server_id, death_time, user_name)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (raid_name, server_id)
      DO UPDATE SET death_time = $3, user_name = $4, updated_at = NOW()
    `, [boss, serverId, newTime, user]);

    const respawnStart = new Date(newTime.getTime() + catalog.rows[0].timer_ms);

    return message.reply(
      `${capitalize(boss)} updated: death time set to <t:${Math.floor(newTime.getTime() / 1000)}:F>, respawn starts at <t:${Math.floor(respawnStart.getTime() / 1000)}:F>.`
    );
  }

  // !rb — tracked bosses
  if (command === '!rb') {
    const tracked = await db.query(`
      SELECT rb.*, c.timer_ms, c.window_hours
      FROM raid_boss rb
      JOIN raid_boss_catalog c ON rb.raid_name = c.raid_name
      WHERE rb.server_id = $1
    `, [serverId]);

    if (tracked.rowCount === 0) {
      return message.reply("No bosses are being tracked yet on this server.");
    }

    let reply = "**RaidBosses respawn times:**\n\n";
    tracked.rows.forEach(row => {
      const deathTime = `<t:${Math.floor(new Date(row.death_time).getTime() / 1000)}:F>`;
      const respawnStart = new Date(new Date(row.death_time).getTime() + row.timer_ms);
      const formattedRespawn = `<t:${Math.floor(respawnStart.getTime() / 1000)}:F>`;
      reply += `• **${capitalize(row.raid_name)}** - Died at ${deathTime}, respawn starts at ${formattedRespawn}. Updated by ${row.user_name}\n`;
    });

    return message.reply(reply);
  }

  // !<boss> — get boss window
  const boss = command.replace("!", "").toLowerCase();
  const catalog = await db.query('SELECT * FROM raid_boss_catalog WHERE raid_name = $1', [boss]);

  if (catalog.rowCount > 0) {
    const result = await db.query(`
      SELECT * FROM raid_boss
      WHERE raid_name = $1 AND server_id = $2
    `, [boss, serverId]);

    if (result.rowCount === 0) {
      return message.reply(`No death record found for ${capitalize(boss)} on this server.`);
    }

    const deathInfo = result.rows[0];
    const { timer_ms, window_hours } = catalog.rows[0];
    const deathTime = new Date(deathInfo.death_time);
    const respawnStart = new Date(deathTime.getTime() + timer_ms);
    const respawnEnd = new Date(respawnStart.getTime() + window_hours * 60 * 60 * 1000);
    const now = new Date();

    if (now >= respawnStart && now <= respawnEnd) {
      const minutesLeft = Math.floor((respawnEnd - now) / 60000);
      const hours = Math.floor(minutesLeft / 60);
      const mins = minutesLeft % 60;
      return message.reply(
        `**${capitalize(boss)} is currently within its spawn window!**\nRemaining time: ${hours}h ${mins}m.\nLast updated by ${deathInfo.user_name}.`
      );
    } else if (now < respawnStart) {
      return message.reply(
        `${capitalize(boss)} window starts at <t:${Math.floor(respawnStart.getTime() / 1000)}:F> and will last for ${window_hours} hours. Last updated by ${deathInfo.user_name}.`
      );
    } else {
      return message.reply(
        `${capitalize(boss)} window has ended. Last updated by ${deathInfo.user_name}.`
      );
    }
  }
});

client.login(process.env.DISCORD_TOKEN);

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
