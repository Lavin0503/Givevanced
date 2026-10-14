require('dotenv').config();
const fs = require('fs');
const {
  Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, REST, Routes, PermissionFlagsBits, MessageFlags, ChannelType, ActivityType,
} = require('discord.js');

const TICK_ID = '1559999432597180516', CROSS_ID = '1559999451513487529';
const TICK = `<:tick:${TICK_ID}>`, CROSS = `<:cross:${CROSS_ID}>`;
const withEmoji = (t) => String(t).replace(/✅/g, TICK).replace(/❌/g, CROSS);
const BASE = (process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || '').replace(/\/$/, '');

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
      `**Ends:** <t:${Math.floor(g.endsAt / 1000)}:R> (<t:${Math.floor(g.endsAt / 1000)}:f>)`,
      `**Hosted by:** <@${g.host}>`,
      `**Winners:** ${g.winners}`,
      `**Entries:** ${Object.keys(g.entries).length}`,
      BASE && g.messageId ? `🌐 [View on the website](${BASE}/giveaway/${g.messageId})` : '',
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
  if (r.daily) l.push(`${r.daily}+ messages today`);
  if (r.weekly) l.push(`${r.weekly}+ messages this week`);
  if (r.monthly) l.push(`${r.monthly}+ messages this month`);
  if (r.total) l.push(`${r.total}+ total messages`);
  if (g.extra && Object.keys(g.extra).length)
    l.push('Extra entries: ' + Object.entries(g.extra).map(([id, n]) => `<@&${id}> ×${n}`).join(', '));
  return l.length ? `\n**Requirements**\n${l.map((x) => `• ${x}`).join('\n')}` : '';
}
const enterRow = (g, disabled = false) => {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('gw_enter').setLabel(String(Object.keys(g.entries).length)).setEmoji('🎉').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`gw_parts:${g.messageId}`).setLabel('Participants').setEmoji('👥').setStyle(ButtonStyle.Secondary));
  return row;
};

/* ───────────── core giveaway logic ───────────── */
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

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
const linkBtn = (g) => new ButtonBuilder().setLabel('Giveaway Message').setEmoji('🎁').setStyle(ButtonStyle.Link).setURL(gLink(g));
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
      const e = new EmbedBuilder().setColor(g.color).setTitle('🎉 You won!')
        .setDescription(`You won **${g.prize}** in **${guild?.name ?? 'a server'}**!\nClick **Claim** <t:${Math.floor(g.claimDeadline / 1000)}:R> or you'll be rerolled.${custom ? `\n\n${custom}` : ''}\n\n[Jump to giveaway](${link})`);
      try {
        const u = await client.users.fetch(w);
        await u.send({ embeds: [e], components: [claimRow(g)] });
      } catch { failed.push(w); }
    } else if (custom) {
      const e = new EmbedBuilder().setColor(g.color).setTitle('🎉 You won!').setDescription(`${custom}\n\n[Jump to giveaway](${link})`);
      client.users.fetch(w).then((u) => u.send({ embeds: [e], components: [linkRow(g)] })).catch(() => {});
    }
  }
  let desc = winners.length
    ? `Congratulations ${winners.map((w) => `<@${w}>`).join(', ')}! You won **${g.prize}**!`
    : `No valid entries for **${g.prize}**, so no winner was chosen.`;
  const payload = { allowedMentions: { users: winners } };
  if (g.claimMs && winners.length) {
    if (failed.length < winners.length) desc += `\n📬 Check your DMs to claim within <t:${Math.floor(g.claimDeadline / 1000)}:R>.`;
    if (failed.length) {
      desc += `\n${failed.map((w) => `<@${w}>`).join(', ')}: your DMs are closed, so claim here within <t:${Math.floor(g.claimDeadline / 1000)}:R>.`;
      payload.components = [claimRow(g)];
    }
  }
  if (!payload.components) payload.components = [linkRow(g)];
  if (winners.length) payload.content = winners.map((w) => `<@${w}>`).join(' ');   // ping
  payload.embeds = [new EmbedBuilder().setColor(winners.length ? 0x57f287 : 0xed4245).setTitle('🎉 Giveaway ended').setDescription(desc)];
  await ch.send(payload).catch(() => {});
}
async function endGiveaway(g) {
  g.ended = true;
  g.winnerIds = pickWinners(g, g.winners);
  g.claimed = [];
  if (g.claimMs) g.claimDeadline = Date.now() + g.claimMs;
  save();
  const { ch, msg } = await fetchMsg(g);
  if (msg) await msg.edit({ embeds: [embedFor(g, true)], components: [enterRow(g, true)] }).catch(() => {});
  if (ch) await announce(g, ch, g.winnerIds);
}
async function rerollUnclaimed(g) {
  const lost = g.winnerIds.filter((w) => !g.claimed.includes(w));
  if (!lost.length) { g.claimDeadline = null; return save(); }
  const keep = g.winnerIds.filter((w) => g.claimed.includes(w));
  const fresh = pickWinners(g, lost.length, g.winnerIds);
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
      if (!g.ended && g.endsAt <= Date.now()) await endGiveaway(g);
      else if (g.ended && g.claimDeadline && g.claimDeadline <= Date.now()) await rerollUnclaimed(g);
    } catch (e) { console.error(e); }
  }
  await runScheduled();
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
    .addStringOption((o) => o.setName('giveaway-create-message').setDescription('The message the bot sends after creating this giveaway'))
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
    .addStringOption((o) => o.setName('color').setDescription('Embed hex color, e.g. #5865F2'))
    .addStringOption((o) => o.setName('end-color').setDescription('Embed hex color after the giveaway ends'));
};
gw.addSubcommand((s) => addGiveawayOptions(s.setName('create').setDescription('Create a giveaway')));
gw.addSubcommand((s) => addGiveawayOptions(s.setName('schedule').setDescription('Schedule a giveaway to start later'),
  (r) => r.addStringOption((o) => o.setName('start').setDescription('When it starts, like 2 hours or 1 day, or a Discord timestamp').setRequired(true))));
