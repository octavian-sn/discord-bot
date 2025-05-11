require('dotenv').config();
const { Client, GatewayIntentBits, Events, PermissionsBitField } = require('discord.js');
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
  switch(command){
    case '!rb': 
      return returnTrackedBosses(message, 'regular');
    case '!epic': 
      return returnTrackedBosses(message, 'epic');
    case '!sub': 
       return returnTrackedBosses(message, 'subclass');
  }

  async function returnTrackedBosses(message, type) {
    const serverId = message.guild.id

    const tracked = await db.query(`
      SELECT rb.*, c.timer_ms, c.window_hours
      FROM raid_boss rb
      JOIN raid_boss_catalog c ON rb.raid_name = c.raid_name
      WHERE rb.server_id = $1
        AND c.type = $2
        AND NOW() < 
          death_time 
          + (c.timer_ms * INTERVAL '1 millisecond')
          + (c.window_hours * INTERVAL '1 hour');
    `, [serverId, type]);

    if (tracked.rowCount === 0) {
      return message.reply("All tracked raid bosses are currently outdated or no bosses are being tracked yet on this server.");
    }

    let reply = "**RaidBosses respawn times:**\n\n";
    tracked.rows.forEach(row => {
      const respawnStart = new Date(new Date(row.death_time).getTime() + row.timer_ms);
      const formattedRespawn = `<t:${Math.floor(respawnStart.getTime() / 1000)}:F>`;
      reply += `• **${capitalize(row.raid_name)}** -${formattedRespawn}\n`;
    });

    return message.reply(reply);
  }

  if (command === '!rbadd'){
    const [bossName, type, respawnTime, respawnWindow] = args;
    const user = message.author.username;

    if (!bossName) {
     return message.reply("Usage: !rbadd {bossName} {type} {respawnTimeHours} {windowHours}\nExample: !rbadd tezza epic 72 4");
    }
    const lowerCaseBossName = bossName.toLocaleLowerCase()

    if (type && (type !== 'epic' && type !== 'subclass' && type !== 'regular')) {
      return message.reply(`Invalid type. Must be either epic or subclass.`);
    }
    if (type && (!respawnTime || !respawnWindow)){
      return message.reply('For epic and subclass bosses a respawn time and window must be provided. \nExample: !rbadd tezza epic 72 4')
    }
    if (respawnTime < 1 || respawnTime > 999 || respawnWindow < 1 || respawnWindow > 9) {
      return message.reply("Respawn time must be between 1 and 999. Window hours must be between 1 and 9.")
    }

    try{
      return await addNewRaidBoss(lowerCaseBossName, type, respawnTime, respawnWindow, user);
    }catch(e){
      return message.reply(`There was an issue adding a new rb to the list of tracked raid bosses: ${e.message}`)
    }
  }

  async function addNewRaidBoss(bossName, type = 'regular', respawnTime = 12, respawnWindow = 9, added_by){
    const respawnTimeMs = respawnTime * 60 * 60 * 1000

    await db.query(`
      INSERT INTO raid_boss_catalog (raid_name, type, timer_ms, window_hours, added_by)
      VALUES ($1, $2, $3, $4, $5)
    `, [bossName, type, respawnTimeMs, respawnWindow, added_by])

    return message.reply(
      `${capitalize(bossName)} (${respawnTime}h + ${respawnWindow}h random) has been added to the ${type !== 'regular' ? type : ''} list.`
    )
  }

  if(command === '!rbremove'){
    if(!message.member.permissions.has(PermissionsBitField.Flags.Administrator)){
      return message.reply(`This command is only available for admins.`)
    }

    try{
      const raidName = args[0].toLocaleLowerCase()
      const result = await db.query(`
        DELETE FROM raid_boss_catalog
        WHERE raid_name = $1;
      `, [raidName])
  
      if (result.rowCount === 0){
        return message.reply(`Unknown boss name. Use !list to check the currently tracked bosses.`)
      }
      return message.reply(`${raidName} has been removed from the list.`)

    }catch(e){
      return message.reply(`There was an issue removing the rb from the tracked list: ${e.message}`)
    }
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
        `${capitalize(boss)} window has ended <t:${Math.floor(respawnEnd.getTime() / 1000)}:F>. Last updated by ${deathInfo.user_name}.`
      );
    }
  }

  // !help — list of available commands
if (command === '!help') {
  let reply = `
**Raid Bot Commands:**

•  \`!rb\` - Lists all tracked **regular** bosses on your server *(only shows those within or approaching their spawn window)*
•  \`!epic\` - Lists all tracked **epic** bosses *(same)*
•  \`!sub\` - Lists all tracked **subclass** bosses *(same; baium and barakiel are listed here)*
•  \`!{boss_name}\` - Check the spawn window of a specific boss (Example: \`!baium\`)
•  \`!dead {boss_name}\` - Mark a boss as dead (Example: \`!dead antharas\`)
•  \`!update {boss_name} YYYY-MM-DD HH:MM\` - Update a boss death time in **UTC-0** (Example: \`!update golkonda 2025-04-12 18:30\`)
•  \`!list\` - Returns a list of all bosses that can be tracked
•  \`!rbadd {bossName} {type} {respawnTimeHours} {windowHours}\` - Add a new boss (type, respawn and window are mandatory for epic/subclass only)
•  \`!rbremove {bossName}\` - Remove a boss from the list (**admin only**)

All tracked times are:
•  **Localized to your Discord’s local time**
•  Labeled with who last updated them
`;

  return message.reply(reply);
}

  // !list - list of bosses that the bot can track
  if(command === '!list'){
    const results = await db.query(`
      SELECT rb.raid_name, rb.window_hours
      FROM raid_boss_catalog rb
    `)

    if (results.rowCount === 0){
      return message.reply("No raid boss information currently available.")
    }

    let reply = "**The following raid bosses can be tracked:**\n\n" 
    results.rows.forEach(row=>{
      reply += `• ${capitalize(row.raid_name)} - ${row.window_hours} hours spawn window \n`
    })
    
    return message.reply(reply)
  }

});

client.login(process.env.DISCORD_TOKEN);

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
