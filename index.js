require('dotenv').config();
const fs = require('fs');
const {
  Client, GatewayIntentBits, IntentsBitField, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, REST, Routes, PermissionFlagsBits, MessageFlags, ChannelType, ActivityType,
} = require('discord.js');

const TICK_ID = '1559999432597180516', CROSS_ID = '1559999451513487529';
const TICK = `<:tick:${TICK_ID}>`, CROSS = `<:cross:${CROSS_ID}>`;
const CONE_ID = '1560018755701186610', GIFT_ID = '1560018740362608721', MEMBERS_ID = '1560018723794845846';
const CONE = `<:cone:${CONE_ID}>`, GIFT = `<:gift:${GIFT_ID}>`, MEMBERS = `<:members:${MEMBERS_ID}>`;
const BELL_ID = '1561462986911125614';
const EM = {   // custom emojis uploaded to the bot
  template: '<:template:1561831636348178503>', trophy: '<:trophy:1561831637472510062>', chat: '<:chat:1561831638730543194>', repeat: '<:repeat:1561831640765046784>',
  hourglass: '<:hourglass:1561831642400690337>', no: '<:no:1561831644304900208>', pause: '<:pause:1561831646158655519>', mail: '<:mail:1561831647786172548>',
  medal1: '<:medal1:1561831649744785528>', medal2: '<:medal2:1561831651712176249>', medal3: '<:medal3:1561831660960354366>', flag: '<:flag:1561831653117267998>',
  crown: '<:crown:1561831654509776976>', bellOff: '<:belloff:1561831655860342924>', lock: '<:lock:1561831657424822333>', chart: '<:chart:1561831659249205318>',
  calendar: '<:calendar:1561831662873219102>', wrench: '<:wrench:1561831664370450592>',
};
const WEB_ID = '1560217018312032277', WEB = `<:website:${WEB_ID}>`;
const withEmoji = (t) => String(t).replace(/✅/g, TICK).replace(/❌/g, CROSS);
// Your own domain (BASE_URL) wins; otherwise Render's automatic address is used
const BASE = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');

// Turns plain-text interaction replies into embeds (mentions that must ping are sent separately as content)
const RED = /^(❌|⚠️|invalid|you need|you are not|not allowed|giveaway not found|something went wrong|only managers|that giveaway|this giveaway has ended|pick a text|please enter|the claim time|you already|you were removed)/i;
const GREEN = /^(✅|giveaway (created|deleted|updated|fixed)|rerolled|ending|scheduled|cancelled)/i;
function embedify(o) {
  if (typeof o === 'string') o = { content: o };
  if (!o || typeof o !== 'object' || !o.content) return o;
  const good = GREEN.test(o.content), bad = !good && RED.test(o.content);
  let text = o.content;
  if (good && !text.startsWith('✅')) text = '✅ ' + text;
  if (bad && !text.startsWith('❌')) text = '❌ ' + text;
  const e = new EmbedBuilder().setColor(good ? 0x57f287 : bad ? 0xed4245 : 0x5865f2).setDescription(withEmoji(text).slice(0, 4000));
  return { ...o, content: '', embeds: [e, ...(o.embeds || [])] };
}

/* ───────────── storage (MongoDB if MONGODB_URI is set, otherwise a JSON file) ───────────── */
const DATA_DIR = process.env.DATA_DIR || '.';
const FILE = `${DATA_DIR}/data.json`;
let db = { giveaways: {}, guilds: {}, stats: {} };
let mongoColl = null;
async function initStorage() {
  if (process.env.MONGODB_URI) {
    const { MongoClient } = require('mongodb');
    const mc = new MongoClient(process.env.MONGODB_URI);
    await mc.connect();
    mongoColl = mc.db('givevanced').collection('state');
    const doc = await mongoColl.findOne({ _id: 'main' });
    if (doc) { delete doc._id; db = { ...db, ...doc }; }
    console.log('Storage: MongoDB');
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
    console.log('Storage: JSON file');
  }
}
let saveTimer;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (mongoColl) mongoColl.replaceOne({ _id: 'main' }, { _id: 'main', ...db }, { upsert: true }).catch((e) => console.error('Save failed', e));
    else fs.writeFileSync(FILE, JSON.stringify(db));
  }, 1000);
};
function blacklistOf(gid) { return (guildCfg(gid).blacklist ??= []); }
async function addBlacklist(gid, uid) {
  const bl = blacklistOf(gid);
  if (!bl.includes(uid)) bl.push(uid);
  for (const g of Object.values(db.giveaways)) if (g.guildId === gid && !g.ended && g.entries[uid]) { delete g.entries[uid]; refreshMessage(g); }
  save();
}
const guildCfg = (id) => (db.guilds[id] ??= { creatorRoles: [], managerRoles: [] });

/* ───────────── helpers ───────────── */
const day = (d = new Date()) => d.toISOString().slice(0, 10);
function parseDuration(str) {
  if (!str) return null;
  const ts = str.match(/<t:(\d+)(?::\w)?>/);
  if (ts) return Number(ts[1]) * 1000;
  const units = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
  let total = 0, found = false;
  for (const [, n, u] of str.toLowerCase().matchAll(/(\d+(?:\.\d+)?)\s*(s|m|h|d|w)[a-z]*/g)) {
    total += parseFloat(n) * units[u]; found = true;
  }
  return found ? Date.now() + total : null;
}
const parseMs = (str) => { const t = parseDuration(str); return t ? t - Date.now() : null; };
const ids = (s) => (s ? [...s.matchAll(/\d{17,20}/g)].map((m) => m[0]) : []);
const parseColor = (s, fb) => (s && /^#?[0-9a-f]{6}$/i.test(s) ? parseInt(s.replace('#', ''), 16) : fb);
function parseExtra(s) {
  const out = {};
  if (!s) return out;
  for (const part of s.split(',')) {
    const id = ids(part)[0], n = part.replace(/<@&\d+>/, '').match(/\d+/);
    if (id && n) out[id] = Number(n[0]);
  }
  return out;
}
function statsOf(gid, uid) { return ((db.stats[gid] ??= {})[uid] ??= { total: 0, days: {} }); }
function countSince(s, daysBack) {
  let n = 0;
  for (let i = 0; i < daysBack; i++) n += s.days[day(new Date(Date.now() - i * 864e5))] || 0;
  return n;
}
const weekDays = () => ((new Date().getUTCDay() + 6) % 7) + 1;   // days since Monday, incl. today
const monthDays = () => new Date().getUTCDate();

function isManager(i) {
  if (i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) return true;
  return guildCfg(i.guildId).managerRoles.some((r) => i.member.roles.cache.has(r));
}
function isCreator(i) {
  const c = guildCfg(i.guildId);
  if (isManager(i)) return true;
  return c.creatorRoles.length === 0 ? false : c.creatorRoles.some((r) => i.member.roles.cache.has(r));
}

/* ───────────── embeds / components ───────────── */
function embedFor(g, ended = false) {
  const e = new EmbedBuilder()
    .setTitle(g.prize)
    .setColor(ended ? g.endColor : g.color)
    .setDescription([
      ended ? `${EM.flag} **Ended** <t:${Math.floor(g.endsAt / 1000)}:R>` : g.paused ? (g.pausedReason === 'server' && g.req?.server ? `**Status:** ${EM.pause} Paused until I'm added back to **${g.req.server.name}**` : `**Status:** ${EM.pause} Paused (${shortLeft(g.pausedLeft)} left)`) : `**Ends:** <t:${Math.floor(g.endsAt / 1000)}:R> (<t:${Math.floor(g.endsAt / 1000)}:f>)`,
      `${EM.crown} **Hosted by:** <@${g.host}>`,
      `**Winners:** ${g.winners}`,
      `**Entries:** ${Object.keys(g.entries).length}`,
      BASE && g.messageId ? `${WEB} [View on the website](${BASE}/giveaway/${g.messageId})` : '',
      reqText(g),
      ended ? `\n**Winner(s):** ${g.winnerIds.length ? g.winnerIds.map((w) => `<@${w}>${(g.claimed || []).includes(w) ? ` ${TICK}` : ''}`).join(', ') : 'No valid entries'}` : '',
    ].filter(Boolean).join('\n'))
    .setFooter({ text: ended ? (allClaimed(g) ? 'Giveaway ended • Prize claimed' : 'Giveaway ended') : 'Givevanced' });
  if (g.image) e.setImage(g.image);
  if (g.thumbnail) e.setThumbnail(g.thumbnail);
  return e;
}
function reqText(g) {
  const r = g.req, l = [];
  if (r.roles.length) l.push(`Roles: ${r.roles.map((x) => `<@&${x}>`).join(', ')}`);
  if (r.boosts) l.push('Must be boosting this server');
  if (r.serverTag) l.push("Must have this server's tag equipped");
  if (r.server) l.push(`Must join **${r.server.name}**`);
  if (r.daily) l.push(`${r.daily}+ messages today`);
  if (r.weekly) l.push(`${r.weekly}+ messages this week`);
  if (r.monthly) l.push(`${r.monthly}+ messages this month`);
  if (r.total) l.push(`${r.total}+ total messages`);
  if (g.extra && Object.keys(g.extra).length)
    l.push('Extra entries: ' + Object.entries(g.extra).map(([id, n]) => `<@&${id}> ×${n}`).join(', '));
  return l.length ? `\n${EM.lock} **Requirements**\n${l.map((x) => `• ${x}`).join('\n')}` : '';
}
const enterRow = (g, disabled = false) => {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('gw_enter').setLabel(String(Object.keys(g.entries).length)).setEmoji({ id: CONE_ID }).setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`gw_parts:${g.messageId}`).setLabel('Participants').setEmoji({ id: MEMBERS_ID }).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('gw_remind').setEmoji({ id: BELL_ID }).setStyle(ButtonStyle.Secondary).setDisabled(disabled));
  return row;
};

/* ───────────── core giveaway logic ───────────── */
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });

function pickWinners(g, count, exclude = []) {
  const pool = Object.entries(g.entries).filter(([id]) => !exclude.includes(id));
  const picked = [];
  while (picked.length < count && pool.length) {
    const total = pool.reduce((a, [, w]) => a + w, 0);
    let roll = Math.random() * total, idx = 0;
    for (; idx < pool.length; idx++) { roll -= pool[idx][1]; if (roll <= 0) break; }
    picked.push(pool.splice(Math.min(idx, pool.length - 1), 1)[0][0]);
  }
  return picked;
}
async function fetchMsg(g) {
  const ch = await client.channels.fetch(g.channelId).catch(() => null);
  return { ch, msg: ch ? await ch.messages.fetch(g.messageId).catch(() => null) : null };
}
const allClaimed = (g) => !!g.claimMs && g.winnerIds.length > 0 && g.winnerIds.every((w) => (g.claimed || []).includes(w));
const gLink = (g) => `https://discord.com/channels/${g.guildId}/${g.channelId}/${g.messageId}`;
const linkBtn = (g) => new ButtonBuilder().setLabel('Giveaway Message').setEmoji({ id: GIFT_ID }).setStyle(ButtonStyle.Link).setURL(gLink(g));
const linkRow = (g) => new ActionRowBuilder().addComponents(linkBtn(g));
const claimRow = (g, disabled = false) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gw_claim:${g.messageId}`).setLabel(disabled ? 'Claimed' : 'Claim').setEmoji({ id: TICK_ID }).setStyle(ButtonStyle.Success).setDisabled(disabled),
    linkBtn(g));

async function announce(g, ch, winners) {
  const guild = await client.guilds.fetch(g.guildId).catch(() => null);
  const fill = (t) => t.replaceAll('{prize}', g.prize).replaceAll('{server}', guild?.name ?? '');
  const link = `https://discord.com/channels/${g.guildId}/${g.channelId}/${g.messageId}`;
  const failed = [];
  for (const w of winners) {
    if (g.winnersRole && guild) guild.members.fetch(w).then((m) => m.roles.add(g.winnersRole)).catch(() => {});
    const custom = g.dmMessage ? fill(g.dmMessage) : '';
    if (g.claimMs) {
      // Claim button is sent to the winner's DMs
      const e = new EmbedBuilder().setColor(g.color).setTitle(`${EM.trophy} You won!`)
        .setDescription(`You won **${g.prize}** in **${guild?.name ?? 'a server'}**!\n${EM.hourglass} Click **Claim** <t:${Math.floor(g.claimDeadline / 1000)}:R> or you'll be rerolled.${custom ? `\n\n${custom}` : ''}\n\n[Jump to giveaway](${link})`);
      try {
        const u = await client.users.fetch(w);
        await u.send({ embeds: [e], components: [claimRow(g)] });
      } catch { failed.push(w); }
    } else if (custom) {
      const e = new EmbedBuilder().setColor(g.color).setTitle(`${EM.trophy} You won!`).setDescription(`${custom}\n\n[Jump to giveaway](${link})`);
      client.users.fetch(w).then((u) => u.send({ embeds: [e], components: [linkRow(g)] })).catch(() => {});
    }
  }
  let desc = winners.length
    ? `Congratulations ${winners.map((w) => `<@${w}>`).join(', ')}! You won **${g.prize}**!`
    : `No valid entries for **${g.prize}**, so no winner was chosen.`;
  const payload = { allowedMentions: { users: winners } };
  if (g.claimMs && winners.length) {
    if (failed.length < winners.length) desc += `\n${EM.mail} Check your DMs to claim within <t:${Math.floor(g.claimDeadline / 1000)}:R>.`;
    if (failed.length) {
      desc += `\n${failed.map((w) => `<@${w}>`).join(', ')}: your DMs are closed, so claim here within <t:${Math.floor(g.claimDeadline / 1000)}:R>.`;
      payload.components = [claimRow(g)];
    }
  }
  if (!payload.components) payload.components = [linkRow(g)];
  if (winners.length) payload.content = winners.map((w) => `<@${w}>`).join(' ');   // ping
  payload.embeds = [new EmbedBuilder().setColor(winners.length ? 0x57f287 : 0xed4245).setTitle(`${EM.trophy} Giveaway ended`).setDescription(desc)];
  await ch.send(payload).catch(() => {});
}
async function endGiveaway(g) {
  g.ended = true;
  g.winnerIds = await pickWinnersChecked(g, g.winners);
  g.claimed = [];
  if (g.claimMs) g.claimDeadline = Date.now() + g.claimMs;
  save();
  const { ch, msg } = await fetchMsg(g);
  if (msg) await msg.edit({ embeds: [embedFor(g, true)], components: [enterRow(g, true)] }).catch(() => {});
  if (ch) await announce(g, ch, g.winnerIds);
  notifyReminders(g);
  if (ch && g.endMessage) await sendEndMessage(g, ch);
  if (g.dmHost) dmHostEnded(g);
}
async function rerollUnclaimed(g) {
  const lost = g.winnerIds.filter((w) => !g.claimed.includes(w));
  if (!lost.length) { g.claimDeadline = null; return save(); }
  const keep = g.winnerIds.filter((w) => g.claimed.includes(w));
  const fresh = await pickWinnersChecked(g, lost.length, g.winnerIds);
  g.winnerIds = [...keep, ...fresh];
  g.claimDeadline = fresh.length ? Date.now() + g.claimMs : null;
  save();
  const { ch, msg } = await fetchMsg(g);
  if (msg) await msg.edit({ embeds: [embedFor(g, true)] }).catch(() => {});
  if (ch && fresh.length) await announce(g, ch, fresh);
}
setInterval(async () => {
  for (const g of Object.values(db.giveaways)) {
    try {
      if (client.isReady() && !client.guilds.cache.has(g.guildId)) continue;
      if (!g.ended && !g.paused && g.endsAt <= Date.now()) await endGiveaway(g);
      else if (g.ended && g.claimDeadline && g.claimDeadline <= Date.now()) await rerollUnclaimed(g);
    } catch (e) { console.error(e); }
  }
  await runScheduled();
  await checkRequiredServers().catch((e) => console.error(e));
  await sweepServerRequirements().catch((e) => console.error(e));
  await checkPending().catch((e) => console.error(e));
}, 5000);

