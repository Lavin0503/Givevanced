require('dotenv').config();
const fs = require('fs');
const {
  Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, REST, Routes,
  PermissionFlagsBits, MessageFlags,
} = require('discord.js');

/* ───────────── storage (simple JSON file) ───────────── */
const DATA_DIR = process.env.DATA_DIR || '.';
fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = `${DATA_DIR}/data.json`;
let db = { giveaways: {}, guilds: {}, stats: {} };
if (fs.existsSync(FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
let saveTimer;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => fs.writeFileSync(FILE, JSON.stringify(db)), 500); };
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
const levelOf = (xp) => Math.floor(Math.sqrt(xp / 100));
function statsOf(gid, uid) { return ((db.stats[gid] ??= {})[uid] ??= { total: 0, xp: 0, days: {}, lastXp: 0 }); }
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
      reqText(g),
      ended ? `\n**Winner(s):** ${g.winnerIds.length ? g.winnerIds.map((w) => `<@${w}>`).join(', ') : 'No valid entries'}` : '',
    ].filter(Boolean).join('\n'))
    .setFooter({ text: ended ? 'Giveaway ended' : 'Givevanced' });
  if (g.image) e.setImage(g.image);
  if (g.thumbnail) e.setThumbnail(g.thumbnail);
  return e;
}
function reqText(g) {
  const r = g.req, l = [];
  if (r.roles.length) l.push(`Roles: ${r.roles.map((x) => `<@&${x}>`).join(', ')}`);
  if (r.boosts) l.push('Must be boosting this server');
  if (r.serverTag) l.push("Must have this server's tag equipped");
  if (r.level) l.push(`Level ${r.level}+`);
  if (r.daily) l.push(`${r.daily}+ messages today`);
  if (r.weekly) l.push(`${r.weekly}+ messages this week`);
  if (r.monthly) l.push(`${r.monthly}+ messages this month`);
  if (r.total) l.push(`${r.total}+ total messages`);
  if (g.extra && Object.keys(g.extra).length)
    l.push('Extra entries: ' + Object.entries(g.extra).map(([id, n]) => `<@&${id}> ×${n}`).join(', '));
  return l.length ? `\n**Requirements**\n${l.map((x) => `• ${x}`).join('\n')}` : '';
}
const enterRow = (disabled = false) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('gw_enter').setLabel('Enter').setEmoji('🎉').setStyle(ButtonStyle.Primary).setDisabled(disabled));

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
async function announce(g, ch, winners) {
  const txt = winners.length
    ? `🎉 Congratulations ${winners.map((w) => `<@${w}>`).join(', ')}! You won **${g.prize}**!`
    : `No valid entries for **${g.prize}**, so no winner was chosen.`;
  const payload = { content: txt, allowedMentions: { users: winners } };
  if (g.claimMs && winners.length) {
    payload.components = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gw_claim:${g.messageId}`).setLabel('Claim').setStyle(ButtonStyle.Success))];
    payload.content += `\nClick **Claim** within <t:${Math.floor(g.claimDeadline / 1000)}:R> or you'll be rerolled.`;
  }
  await ch.send(payload).catch(() => {});
  const guild = await client.guilds.fetch(g.guildId).catch(() => null);
  for (const w of winners) {
    if (g.winnersRole && guild) guild.members.fetch(w).then((m) => m.roles.add(g.winnersRole)).catch(() => {});
    if (g.dmMessage) client.users.fetch(w).then((u) =>
      u.send(g.dmMessage.replaceAll('{prize}', g.prize).replaceAll('{server}', guild?.name ?? ''))).catch(() => {});
  }
}
async function endGiveaway(g) {
  g.ended = true;
  g.winnerIds = pickWinners(g, g.winners);
  g.claimed = [];
  if (g.claimMs) g.claimDeadline = Date.now() + g.claimMs;
  save();
  const { ch, msg } = await fetchMsg(g);
  if (msg) await msg.edit({ embeds: [embedFor(g, true)], components: [enterRow(true)] }).catch(() => {});
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
}, 5000);