gw.addSubcommand((s) => s.setName('scheduled').setDescription('View giveaways that are scheduled to start'));
gw.addSubcommand((s) => s.setName('unschedule').setDescription('Cancel a scheduled giveaway')
  .addStringOption((o) => o.setName('schedule').setDescription('Pick the scheduled giveaway to cancel').setRequired(true).setAutocomplete(true)));
const idOpt = (s, d) => s.addStringOption((o) => o.setName('message-id').setDescription(d).setRequired(true).setAutocomplete(true));
gw.addSubcommand((s) => s.setName('creator-roles').setDescription('Set roles with which people can only create or schedule giveaways'));
gw.addSubcommand((s) => idOpt(s.setName('delete').setDescription('Delete a giveaway'), 'Giveaway message ID'));
gw.addSubcommand((s) => idOpt(s.setName('edit').setDescription('Edit a giveaway'), 'Giveaway message ID')
  .addStringOption((o) => o.setName('prize').setDescription('New prize'))
  .addIntegerOption((o) => o.setName('winners').setDescription('New winner count').setMinValue(1).setMaxValue(50))
  .addStringOption((o) => o.setName('duration').setDescription('New duration from now, or a Discord timestamp')));
gw.addSubcommand((s) => idOpt(s.setName('end').setDescription('End a giveaway with the giveaway message ID'), 'Giveaway message ID'));
gw.addSubcommand((s) => idOpt(s.setName('fix').setDescription('Fix a giveaway if it fails to end'), 'Giveaway message ID'));
gw.addSubcommand((s) => s.setName('manager-roles').setDescription('Set roles with which people can use every command in the bot'));
gw.addSubcommand((s) => idOpt(s.setName('participants').setDescription('View the users that have participated in a giveaway'), 'Giveaway message ID'));
gw.addSubcommand((s) => idOpt(s.setName('reroll').setDescription('Reroll the winner of a giveaway with the giveaway message ID'), 'Giveaway message ID'));

const messagesCmd = new SlashCommandBuilder().setName('messages').setDescription('View the number of messages you/other user has sent').setDMPermission(false)
  .addUserOption((o) => o.setName('user').setDescription('User to look up'));