/* ───────────── requirement check on entry ───────────── */
const checkEntry = (i, g) => checkEntryFor(i.member, i.user.id, i.guildId, g);
async function checkEntryFor(m, uid, gid, g) {
  const r = g.req;
  if (blacklistOf(gid).includes(uid)) return '🚫 You are blacklisted from giveaways in this server.';
  if (g.bypass.some((x) => m.roles.cache.has(x))) return null;
  const s = statsOf(gid, uid);
  if (r.roles.length && !r.roles.every((x) => m.roles.cache.has(x))) return 'You are missing a required role.';
  if (r.boosts && !m.premiumSince) return 'You need to be boosting this server.';
  if (r.serverTag) {
    const u = await client.users.fetch(uid, { force: true }).catch(() => ({}));
    const pg = u.primaryGuild;
    if (!pg || pg.identityGuildId !== gid || pg.identityEnabled === false) return "You need this server's tag equipped.";
  }
  if (r.daily && countSince(s, 1) < r.daily) return `You need ${r.daily} messages today (you have ${countSince(s, 1)}).`;
  if (r.weekly && countSince(s, weekDays()) < r.weekly) return `You need ${r.weekly} messages this week (you have ${countSince(s, weekDays())}).`;
  if (r.monthly && countSince(s, monthDays()) < r.monthly) return `You need ${r.monthly} messages this month (you have ${countSince(s, monthDays())}).`;
  if (r.total && s.total < r.total) return `You need ${r.total} total messages (you have ${s.total}).`;
  return null;
}
function weightForMember(m, g) {
  let w = 1;
  for (const [role, n] of Object.entries(g.extra || {})) if (m.roles.cache.has(role)) w += n;
  return w;
}
const weightFor = (i, g) => weightForMember(i.member, g);
async function refreshMessage(g) {
  const { msg } = await fetchMsg(g);
  if (msg) await msg.edit({ embeds: [embedFor(g, g.ended)], components: [enterRow(g, g.ended)] }).catch(() => {});
}

/* ───────────── slash command definitions ───────────── */
const gw = new SlashCommandBuilder().setName('giveaway').setDescription('Giveaway commands').setDMPermission(false);
const addGiveawayOptions = (s, afterRequired) => {
  let r = s
    .addStringOption((o) => o.setName('duration').setDescription('How long it lasts, like 1 hour or 2 days, or a Discord timestamp').setRequired(true))
    .addIntegerOption((o) => o.setName('winners').setDescription('The number of winners for this giveaway').setMinValue(1).setMaxValue(50).setRequired(true))
    .addStringOption((o) => o.setName('prize').setDescription('The prize of this giveaway').setRequired(true));
  if (afterRequired) r = afterRequired(r);
  return r
    .addChannelOption((o) => o.setName('channel').setDescription('The channel this giveaway will be created in'))
    .addUserOption((o) => o.setName('host').setDescription('The host of this giveaway'))
    .addStringOption((o) => o.setName('extra-entries').setDescription('Extra entries for roles, e.g. "@role1 5, @role2 10"'))
    .addStringOption((o) => o.setName('giveaway-start-message').setDescription('The message the bot sends when this giveaway starts'))
    .addRoleOption((o) => o.setName('giveaway-winners-role').setDescription('The role the bot gives to the winners'))
    .addStringOption((o) => o.setName('claim-time').setDescription('How long winners have to click Claim before being rerolled, e.g. "24 hours"'))
    .addStringOption((o) => o.setName('giveaway-winners-dm-message').setDescription('DM sent to winners. Use {prize} and {server}'))
    .addAttachmentOption((o) => o.setName('image').setDescription('Image shown at the bottom of the embed'))
    .addAttachmentOption((o) => o.setName('thumbnail').setDescription('Thumbnail shown at the top right of the embed'))
    .addStringOption((o) => o.setName('required-roles').setDescription('Roles required to participate (separate with commas)'))
    .addIntegerOption((o) => o.setName('required-server-boosts').setDescription('Boosts required (the user must be boosting)').setMinValue(1))
    .addBooleanOption((o) => o.setName('require-server-tag').setDescription("Must have this server's tag equipped"))
    .addIntegerOption((o) => o.setName('required-daily-messages').setDescription('Messages required today').setMinValue(1))
    .addIntegerOption((o) => o.setName('required-weekly-messages').setDescription('Messages required this week').setMinValue(1))
    .addIntegerOption((o) => o.setName('required-monthly-messages').setDescription('Messages required this month').setMinValue(1))
    .addIntegerOption((o) => o.setName('required-total-messages').setDescription('Messages required in total').setMinValue(1))
    .addStringOption((o) => o.setName('requirement-bypass-roles').setDescription('Roles that bypass all requirements (separate with commas)'))
    .addStringOption((o) => o.setName('required-server').setDescription('Members must join this server to enter (I must be in it too)').setAutocomplete(true))
    .addStringOption((o) => o.setName('color').setDescription('Embed hex color, e.g. #5865F2'))
    .addStringOption((o) => o.setName('end-color').setDescription('Embed hex color after the giveaway ends'));
};
gw.addSubcommand((s) => addGiveawayOptions(s.setName('create').setDescription('Create a giveaway'))
  .addStringOption((o) => o.setName('giveaway-end-message').setDescription('The message the bot sends when this giveaway ends ({prize} and {winners} work)'))
  .addBooleanOption((o) => o.setName('dm-host').setDescription('DM the host when this giveaway ends')));
gw.addSubcommand((s) => addGiveawayOptions(s.setName('schedule').setDescription('Schedule a giveaway to start later'),
  (r) => r.addStringOption((o) => o.setName('start').setDescription('When it starts, like 2 hours or 1 day, or a Discord timestamp').setRequired(true))
    .addStringOption((o) => o.setName('repeat').setDescription('Repeat every, like 1 day or 1 week (cancel with /giveaway unschedule)'))));
gw.addSubcommand((s) => s.setName('scheduled').setDescription('View giveaways that are scheduled to start'));
gw.addSubcommand((s) => s.setName('unschedule').setDescription('Cancel a scheduled giveaway')
  .addStringOption((o) => o.setName('schedule').setDescription('Pick the scheduled giveaway to cancel').setRequired(true).setAutocomplete(true)));
const idOpt = (s, d) => s.addStringOption((o) => o.setName('message-id').setDescription(d).setRequired(true).setAutocomplete(true));
gw.addSubcommand((s) => s.setName('creator-roles').setDescription('Set roles with which people can only create or schedule giveaways'));
gw.addSubcommand((s) => idOpt(s.setName('delete').setDescription('Delete a giveaway'), 'Giveaway message ID'));
gw.addSubcommand((s) => idOpt(s.setName('edit').setDescription('Edit a giveaway'), 'Giveaway message ID')
  .addStringOption((o) => o.setName('prize').setDescription('New prize'))
  .addIntegerOption((o) => o.setName('winners').setDescription('New winner count').setMinValue(1).setMaxValue(50))
  .addStringOption((o) => o.setName('duration').setDescription('New duration from now, or a Discord timestamp'))
  .addStringOption((o) => o.setName('giveaway-end-message').setDescription('New end message (type none to remove it)'))
  .addBooleanOption((o) => o.setName('dm-host').setDescription('DM the host when it ends (true or false)')));
gw.addSubcommand((s) => idOpt(s.setName('end').setDescription('End a giveaway with the giveaway message ID'), 'Giveaway message ID'));
gw.addSubcommand((s) => idOpt(s.setName('fix').setDescription('Fix a giveaway if it fails to end'), 'Giveaway message ID'));
gw.addSubcommand((s) => s.setName('manager-roles').setDescription('Set roles with which people can use every command in the bot'));
gw.addSubcommand((s) => idOpt(s.setName('participants').setDescription('View the users that have participated in a giveaway'), 'Giveaway message ID'));
gw.addSubcommand((s) => idOpt(s.setName('reroll').setDescription('Reroll the winner of a giveaway with the giveaway message ID'), 'Giveaway message ID'));
gw.addSubcommand((s) => s.setName('list').setDescription('See every running giveaway in this server'));
gw.addSubcommand((s) => idOpt(s.setName('pause').setDescription('Pause a running giveaway'), 'Pick the giveaway to pause'));
gw.addSubcommand((s) => idOpt(s.setName('resume').setDescription('Resume a paused giveaway'), 'Pick the giveaway to resume'));
gw.addSubcommand((s) => idOpt(s.setName('extend').setDescription('Add more time to a running giveaway'), 'Pick the giveaway to extend')
  .addStringOption((o) => o.setName('time').setDescription('How much time to add, like 30 minutes, 2 hours or 1 day').setRequired(true)));
gw.addSubcommand((s) => s.setName('winners').setDescription('See the winners of a giveaway, or recent winners')
  .addStringOption((o) => o.setName('message-id').setDescription('Pick a giveaway (leave empty for recent winners)').setAutocomplete(true)));
gw.addSubcommand((s) => idOpt(s.setName('add-entries').setDescription('Give someone bonus entries'), 'Pick the giveaway')
  .addUserOption((o) => o.setName('user').setDescription('Who gets the entries').setRequired(true))
  .addIntegerOption((o) => o.setName('entries').setDescription('How many entries to add').setRequired(true).setMinValue(1).setMaxValue(100)));
gw.addSubcommand((s) => s.setName('drop').setDescription('Start a drop: the first people to click win')
  .addStringOption((o) => o.setName('prize').setDescription('What is being dropped').setRequired(true))
  .addIntegerOption((o) => o.setName('winners').setDescription('How many people can win (default 1)').setMinValue(1).setMaxValue(20))
  .addChannelOption((o) => o.setName('channel').setDescription('Where to post the drop')));

const messagesCmd = new SlashCommandBuilder().setName('messages').setDescription('View the number of messages you/other user has sent').setDMPermission(false)
  .addUserOption((o) => o.setName('user').setDescription('User to look up'));

/* ───────────── logging, defaults, reminders ───────────── */
async function notifyReminders(g) {
  const list = g.reminders || [];
  if (!list.length) return;
  g.reminders = []; save();
  const e = new EmbedBuilder().setColor(g.endColor).setTitle(`${CONE} Giveaway ended`)
    .setDescription(`**${g.prize}** has ended!\nWinners: ${g.winnerIds.length ? g.winnerIds.map((w) => `<@${w}>`).join(', ') : 'nobody'}\n\n[Jump to giveaway](${gLink(g)})`);
  for (const u of list.slice(0, 500)) {
    client.users.fetch(u).then((x) => x.send({ embeds: [e], components: [linkRow(g)] })).catch(() => {});
    await new Promise((r) => setTimeout(r, 120));
  }
}

/* ───────────── end message and "DM the host" ───────────── */
async function sendEndMessage(g, ch) {
  const winners = (g.winnerIds || []).map((w) => `<@${w}>`).join(', ') || 'nobody';
  const text = g.endMessage.replaceAll('{prize}', g.prize).replaceAll('{winners}', winners)
    .replaceAll('{entries}', String(Object.keys(g.entries).length)).replaceAll('{host}', `<@${g.host}>`);
  const pings = (g.endMessage.match(/<@[&!]?\d+>|@everyone|@here/g) || []).join(' ');   // only pings the host typed themselves
  await ch.send({ content: pings || undefined, embeds: [new EmbedBuilder().setColor(g.endColor).setDescription(text.slice(0, 4000))], allowedMentions: { parse: ['roles', 'users'] } }).catch(() => {});
}
function dmHostEnded(g) {
  const e = new EmbedBuilder().setColor(g.endColor).setTitle(`${EM.flag} Your giveaway ended`).setDescription(`**${g.prize}** has ended.`).addFields(
    { name: 'Winners', value: g.winnerIds.length ? g.winnerIds.map((w) => `<@${w}>`).join(', ') : 'No valid entries' },
    { name: 'Entries', value: String(Object.keys(g.entries).length), inline: true },
    { name: 'Claims', value: g.claimMs ? `${(g.claimed || []).length}/${g.winnerIds.length} claimed so far` : 'No claim needed', inline: true });
  client.users.fetch(g.host).then((u) => u.send({ embeds: [e], components: [linkRow(g)] })).catch(() => {});
}

/* ───────────── drops: first to click wins ───────────── */
const dropOver = (d) => d.claimed.length >= d.winners;
const dropEmbed = (d) => new EmbedBuilder().setColor(dropOver(d) ? 0x2b2d31 : 0xffb340).setTitle(`${CONE} Drop: ${d.prize}`)
  .setDescription(dropOver(d)
    ? `Drop over! Winner${d.winners > 1 ? 's' : ''}: ${d.claimed.map((u) => `<@${u}>`).join(', ')}`
    : `First **${d.winners}** to click **Claim** win${d.winners > 1 ? '' : 's'}!${d.claimed.length ? `\nClaimed so far: ${d.claimed.map((u) => `<@${u}>`).join(', ')}` : ''}\n${EM.crown} Hosted by <@${d.host}>`)
  .setFooter({ text: dropOver(d) ? 'Drop over' : `${d.winners - d.claimed.length} left` });
const dropRow = (d) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('gw_drop').setLabel('Claim').setEmoji({ id: GIFT_ID }).setStyle(ButtonStyle.Success).setDisabled(dropOver(d)));
async function launchDrop(o) {
  const d = { guildId: o.guildId, channelId: o.ch.id, prize: o.prize, winners: o.winners, host: o.host, claimed: [], messageId: null };
  const msg = await o.ch.send({ embeds: [dropEmbed(d)], components: [dropRow(d)] });
  d.messageId = msg.id; (db.drops ??= {})[msg.id] = d; save();
}
async function onDrop(i) {
  const d = (db.drops ??= {})[i.message.id];
  if (!d) return i.reply({ content: 'This drop is no longer available.', ...eph });
  if (dropOver(d)) return i.reply({ content: 'Too late, this drop was already claimed.', ...eph });
  if (d.claimed.includes(i.user.id)) return i.reply({ content: 'You already claimed this drop.', ...eph });
  const fail = await checkEntryFor(i.member, i.user.id, i.guildId, { bypass: [], req: { roles: [], boosts: 0, serverTag: false, daily: 0, weekly: 0, monthly: 0, total: 0 } });
  if (fail) return i.reply({ content: `❌ ${fail}`, ...eph });
  if (dropOver(d)) return i.reply({ content: 'Too late, this drop was already claimed.', ...eph });
  d.claimed.push(i.user.id); save();
  await i.update({ embeds: [dropEmbed(d)], components: [dropRow(d)] });
  await i.followUp({ content: `${GIFT} You got it! You claimed **${d.prize}**.`, ...eph }).catch(() => {});
  if (dropOver(d)) {
    await i.channel.send({ content: d.claimed.map((u) => `<@${u}>`).join(' '), allowedMentions: { users: d.claimed },
      embeds: [new EmbedBuilder().setColor(0x57f287).setTitle(`${CONE} Drop claimed`).setDescription(`${d.claimed.map((u) => `<@${u}>`).join(', ')} won **${d.prize}**! <@${d.host}>, they're ready for their prize.`)] }).catch(() => {});
  }
}
async function dropCommand(i) {
  const ch = i.options.getChannel('channel') || i.channel;
  if (!ch?.isTextBased()) return i.reply({ content: 'Pick a text channel.', ...eph });
  await launchDrop({ guildId: i.guildId, ch, prize: i.options.getString('prize'), winners: i.options.getInteger('winners') || 1, host: i.user.id });
  return i.reply({ content: `✅ Drop started in ${ch}.`, ...eph });
}