/* ───────────── requirement check on entry ───────────── */
async function checkEntry(i, g) {
  const m = i.member, r = g.req;
  if (g.bypass.some((x) => m.roles.cache.has(x))) return null;
  const s = statsOf(i.guildId, i.user.id);
  if (r.roles.length && !r.roles.every((x) => m.roles.cache.has(x))) return 'You are missing a required role.';
  if (r.boosts && !m.premiumSince) return 'You need to be boosting this server.';
  if (r.serverTag) {
    const u = await client.users.fetch(i.user.id, { force: true }).catch(() => i.user);
    const pg = u.primaryGuild;
    if (!pg || pg.identityGuildId !== i.guildId || pg.identityEnabled === false) return "You need this server's tag equipped.";
  }
  if (r.level && levelOf(s.xp) < r.level) return `You need level ${r.level} (you are level ${levelOf(s.xp)}).`;
  if (r.daily && countSince(s, 1) < r.daily) return `You need ${r.daily} messages today (you have ${countSince(s, 1)}).`;
  if (r.weekly && countSince(s, weekDays()) < r.weekly) return `You need ${r.weekly} messages this week (you have ${countSince(s, weekDays())}).`;
  if (r.monthly && countSince(s, monthDays()) < r.monthly) return `You need ${r.monthly} messages this month (you have ${countSince(s, monthDays())}).`;
  if (r.total && s.total < r.total) return `You need ${r.total} total messages (you have ${s.total}).`;
  return null;
}
function weightFor(i, g) {
  let w = 1;
  for (const [role, n] of Object.entries(g.extra || {})) if (i.member.roles.cache.has(role)) w += n;
  return w;
}

/* ───────────── slash command definitions ───────────── */
const gw = new SlashCommandBuilder().setName('giveaway').setDescription('Giveaway commands').setDMPermission(false);
gw.addSubcommand((s) => s.setName('create').setDescription('Create a giveaway')
  .addStringOption((o) => o.setName('duration').setDescription('How long it lasts, like 1 hour or 2 days, or a Discord timestamp').setRequired(true))
  .addIntegerOption((o) => o.setName('winners').setDescription('The number of winners for this giveaway').setMinValue(1).setMaxValue(50).setRequired(true))
  .addStringOption((o) => o.setName('prize').setDescription('The prize of this giveaway').setRequired(true))
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
  .addIntegerOption((o) => o.setName('required-level').setDescription('The level required to participate').setMinValue(1))
  .addIntegerOption((o) => o.setName('required-daily-messages').setDescription('Messages required today').setMinValue(1))
  .addIntegerOption((o) => o.setName('required-weekly-messages').setDescription('Messages required this week').setMinValue(1))
  .addIntegerOption((o) => o.setName('required-monthly-messages').setDescription('Messages required this month').setMinValue(1))
  .addIntegerOption((o) => o.setName('required-total-messages').setDescription('Messages required in total').setMinValue(1))
  .addStringOption((o) => o.setName('requirement-bypass-roles').setDescription('Roles that bypass all requirements (separate with commas)'))
  .addStringOption((o) => o.setName('color').setDescription('Embed hex color, e.g. #5865F2'))
  .addStringOption((o) => o.setName('end-color').setDescription('Embed hex color after the giveaway ends')));
const idOpt = (s, d) => s.addStringOption((o) => o.setName('message-id').setDescription(d).setRequired(true));
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
const leaderboard = new SlashCommandBuilder().setName('leaderboard').setDescription('Leaderboards').setDMPermission(false)
  .addSubcommand((s) => s.setName('levels').setDescription('View the level leaderboard of this server'));

client.once('ready', async () => {
  const rest = new REST().setToken(process.env.TOKEN);
  const body = [gw, messagesCmd, leaderboard].map((c) => c.toJSON());
  const route = process.env.GUILD_ID
    ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID)
    : Routes.applicationCommands(process.env.CLIENT_ID);
  await rest.put(route, { body });
  console.log(`Givevanced online as ${client.user.tag}`);
});