const helpCmd = new SlashCommandBuilder().setName('help').setDescription('How to use Givevanced').setDMPermission(false);
const blacklistCmd = new SlashCommandBuilder().setName('blacklist').setDescription('Stop people from joining giveaways in this server').setDMPermission(false)
  .addSubcommand((s) => s.setName('add').setDescription('Blacklist a person').addUserOption((o) => o.setName('user').setDescription('The person to blacklist').setRequired(true)))
  .addSubcommand((s) => s.setName('remove').setDescription('Remove a person from the blacklist').addUserOption((o) => o.setName('user').setDescription('The person to remove').setRequired(true)))
  .addSubcommand((s) => s.setName('list').setDescription('View everyone who is blacklisted'));

function helpMessage() {
  const e = new EmbedBuilder().setColor(0x5865f2).setTitle('🎉 Givevanced Help')
    .setDescription('The free, advanced giveaway bot. Click the 🎉 button on a giveaway to enter, and click it again to leave.')
    .addFields(
      { name: '🎁 Giveaways', value: '`/giveaway create` start a giveaway\n`/giveaway schedule` start one later\n`/giveaway scheduled` and `unschedule` view or cancel them\n`/giveaway end` end one early\n`/giveaway reroll` pick new winners\n`/giveaway edit` change the prize, winners or time\n`/giveaway delete` remove a giveaway\n`/giveaway fix` repair one that failed to end\n`/giveaway participants` see who entered' },
      { name: '🛠️ Setup', value: '`/giveaway manager-roles` who can use every command\n`/giveaway creator-roles` who can only create giveaways\n`/blacklist add`, `remove`, `list` block people from entering' },
      { name: '📊 Other', value: '`/messages` message counts for you or another user\n`/help` this menu' },
      { name: '✨ Good to know', value: '• Winners get a **Claim** button in their DMs when a claim time is set\n• Requirements: roles, boosting, server tag and message counts\n• Commands that need a giveaway let you pick it from a list\n• Create and manage giveaways from the website dashboard' })
    .setFooter({ text: 'Made by @lav1nrules' });
  const row = new ActionRowBuilder();
  if (BASE) row.addComponents(new ButtonBuilder().setLabel('Dashboard').setStyle(ButtonStyle.Link).setURL(`${BASE}/dashboard`));
  row.addComponents(new ButtonBuilder().setLabel('Add to your server').setStyle(ButtonStyle.Link).setURL(`https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&permissions=268520448&scope=bot%20applications.commands`));
  return { embeds: [e], components: [row] };
}
async function blacklistCommand(i) {
  if (!isManager(i)) return i.reply({ content: 'You need Manage Server or a manager role.', ...eph });
  const sub = i.options.getSubcommand(), bl = blacklistOf(i.guildId);
  if (sub === 'list') return i.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🚫 Giveaway blacklist')
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

client.once('ready', async () => {
  const rest = new REST().setToken(process.env.TOKEN);
  const body = [gw, messagesCmd, helpCmd, blacklistCmd].map((c) => c.toJSON());
  const route = process.env.GUILD_ID
    ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID)
    : Routes.applicationCommands(process.env.CLIENT_ID);
  await rest.put(route, { body });
  // Scrolling status: the text slides one character every STATUS_SPEED ms and loops
  const MARQUEE = 'givevanced.onrender.com | Made by @lav1nrules ✦ ';
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

    if (i.commandName === 'help') return i.reply({ ...helpMessage(), ...eph });
    if (i.commandName === 'blacklist') return await blacklistCommand(i);
    const sub = i.options.getSubcommand();
    if (sub === 'manager-roles' || sub === 'creator-roles') {
      if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild) && !isManager(i))
        return i.reply({ content: 'You need Manage Server or a manager role.', ...eph });
      return i.reply({ content: `Select the **${sub === 'manager-roles' ? 'manager' : 'creator'}** roles (select none to clear):`,
        components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`cfg:${sub}`).setMinValues(0).setMaxValues(10))], ...eph });
    }
    if (sub === 'create' || sub === 'schedule') {
      if (!isCreator(i)) return i.reply({ content: 'You need Manage Server, a manager role, or a creator role.', ...eph });
      return await (sub === 'create' ? createGiveaway(i) : scheduleGiveaway(i));
    }
    if (!isManager(i)) return i.reply({ content: 'You need Manage Server or a manager role.', ...eph });
    if (sub === 'scheduled') return scheduledList(i);
    if (sub === 'unschedule') return unschedule(i);
    const g = db.giveaways[i.options.getString('message-id')];
    if (!g || g.guildId !== i.guildId) return i.reply({ content: 'Giveaway not found.', ...eph });

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
      const w = pickWinners(g, g.winners);
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
    color: o.color, endColor: o.endColor, bypass: o.bypass || [], req: o.req, entries: {}, winnerIds: [], claimed: [],
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
    bypass: ids(o.getString('requirement-bypass-roles')), createMessage: o.getString('giveaway-create-message'),
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
  await launchGiveaway({ ...readGiveawayOptions(i), ch, endsAt });
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
  const id = crypto.randomBytes(4).toString('hex');
  scheduledMap()[id] = { ...readGiveawayOptions(i), id, channelId: ch.id, startsAt, durationMs, createdBy: i.user.id };
  save();
  return i.reply({ content: `✅ Scheduled! **${scheduledMap()[id].prize}** will start <t:${Math.floor(startsAt / 1000)}:R> in ${ch} and run for ${shortLeft(durationMs)}.\nCancel it with \`/giveaway unschedule\`.`, ...eph });
}
function scheduledList(i) {
  const list = Object.values(scheduledMap()).filter((x) => x.guildId === i.guildId).sort((a, b) => a.startsAt - b.startsAt);
  return i.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🗓️ Scheduled giveaways')
    .setDescription(list.map((x, n) => `${n + 1}. **${x.prize}** · starts <t:${Math.floor(x.startsAt / 1000)}:R> in <#${x.channelId}> · ${x.winners} winner${x.winners > 1 ? 's' : ''}`).join('\n').slice(0, 4000) || 'Nothing is scheduled. Use `/giveaway schedule`.')], ...eph });
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
    if (i.commandName !== 'giveaway' || !i.guildId || !isManager(i)) return await i.respond([]);
    const f = i.options.getFocused(true), sub = i.options.getSubcommand(), q = String(f.value || '').toLowerCase();
    const chan = (id) => i.guild?.channels.cache.get(id)?.name || 'channel';
    if (sub === 'unschedule' && f.name === 'schedule') {
      const list = Object.values(scheduledMap()).filter((x) => x.guildId === i.guildId && x.prize.toLowerCase().includes(q)).sort((a, b) => a.startsAt - b.startsAt).slice(0, 25);
      return await i.respond(list.map((x) => ({ name: `🗓️ ${x.prize} · #${chan(x.channelId)} · starts in ${shortLeft(x.startsAt - Date.now())}`.slice(0, 100), value: x.id })));
    }
    if (f.name !== 'message-id') return await i.respond([]);
    let list = Object.values(db.giveaways).filter((g) => g.guildId === i.guildId);
    if (sub === 'reroll') list = list.filter((g) => g.ended);
    else if (sub === 'end' || sub === 'fix') list = list.filter((g) => !g.ended);
    list = list.filter((g) => g.prize.toLowerCase().includes(q) || g.messageId.includes(q))
      .sort((a, b) => (a.ended - b.ended) || (a.ended ? b.endsAt - a.endsAt : a.endsAt - b.endsAt)).slice(0, 25);
    return await i.respond(list.map((g) => ({
      name: `${g.ended ? '🏁' : '🎉'} ${g.prize} · #${chan(g.channelId)} · ${g.ended ? 'ended' : `ends in ${shortLeft(g.endsAt - Date.now())}`}`.slice(0, 100), value: g.messageId })));
  } catch { try { await i.respond([]); } catch { /* already answered */ } }
}