/* ───────────── lists and stats ───────────── */
function listGiveaways(i) {
  const live = Object.values(db.giveaways).filter((g) => g.guildId === i.guildId && !g.ended).sort((a, b) => a.endsAt - b.endsAt).slice(0, 15);
  return i.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`${CONE} Running giveaways`)
    .setDescription(live.map((g) => `${g.paused ? EM.pause : '•'} **${g.prize}** · <#${g.channelId}> · ${g.paused ? 'paused' : `ends <t:${Math.floor(g.endsAt / 1000)}:R>`} · ${Object.keys(g.entries).length} entries · [jump](${gLink(g)})`).join('\n').slice(0, 4000)
      || 'No giveaways are running right now.')], allowedMentions: { parse: [] } });
}
async function winnersCmd(i) {
  const id = i.options.getString('message-id');
  if (id) {
    const g = db.giveaways[id];
    if (!g || g.guildId !== i.guildId) return i.reply({ content: 'Giveaway not found.', ...eph });
    if (!g.ended) return i.reply({ content: '❌ That giveaway has not ended yet.', ...eph });
    const lines = g.winnerIds.map((w) => `• <@${w}> ${(g.claimed || []).includes(w) ? `${TICK} claimed` : g.claimMs ? `${EM.hourglass} not claimed` : ''}`);
    return i.reply({ embeds: [new EmbedBuilder().setColor(g.endColor).setTitle(`${EM.trophy} Winners: ${g.prize}`).setDescription(lines.join('\n') || 'No valid entries.')
      .addFields({ name: 'Entries', value: String(Object.keys(g.entries).length), inline: true }, { name: 'Ended', value: `<t:${Math.floor(g.endsAt / 1000)}:R>`, inline: true })], allowedMentions: { parse: [] }, ...eph });
  }
  const recent = Object.values(db.giveaways).filter((g) => g.guildId === i.guildId && g.ended).sort((a, b) => b.endsAt - a.endsAt).slice(0, 10);
  return i.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`${EM.trophy} Recent winners`)
    .setDescription(recent.map((g) => `**${g.prize}**: ${g.winnerIds.length ? g.winnerIds.map((w) => `<@${w}>`).join(', ') : 'no winners'} · <t:${Math.floor(g.endsAt / 1000)}:d>`).join('\n').slice(0, 4000) || 'No giveaways have ended yet.')],
    allowedMentions: { parse: [] }, ...eph });
}
async function myWins(i) {
  const won = Object.values(db.giveaways).filter((g) => g.guildId === i.guildId && g.ended && g.winnerIds.includes(i.user.id)).sort((a, b) => b.endsAt - a.endsAt);
  const drops = Object.values(db.drops || {}).filter((d) => d.guildId === i.guildId && d.claimed.includes(i.user.id));
  const lines = [
    ...won.map((g) => `• **${g.prize}** · <t:${Math.floor(g.endsAt / 1000)}:d> · ${g.claimMs ? ((g.claimed || []).includes(i.user.id) ? `${TICK} claimed` : `${EM.hourglass} not claimed`) : 'won'} · [jump](${gLink(g)})`),
    ...drops.map((d) => `• **${d.prize}** (drop) · [jump](https://discord.com/channels/${d.guildId}/${d.channelId}/${d.messageId})`)];
  return i.reply({ embeds: [new EmbedBuilder().setColor(0xffb340).setTitle(`${EM.trophy} Your wins`).setDescription(lines.slice(0, 15).join('\n').slice(0, 4000) || "You haven't won a giveaway here yet. Good luck!")], ...eph });
}
async function myEntries(i) {
  const mine = Object.values(db.giveaways).filter((g) => g.guildId === i.guildId && !g.ended && g.entries[i.user.id]).sort((a, b) => a.endsAt - b.endsAt);
  return i.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`${MEMBERS} Your entries`)
    .setDescription(mine.slice(0, 15).map((g) => `• **${g.prize}** · ${g.entries[i.user.id]} ${g.entries[i.user.id] === 1 ? 'entry' : 'entries'} · ${g.paused ? 'paused' : `ends <t:${Math.floor(g.endsAt / 1000)}:R>`} · [jump](${gLink(g)})`).join('\n').slice(0, 4000)
      || "You haven't entered any running giveaways.")], ...eph });
}
async function leaderboardCommand(i) {
  const period = i.options.getString('period') || 'total';
  const days = { today: 1, week: weekDays(), month: monthDays() }[period];
  const rows = Object.entries(db.stats[i.guildId] || {}).map(([id, st]) => [id, days ? countSince(st, days) : st.total]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const label = { today: 'Today', week: 'This week', month: 'This month', total: 'All time' }[period];
  const medal = [EM.medal1, EM.medal2, EM.medal3];
  return i.reply({ embeds: [new EmbedBuilder().setColor(0xffb340).setTitle(`${EM.chat} Top chatters: ${label}`)
    .setDescription(rows.map(([id, n], k) => `${medal[k] || `**${k + 1}.**`} <@${id}> · ${n} message${n === 1 ? '' : 's'}`).join('\n') || 'No messages counted yet.')], allowedMentions: { parse: [] } });
}
async function statsCommand(i) {
  const all = Object.values(db.giveaways).filter((g) => g.guildId === i.guildId), live = all.filter((g) => !g.ended);
  const drops = Object.values(db.drops || {}).filter((d) => d.guildId === i.guildId), cfg = guildCfg(i.guildId);
  return i.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`${EM.chart} Giveaway stats`).addFields(
    { name: 'Hosted', value: String(all.length), inline: true }, { name: 'Running', value: String(live.length), inline: true }, { name: 'Ended', value: String(all.length - live.length), inline: true },
    { name: 'Entries in running giveaways', value: String(live.reduce((n, g) => n + Object.keys(g.entries).length, 0)), inline: true },
    { name: 'Winners picked', value: String(all.reduce((n, g) => n + g.winnerIds.length, 0)), inline: true }, { name: 'Drops', value: String(drops.length), inline: true },
    { name: 'Scheduled', value: String(Object.values(scheduledMap()).filter((x) => x.guildId === i.guildId).length), inline: true },
    { name: 'Templates', value: String(Object.keys(cfg.templates || {}).length), inline: true },
    { name: 'Blacklisted', value: `${blacklistOf(i.guildId).length} people`, inline: true })] });
}

/* ───────────── templates ───────────── */
async function templateCommand(i) {
  const sub = i.options.getSubcommand(), tpls = (guildCfg(i.guildId).templates ??= {});
  if (sub === 'save' || sub === 'delete') { if (!isManager(i)) return i.reply({ content: 'You need Manage Server or a manager role.', ...eph }); }
  else if (!isCreator(i)) return i.reply({ content: 'You need Manage Server, a manager role, or a creator role.', ...eph });
  if (sub === 'list') {
    return i.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`${EM.template} Templates`)
      .setDescription(Object.entries(tpls).map(([n, t]) => `• **${n}**: ${t.prize} · ${t.winners} winner${t.winners > 1 ? 's' : ''}`).join('\n').slice(0, 4000) || 'No templates yet. Use `/template save`.')], ...eph });
  }
  const name = i.options.getString('name').trim().slice(0, 32);
  if (sub === 'delete') {
    if (!tpls[name]) return i.reply({ content: '❌ Template not found.', ...eph });
    delete tpls[name]; save();
    return i.reply({ content: `✅ Deleted the template **${name}**.`, ...eph });
  }
  if (sub === 'save') {
    const g = db.giveaways[i.options.getString('message-id')];
    if (!g || g.guildId !== i.guildId) return i.reply({ content: 'Giveaway not found.', ...eph });
    if (!tpls[name] && Object.keys(tpls).length >= 25) return i.reply({ content: '❌ You can have up to 25 templates.', ...eph });
    tpls[name] = JSON.parse(JSON.stringify({ prize: g.prize, winners: g.winners, extra: g.extra, winnersRole: g.winnersRole, claimMs: g.claimMs, dmMessage: g.dmMessage,
      image: g.image, thumbnail: g.thumbnail, color: g.color, endColor: g.endColor, bypass: g.bypass, req: g.req, endMessage: g.endMessage, dmHost: g.dmHost }));
    save();
    return i.reply({ content: `✅ Saved the template **${name}**. Use it with \`/template use\`.`, ...eph });
  }
  const tpl = tpls[name];
  if (!tpl) return i.reply({ content: '❌ Template not found.', ...eph });
  const endsAt = parseDuration(i.options.getString('duration'));
  if (!endsAt || endsAt <= Date.now()) return i.reply({ content: 'Invalid duration. Try `1 hour`, `2 days` or a Discord timestamp.', ...eph });
  const ch = i.options.getChannel('channel') || i.channel;
  if (!ch?.isTextBased()) return i.reply({ content: 'Pick a text channel.', ...eph });
  await launchGiveaway({ ...JSON.parse(JSON.stringify(tpl)), guildId: i.guildId, ch, endsAt, host: i.user.id,
    prize: i.options.getString('prize') || tpl.prize, winners: i.options.getInteger('winners') || tpl.winners });
  return i.reply({ content: `✅ Giveaway started from **${name}** in ${ch}.`, ...eph });
}

/* ───────────── .gv test commands (testers only) ───────────── */
const GV_USERS = ['1411789389163401277', '1423109124803264623'];
const GV_HELP = '`.gv test` or `.gv test help` this list\n`.gv test dummy [giveaway-id] [count]` add dummy users to a giveaway (default: newest running giveaway, 5 users)\n`.gv test undummy [giveaway-id]` remove the dummy users again\n`.gv say <text>` make the bot say something\n`.gv emojis` list every emoji uploaded to the bot';
async function handleGv(m) {
  const args = m.content.trim().split(/\s+/).slice(1), cmd = (args[0] || '').toLowerCase();
  const reply = (e) => m.reply({ embeds: [e], allowedMentions: { repliedUser: false } }).catch(() => {});
  const note = (text, ok = true) => reply(new EmbedBuilder().setColor(ok ? 0x57f287 : 0xed4245).setDescription(`${ok ? TICK : CROSS} ${text}`));
  const showHelp = () => reply(new EmbedBuilder().setColor(0x5865f2).setTitle('🧪 Test commands').setDescription(GV_HELP).setFooter({ text: 'Only testers can use these' }));

  if (cmd === 'say') {
    const text = m.content.replace(/^\s*\.gv\s+say\s*/i, '');
    if (!text.trim()) return note('Say what? Use `.gv say <text>`.', false);
    if (m.guild) await m.delete().catch(() => {});
    return m.channel.send({ content: text.slice(0, 2000), allowedMentions: { parse: ['users', 'roles'] } });
  }
  if (cmd === 'emojis') {
    const list = [...(await client.application.emojis.fetch()).values()];
    if (!list.length) return note('The bot has no emojis uploaded.', false);
    const lines = list.map((e) => `${e.animated ? '<a:' : '<:'}${e.name}:${e.id}> \`:${e.name}:\` \`${e.id}\``);
    const pages = [];
    let cur = '';
    for (const l of lines) { if ((cur + l).length > 3800) { pages.push(cur); cur = ''; } cur += `${l}\n`; }
    pages.push(cur);
    for (let k = 0; k < pages.length; k++) {
      await m.channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`Bot emojis (${list.length})${pages.length > 1 ? ` · page ${k + 1}/${pages.length}` : ''}`).setDescription(pages[k])] });
    }
    return;
  }
  if (cmd === 'test' || cmd === '') {
    const sub = (args[1] || 'help').toLowerCase();
    if (sub === 'help') return showHelp();
    if (sub === 'dummy' || sub === 'undummy') {
      if (!m.guild) return note('Use this in a server.', false);
      const idArg = args.slice(2).find((x) => /^\d{15,}$/.test(x)), countArg = args.slice(2).find((x) => /^\d{1,3}$/.test(x));
      const live = Object.values(db.giveaways).filter((x) => x.guildId === m.guild.id && !x.ended).sort((x, y) => (BigInt(y.messageId) > BigInt(x.messageId) ? 1 : -1));
      const g = idArg ? db.giveaways[idArg] : live[0];
      if (!g || g.guildId !== m.guild.id) return note(idArg ? 'Giveaway not found.' : 'There is no running giveaway in this server.', false);
      g.dummies ??= [];
      if (sub === 'undummy') {
        for (const d of g.dummies) delete g.entries[d];
        const n = g.dummies.length; g.dummies = []; save();
        if (!g.ended) await refreshMessage(g);
        return note(`Removed **${n}** dummy users from **${g.prize}**.`);
      }
      if (g.ended) return note('That giveaway has already ended.', false);
      const count = Math.min(Math.max(parseInt(countArg, 10) || 5, 1), 200);
      let added = 0;
      while (added < count) {
        const id = `99${String(Math.floor(Math.random() * 1e16)).padStart(16, '0')}`;
        if (g.entries[id]) continue;
        g.entries[id] = 1; g.dummies.push(id); added++;
      }
      save(); await refreshMessage(g);
      return note(`Added **${added}** dummy users to **${g.prize}** (now ${Object.keys(g.entries).length} entries). Remove them with \`.gv test undummy\`.`);
    }
  }
  return showHelp();
}

/* ───────────── "join this server to enter" giveaways ───────────── */
async function makeInvite(guild) {
  const me = guild.members.me;
  const ch = [...guild.channels.cache.values()].find((c) => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.permissionsFor(me)?.has('CreateInstantInvite'));
  const inv = ch ? await ch.createInvite({ maxAge: 0, maxUses: 0, unique: false, reason: 'Givevanced giveaway server requirement' }).catch(() => null) : null;
  return inv ? `https://discord.gg/${inv.code}` : null;
}
// input: a server ID (picked from the list) or an invite link
async function resolveRequiredServer(hostGuildId, userId, input) {
  input = String(input || '').trim();
  if (!input) return null;
  let guild = null, invite = null;
  const code = input.match(/(?:discord\.gg|discord(?:app)?\.com\/invite)\/([\w-]+)/i)?.[1];
  if (code) {
    const inv = await client.fetchInvite(code).catch(() => null);
    if (!inv?.guild) return { error: "I couldn't read that invite. Check that it hasn't expired." };
    guild = client.guilds.cache.get(inv.guild.id);
    invite = `https://discord.gg/${inv.code}`;
  } else if (/^\d{15,22}$/.test(input)) guild = client.guilds.cache.get(input);
  else return { error: 'Pick a server from the list, or paste a server ID or an invite link.' };
  if (!guild) return { error: "I'm not in that server yet. Add me there first, then try again." };
  if (guild.id === hostGuildId) return { error: 'Pick a different server. Members are already in this one.' };
  const creator = await guild.members.fetch(userId).catch(() => null);
  if (!creator) return { error: 'You need to be a member of that server to require it.' };
  if (!invite) {
    if (!creator.permissions.has(PermissionFlagsBits.CreateInstantInvite) && !creator.permissions.has(PermissionFlagsBits.ManageGuild)) return { error: "I can't make an invite for that server for you. Paste an invite link for it instead." };
    invite = await makeInvite(guild);
    if (!invite) return { error: "I couldn't create an invite there (I need the Create Invite permission). Paste an invite link instead." };
  }
  return { id: guild.id, name: guild.name, invite, icon: guild.iconURL({ size: 256, extension: 'png' }) };
}
// { ok: true } | { ok: false, guild, unverifiable }
async function serverStatus(g, uid) {
  const rs = g.req?.server;
  if (!rs) return { ok: true };
  const guild = client.guilds.cache.get(rs.id);
  if (!guild) return { ok: false, unverifiable: true };
  const m = await guild.members.fetch(uid).catch((e) => (e?.code === 10007 ? null : undefined));
  if (m === undefined) return { ok: false, unverifiable: true };
  return m ? { ok: true } : { ok: false, guild };
}
async function dropForLeaving(g, uid) {
  delete g.entries[uid];
  client.users.fetch(uid).then((u) => u.send({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle(`${CROSS} Removed from giveaway`)
    .setDescription(`You were removed from the giveaway for **${g.prize}** because you left **${g.req.server.name}**.\nJoin the server again and press Enter again if you still want to take part.`)], components: [linkRow(g)] })).catch(() => {});
}
async function onServerLeave(gid, uid) {
  for (const g of Object.values(db.giveaways)) {
    if (g.ended || g.req?.server?.id !== gid || !g.entries[uid]) continue;
    await dropForLeaving(g, uid); save(); await refreshMessage(g);
  }
}
let sweeping = false;
async function sweepServerRequirements() {
  if (sweeping) return;
  sweeping = true;
  try {
    let budget = 20;
    for (const g of Object.values(db.giveaways)) {
      if (g.ended || g.paused || !g.req?.server || budget <= 0) continue;
      const guild = client.guilds.cache.get(g.req.server.id);
      const ids = Object.keys(g.entries).filter((u) => !(g.dummies || []).includes(u));
      if (!guild || !ids.length) continue;
      let changed = false;
      for (let n = 0; n < Math.min(budget, ids.length); n++) {
        g.sweepAt = ((g.sweepAt ?? -1) + 1) % ids.length;
        budget--;
        const uid = ids[g.sweepAt];
        const m = await guild.members.fetch(uid).catch((e) => (e?.code === 10007 ? null : undefined));
        if (m === null) { await dropForLeaving(g, uid); changed = true; }
      }
      if (changed) { save(); await refreshMessage(g); }
    }
  } finally { sweeping = false; }
}
// picks winners, skipping anyone who left the required server
async function pickWinnersChecked(g, count, exclude = []) {
  const guild = g.req?.server ? client.guilds.cache.get(g.req.server.id) : null;
  if (!guild) return pickWinners(g, count, exclude);
  const out = [], skip = new Set(exclude);
  while (out.length < count) {
    const cand = pickWinners(g, count - out.length, [...skip]);
    if (!cand.length) break;
    const checked = await Promise.all(cand.map(async (u) => {
      if ((g.dummies || []).includes(u)) return [u, true];
      const m = await guild.members.fetch(u).catch((e) => (e?.code === 10007 ? null : undefined));
      return [u, m !== null];
    }));
    for (const [u, ok] of checked) { skip.add(u); if (ok) out.push(u); else delete g.entries[u]; }
  }
  return out;
}