/* ───────────── message tracking (messages + levels) ───────────── */
client.on('messageCreate', (m) => {
  if (!m.guild || m.author.bot) return;
  const s = statsOf(m.guild.id, m.author.id);
  s.total++; s.days[day()] = (s.days[day()] || 0) + 1;
  if (Date.now() - s.lastXp > 60000) { s.xp += 15 + Math.floor(Math.random() * 11); s.lastXp = Date.now(); }
  save();
});

/* ───────────── interactions ───────────── */
const eph = { flags: MessageFlags.Ephemeral };
client.on('interactionCreate', async (i) => {
  try {
    if (i.isButton()) return await onButton(i);
    if (i.isRoleSelectMenu()) return await onRoleSelect(i);
    if (!i.isChatInputCommand()) return;

    if (i.commandName === 'messages') {
      const u = i.options.getUser('user') || i.user, s = statsOf(i.guildId, u.id);
      return i.reply({ embeds: [new EmbedBuilder().setTitle(`Messages: ${u.username}`).setColor(0x5865f2).addFields(
        { name: 'Today', value: String(countSince(s, 1)), inline: true },
        { name: 'This week', value: String(countSince(s, weekDays())), inline: true },
        { name: 'This month', value: String(countSince(s, monthDays())), inline: true },
        { name: 'Total', value: String(s.total), inline: true },
        { name: 'Level', value: String(levelOf(s.xp)), inline: true })] });
    }
    if (i.commandName === 'leaderboard') {
      const top = Object.entries(db.stats[i.guildId] || {}).sort((a, b) => b[1].xp - a[1].xp).slice(0, 10);
      return i.reply({ embeds: [new EmbedBuilder().setTitle('Level leaderboard').setColor(0x5865f2)
        .setDescription(top.map(([id, s], n) => `**${n + 1}.** <@${id}> — Level ${levelOf(s.xp)} (${s.xp} XP)`).join('\n') || 'Nothing yet.')],
        allowedMentions: { parse: [] } });
    }

    const sub = i.options.getSubcommand();
    if (sub === 'manager-roles' || sub === 'creator-roles') {
      if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild) && !isManager(i))
        return i.reply({ content: 'You need Manage Server or a manager role.', ...eph });
      return i.reply({ content: `Select the **${sub === 'manager-roles' ? 'manager' : 'creator'}** roles (select none to clear):`,
        components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`cfg:${sub}`).setMinValues(0).setMaxValues(10))], ...eph });
    }
    if (sub === 'create') {
      if (!isCreator(i)) return i.reply({ content: 'You need Manage Server, a manager role, or a creator role.', ...eph });
      return await createGiveaway(i);
    }
    if (!isManager(i)) return i.reply({ content: 'You need Manage Server or a manager role.', ...eph });
    const g = db.giveaways[i.options.getString('message-id')];
    if (!g || g.guildId !== i.guildId) return i.reply({ content: 'Giveaway not found.', ...eph });

    if (sub === 'end') {
      if (g.ended) return i.reply({ content: 'That giveaway already ended.', ...eph });
      await i.reply({ content: 'Ending...', ...eph }); return endGiveaway(g);
    }
    if (sub === 'fix') {
      if (!g.ended && g.endsAt <= Date.now()) await endGiveaway(g);
      else { const { msg } = await fetchMsg(g); if (msg) await msg.edit({ embeds: [embedFor(g, g.ended)], components: [enterRow(g.ended)] }); }
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
      const { msg } = await fetchMsg(g); if (msg) await msg.edit({ embeds: [embedFor(g, g.ended)] });
      return i.reply({ content: 'Giveaway updated.', ...eph });
    }
  } catch (e) {
    console.error(e);
    const p = { content: 'Something went wrong.', ...eph };
    i.deferred || i.replied ? i.followUp(p).catch(() => {}) : i.reply(p).catch(() => {});
  }
});

