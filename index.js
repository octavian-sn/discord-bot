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
    const catalog = await db.query('SELECT * FROM raid_boss_catalog WHERE raid_name = $1 AND server_id = $2', [boss, serverId]);
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
      `${capitalize(boss)} updated. TOD: <t:${Math.floor(now.getTime() / 1000)}:F>, window start: <t:${Math.floor(respawnStart.getTime() / 1000)}:F>`
    );
  }

  // !update <boss> <YYYY-MM-DD HH:MM>
  if (command === '!update') {
    const boss = args[0]?.toLowerCase();
    const dateString = args.slice(1).join(" ");
    const catalog = await db.query('SELECT * FROM raid_boss_catalog WHERE raid_name = $1 AND server_id = $2', [boss, serverId]);
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
      `${capitalize(boss)} updated. TOD: <t:${Math.floor(newTime.getTime() / 1000)}:F>, window start: <t:${Math.floor(respawnStart.getTime() / 1000)}:F>.`
    );
  }

  // !epic/!sub/!rb — tracked bosses
  switch(command){
    case '!epic': 
      return returnTrackedBosses(message, 'epic');
    case '!sub': 
      return returnTrackedBosses(message, 'subclass');
    case '!rb':
      return returnTrackedBosses(message, 'regular')
  }

  async function returnTrackedBosses(message, type) {
    const tracked = await getTrackedBosses(serverId, { 
      isRegular : type === 'regular',
      isEpic : type === 'epic', 
      isSubclass : type === 'subclass'
    });

    if (tracked.rowCount === 0) {
      return message.reply(`No ${type} bosses are being tracked yet. Use '!dead' to update timers or '!rbadd' to update the list.`);
    }

    let reply = `**${type.toUpperCase()}:**\n\n`;
    let outdatedBosses = '';
    tracked.rows.forEach(row => {
      const respawnStart = new Date(row.death_time.getTime() + row.timer_ms);
      const respawnEnd = new Date(respawnStart.getTime() + row.window_hours * 60 * 60 * 1000);
      const now = new Date();
      const formattedStart = `<t:${Math.floor(respawnStart.getTime() / 1000)}:F>`;
      const formattedEnd = `<t:${Math.floor(respawnEnd.getTime() / 1000)}:F>`;
      if(now > respawnEnd){
        outdatedBosses += `• **${capitalize(row.raid_name)}** - ended ${formattedEnd}\n`;
      } else if(respawnStart <= now && now <= respawnEnd){
        const minutesLeft = Math.floor((respawnEnd - now) / 60000);
        const hours = Math.floor(minutesLeft / 60);
        const mins = minutesLeft % 60;
        reply += `• **${capitalize(row.raid_name)}** - ON! Window ends in ${hours}h ${mins}m\n`;
      } else{
        reply += `• **${capitalize(row.raid_name)}** - starts ${formattedStart}\n`;
      }
    });

    return message.reply( reply + outdatedBosses );
  }

  async function getTrackedBosses(serverId, {isRegular = false, isEpic = false, isSubclass = false} = {}){
    let query = `
    SELECT rb.*, c.timer_ms, c.window_hours
    FROM raid_boss rb
    JOIN raid_boss_catalog c 
    ON rb.raid_name = c.raid_name
    AND rb.server_id = c.server_id
    WHERE rb.server_id = $1
    `
    const values = [serverId]

    if (isRegular){
      query += ` 
        AND c.is_regular IS TRUE
        AND NOW() < 
          death_time 
          + (c.timer_ms * INTERVAL '1 millisecond')
          + (c.window_hours * INTERVAL '1 hour')
      `;
    }
    if (isEpic){
      query += ` AND c.is_epic IS TRUE`
    }
    if (isSubclass){
      query += ` AND c.is_subclass IS TRUE`
    }

    query += ` 
      ORDER BY
        (death_time
        + (c.timer_ms * INTERVAL '1 millisecond')
        + (c.window_hours * INTERVAL '1 hour')) - NOW();
    `
    return db.query(query, values)
  }

  // !rbadd - add bosses
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
      await addNewServer(serverId);
      return await addNewRaidBoss(lowerCaseBossName, type, respawnTime, respawnWindow, user);
    }catch(e){
      if(e.message.includes('duplicate key value')){
        return message.reply(`Duplicate entry detected. ${bossName} already exists.`)
      }
      return message.reply(`There was an issue adding a new rb to the list of tracked raid bosses: ${e.message}`)
    }
  }

  async function addNewServer(serverId){
    const serverName = message.guild.name;
    const ownerId = (await message.guild.fetchOwner()).id;

    const result = await db.query(`
      INSERT INTO servers (server_id, name, owner_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (server_id) DO NOTHING
    `, [serverId, serverName, ownerId])

    if (result.rowCount > 0){
      console.info(`New server ${serverId} has been added. O: ${ownerId}`)
    }
  }

  async function addNewRaidBoss(bossName, type = 'regular', respawnTime = 12, respawnWindow = 9, added_by){
    const respawnTimeMs = respawnTime * 60 * 60 * 1000
    const isEpic = 'epic' === type
    const isSubclass = 'subclass' === type
    const isRegular = 'regular' === type

    await db.query(`
      INSERT INTO raid_boss_catalog (raid_name, timer_ms, window_hours, added_by, server_id, is_epic, is_subclass, is_regular)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [bossName, respawnTimeMs, respawnWindow, added_by, serverId, isEpic, isSubclass, isRegular])

    return message.reply(
      `${capitalize(bossName)} (${respawnTime}h + ${respawnWindow}h random) has been added to the ${type !== 'regular' ? type : ''} list.`
    )
  }

  // !rbremove - remove bosses
  if(command === '!rbremove'){
    if(!message.member.permissions.has(PermissionsBitField.Flags.Administrator)){
      return message.reply(`This command is only available for admins.`)
    }

    try{
      const raidName = args[0].toLocaleLowerCase()
      const result = await db.query(`
        DELETE FROM raid_boss_catalog
        WHERE raid_name = $1
        AND server_id = $2;
      `, [raidName, serverId])
  
      if (result.rowCount === 0){
        return message.reply(`Unknown boss name. Use !list to check the available bosses.`)
      }
      return message.reply(`${raidName} has been removed from the list.`)

    }catch(e){
      return message.reply(`There was an issue removing the rb from the tracked list: ${e.message}`)
    }
  }

  // !<boss> — get boss window
  if(command.startsWith("!") && !['!help', '!list', '!rb', '!epic', '!sub', '!dead', '!update', '!rbadd', '!rbremove'].includes(command)){
    const boss = command.replace("!", "").toLowerCase();
    const catalog = await db.query('SELECT * FROM raid_boss_catalog WHERE raid_name = $1 AND server_id = $2', [boss, serverId]);
  
    if (catalog.rowCount > 0) {
      const result = await db.query(`
        SELECT * FROM raid_boss
        WHERE raid_name = $1 
        AND server_id = $2;
      `, [boss, serverId]);
  
      if (result.rowCount === 0) {
        return message.reply(`No death record found for ${capitalize(boss)}.`);
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
          `**${capitalize(boss)} is currently within spawn window!**\nRemaining time: ${hours}h ${mins}m.\nU: ${deathInfo.user_name}.`
        );
      } else if (now < respawnStart) {
        return message.reply(
          `${capitalize(boss)} window starts <t:${Math.floor(respawnStart.getTime() / 1000)}:F> (+${window_hours} random). U: ${deathInfo.user_name}.`
        );
      } else {
        return message.reply(
          `${capitalize(boss)} TOD info OUTDATED: <t:${Math.floor(respawnEnd.getTime() / 1000)}:F>. U: ${deathInfo.user_name}.`
        );
      }
    }
  }

  // !help — list of available commands
  if (command === '!help') {
    let reply = `
    **Raid Bot Commands:**

    •  \`!rb\` - Lists all tracked **regular** bosses *(only shows those within or approaching their spawn window)*
    •  \`!epic\` - Lists all tracked **epic** bosses *(same)*
    •  \`!sub\` - Lists all tracked **subclass** bosses *(same)*
    •  \`!{boss_name}\` - Check the spawn window of a specific boss (Ex: \`!baium\`)
    •  \`!dead {boss_name}\` - Updates a boss' TOD (Ex: \`!dead antharas\`)
    •  \`!update {boss_name} YYYY-MM-DD HH:MM\` - Update a boss TOD **USE UTC-0** (Ex: \`!update golkonda 2025-04-12 18:30\`)
    •  \`!list\` - Returns a list of all registered bosses
    •  \`!rbadd {bossName} {type} {respawnTimeHours} {windowHours}\` - Add a new boss to the list (type, respawn and window are mandatory for epic and subclass only)
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
      WHERE rb.server_id = $1
      ORDER BY rb.raid_name
    `, [serverId])

    if (results.rowCount === 0){
      return message.reply("No raid boss information currently available.")
    }

    let reply = "**Raid Boss list (Name - x hours respawn window)**\n\n" 
    results.rows.forEach(row=>{
      reply += `• ${capitalize(row.raid_name)} - ${row.window_hours}\n`
    })
    
    return message.reply(reply)
  }

});

client.login(process.env.DISCORD_TOKEN);

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}