// If I get removed from a required server I can't check anyone, so the giveaway pauses until I'm added back
const addBotUrl = (gid) => `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&permissions=268520449&scope=bot%20applications.commands${gid ? `&guild_id=${gid}&disable_guild_select=true` : ''}`;
async function pauseForServer(g) {
  if (g.ended || g.paused) return;
  g.paused = true; g.pausedReason = 'server'; g.pausedLeft = Math.max(0, g.endsAt - Date.now()); save();
  await refreshMessage(g);
  const rs = g.req.server;
  const e = new EmbedBuilder().setColor(0xed4245).setTitle(`${CROSS} Giveaway paused`)
    .setDescription(`I was removed from **${rs.name}**, which **${g.prize}** requires, so I can no longer check who joined.\nThe giveaway is **paused** and keeps its remaining time. Add me back to **${rs.name}** and it carries on automatically.`);
  if (rs.icon) e.setThumbnail(rs.icon);
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel(`Add me to ${rs.name}`.slice(0, 80)).setStyle(ButtonStyle.Link).setURL(addBotUrl(rs.id)), linkBtn(g));
  const { ch } = await fetchMsg(g);
  if (ch) await ch.send({ embeds: [e], components: [row] }).catch(() => {});
  client.users.fetch(g.host).then((u) => u.send({ embeds: [e], components: [row] })).catch(() => {});
}
async function resumeForServer(g) {
  if (g.ended || !g.paused || g.pausedReason !== 'server') return;
  g.paused = false; g.pausedReason = null; g.endsAt = Date.now() + (g.pausedLeft || 0); save();
  await refreshMessage(g);
  const e = new EmbedBuilder().setColor(0x57f287).setTitle(`${TICK} Giveaway resumed`)
    .setDescription(`I'm back in **${g.req.server.name}**, so **${g.prize}** is running again. It ends <t:${Math.floor(g.endsAt / 1000)}:R>.`);
  const { ch } = await fetchMsg(g);
  if (ch) await ch.send({ embeds: [e], components: [linkRow(g)] }).catch(() => {});
}
async function checkRequiredServers() {
  if (!client.isReady()) return;
  for (const g of Object.values(db.giveaways)) {
    const id = g.req?.server?.id;
    if (!id || g.ended) continue;
    const here = client.guilds.cache.has(id);
    if (!here && !g.paused) await pauseForServer(g);
    else if (here && g.paused && g.pausedReason === 'server') await resumeForServer(g);
  }
}

// People who pressed Enter but are not in the required server yet: we enter them the moment they join
const pendingUi = new Map();   // "giveawayId:userId" -> the interaction whose private message we edit
async function autoConfirm(g, uid) {
  if (!g.pending?.[uid]) return;
  const key = `${g.messageId}:${uid}`, ui = pendingUi.get(key);
  delete g.pending[uid]; pendingUi.delete(key); save();
  const say = async (embed) => {
    if (ui) { try { return await ui.editReply({ content: '', embeds: [embed], components: [] }); } catch { /* the 15 minute window passed */ } }
    client.users.fetch(uid).then((u) => u.send({ embeds: [embed], components: [linkRow(g)] })).catch(() => {});
  };
  const red = (t) => new EmbedBuilder().setColor(0xed4245).setDescription(`${CROSS} ${t}`);
  if (g.ended) return say(red(`The giveaway for **${g.prize}** has already ended.`));
  if (g.paused) return say(red(`The giveaway for **${g.prize}** is paused. Press Enter again once it resumes.`));
  if (g.entries[uid]) return;
  if ((g.removed || []).includes(uid)) return say(red('You were removed from this giveaway by a moderator.'));
  const hg = client.guilds.cache.get(g.guildId), m = hg ? await hg.members.fetch(uid).catch(() => null) : null;
  if (!m) return;
  const fail = await checkEntryFor(m, uid, g.guildId, g);
  if (fail) return say(red(fail));
  g.entries[uid] = weightForMember(m, g); save(); refreshMessage(g);
  const w = g.entries[uid];
  const okIcon = client.guilds.cache.get(g.req.server.id)?.iconURL({ size: 256, extension: 'png' }) || g.req.server.icon;
  return say(new EmbedBuilder().setColor(0x57f287).setTitle(`${TICK} Entry Confirmed!`).setThumbnail(okIcon || null)
    .setDescription(`You joined **${g.req.server.name}** and your entry for **${g.prize}** is confirmed!${w > 1 ? `\nYou have **${w}** entries.` : ''}\nStay in the server or you'll be removed.`));
}
async function onServerJoin(gid, uid) {
  for (const g of Object.values(db.giveaways)) if (!g.ended && g.req?.server?.id === gid && g.pending?.[uid]) await autoConfirm(g, uid);
}
async function checkPending() {
  let budget = 15;
  for (const g of Object.values(db.giveaways)) {
    if (!g.pending) continue;
    for (const [uid, at] of Object.entries(g.pending)) {
      if (g.ended || Date.now() - at > 30 * 60 * 1000) { delete g.pending[uid]; pendingUi.delete(`${g.messageId}:${uid}`); save(); continue; }
      const guild = client.guilds.cache.get(g.req?.server?.id);
      if (!guild || budget-- <= 0) continue;
      const m = await guild.members.fetch(uid).catch((e) => (e?.code === 10007 ? null : undefined));
      if (m) await autoConfirm(g, uid);
    }
  }
}

// the whole "click Enter" flow, shared by the Enter and "I've joined" buttons
async function tryEnter(i, g, respond) {
  if (!g || g.ended) return respond({ content: 'This giveaway has ended.' });
  if (g.paused) return respond({ content: g.pausedReason === 'server' && g.req?.server ? `${EM.pause} This giveaway is paused until I'm added back to **${g.req.server.name}**. Try again once it resumes.` : `${EM.pause} This giveaway is paused. Try again once it resumes.` });
  const uid = i.user.id;
  if (g.entries[uid]) {
    const n = g.entries[uid];
    return respond({ content: `✅ You've already joined this giveaway (${n} ${n === 1 ? 'entry' : 'entries'}).`,
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`gw_leave:${g.messageId}`).setLabel('Leave giveaway').setStyle(ButtonStyle.Danger))] });
  }
  if ((g.removed || []).includes(uid)) return respond({ content: '❌ You were removed from this giveaway by a moderator.' });
  const fail = await checkEntry(i, g);
  if (fail) return respond({ content: `❌ ${fail}` });
  const rs = g.req.server;
  if (rs) {
    const st = await serverStatus(g, uid);
    if (!st.ok) {
      if (st.unverifiable) return respond({ content: "❌ I can't check the required server right now. Please tell the host." });
      g.pending ??= {}; g.pending[uid] = Date.now(); save();
      pendingUi.set(`${g.messageId}:${uid}`, i);
      const e = new EmbedBuilder().setColor(0x5865f2).setTitle(`${MEMBERS} Join ${rs.name} to enter`)
        .setDescription(`To enter **${g.prize}** you need to be a member of **${rs.name}**.\nJoin the server with the button below. **I'll enter you automatically as soon as you join.**\nIf you leave the server later, you'll be removed from the giveaway.`);
      const icon = st.guild?.iconURL({ size: 256, extension: 'png' }) || rs.icon;
      if (icon) e.setThumbnail(icon).setAuthor({ name: rs.name, iconURL: icon });
      return respond({ embeds: [e], components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Join server').setEmoji({ id: MEMBERS_ID }).setStyle(ButtonStyle.Link).setURL(rs.invite))] });
    }
  }
  g.entries[uid] = weightFor(i, g);
  if (g.pending) { delete g.pending[uid]; pendingUi.delete(`${g.messageId}:${uid}`); }
  save();
  refreshMessage(g);
  const w = g.entries[uid];
  return respond({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle(`${TICK} Entry Confirmed!`)
    .setDescription(`Your entry for the giveaway of **${g.prize}** is confirmed!${w > 1 ? `\nYou have **${w}** entries.` : ''}${rs ? `\nStay in **${rs.name}** or you'll be removed.` : ''}`)], components: [] });
}

const textCh = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const templateCmd = new SlashCommandBuilder().setName('template').setDescription('Save and reuse giveaway settings').setDMPermission(false)
  .addSubcommand((s) => s.setName('save').setDescription("Save a giveaway's settings as a template")
    .addStringOption((o) => o.setName('name').setDescription('Template name').setRequired(true).setMaxLength(32))
    .addStringOption((o) => o.setName('message-id').setDescription('Pick the giveaway to copy').setRequired(true).setAutocomplete(true)))
  .addSubcommand((s) => s.setName('use').setDescription('Start a giveaway from a template')
    .addStringOption((o) => o.setName('name').setDescription('Pick a template').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('duration').setDescription('How long it lasts, like 1 hour or 2 days').setRequired(true))
    .addChannelOption((o) => o.setName('channel').setDescription('Where to post it').addChannelTypes(...textCh))
    .addStringOption((o) => o.setName('prize').setDescription('Use a different prize'))
    .addIntegerOption((o) => o.setName('winners').setDescription('Use a different winner count').setMinValue(1).setMaxValue(50)))
  .addSubcommand((s) => s.setName('list').setDescription('See your saved templates'))
  .addSubcommand((s) => s.setName('delete').setDescription('Delete a template')
    .addStringOption((o) => o.setName('name').setDescription('Pick a template').setRequired(true).setAutocomplete(true)));
const leaderboardCmd = new SlashCommandBuilder().setName('leaderboard').setDescription('Server leaderboards').setDMPermission(false)
  .addSubcommand((s) => s.setName('messages').setDescription('Top chatters in this server')
    .addStringOption((o) => o.setName('period').setDescription('Time period').addChoices({ name: 'Today', value: 'today' }, { name: 'This week', value: 'week' }, { name: 'This month', value: 'month' }, { name: 'All time', value: 'total' })));
const mywinsCmd = new SlashCommandBuilder().setName('mywins').setDescription('See the giveaways you won in this server').setDMPermission(false);
const myentriesCmd = new SlashCommandBuilder().setName('myentries').setDescription('See the running giveaways you have entered').setDMPermission(false);
const statsCmd = new SlashCommandBuilder().setName('stats').setDescription('Giveaway stats for this server').setDMPermission(false);
const helpCmd = new SlashCommandBuilder().setName('help').setDescription('How to use Givevanced').setDMPermission(false);
const blacklistCmd = new SlashCommandBuilder().setName('blacklist').setDescription('Stop people from joining giveaways in this server').setDMPermission(false)
  .addSubcommand((s) => s.setName('add').setDescription('Blacklist a person').addUserOption((o) => o.setName('user').setDescription('The person to blacklist').setRequired(true)))
  .addSubcommand((s) => s.setName('remove').setDescription('Remove a person from the blacklist').addUserOption((o) => o.setName('user').setDescription('The person to remove').setRequired(true)))
  .addSubcommand((s) => s.setName('list').setDescription('View everyone who is blacklisted'));

/* ───────────── /help: pick any command for detailed help ───────────── */
const WHO = { all: 'Everyone', create: 'Creator roles, manager roles or Manage Server', mgr: 'Manage Server or a manager role' };
const PICK = 'Pick a giveaway from the list that appears as you type. Typing part of the prize narrows it down.';
const HELP_CMDS = [
  { id: 'giveaway create', desc: 'Start a giveaway', who: WHO.create,
    usage: '/giveaway create duration:<time> winners:<number> prize:<text> [options]',
    opts: [['duration', 'how long it lasts: `1 hour`, `2 days` or a Discord timestamp (required)'], ['winners', 'how many people win (required)'], ['prize', 'what is being given away (required)'],
      ['channel', 'where to post it (default: this channel)'], ['host', 'who is hosting (default: you)'], ['extra-entries', 'bonus entries for roles, like `@Booster 5, @VIP 3`'],
      ['giveaway-start-message', 'an extra message posted when it starts'], ['giveaway-end-message', 'a message posted when it ends (`{prize}`, `{winners}`, `{entries}` and `{host}` work)'], ['dm-host', 'DM the host a summary when it ends'], ['giveaway-winners-role', 'role given to every winner'], ['claim-time', 'how long winners have to press Claim, like `24 hours`'],
      ['giveaway-winners-dm-message', 'DM sent to winners (`{prize}` and `{server}` work)'], ['image / thumbnail', 'pictures for the giveaway embed'],
      ['required-roles', 'roles needed to enter (mention them, separate with commas)'], ['required-server-boosts', 'entrant must be boosting this server'], ['require-server-tag', "entrant must have this server's tag equipped"],
      ['required-daily / weekly / monthly / total-messages', 'minimum message counts'], ['required-server', 'members must join another server first (the bot must be in both). They are entered automatically once they join, and removed if they leave'],
      ['requirement-bypass-roles', 'roles that skip every requirement'], ['color / end-color', 'hex colours before and after it ends']],
    example: '/giveaway create duration:1 day winners:2 prize:Discord Nitro required-roles:@Member', notes: 'Members click the party button to enter and click it again to leave.' },
  { id: 'giveaway schedule', desc: 'Start a giveaway at a later time', who: WHO.create,
    usage: '/giveaway schedule duration:<time> winners:<number> prize:<text> start:<when> [repeat:<every>] [options]',
    opts: [['start', 'when it begins: `2 hours`, `1 day` or a Discord timestamp, up to 90 days ahead (required)'], ['repeat', 'run it again every `1 day`, `1 week` and so on (must be longer than the duration)'], ['duration', 'how long it runs once started (a length, not a timestamp)'], ['everything else', 'all the options of /giveaway create work here too, except giveaway-end-message and dm-host (set those afterwards with /giveaway edit)']],
    example: '/giveaway schedule duration:1 day winners:1 prize:Nitro start:2 hours repeat:1 week', notes: 'Cancel it with /giveaway unschedule. Pictures you attach can expire before a start that is far away.' },
  { id: 'giveaway scheduled', desc: 'See giveaways waiting to start', who: WHO.mgr, usage: '/giveaway scheduled', opts: [], example: '/giveaway scheduled', notes: 'Shows the start time, channel and repeat for each one.' },
  { id: 'giveaway unschedule', desc: 'Cancel a scheduled giveaway', who: WHO.mgr, usage: '/giveaway unschedule schedule:<pick>', opts: [['schedule', 'pick the scheduled giveaway from the list. For a repeating one this stops the whole series']], example: '/giveaway unschedule schedule:Nitro', notes: '' },
  { id: 'giveaway drop', desc: 'Start a drop: the first people to click win', who: WHO.create, usage: '/giveaway drop prize:<text> [winners:<number>] [channel:<#channel>]',
    opts: [['prize', 'what is being dropped (required)'], ['winners', 'how many people can win, 1 to 20 (default 1)'], ['channel', 'where to post it (default: this channel)']],
    example: '/giveaway drop prize:Steam key winners:2', notes: 'There is no timer. The drop ends when every spot is claimed. Blacklisted people cannot claim.' },
  { id: 'giveaway list', desc: 'See every running giveaway', who: WHO.all, usage: '/giveaway list', opts: [], example: '/giveaway list', notes: 'Shows the prize, channel, time left, entries and a link to each giveaway.' },
  { id: 'giveaway end', desc: 'End a giveaway early and pick winners', who: WHO.mgr, usage: '/giveaway end message-id:<pick>', opts: [['message-id', PICK + ' Only running giveaways are listed.']], example: '/giveaway end message-id:Nitro', notes: 'Winners are announced straight away.' },
  { id: 'giveaway reroll', desc: 'Pick new winners for an ended giveaway', who: WHO.mgr, usage: '/giveaway reroll message-id:<pick>', opts: [['message-id', PICK + ' Only ended giveaways are listed.']], example: '/giveaway reroll message-id:Nitro', notes: 'Anyone who left the required server is skipped, and the claim timer restarts.' },
  { id: 'giveaway winners', desc: 'See winners and who claimed', who: WHO.mgr, usage: '/giveaway winners [message-id:<pick>]', opts: [['message-id', 'pick an ended giveaway to see its winners and claims. Leave it empty to see the last 10 giveaways and their winners']], example: '/giveaway winners', notes: '' },
  { id: 'giveaway participants', desc: 'See everyone who entered', who: WHO.mgr, usage: '/giveaway participants message-id:<pick>', opts: [['message-id', PICK]], example: '/giveaway participants message-id:Nitro', notes: 'The Participants button on a giveaway shows the same list, with paging and a Remove button for managers.' },
  { id: 'giveaway edit', desc: 'Change a giveaway', who: WHO.mgr, usage: '/giveaway edit message-id:<pick> [prize:<text>] [winners:<number>] [duration:<time>]',
    opts: [['message-id', PICK], ['prize', 'a new prize'], ['winners', 'a new winner count'], ['duration', 'a new end time counted from now (running giveaways only)'], ['giveaway-end-message', 'a new end message, or `none` to remove it'], ['dm-host', 'turn the DM to the host on or off']], example: '/giveaway edit message-id:Nitro duration:3 hours', notes: 'Leave out anything you do not want to change.' },
  { id: 'giveaway pause', desc: 'Freeze a running giveaway', who: WHO.mgr, usage: '/giveaway pause message-id:<pick>', opts: [['message-id', PICK + ' Only running giveaways are listed.']], example: '/giveaway pause message-id:Nitro', notes: 'The timer stops and nobody can join until you resume it. The time left is kept.' },
  { id: 'giveaway resume', desc: 'Carry on a paused giveaway', who: WHO.mgr, usage: '/giveaway resume message-id:<pick>', opts: [['message-id', PICK + ' Only paused giveaways are listed.']], example: '/giveaway resume message-id:Nitro', notes: 'It ends after the time that was left when you paused it.' },
  { id: 'giveaway extend', desc: 'Add more time to a running giveaway', who: WHO.mgr, usage: '/giveaway extend message-id:<pick> time:<amount>',
    opts: [['message-id', PICK + ' Only running giveaways are listed.'], ['time', 'how much to add: `30 minutes`, `2 hours`, `1 day` (up to 60 days at once)']], example: '/giveaway extend message-id:Nitro time:2 hours', notes: 'A paused giveaway keeps the extra time for when it resumes.' },
  { id: 'giveaway add-entries', desc: 'Give someone bonus entries', who: WHO.mgr, usage: '/giveaway add-entries message-id:<pick> user:<@user> entries:<1-100>', opts: [['message-id', PICK], ['user', 'who gets the entries'], ['entries', 'how many to add, 1 to 100']], example: '/giveaway add-entries message-id:Nitro user:@Sam entries:5', notes: 'This adds to what they already have. Bots and blacklisted people are blocked.' },
  { id: 'giveaway delete', desc: 'Delete a giveaway and its message', who: WHO.mgr, usage: '/giveaway delete message-id:<pick>', opts: [['message-id', PICK]], example: '/giveaway delete message-id:Nitro', notes: 'This cannot be undone.' },
  { id: 'giveaway fix', desc: 'Fix a giveaway that failed to end', who: WHO.mgr, usage: '/giveaway fix message-id:<pick>', opts: [['message-id', PICK + ' Only running giveaways are listed.']], example: '/giveaway fix message-id:Nitro', notes: 'Ends it if its time is up, or refreshes its message if not.' },
  { id: 'giveaway manager-roles', desc: 'Choose who can use every command', who: WHO.mgr, usage: '/giveaway manager-roles', opts: [], example: '/giveaway manager-roles', notes: 'Opens a role picker. Choose none to clear it. Members with Manage Server can always do everything.' },
  { id: 'giveaway creator-roles', desc: 'Choose who can only create giveaways', who: WHO.mgr, usage: '/giveaway creator-roles', opts: [], example: '/giveaway creator-roles', notes: 'Creators can use create, schedule, drop and templates, but not manage other giveaways.' },
  { id: 'template save', desc: "Save a giveaway's settings under a name", who: WHO.mgr, usage: '/template save name:<text> message-id:<pick>', opts: [['name', 'a name for the template (up to 32 characters)'], ['message-id', PICK]], example: '/template save name:weekly message-id:Nitro', notes: 'You can keep up to 25 templates.' },
  { id: 'template use', desc: 'Start a giveaway from a template', who: WHO.create, usage: '/template use name:<pick> duration:<time> [channel:<#channel>] [prize:<text>] [winners:<number>]', opts: [['name', 'pick a saved template'], ['duration', 'how long it lasts'], ['channel', 'where to post it'], ['prize / winners', 'use these instead of the saved ones']], example: '/template use name:weekly duration:1 day', notes: '' },
  { id: 'template list', desc: 'See your saved templates', who: WHO.create, usage: '/template list', opts: [], example: '/template list', notes: '' },
  { id: 'template delete', desc: 'Delete a template', who: WHO.mgr, usage: '/template delete name:<pick>', opts: [['name', 'pick the template to delete']], example: '/template delete name:weekly', notes: '' },
  { id: 'blacklist add', desc: 'Stop a person from joining giveaways', who: WHO.mgr, usage: '/blacklist add user:<@user>', opts: [['user', 'the person to block']], example: '/blacklist add user:@Sam', notes: 'They are removed from running giveaways and cannot join new ones.' },
  { id: 'blacklist remove', desc: 'Let a blacklisted person join again', who: WHO.mgr, usage: '/blacklist remove user:<@user>', opts: [['user', 'the person to unblock']], example: '/blacklist remove user:@Sam', notes: '' },
  { id: 'blacklist list', desc: 'See everyone who is blacklisted', who: WHO.mgr, usage: '/blacklist list', opts: [], example: '/blacklist list', notes: '' },
  { id: 'leaderboard messages', desc: 'Top chatters in the server', who: WHO.all, usage: '/leaderboard messages [period:<today|week|month|total>]', opts: [['period', 'Today, This week, This month or All time (default: all time)']], example: '/leaderboard messages period:week', notes: 'Counts messages sent after the bot joined.' },
  { id: 'messages', desc: 'View message counts', who: WHO.all, usage: '/messages [user:<@user>]', opts: [['user', 'whose counts to see (default: you)']], example: '/messages user:@Sam', notes: 'Shows today, this week, this month and total.' },
  { id: 'mywins', desc: 'See the giveaways you won', who: WHO.all, usage: '/mywins', opts: [], example: '/mywins', notes: 'Only you can see the reply.' },
  { id: 'myentries', desc: 'See the running giveaways you are in', who: WHO.all, usage: '/myentries', opts: [], example: '/myentries', notes: 'Only you can see the reply.' },
  { id: 'stats', desc: 'Giveaway stats for this server', who: WHO.all, usage: '/stats', opts: [], example: '/stats', notes: '' },
  { id: 'help', desc: 'This menu', who: WHO.all, usage: '/help', opts: [], example: '/help', notes: 'Pick any command from the menus to see how to use it.' },
];
function helpRows(selected) {
  const groups = [['help_giveaway', 'Giveaway commands', HELP_CMDS.filter((c) => c.id.startsWith('giveaway '))], ['help_other', 'Other commands', HELP_CMDS.filter((c) => !c.id.startsWith('giveaway '))]];
  return groups.map(([cid, placeholder, list]) => new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(cid).setPlaceholder(placeholder)
    .addOptions(list.map((c) => ({ label: `/${c.id}`, description: c.desc.slice(0, 100), value: c.id, default: c.id === selected })))));
}
function helpLinkRow(back) {
  const row = new ActionRowBuilder();
  if (back) row.addComponents(new ButtonBuilder().setCustomId('help_back').setLabel('Back to help').setStyle(ButtonStyle.Secondary));
  if (BASE) row.addComponents(new ButtonBuilder().setLabel('Dashboard').setEmoji({ id: WEB_ID }).setStyle(ButtonStyle.Link).setURL(`${BASE}/dashboard`));
  row.addComponents(new ButtonBuilder().setLabel('Add to your server').setStyle(ButtonStyle.Link).setURL(`https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&permissions=268520449&scope=bot%20applications.commands`));
  return row;
}
function helpDetail(c) {
  const opts = c.opts.length ? c.opts.map(([n, t]) => `• **${n}**: ${t}`).join('\n') : 'This command has no options.';
  return new EmbedBuilder().setColor(0x5865f2).setTitle(`/${c.id}`)
    .setDescription(`${c.desc}\n\n**Who can use it:** ${c.who}\n\n**How to use it**\n\`\`\`\n${c.usage}\n\`\`\`\n**Options**\n${opts}\n\n**Example**\n\`\`\`\n${c.example}\n\`\`\`${c.notes ? `\n${c.notes}` : ''}`.slice(0, 4090))
    .setFooter({ text: 'Pick another command from the menus below' });
}
function helpSelect(i) {
  const c = HELP_CMDS.find((x) => x.id === i.values[0]);
  if (!c) return i.update(helpMessage());
  return i.update({ content: '', embeds: [helpDetail(c)], components: [...helpRows(c.id), helpLinkRow(true)] });
}

function helpMessage() {
  const e = new EmbedBuilder().setColor(0x5865f2).setTitle(`${CONE} Givevanced Help`)
    .setDescription(`The free, advanced giveaway bot. Click the ${CONE} button on a giveaway to enter, and click it again to leave.\n**Pick a command from the menus below to see exactly how to use it.**`)
    .addFields(
      { name: `${GIFT} Giveaways`, value: '`/giveaway create` start a giveaway\n`/giveaway schedule` start one later\n`/giveaway scheduled` and `unschedule` view or cancel them\n`/giveaway end` end one early\n`/giveaway reroll` pick new winners\n`/giveaway edit` change the prize, winners or time\n`/giveaway delete` remove a giveaway\n`/giveaway fix` repair one that failed to end\n`/giveaway participants` see who entered' },
      { name: `${EM.wrench} Setup`, value: '`/giveaway manager-roles` who can use every command\n`/giveaway creator-roles` who can only create giveaways' },
      { name: '🧰 More tools', value: '`/giveaway list` running giveaways\n`/giveaway pause` and `resume`\n`/giveaway winners` winners and claims\n`/giveaway add-entries` bonus entries\n`/giveaway drop` first to click wins\n`/template` save and reuse settings\n🔔 button on a giveaway: DM me when it ends' },
      { name: `${EM.chart} Info`, value: '`/mywins` `/myentries` `/stats` `/messages`\n`/leaderboard messages` top chatters\n`/blacklist add`, `remove`, `list`\n`/help` this menu' },
      { name: '✨ Good to know', value: '• Winners get a **Claim** button in their DMs when a claim time is set\n• Requirements: roles, boosting, server tag, message counts, or joining another server\n• Commands that need a giveaway let you pick it from a list\n• Create and manage giveaways from the website dashboard' })
    .setFooter({ text: 'Made by @lav1nrules' });
  return { embeds: [e], components: [...helpRows(), helpLinkRow(false)] };
}
async function blacklistCommand(i) {
  if (!isManager(i)) return i.reply({ content: 'You need Manage Server or a manager role.', ...eph });
  const sub = i.options.getSubcommand(), bl = blacklistOf(i.guildId);
  if (sub === 'list') return i.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`${EM.no} Giveaway blacklist`)
    .setDescription(bl.map((u, n) => `${n + 1}. <@${u}>`).join('\n').slice(0, 4000) || 'Nobody is blacklisted.')], allowedMentions: { parse: [] }, ...eph });
  const u = i.options.getUser('user');
  if (sub === 'add') {
    if (u.bot) return i.reply({ content: "❌ You can't blacklist a bot.", ...eph });
    await addBlacklist(i.guildId, u.id);
    return i.reply({ content: `✅ <@${u.id}> is blacklisted. They were removed from live giveaways and can't join new ones.`, allowedMentions: { parse: [] }, ...eph });
  }
  const idx = bl.indexOf(u.id);
  if (idx < 0) return i.reply({ content: '❌ That person is not blacklisted.', ...eph });
  bl.splice(idx, 1); save();
  return i.reply({ content: `✅ <@${u.id}> was removed from the blacklist.`, allowedMentions: { parse: [] }, ...eph });
}