async function onButton(i) {
  if (i.customId === 'gw_enter') {
    const g = db.giveaways[i.message.id];
    if (!g || g.ended) return i.reply({ content: 'This giveaway has ended.', ...eph });
    if (g.entries[i.user.id]) {
      const n = g.entries[i.user.id];
      return i.reply({
        content: `✅ You've already joined this giveaway (${n} ${n === 1 ? 'entry' : 'entries'}).`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`gw_leave:${g.messageId}`).setLabel('Leave giveaway').setStyle(ButtonStyle.Danger))],
        ...eph,
      });
    }
    if ((g.removed || []).includes(i.user.id)) return i.reply({ content: '❌ You were removed from this giveaway by a moderator.', ...eph });
    const fail = await checkEntry(i, g);
    if (fail) return i.reply({ content: `❌ ${fail}`, ...eph });
    g.entries[i.user.id] = weightFor(i, g); save();
    await i.message.edit({ embeds: [embedFor(g)], components: [enterRow(g)] }).catch(() => {});
    const w = g.entries[i.user.id];
    return i.reply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle(`${TICK} Entry Confirmed!`)
      .setDescription(`Your entry for the giveaway of **${g.prize}** is confirmed!${w > 1 ? `\nYou have **${w}** entries.` : ''}`)], ...eph });
  }
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
  const lines = slice.map((id, n) => `${(page - 1) * PAGE + n + 1}. <@${id}> (**${g.entries[id]}** ${g.entries[id] === 1 ? 'entry' : 'entries'})`);
  const e = new EmbedBuilder().setColor(0xe67e22).setTitle(`👥 Giveaway Participants (Page ${page}/${pages})`)
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
  const w = pickWinners(g, g.winners);
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
  const g = await launchGiveaway({
    guildId: guild.id, ch, endsAt, prize, winners: int(b.winners, 1, 50), host: s.uid, extra,
    winnersRole: hasRole(b.winnersRole) ? b.winnersRole : null, claimMs, dmMessage: str(b.dmMessage, 1500) || null,
    image: link(b.image), thumbnail: link(b.thumbnail), color: parseColor(str(b.color, 7), 0x5865f2), endColor: parseColor(str(b.endColor, 7), 0x2b2d31),
    bypass: roleList(b.bypass), createMessage: str(b.createMessage, 1500) || null,
    req: { roles: roleList(b.requiredRoles), boosts: b.boosts ? 1 : 0, serverTag: !!b.serverTag,
      daily: int(b.daily, 0, 100000), weekly: int(b.weekly, 0, 100000), monthly: int(b.monthly, 0, 100000), total: int(b.total, 0, 1000000) },
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
    }
  }
  return info;
}
async function webJoin(g, s) {
  if (g.ended || Date.now() >= g.endsAt) return [400, 'This giveaway has ended.'];
  if ((g.removed || []).includes(s.uid)) return [403, 'You were removed from this giveaway by a moderator.'];
  if (g.entries[s.uid]) return [400, "You've already joined this giveaway."];
  const guild = client.guilds.cache.get(g.guildId), m = guild ? await guild.members.fetch(s.uid).catch(() => null) : null;
  if (!m) return [403, "You're not a member of this server."];
  const fail = await checkEntryFor(m, s.uid, g.guildId, g);
  if (fail) return [403, fail];
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
  const site = `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;   // the address the visitor is actually on
  res.gvSecure = proto === 'https';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
    // Only allow requests that come from this site itself (compare hosts, so BASE_URL typos can't lock people out)
    let ok = false;
    try {
      const oh = new URL(req.headers.origin).host;
      ok = oh === req.headers.host || oh === req.headers['x-forwarded-host'] || (!!BASE && oh === new URL(BASE).host);
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
    if (!loginReady() || !code || !state || state !== ck.gv_state) return redirect(res, '/dashboard?error=login');
    const tok = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: `${site}/callback` }) }).then((r) => r.json());
    if (!tok.access_token) return redirect(res, '/dashboard?error=login');
    const auth = { headers: { Authorization: `Bearer ${tok.access_token}` } };
    const [user, guilds] = await Promise.all([fetch('https://discord.com/api/users/@me', auth).then((r) => r.json()), fetch('https://discord.com/api/users/@me/guilds', auth).then((r) => r.json())]);
    if (!user.id) return redirect(res, '/dashboard?error=login');
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
        dmMessage: g.dmMessage || '', color: hex(g.color), endColor: hex(g.endColor), image: g.image || '', thumbnail: g.thumbnail || '' });
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

initStorage().then(() => client.login(process.env.TOKEN)).catch((e) => { console.error(e); process.exit(1); });