async function createGiveaway(i) {
  const o = i.options, endsAt = parseDuration(o.getString('duration'));
  if (!endsAt || endsAt <= Date.now()) return i.reply({ content: 'Invalid duration. Try `1 hour`, `2 days` or a Discord timestamp.', ...eph });
  const ch = o.getChannel('channel') || i.channel;
  if (!ch?.isTextBased()) return i.reply({ content: 'Pick a text channel.', ...eph });
  const claimStr = o.getString('claim-time');
  const g = {
    guildId: i.guildId, channelId: ch.id, messageId: null, endsAt, ended: false,
    prize: o.getString('prize'), winners: o.getInteger('winners'), host: (o.getUser('host') || i.user).id,
    extra: parseExtra(o.getString('extra-entries')), winnersRole: o.getRole('giveaway-winners-role')?.id || null,
    claimMs: claimStr ? parseMs(claimStr) : null, dmMessage: o.getString('giveaway-winners-dm-message'),
    image: o.getAttachment('image')?.url || null, thumbnail: o.getAttachment('thumbnail')?.url || null,
    color: parseColor(o.getString('color'), 0x5865f2), endColor: parseColor(o.getString('end-color'), 0x2b2d31),
    bypass: ids(o.getString('requirement-bypass-roles')),
    req: {
      roles: ids(o.getString('required-roles')), boosts: o.getInteger('required-server-boosts') || 0,
      serverTag: !!o.getBoolean('require-server-tag'), level: o.getInteger('required-level') || 0,
      daily: o.getInteger('required-daily-messages') || 0, weekly: o.getInteger('required-weekly-messages') || 0,
      monthly: o.getInteger('required-monthly-messages') || 0, total: o.getInteger('required-total-messages') || 0,
    },
    entries: {}, winnerIds: [], claimed: [],
  };
  const msg = await ch.send({ embeds: [embedFor(g)], components: [enterRow()] });
  g.messageId = msg.id; db.giveaways[msg.id] = g; save();
  const extraMsg = o.getString('giveaway-create-message');
  if (extraMsg) await ch.send(extraMsg).catch(() => {});
  return i.reply({ content: `Giveaway created in ${ch}.`, ...eph });
}

async function onButton(i) {
  if (i.customId === 'gw_enter') {
    const g = db.giveaways[i.message.id];
    if (!g || g.ended) return i.reply({ content: 'This giveaway has ended.', ...eph });
    if (g.entries[i.user.id]) {
      delete g.entries[i.user.id]; save();
      await i.message.edit({ embeds: [embedFor(g)] }).catch(() => {});
      return i.reply({ content: 'You left the giveaway.', ...eph });
    }
    const fail = await checkEntry(i, g);
    if (fail) return i.reply({ content: `❌ ${fail}`, ...eph });
    g.entries[i.user.id] = weightFor(i, g); save();
    await i.message.edit({ embeds: [embedFor(g)] }).catch(() => {});
    return i.reply({ content: `🎉 You're in! (${g.entries[i.user.id]} ${g.entries[i.user.id] === 1 ? 'entry' : 'entries'}). Click again to leave.`, ...eph });
  }
  if (i.customId.startsWith('gw_claim:')) {
    const g = db.giveaways[i.customId.split(':')[1]];
    if (!g || !g.winnerIds.includes(i.user.id)) return i.reply({ content: 'You are not a winner of this giveaway.', ...eph });
    if (!g.claimed.includes(i.user.id)) g.claimed.push(i.user.id);
    save();
    return i.reply({ content: '✅ Prize claimed!', ...eph });
  }
}
async function onRoleSelect(i) {
  if (!i.customId.startsWith('cfg:') || !isManager(i)) return i.reply({ content: 'Not allowed.', ...eph });
  const key = i.customId === 'cfg:manager-roles' ? 'managerRoles' : 'creatorRoles';
  guildCfg(i.guildId)[key] = i.values; save();
  return i.update({ content: `Saved ${key === 'managerRoles' ? 'manager' : 'creator'} roles: ${i.values.map((r) => `<@&${r}>`).join(', ') || 'none'}`, components: [] });
}

// Tiny HTTP server so Render sees a web service (and so uptime pings have something to hit)
require('http').createServer((_, res) => res.end('Givevanced is running')).listen(process.env.PORT || 3000);

client.login(process.env.TOKEN);