client.on('guildDelete', (gd) => { if (gd.available !== false) checkRequiredServers().catch(console.error); });
client.on('guildCreate', () => { checkRequiredServers().catch(console.error); });
client.on('guildMemberAdd', (m) => { onServerJoin(m.guild.id, m.id).catch(console.error); });
client.on('guildMemberRemove', (m) => { onServerLeave(m.guild.id, m.id).catch(console.error); });

client.once('ready', async () => {
  const rest = new REST().setToken(process.env.TOKEN);
  const body = [gw, messagesCmd, helpCmd, blacklistCmd, templateCmd, leaderboardCmd, mywinsCmd, myentriesCmd, statsCmd].map((c) => c.toJSON());
  const route = process.env.GUILD_ID
    ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID)
    : Routes.applicationCommands(process.env.CLIENT_ID);
  await rest.put(route, { body });
  // Scrolling status: the text slides one character every STATUS_SPEED ms and loops
  const MARQUEE = 'givevanced.is-a.bot | Made by @lav1nrules ✦ ';
  const WINDOW = 24;          // characters shown at once
  const STATUS_SPEED = 2000;  // ms between updates (Discord may drop updates if this is too fast)
  let pos = 0;
  const rotate = () => {
    const text = (MARQUEE + MARQUEE).slice(pos, pos + WINDOW).trim();
    pos = (pos + 1) % MARQUEE.length;
    client.user.setPresence({ activities: [{ name: text, type: ActivityType.Playing }], status: 'online' });
  };
  rotate();
  setInterval(rotate, STATUS_SPEED);
  console.log(`Givevanced online as ${client.user.tag}`);
});

/* ───────────── message tracking ───────────── */
client.on('messageCreate', (m) => {
  if (!m.author.bot && GV_USERS.includes(m.author.id) && /^\.gv(\s|$)/i.test(m.content || '')) { handleGv(m).catch(console.error); return; }
  if (!m.guild || m.author.bot) return;
  const s = statsOf(m.guild.id, m.author.id);
  s.total++; s.days[day()] = (s.days[day()] || 0) + 1;
  save();
});

/* ───────────── interactions ───────────── */
const eph = { flags: MessageFlags.Ephemeral };
client.on('interactionCreate', async (i) => {
  for (const m of ['reply', 'update', 'followUp', 'editReply']) {
    if (typeof i[m] === 'function') { const f = i[m].bind(i); i[m] = (o) => f(embedify(o)); }
  }
  try {
    if (i.isAutocomplete()) return await onAutocomplete(i);
    if (i.isButton()) return await onButton(i);
    if (i.isRoleSelectMenu()) return await onRoleSelect(i);
    if (i.isStringSelectMenu()) return await onStringSelect(i);
    if (i.isModalSubmit()) return await onModal(i);
    if (!i.isChatInputCommand()) return;

    if (i.commandName === 'messages') {
      const u = i.options.getUser('user') || i.user, s = statsOf(i.guildId, u.id);
      return i.reply({ embeds: [new EmbedBuilder().setTitle(`Messages: ${u.username}`).setColor(0x5865f2).addFields(
        { name: 'Today', value: String(countSince(s, 1)), inline: true },
        { name: 'This week', value: String(countSince(s, weekDays())), inline: true },
        { name: 'This month', value: String(countSince(s, monthDays())), inline: true },
        { name: 'Total', value: String(s.total), inline: true })] });
    }

    if (i.commandName === 'template') return await templateCommand(i);
    if (i.commandName === 'leaderboard') return await leaderboardCommand(i);
    if (i.commandName === 'mywins') return await myWins(i);
    if (i.commandName === 'myentries') return await myEntries(i);
    if (i.commandName === 'stats') return await statsCommand(i);
    if (i.commandName === 'help') return i.reply({ ...helpMessage(), ...eph });
    if (i.commandName === 'blacklist') return await blacklistCommand(i);
    const sub = i.options.getSubcommand();
    if (sub === 'manager-roles' || sub === 'creator-roles') {
      if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild) && !isManager(i))
        return i.reply({ content: 'You need Manage Server or a manager role.', ...eph });
      return i.reply({ content: `Select the **${sub === 'manager-roles' ? 'manager' : 'creator'}** roles (select none to clear):`,
        components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`cfg:${sub}`).setMinValues(0).setMaxValues(10))], ...eph });
    }
    if (sub === 'list') return listGiveaways(i);
    if (sub === 'create' || sub === 'schedule' || sub === 'drop') {
      if (!isCreator(i)) return i.reply({ content: 'You need Manage Server, a manager role, or a creator role.', ...eph });
      return await (sub === 'create' ? createGiveaway(i) : sub === 'schedule' ? scheduleGiveaway(i) : dropCommand(i));
    }
    if (!isManager(i)) return i.reply({ content: 'You need Manage Server or a manager role.', ...eph });
    if (sub === 'scheduled') return scheduledList(i);
    if (sub === 'winners') return winnersCmd(i);
    if (sub === 'unschedule') return unschedule(i);
    const g = db.giveaways[i.options.getString('message-id')];
    if (!g || g.guildId !== i.guildId) return i.reply({ content: 'Giveaway not found.', ...eph });

    if (sub === 'extend') {
      if (g.ended) return i.reply({ content: '❌ That giveaway has already ended.', ...eph });
      const timeStr = i.options.getString('time'), add = /<t:\d+/.test(timeStr) ? null : parseMs(timeStr);
      if (!add || add < 1000) return i.reply({ content: 'Invalid time. Try `30 minutes`, `2 hours` or `1 day`.', ...eph });
      if (add > 60 * 864e5) return i.reply({ content: 'Invalid time. You can add up to 60 days at once.', ...eph });
      if (g.paused) g.pausedLeft = (g.pausedLeft || 0) + add; else g.endsAt += add;
      save(); await refreshMessage(g);
      return i.reply({ content: `✅ Added **${shortLeft(add)}** to **${g.prize}**. ${g.paused ? `It is paused with ${shortLeft(g.pausedLeft)} left.` : `It now ends <t:${Math.floor(g.endsAt / 1000)}:R>.`}`, ...eph });
    }
    if (sub === 'pause') {
      if (g.ended) return i.reply({ content: '❌ That giveaway has already ended.', ...eph });
      if (g.paused) return i.reply({ content: '❌ That giveaway is already paused.', ...eph });
      g.paused = true; g.pausedReason = 'manual'; g.pausedLeft = Math.max(0, g.endsAt - Date.now()); save(); await refreshMessage(g);
      return i.reply({ content: `✅ Paused **${g.prize}** with ${shortLeft(g.pausedLeft)} left. Nobody can join until you resume it.`, ...eph });
    }
    if (sub === 'resume') {
      if (!g.paused) return i.reply({ content: '❌ That giveaway is not paused.', ...eph });
      if (g.pausedReason === 'server' && g.req?.server && !client.guilds.cache.has(g.req.server.id)) return i.reply({ content: `❌ I'm not in **${g.req.server.name}** right now. Add me back there and this giveaway resumes by itself.`, ...eph });
      g.paused = false; g.pausedReason = null; g.endsAt = Date.now() + g.pausedLeft; save(); await refreshMessage(g);
      return i.reply({ content: `✅ Resumed **${g.prize}**. It ends <t:${Math.floor(g.endsAt / 1000)}:R>.`, ...eph });
    }
    if (sub === 'add-entries') {
      const u = i.options.getUser('user'), n = i.options.getInteger('entries');
      if (g.ended) return i.reply({ content: '❌ That giveaway has already ended.', ...eph });
      if (u.bot) return i.reply({ content: "❌ Bots can't enter giveaways.", ...eph });
      if (blacklistOf(i.guildId).includes(u.id)) return i.reply({ content: '❌ That person is blacklisted.', ...eph });
      g.entries[u.id] = (g.entries[u.id] || 0) + n; save(); await refreshMessage(g);
      return i.reply({ content: `✅ Gave <@${u.id}> **${n}** bonus ${n === 1 ? 'entry' : 'entries'} (now ${g.entries[u.id]}).`, allowedMentions: { parse: [] }, ...eph });
    }
    if (sub === 'end') {
      if (g.ended) return i.reply({ content: 'That giveaway already ended.', ...eph });
      await i.reply({ content: 'Ending...', ...eph }); return endGiveaway(g);
    }
    if (sub === 'fix') {
      if (!g.ended && g.endsAt <= Date.now()) await endGiveaway(g);
      else { const { msg } = await fetchMsg(g); if (msg) await msg.edit({ embeds: [embedFor(g, g.ended)], components: [enterRow(g, g.ended)] }); }
      return i.reply({ content: 'Giveaway fixed.', ...eph });
    }
    if (sub === 'delete') {
      const { msg } = await fetchMsg(g); if (msg) await msg.delete().catch(() => {});
      delete db.giveaways[g.messageId]; save();
      return i.reply({ content: 'Giveaway deleted.', ...eph });
    }
    if (sub === 'participants') {
      const list = Object.keys(g.entries).map((u) => `<@${u}>`).join('\n') || 'Nobody yet.';
      return i.reply({ embeds: [new EmbedBuilder().setTitle(`Participants (${Object.keys(g.entries).length})`).setDescription(list.slice(0, 4000)).setColor(0x5865f2)], allowedMentions: { parse: [] }, ...eph });
    }
    if (sub === 'reroll') {
      if (!g.ended) return i.reply({ content: 'That giveaway has not ended.', ...eph });
      const w = await pickWinnersChecked(g, g.winners);
      g.winnerIds = w; g.claimed = []; if (g.claimMs) g.claimDeadline = Date.now() + g.claimMs; save();
      const { ch, msg } = await fetchMsg(g);
      if (msg) await msg.edit({ embeds: [embedFor(g, true)] }).catch(() => {});
      await i.reply({ content: 'Rerolled.', ...eph });
      return ch && announce(g, ch, w);
    }
    if (sub === 'edit') {
      const prize = i.options.getString('prize'), winners = i.options.getInteger('winners'), dur = i.options.getString('duration');
      if (prize) g.prize = prize;
      if (winners) g.winners = winners;
      const endMsg = i.options.getString('giveaway-end-message'), dmHost = i.options.getBoolean('dm-host');
      if (endMsg !== null) g.endMessage = /^(none|off)$/i.test(endMsg.trim()) ? null : endMsg.trim().slice(0, 1500);
      if (dmHost !== null) g.dmHost = dmHost;
      if (dur && !g.ended) { const t = parseDuration(dur); if (!t) return i.reply({ content: 'Invalid duration.', ...eph }); g.endsAt = t; }
      save();
      const { msg } = await fetchMsg(g); if (msg) await msg.edit({ embeds: [embedFor(g, g.ended)], components: [enterRow(g, g.ended)] });
      return i.reply({ content: 'Giveaway updated.', ...eph });
    }
  } catch (e) {
    console.error(e);
    const p = { content: 'Something went wrong.', ...eph };
    i.deferred || i.replied ? i.followUp(p).catch(() => {}) : i.reply(p).catch(() => {});
  }
});

async function launchGiveaway(o) {
  const g = {
    guildId: o.guildId, channelId: o.ch.id, messageId: null, endsAt: o.endsAt, ended: false,
    prize: o.prize, winners: o.winners, host: o.host, extra: o.extra || {}, winnersRole: o.winnersRole || null,
    claimMs: o.claimMs || null, dmMessage: o.dmMessage || null, image: o.image || null, thumbnail: o.thumbnail || null,
    color: o.color, endColor: o.endColor, bypass: o.bypass || [], endMessage: o.endMessage || null, dmHost: !!o.dmHost, req: o.req, entries: {}, winnerIds: [], claimed: [],
  };
  const msg = await o.ch.send({ embeds: [embedFor(g)], components: [enterRow(g)] });
  g.messageId = msg.id; db.giveaways[msg.id] = g; save();
  await msg.edit({ embeds: [embedFor(g)], components: [enterRow(g)] }).catch(() => {});
  const extraMsg = o.createMessage;
  if (extraMsg) await o.ch.send({ content: (extraMsg.match(/<@[&!]?\d+>|@everyone|@here/g) || []).join(' ') || undefined,
    embeds: [new EmbedBuilder().setColor(g.color).setDescription(extraMsg.slice(0, 4000))], allowedMentions: { parse: ['roles', 'users'] } }).catch(() => {});
  return g;
}
function readGiveawayOptions(i) {
  const o = i.options, claimStr = o.getString('claim-time');
  return {
    guildId: i.guildId, prize: o.getString('prize'), winners: o.getInteger('winners'), host: (o.getUser('host') || i.user).id,
    extra: parseExtra(o.getString('extra-entries')), winnersRole: o.getRole('giveaway-winners-role')?.id || null,
    claimMs: claimStr ? parseMs(claimStr) : null, dmMessage: o.getString('giveaway-winners-dm-message'),
    image: o.getAttachment('image')?.url || null, thumbnail: o.getAttachment('thumbnail')?.url || null,
    color: parseColor(o.getString('color'), 0x5865f2), endColor: parseColor(o.getString('end-color'), 0x2b2d31),
    bypass: ids(o.getString('requirement-bypass-roles')), createMessage: o.getString('giveaway-start-message'), endMessage: o.getString('giveaway-end-message'), dmHost: !!o.getBoolean('dm-host'),
    req: {
      roles: ids(o.getString('required-roles')), boosts: o.getInteger('required-server-boosts') || 0,
      serverTag: !!o.getBoolean('require-server-tag'),
      daily: o.getInteger('required-daily-messages') || 0, weekly: o.getInteger('required-weekly-messages') || 0,
      monthly: o.getInteger('required-monthly-messages') || 0, total: o.getInteger('required-total-messages') || 0,
    },
  };
}
async function createGiveaway(i) {
  const endsAt = parseDuration(i.options.getString('duration'));
  if (!endsAt || endsAt <= Date.now()) return i.reply({ content: 'Invalid duration. Try `1 hour`, `2 days` or a Discord timestamp.', ...eph });
  const ch = i.options.getChannel('channel') || i.channel;
  if (!ch?.isTextBased()) return i.reply({ content: 'Pick a text channel.', ...eph });
  const base = readGiveawayOptions(i);
  const rs = await resolveRequiredServer(i.guildId, i.user.id, i.options.getString('required-server'));
  if (rs?.error) return i.reply({ content: `❌ ${rs.error}`, ...eph });
  if (rs) base.req.server = rs;
  await launchGiveaway({ ...base, ch, endsAt });
  return i.reply({ content: `✅ Giveaway created in ${ch}.`, ...eph });
}

/* ───────────── scheduled giveaways ───────────── */
const scheduledMap = () => (db.scheduled ??= {});
const shortLeft = (ms) => { const m = Math.max(0, Math.round(ms / 60000)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`; };
async function scheduleGiveaway(i) {
  const durStr = i.options.getString('duration'), startsAt = parseDuration(i.options.getString('start'));
  if (/<t:\d+/.test(durStr)) return i.reply({ content: 'Invalid duration. For a scheduled giveaway use a length like `1 hour`, not a timestamp.', ...eph });
  const durationMs = parseMs(durStr);
  if (!durationMs || durationMs < 10000) return i.reply({ content: 'Invalid duration. Try `1 hour` or `2 days`.', ...eph });
  if (!startsAt || startsAt <= Date.now() + 5000) return i.reply({ content: 'Invalid start time. Try `2 hours`, `1 day` or a Discord timestamp in the future.', ...eph });
  if (startsAt > Date.now() + 90 * 864e5) return i.reply({ content: 'Invalid start time. You can schedule up to 90 days ahead.', ...eph });
  const ch = i.options.getChannel('channel') || i.channel;
  if (!ch?.isTextBased()) return i.reply({ content: 'Pick a text channel.', ...eph });
  const repeatStr = i.options.getString('repeat'), repeatMs = repeatStr ? parseMs(repeatStr) : null;
  if (repeatStr && (!repeatMs || repeatMs < durationMs + 60000)) return i.reply({ content: 'Invalid repeat. Use a length longer than the giveaway, like `1 day` or `1 week`.', ...eph });
  const base = readGiveawayOptions(i);
  const rs = await resolveRequiredServer(i.guildId, i.user.id, i.options.getString('required-server'));
  if (rs?.error) return i.reply({ content: `❌ ${rs.error}`, ...eph });
  if (rs) base.req.server = rs;
  const id = crypto.randomBytes(4).toString('hex');
  scheduledMap()[id] = { ...base, id, channelId: ch.id, startsAt, durationMs, repeatMs, createdBy: i.user.id };
  save();
  return i.reply({ content: `✅ Scheduled! **${scheduledMap()[id].prize}** will start <t:${Math.floor(startsAt / 1000)}:R> in ${ch} and run for ${shortLeft(durationMs)}${repeatMs ? ` and repeat every ${shortLeft(repeatMs)}` : ''}.\nCancel it with \`/giveaway unschedule\`.`, ...eph });
}
function scheduledList(i) {
  const list = Object.values(scheduledMap()).filter((x) => x.guildId === i.guildId).sort((a, b) => a.startsAt - b.startsAt);
  return i.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`${EM.calendar} Scheduled giveaways`)
    .setDescription(list.map((x, n) => `${n + 1}. **${x.prize}** · starts <t:${Math.floor(x.startsAt / 1000)}:R> in <#${x.channelId}> · ${x.winners} winner${x.winners > 1 ? 's' : ''}${x.repeatMs ? ` · ${EM.repeat} every ${shortLeft(x.repeatMs)}` : ''}`).join('\n').slice(0, 4000) || 'Nothing is scheduled. Use `/giveaway schedule`.')], ...eph });
}
function unschedule(i) {
  const x = scheduledMap()[i.options.getString('schedule')];
  if (!x || x.guildId !== i.guildId) return i.reply({ content: 'Scheduled giveaway not found.', ...eph });
  delete scheduledMap()[x.id]; save();
  return i.reply({ content: `✅ Cancelled the scheduled giveaway **${x.prize}**.`, ...eph });
}
async function runScheduled() {
  for (const sc of Object.values(scheduledMap())) {
    if (sc.startsAt > Date.now()) continue;
    delete scheduledMap()[sc.id]; save();
    try {
      const ch = await client.channels.fetch(sc.channelId);
      await launchGiveaway({ ...sc, ch, endsAt: Date.now() + sc.durationMs });
      if (sc.repeatMs) {
        let next = sc.startsAt + sc.repeatMs;
        while (next <= Date.now()) next += sc.repeatMs;
        const nid = crypto.randomBytes(4).toString('hex');
        scheduledMap()[nid] = { ...sc, id: nid, startsAt: next }; save();
      }
    } catch (e) {
      console.error(e);
      client.users.fetch(sc.createdBy).then((u) => u.send({ embeds: [new EmbedBuilder().setColor(0xed4245)
        .setDescription(`${CROSS} Your scheduled giveaway **${sc.prize}** could not be started. Check that I can send messages and embeds in the channel.`)] })).catch(() => {});
    }
  }
}

/* ───────────── pick a giveaway from a list (autocomplete) ───────────── */
async function onAutocomplete(i) {
  try {
    const needCreator = i.commandName === 'template' || ['create', 'schedule'].includes(i.options.getSubcommand(false));
    if ((i.commandName !== 'giveaway' && i.commandName !== 'template') || !i.guildId || !(needCreator ? isCreator(i) : isManager(i))) return await i.respond([]);
    const f = i.options.getFocused(true), sub = i.options.getSubcommand(), q = String(f.value || '').toLowerCase();
    const chan = (id) => i.guild?.channels.cache.get(id)?.name || 'channel';
    if (f.name === 'required-server') {
      const cands = [...client.guilds.cache.values()].filter((x) => x.id !== i.guildId && x.name.toLowerCase().includes(q)).slice(0, 15);
      const mine = (await Promise.all(cands.map(async (x) => ((await x.members.fetch(i.user.id).catch(() => null)) ? x : null)))).filter(Boolean);
      return await i.respond(mine.map((x) => ({ name: `🌐 ${x.name} (${x.memberCount} members)`.slice(0, 100), value: x.id })));
    }
    if (i.commandName === 'template' && f.name === 'name') {
      const names = Object.keys(guildCfg(i.guildId).templates || {}).filter((n) => n.toLowerCase().includes(q)).slice(0, 25);
      return await i.respond(names.map((n) => ({ name: `📋 ${n}`.slice(0, 100), value: n })));
    }
    if (sub === 'unschedule' && f.name === 'schedule') {
      const list = Object.values(scheduledMap()).filter((x) => x.guildId === i.guildId && x.prize.toLowerCase().includes(q)).sort((a, b) => a.startsAt - b.startsAt).slice(0, 25);
      return await i.respond(list.map((x) => ({ name: `🗓️ ${x.prize} · #${chan(x.channelId)} · starts in ${shortLeft(x.startsAt - Date.now())}`.slice(0, 100), value: x.id })));
    }
    if (f.name !== 'message-id') return await i.respond([]);
    let list = Object.values(db.giveaways).filter((g) => g.guildId === i.guildId);
    if (sub === 'reroll') list = list.filter((g) => g.ended);
    else if (sub === 'end' || sub === 'fix' || sub === 'add-entries' || sub === 'extend') list = list.filter((g) => !g.ended);
    else if (sub === 'pause') list = list.filter((g) => !g.ended && !g.paused);
    else if (sub === 'resume') list = list.filter((g) => g.paused);
    else if (sub === 'winners') list = list.filter((g) => g.ended);
    list = list.filter((g) => g.prize.toLowerCase().includes(q) || g.messageId.includes(q))
      .sort((a, b) => (a.ended - b.ended) || (a.ended ? b.endsAt - a.endsAt : a.endsAt - b.endsAt)).slice(0, 25);
    return await i.respond(list.map((g) => ({
      name: `${g.ended ? '🏁' : '🎉'} ${g.prize} · #${chan(g.channelId)} · ${g.ended ? 'ended' : `ends in ${shortLeft(g.endsAt - Date.now())}`}`.slice(0, 100), value: g.messageId })));
  } catch { try { await i.respond([]); } catch { /* already answered */ } }
}

async function onButton(i) {
  if (i.customId === 'gw_enter') return tryEnter(i, db.giveaways[i.message.id], (p) => i.reply({ ...p, ...eph }));
  if (i.customId === 'help_back') return i.update(helpMessage());
  if (i.customId === 'gw_remind') {
    const g = db.giveaways[i.message.id];
    if (!g || g.ended) return i.reply({ content: 'This giveaway has ended.', ...eph });
    g.reminders ??= [];
    const at = g.reminders.indexOf(i.user.id);
    if (at >= 0) { g.reminders.splice(at, 1); save(); return i.reply({ content: `${EM.bellOff} Reminder removed.`, ...eph }); }
    g.reminders.push(i.user.id); save();
    return i.reply({ content: `✅ I'll DM you when **${g.prize}** ends. Press the bell again to cancel.`, ...eph });
  }
  if (i.customId === 'gw_drop') return await onDrop(i);
  if (i.customId.startsWith('gw_parts:')) {
    const g = db.giveaways[i.message.id];
    if (!g) return i.reply({ content: 'Giveaway not found.', ...eph });
    return i.reply({ ...(await partsView(i, g, 1)), ...eph });
  }
  if (i.customId.startsWith('gw_pg:')) {
    const [, id, page] = i.customId.split(':');
    const g = db.giveaways[id];
    if (!g) return i.reply({ content: 'Giveaway not found.', ...eph });
    return i.update(await partsView(i, g, Number(page)));
  }
  if (i.customId.startsWith('gw_goto:')) {
    return i.showModal(new ModalBuilder().setCustomId(`gw_gotom:${i.customId.split(':')[1]}`).setTitle('Go To Page').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('page').setLabel('Page number').setStyle(TextInputStyle.Short).setRequired(true))));
  }
  if (i.customId.startsWith('gw_rm:')) {
    const [, id, page] = i.customId.split(':');
    const g = db.giveaways[id];
    if (!g || !isManager(i)) return i.reply({ content: 'Only managers can remove participants.', ...eph });
    const all = Object.keys(g.entries), p = Math.min(Math.max(Number(page) || 1, 1), Math.max(1, Math.ceil(all.length / PAGE)));
    const slice = all.slice((p - 1) * PAGE, p * PAGE);
    if (!slice.length) return i.update(await partsView(i, g, p, 'There is nobody to remove.'));
    const users = await Promise.all(slice.map((u) => client.users.fetch(u).catch(() => null)));
    const select = new StringSelectMenuBuilder().setCustomId(`gw_rmsel:${g.messageId}:${p}`).setPlaceholder('Select a participant to remove')
      .addOptions(slice.map((u, n) => ({ label: (users[n]?.username || u).slice(0, 100), description: `ID: ${u}`, value: u })));
    return i.update({ content: 'Select the participant to remove:', embeds: [], components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`gw_pg:${g.messageId}:${p}`).setLabel('Back').setStyle(ButtonStyle.Secondary))] });
  }
  if (i.customId.startsWith('gw_leave:')) {
    const g = db.giveaways[i.customId.split(':')[1]];
    if (!g || g.ended) return i.update({ content: 'This giveaway has ended.', components: [] });
    if (!g.entries[i.user.id]) return i.update({ content: 'You are not in this giveaway.', components: [] });
    delete g.entries[i.user.id]; save();
    const { msg } = await fetchMsg(g);
    if (msg) await msg.edit({ embeds: [embedFor(g)], components: [enterRow(g)] }).catch(() => {});
    return i.update({ content: '✅ You left the giveaway.', components: [] });
  }
  if (i.customId.startsWith('gw_claim:')) {
    const g = db.giveaways[i.customId.split(':')[1]];
    if (!g || !g.winnerIds.includes(i.user.id)) return i.reply({ content: 'You are not a winner of this giveaway.', ...eph });
    if (g.claimed.includes(i.user.id)) return i.reply({ content: 'You already claimed this prize.', ...eph });
    if (g.claimDeadline && g.claimDeadline < Date.now()) return i.reply({ content: 'The claim time has passed.', ...eph });
    g.claimed.push(i.user.id);
    if (allClaimed(g)) g.claimDeadline = null;
    save();
    if (i.inGuild()) await i.reply({ content: '✅ Prize claimed! The host has been notified.', components: [linkRow(g)], ...eph });
    else await i.update({ content: '✅ Prize claimed! The host has been notified.', components: [claimRow(g, true)] });
    const { ch, msg } = await fetchMsg(g);
    if (msg) await msg.edit({ embeds: [embedFor(g, true)] }).catch(() => {});
    if (ch) await ch.send({ content: `<@${i.user.id}> <@${g.host}>`, embeds: [new EmbedBuilder().setColor(0x57f287).setTitle(`${TICK} Prize claimed`)
      .setDescription(`<@${i.user.id}> claimed **${g.prize}**! <@${g.host}>, they're ready for their prize.`)], components: [linkRow(g)], allowedMentions: { users: [i.user.id, g.host] } }).catch(() => {});
    return;
  }
}
const PAGE = 10;
async function partsView(i, g, page, notice = '') {
  const ids = Object.keys(g.entries);
  const pages = Math.max(1, Math.ceil(ids.length / PAGE));
  page = Math.min(Math.max(page || 1, 1), pages);
  const slice = ids.slice((page - 1) * PAGE, page * PAGE);
  const totalEntries = Object.values(g.entries).reduce((a, b) => a + b, 0);
  const mine = g.entries[i.user.id] || 0;
  const chance = (totalEntries ? (mine / totalEntries) * 100 : 0).toFixed(1).replace(/\.0$/, '');
  const lines = slice.map((id, n) => `${(page - 1) * PAGE + n + 1}. ${(g.dummies || []).includes(id) ? `\`dummy ${id.slice(-4)}\`` : `<@${id}>`} (**${g.entries[id]}** ${g.entries[id] === 1 ? 'entry' : 'entries'})`);
  const e = new EmbedBuilder().setColor(0xe67e22).setTitle(`${MEMBERS} Giveaway Participants (Page ${page}/${pages})`)
    .setDescription(`These are the members that have participated in the giveaway of **${g.prize}**:\n\n${lines.join('\n') || '*Nobody has joined yet.*'}\n\nTotal Participants: **${ids.length}**\nTotal Entries: **${totalEntries}**\n\nYour Entries: **${mine}**\nYour Chance of Winning: **${chance}%**`);
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gw_pg:${g.messageId}:${page - 1}`).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`gw_goto:${g.messageId}`).setLabel('Go To Page').setStyle(ButtonStyle.Secondary).setDisabled(pages <= 1),
    new ButtonBuilder().setCustomId(`gw_pg:${g.messageId}:${page + 1}`).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages));
  const rows = [nav];
  if (isManager(i) && !g.ended && slice.length)
    rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`gw_rm:${g.messageId}:${page}`).setLabel('Remove A Participant').setStyle(ButtonStyle.Danger)));
  return { content: notice, embeds: [e], components: rows, allowedMentions: { parse: [] } };
}
async function onStringSelect(i) {
  if (i.customId.startsWith('help_')) return helpSelect(i);
  if (!i.customId.startsWith('gw_rmsel:')) return;
  const [, id, page] = i.customId.split(':');
  const g = db.giveaways[id];
  if (!g || !isManager(i)) return i.reply({ content: 'Not allowed.', ...eph });
  const uid = i.values[0];
  delete g.entries[uid];
  g.removed ??= [];
  if (!g.removed.includes(uid)) g.removed.push(uid);
  save();
  const { msg } = await fetchMsg(g);
  if (msg) await msg.edit({ embeds: [embedFor(g)], components: [enterRow(g)] }).catch(() => {});
  return i.update(await partsView(i, g, Number(page), `✅ Removed <@${uid}> from the giveaway.`));
}
async function onModal(i) {
  if (!i.customId.startsWith('gw_gotom:')) return;
  const g = db.giveaways[i.customId.split(':')[1]];
  if (!g) return i.reply({ content: 'Giveaway not found.', ...eph });
  const p = parseInt(i.fields.getTextInputValue('page'), 10);
  if (Number.isNaN(p)) return i.reply({ content: 'Please enter a valid page number.', ...eph });
  return i.update(await partsView(i, g, p));
}
async function onRoleSelect(i) {
  if (!i.customId.startsWith('cfg:') || !isManager(i)) return i.reply({ content: 'Not allowed.', ...eph });
  const key = i.customId === 'cfg:manager-roles' ? 'managerRoles' : 'creatorRoles';
  guildCfg(i.guildId)[key] = i.values; save();
  return i.update({ content: `Saved ${key === 'managerRoles' ? 'manager' : 'creator'} roles: ${i.values.map((r) => `<@&${r}>`).join(', ') || 'none'}`, components: [] });
}

/* ───────────── dashboard management helpers ───────────── */
function flagsOf(guild, m) {
  const c = guildCfg(guild.id);
  const manage = m.permissions.has(PermissionFlagsBits.ManageGuild) || c.managerRoles.some((r) => m.roles.cache.has(r));
  return { manage, create: manage || c.creatorRoles.some((r) => m.roles.cache.has(r)) };
}
async function rerollGiveaway(g) {
  if (!g.ended) return [400, 'That giveaway has not ended.'];
  const w = await pickWinnersChecked(g, g.winners);
  g.winnerIds = w; g.claimed = []; if (g.claimMs) g.claimDeadline = Date.now() + g.claimMs; save();
  const { ch, msg } = await fetchMsg(g);
  if (msg) await msg.edit({ embeds: [embedFor(g, true)] }).catch(() => {});
  if (ch) await announce(g, ch, w);
  return [200, null];
}
async function deleteGiveaway(g) {
  const { msg } = await fetchMsg(g);
  if (msg) await msg.delete().catch(() => {});
  delete db.giveaways[g.messageId]; save();
  return [200, null];
}
async function editGiveaway(g, b) {
  if (typeof b.prize === 'string' && b.prize.trim()) g.prize = b.prize.trim().slice(0, 256);
  const w = parseInt(b.winners, 10);
  if (w >= 1 && w <= 50) g.winners = w;
  if (!g.ended && typeof b.duration === 'string' && b.duration.trim()) {
    const t = parseDuration(b.duration.trim());
    if (!t || t <= Date.now()) return [400, 'Invalid duration. Try "1 hour", "2 days" or a Discord timestamp.'];
    g.endsAt = t;
  }
  save(); await refreshMessage(g);
  return [200, null];
}
async function removeParticipant(g, uid) {
  if (!g.entries[uid]) return [400, 'That user is not in this giveaway.'];
  delete g.entries[uid];
  g.removed ??= [];
  if (!g.removed.includes(uid)) g.removed.push(uid);
  save(); await refreshMessage(g);
  return [200, null];
}
async function createFromWeb(guild, s, b) {
  const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const int = (v, lo, hi) => { const x = parseInt(v, 10); return Number.isFinite(x) ? Math.min(Math.max(x, lo), hi) : lo; };
  const hasRole = (r) => typeof r === 'string' && guild.roles.cache.has(r);
  const roleList = (arr) => (Array.isArray(arr) ? arr : []).filter(hasRole).slice(0, 25);
  const link = (v) => { v = str(v, 500); return /^https:\/\/\S+$/.test(v) ? v : null; };
  const prize = str(b.prize, 256);
  if (!prize) return [400, 'Prize is required.'];
  const endsAt = parseDuration(str(b.duration, 60));
  if (!endsAt || endsAt <= Date.now()) return [400, 'Invalid duration. Try "1 hour", "2 days" or a Discord timestamp.'];
  const ch = guild.channels.cache.get(str(b.channelId, 25));
  const okType = ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement);
  if (!okType || !ch.permissionsFor(guild.members.me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) return [400, 'Pick a channel the bot can post in.'];
  const claimStr = str(b.claimTime, 40), claimMs = claimStr ? parseMs(claimStr) : null;
  if (claimStr && !claimMs) return [400, 'Invalid claim time. Try "24 hours".'];
  const extra = {};
  for (const e of (Array.isArray(b.extra) ? b.extra : []).slice(0, 25)) if (hasRole(e?.role)) extra[e.role] = int(e.entries, 1, 100);
  const rs = await resolveRequiredServer(guild.id, s.uid, str(b.serverInvite, 100) || str(b.requiredServer, 30));
  if (rs?.error) return [400, rs.error];
  const g = await launchGiveaway({
    guildId: guild.id, ch, endsAt, prize, winners: int(b.winners, 1, 50), host: s.uid, extra,
    winnersRole: hasRole(b.winnersRole) ? b.winnersRole : null, claimMs, dmMessage: str(b.dmMessage, 1500) || null,
    image: link(b.image), thumbnail: link(b.thumbnail), color: parseColor(str(b.color, 7), 0x5865f2), endColor: parseColor(str(b.endColor, 7), 0x2b2d31),
    bypass: roleList(b.bypass), createMessage: str(b.createMessage, 1500) || null, endMessage: str(b.endMessage, 1500) || null, dmHost: !!b.dmHost,
    req: { roles: roleList(b.requiredRoles), boosts: b.boosts ? 1 : 0, serverTag: !!b.serverTag,
      daily: int(b.daily, 0, 100000), weekly: int(b.weekly, 0, 100000), monthly: int(b.monthly, 0, 100000), total: int(b.total, 0, 1000000), ...(rs ? { server: rs } : {}) },
  });
  return [200, null, { id: g.messageId }];
}
const hex = (n) => '#' + Number(n).toString(16).padStart(6, '0');
function readBody(req, max = 65536) {
  return new Promise((resolve, reject) => {
    let d = '', size = 0;
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new Error('Body too large')); req.destroy(); } else d += c; });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
async function authGuild(req, res, gid) {
  const s = getSession(req);
  if (!s) { sendJson(res, 401, { error: 'Log in with Discord first.' }); return null; }
  const guild = client.guilds.cache.get(gid);
  if (!guild) { sendJson(res, 404, { error: 'Givevanced is not in that server.' }); return null; }
  const m = await guild.members.fetch(s.uid).catch(() => null);
  if (!m) { sendJson(res, 403, { error: "You're not a member of that server." }); return null; }
  return { s, guild, m, ...flagsOf(guild, m) };
}
const gSummary = (g, guild) => ({ id: g.messageId, prize: g.prize, ended: g.ended, endsAt: g.endsAt, winners: g.winners, entries: Object.keys(g.entries).length,
  channel: guild.channels.cache.get(g.channelId)?.name || 'deleted-channel' });

/* ───────────── website: pages, Discord login and giveaway API ───────────── */
const crypto = require('crypto');
const sessions = () => (db.sessions ??= {});
const parseCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split(/=(.*)/s).slice(0, 2)).filter((p) => p[0]));
function setCookie(res, name, val, maxAge) {
  const prev = [].concat(res.getHeader('Set-Cookie') || []);
  prev.push(`${name}=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${res.gvSecure ? '; Secure' : ''}`);
  res.setHeader('Set-Cookie', prev);
}
const sendJson = (res, code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); };
const redirect = (res, url) => { res.statusCode = 302; res.setHeader('Location', url); res.end(); };
function getSession(req) {
  const sid = parseCookies(req).gv_sid, s = sid && sessions()[sid];
  if (!s) return null;
  if (s.exp < Date.now()) { delete sessions()[sid]; save(); return null; }
  return s;
}
const avatarUrl = (id, hash) => hash ? `https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=64` : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(id) >> 22n) % 6n)}.png`;
const loginReady = () => !!(process.env.CLIENT_ID && process.env.CLIENT_SECRET);

function reqLines(g, guild) {
  const r = g.req, role = (id) => '@' + (guild?.roles.cache.get(id)?.name || 'role'), l = [];
  if (r.roles.length) l.push('Roles: ' + r.roles.map(role).join(', '));
  if (r.boosts) l.push('Must be boosting this server');
  if (r.serverTag) l.push("Must have this server's tag equipped");
  if (r.daily) l.push(`${r.daily}+ messages today`);
  if (r.weekly) l.push(`${r.weekly}+ messages this week`);
  if (r.monthly) l.push(`${r.monthly}+ messages this month`);
  if (r.total) l.push(`${r.total}+ total messages`);
  if (r.server) l.push(`Must join the server "${r.server.name}"`);
  if (g.extra && Object.keys(g.extra).length) l.push('Extra entries: ' + Object.entries(g.extra).map(([id, n]) => `${role(id)} ×${n}`).join(', '));
  if ((g.bypass || []).length) l.push('Bypass roles: ' + g.bypass.map(role).join(', '));
  return l;
}
const nameOf = async (id) => (await client.users.fetch(id).catch(() => null))?.username || id;
async function giveawayInfo(g, s) {
  const guild = client.guilds.cache.get(g.guildId);
  const info = {
    id: g.messageId, prize: g.prize, ended: g.ended, endsAt: g.endsAt, winners: g.winners, entries: Object.keys(g.entries).length,
    host: await nameOf(g.host), guild: guild ? { name: guild.name, icon: guild.iconURL({ size: 128 }) } : null,
    image: g.image, thumbnail: g.thumbnail, color: '#' + Number(g.color).toString(16).padStart(6, '0'), requirements: reqLines(g, guild),
    winnerNames: g.ended ? await Promise.all(g.winnerIds.map(nameOf)) : [],
    discordUrl: `https://discord.com/channels/${g.guildId}/${g.channelId}/${g.messageId}`,
  };
  if (s) {
    const me = (info.me = { entered: !!g.entries[s.uid], entries: g.entries[s.uid] || 0, removed: (g.removed || []).includes(s.uid) });
    if (!g.ended && !me.entered && !me.removed) {
      const m = guild ? await guild.members.fetch(s.uid).catch(() => null) : null;
      me.reason = m ? await checkEntryFor(m, s.uid, g.guildId, g) : "You're not a member of this server.";
      me.canJoin = !me.reason;
      if (!me.reason && g.req.server) {
        const st = await serverStatus(g, s.uid);
        if (!st.ok) {
          me.canJoin = false;
          me.needServer = st.unverifiable ? null : { name: g.req.server.name, invite: g.req.server.invite };
          me.reason = st.unverifiable ? "The required server can't be checked right now." : `Join ${g.req.server.name} to enter.`;
        }
      }
    }
  }
  return info;
}
async function webJoin(g, s) {
  if (g.paused) return [400, 'This giveaway is paused.'];
  if (g.ended || Date.now() >= g.endsAt) return [400, 'This giveaway has ended.'];
  if ((g.removed || []).includes(s.uid)) return [403, 'You were removed from this giveaway by a moderator.'];
  if (g.entries[s.uid]) return [400, "You've already joined this giveaway."];
  const guild = client.guilds.cache.get(g.guildId), m = guild ? await guild.members.fetch(s.uid).catch(() => null) : null;
  if (!m) return [403, "You're not a member of this server."];
  const fail = await checkEntryFor(m, s.uid, g.guildId, g);
  if (fail) return [403, fail];
  if (g.req.server) {
    const st = await serverStatus(g, s.uid);
    if (!st.ok) return [403, st.unverifiable ? "The required server can't be checked right now." : `Join ${g.req.server.name} first, then try again.`];
  }
  g.entries[s.uid] = weightForMember(m, g); save(); refreshMessage(g);
  return [200, null];
}
async function webLeave(g, s) {
  if (g.ended) return [400, 'This giveaway has ended.'];
  if (!g.entries[s.uid]) return [400, 'You are not in this giveaway.'];
  delete g.entries[s.uid]; save(); refreshMessage(g);
  return [200, null];
}
function servePage(res, name) {
  const page = [`${__dirname}/${name}`, `${__dirname}/public/${name}`].find((p) => fs.existsSync(p));
  if (!page) return res.end('Givevanced is running');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(fs.readFileSync(page, 'utf8').replaceAll('YOUR_CLIENT_ID', process.env.CLIENT_ID || 'YOUR_CLIENT_ID'));
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const hostHeader = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const site = `${proto}://${hostHeader}`;   // the address the visitor is actually on
  res.gvSecure = proto === 'https';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
    // Only allow requests that come from this site itself (compare hosts, so BASE_URL typos can't lock people out)
    let ok = false;
    try {
      const oh = new URL(req.headers.origin).host;
      ok = oh === req.headers.host || oh === hostHeader || (!!BASE && oh === new URL(BASE).host);
    } catch { /* invalid origin */ }
    if (!ok) return sendJson(res, 403, { error: 'Bad origin.' });
  }

  if (p === '/login') {
    if (!loginReady()) return res.end('Login is not configured yet. Set CLIENT_SECRET and BASE_URL on the server.');
    const state = crypto.randomBytes(16).toString('hex');
    setCookie(res, 'gv_state', state, 600);
    const next = url.searchParams.get('next');
    if (next && /^\/[^/\\]/.test(next)) setCookie(res, 'gv_next', encodeURIComponent(next), 600);
    return redirect(res, 'https://discord.com/oauth2/authorize?' + new URLSearchParams({
      client_id: process.env.CLIENT_ID, redirect_uri: `${site}/callback`, response_type: 'code', scope: 'identify guilds', state, prompt: 'none' }));
  }
  if (p === '/callback') {
    const ck = parseCookies(req), code = url.searchParams.get('code'), state = url.searchParams.get('state');
    if (!loginReady()) return redirect(res, '/dashboard?error=secret');
    if (url.searchParams.get('error')) return redirect(res, '/dashboard?error=denied');
    if (!code || !state || state !== ck.gv_state) return redirect(res, '/dashboard?error=state');
    let tok, user, guilds;
    try {
      tok = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: `${site}/callback` }) })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    } catch (e) { console.error('OAuth: could not reach Discord', e); return redirect(res, '/dashboard?error=network'); }
    if (!tok.body.access_token) {
      console.error(`OAuth: Discord refused the login (HTTP ${tok.status}) redirect_uri=${site}/callback`, tok.body);
      return redirect(res, `/dashboard?error=${tok.body.error === 'invalid_client' ? 'secret' : tok.body.error === 'invalid_grant' ? 'redirect' : 'login'}`);
    }
    try {
      const auth = { headers: { Authorization: `Bearer ${tok.body.access_token}` } };
      [user, guilds] = await Promise.all([fetch('https://discord.com/api/users/@me', auth).then((r) => r.json()), fetch('https://discord.com/api/users/@me/guilds', auth).then((r) => r.json())]);
    } catch (e) { console.error('OAuth: could not read your Discord profile', e); return redirect(res, '/dashboard?error=network'); }
    if (!user.id) { console.error('OAuth: profile had no id', user); return redirect(res, '/dashboard?error=login'); }
    for (const [k, v] of Object.entries(sessions())) if (v.exp < Date.now()) delete sessions()[k];
    const sid = crypto.randomBytes(24).toString('hex');
    sessions()[sid] = { uid: user.id, username: user.global_name || user.username, avatar: avatarUrl(user.id, user.avatar), exp: Date.now() + 7 * 864e5,
      guilds: (Array.isArray(guilds) ? guilds : []).map((x) => x.id) };
    save();
    setCookie(res, 'gv_sid', sid, 7 * 86400);
    setCookie(res, 'gv_state', '', 0);
    setCookie(res, 'gv_next', '', 0);
    const next = ck.gv_next ? decodeURIComponent(ck.gv_next) : '/dashboard';
    return redirect(res, /^\/[^/\\]/.test(next) ? next : '/dashboard');
  }
  if (p === '/logout') {
    const sid = parseCookies(req).gv_sid;
    if (sid) { delete sessions()[sid]; save(); }
    setCookie(res, 'gv_sid', '', 0);
    return redirect(res, '/');
  }

  if (p === '/api/me') {
    const s = getSession(req);
    return sendJson(res, 200, { user: s ? { id: s.uid, username: s.username, avatar: s.avatar } : null, loginReady: loginReady() });
  }
  if (p === '/api/giveaways') {
    const s = getSession(req);
    if (!s) return sendJson(res, 401, { error: 'Not logged in' });
    const mine = Object.values(db.giveaways).filter((g) => s.guilds.includes(g.guildId));
    const live = mine.filter((g) => !g.ended).sort((a, b) => a.endsAt - b.endsAt);
    const ended = mine.filter((g) => g.ended).sort((a, b) => b.endsAt - a.endsAt).slice(0, 12);
    const sum = (g) => ({ id: g.messageId, prize: g.prize, ended: g.ended, endsAt: g.endsAt, winners: g.winners, entries: Object.keys(g.entries).length,
      entered: !!g.entries[s.uid], guild: client.guilds.cache.get(g.guildId)?.name || 'Server', icon: client.guilds.cache.get(g.guildId)?.iconURL({ size: 64 }) || null });
    return sendJson(res, 200, { live: live.map(sum), ended: ended.map(sum) });
  }
  if (p === '/api/servers') {
    const s = getSession(req);
    if (!s) return sendJson(res, 401, { error: 'Not logged in' });
    const out = await Promise.all(s.guilds.filter((id) => client.guilds.cache.has(id)).slice(0, 40).map(async (id) => {
      const guild = client.guilds.cache.get(id), m = await guild.members.fetch(s.uid).catch(() => null);
      if (!m) return null;
      return { id, name: guild.name, icon: guild.iconURL({ size: 64 }), ...flagsOf(guild, m), live: Object.values(db.giveaways).filter((g) => g.guildId === id && !g.ended).length };
    }));
    return sendJson(res, 200, { servers: out.filter(Boolean) });
  }
  const sm = p.match(/^\/api\/server\/(\d+)(?:\/(giveaway|roles|blacklist))?$/);
  if (sm) {
    const a = await authGuild(req, res, sm[1]);
    if (!a) return;
    const { guild } = a;
    if (!sm[2]) {
      const all = Object.values(db.giveaways).filter((g) => g.guildId === guild.id);
      const live = all.filter((g) => !g.ended).sort((x, y) => x.endsAt - y.endsAt), ended = all.filter((g) => g.ended).sort((x, y) => y.endsAt - x.endsAt).slice(0, 25);
      const top = Object.entries(db.stats[guild.id] || {}).sort((x, y) => y[1].total - x[1].total).slice(0, 10);
      const me = guild.members.me;
      const blacklist = a.manage ? await Promise.all(blacklistOf(guild.id).map(async (id) => ({ id, username: await nameOf(id) }))) : [];
      return sendJson(res, 200, {
        id: guild.id, name: guild.name, icon: guild.iconURL({ size: 128 }), flags: { manage: a.manage, create: a.create },
        channels: [...guild.channels.cache.values()].filter((c) => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks']))
          .sort((x, y) => x.rawPosition - y.rawPosition).map((c) => ({ id: c.id, name: c.name })),
        roles: [...guild.roles.cache.values()].filter((r) => r.id !== guild.id && !r.managed).sort((x, y) => y.position - x.position).map((r) => ({ id: r.id, name: r.name })),
        joinable: a.s.guilds.filter((id) => id !== guild.id && client.guilds.cache.has(id)).map((id) => ({ id, name: client.guilds.cache.get(id).name })),
        settings: a.manage ? { creatorRoles: guildCfg(guild.id).creatorRoles, managerRoles: guildCfg(guild.id).managerRoles, blacklist } : null,
        live: live.map((g) => gSummary(g, guild)), ended: ended.map((g) => gSummary(g, guild)),
        stats: { live: live.length, hosted: all.length, entries: live.reduce((n, g) => n + Object.keys(g.entries).length, 0), members: guild.memberCount },
        top: await Promise.all(top.map(async ([id, st]) => ({ id, username: await nameOf(id), total: st.total }))),
      });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
    const body = await readBody(req);
    if (sm[2] === 'giveaway') {
      if (!a.create) return sendJson(res, 403, { error: 'You need Manage Server or a creator role to create giveaways.' });
      const [code, error, extra] = await createFromWeb(guild, a.s, body);
      return sendJson(res, code, error ? { error } : { ok: true, ...extra });
    }
    if (!a.manage) return sendJson(res, 403, { error: 'You need Manage Server or a manager role.' });
    if (sm[2] === 'blacklist') {
      const uid = String(body.userId || '').trim();
      if (!/^\d{15,22}$/.test(uid)) return sendJson(res, 400, { error: 'Enter a valid Discord user ID.' });
      if (body.action === 'remove') { const bl = blacklistOf(guild.id), i = bl.indexOf(uid); if (i >= 0) { bl.splice(i, 1); save(); } }
      else await addBlacklist(guild.id, uid);
      return sendJson(res, 200, { ok: true });
    }
    const pick = (arr) => (Array.isArray(arr) ? arr : []).filter((r) => typeof r === 'string' && guild.roles.cache.has(r)).slice(0, 25);
    const cfg = guildCfg(guild.id);
    cfg.creatorRoles = pick(body.creatorRoles); cfg.managerRoles = pick(body.managerRoles); save();
    return sendJson(res, 200, { ok: true });
  }

  const m = p.match(/^\/api\/giveaway\/(\d+)(?:\/([a-z]+))?$/);
  if (m) {
    const g = db.giveaways[m[1]], s = getSession(req), act = m[2];
    if (!g) return sendJson(res, 404, { error: 'Giveaway not found.' });
    if (!act) return sendJson(res, 200, await giveawayInfo(g, s));
    if (act === 'join' || act === 'leave') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
      if (!s) return sendJson(res, 401, { error: 'Log in with Discord first.' });
      const [code, error] = await (act === 'join' ? webJoin(g, s) : webLeave(g, s));
      return sendJson(res, code, error ? { error } : { ok: true });
    }
    if (!['participants', 'config', 'end', 'reroll', 'delete', 'edit', 'remove'].includes(act)) return sendJson(res, 404, { error: 'Unknown action.' });
    const a = await authGuild(req, res, g.guildId);
    if (!a) return;
    if (!a.manage) return sendJson(res, 403, { error: 'You need Manage Server or a manager role.' });
    if (act === 'participants') {
      const list = Object.entries(g.entries).slice(0, 200);
      return sendJson(res, 200, { total: Object.keys(g.entries).length, ended: g.ended, list: await Promise.all(list.map(async ([id, n]) => ({ id, username: await nameOf(id), entries: n }))) });
    }
    if (act === 'config') {
      return sendJson(res, 200, { prize: g.prize, winners: g.winners, channelId: g.channelId, extra: Object.entries(g.extra || {}).map(([role, entries]) => ({ role, entries })),
        bypass: g.bypass || [], req: g.req, claimTime: g.claimMs ? `${Math.max(1, Math.round(g.claimMs / 60000))} minutes` : '', winnersRole: g.winnersRole || '',
        dmMessage: g.dmMessage || '', endMessage: g.endMessage || '', dmHost: !!g.dmHost, color: hex(g.color), endColor: hex(g.endColor), image: g.image || '', thumbnail: g.thumbnail || '' });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
    let r;
    if (act === 'end') r = g.ended ? [400, 'That giveaway already ended.'] : (await endGiveaway(g), [200, null]);
    else if (act === 'reroll') r = await rerollGiveaway(g);
    else if (act === 'delete') r = await deleteGiveaway(g);
    else { const body = await readBody(req); r = act === 'edit' ? await editGiveaway(g, body) : await removeParticipant(g, String(body.userId || '')); }
    return sendJson(res, r[0], r[1] ? { error: r[1] } : { ok: true });
  }

  if (p === '/dashboard' || /^\/dashboard\/server\/\d+\/?$/.test(p) || /^\/giveaway\/\d+\/?$/.test(p)) return servePage(res, 'dashboard.html');
  return servePage(res, 'index.html');
}
// Serves the website and gives Render + uptime pings something to hit
require('http').createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (res.headersSent) return;
    if (req.url.startsWith('/api')) return sendJson(res, 500, { error: 'Something went wrong.' });
    res.statusCode = 500; res.end('Server error');
  });
}).listen(process.env.PORT || 3000);

// Log in. The Message Content and Server Members intents must be switched on in the Developer Portal.
// If they aren't, retry without them instead of crashing (the 5-second membership checks still work).
async function startBot() {
  await initStorage();
  const original = client.options.intents.bitfield;
  const strip = [0, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMembers | GatewayIntentBits.MessageContent];
  for (let n = 0; n < strip.length; n++) {
    try { await client.login(process.env.TOKEN); break; }
    catch (e) {
      if (!/disallowed intents/i.test(String(e?.message)) || n === strip.length - 1) throw e;
      console.warn(n === 0
        ? 'Server Members intent may be off in the Developer Portal. Retrying without it (people who leave a required server are still removed within seconds).'
        : 'Message Content intent is off too, so .gv test commands are disabled. Turn both on under Bot > Privileged Gateway Intents.');
      client.options.intents = new IntentsBitField(original & ~strip[n + 1]).freeze();
      await client.destroy().catch(() => {});
    }
  }
  const has = (b) => client.options.intents.has(b);
  console.log(`Intents: members=${has(GatewayIntentBits.GuildMembers)} messageContent=${has(GatewayIntentBits.MessageContent)}`);
}
startBot().catch((e) => { console.error(e); process.exit(1); });
