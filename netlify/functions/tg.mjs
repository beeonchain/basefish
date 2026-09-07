// Basefish Telegram bot — webhook + full setup via chat commands.
// Subscriber prefs live in data/tg_subs.json in the repo (committed via GitHub API);
// the data pipeline reads that file on each run and sends the actual alerts.
// One-time setup: open  /api/tg?setup=1  once after adding TG_BOT_TOKEN + GH_DISPATCH_TOKEN in Netlify env.
import crypto from 'node:crypto';
import { readJson, updateJson, USERS_PATH, MAX_WATCHES as ACCT_MAX, webhookAddresses } from '../lib/store.mjs';

const REPO = 'beeonchain/basefish';
const SUBS_PATH = 'data/tg_subs.json';
const TOKENS = ['BRETT', 'TOSHI', 'BASECAT', 'AERO', 'VIRTUAL'];
const EVENTS = ['whale', 'entry', 'exit', 'cex', 'school'];
const MAX_WATCHES = 5;
// admin chat ids (Bee) — comma-separated in TG_ADMIN_CHATS env; falls back to the founder chat
const ADMINS = new Set((process.env.TG_ADMIN_CHATS || '7400046972').split(',').map((s) => s.trim()));

const hookSecret = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 32);
const gh = (t) => ({ Authorization: 'Bearer ' + t, Accept: 'application/vnd.github+json', 'User-Agent': 'basefish-tg', 'X-GitHub-Api-Version': '2022-11-28' });

async function loadSubs(ghToken) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${SUBS_PATH}?ref=main`, { headers: gh(ghToken) });
  if (r.status === 404) return { subs: { chats: {} }, sha: null };
  const d = await r.json();
  return { subs: JSON.parse(Buffer.from(d.content, 'base64').toString('utf8')), sha: d.sha };
}
async function saveSubs(ghToken, subs, sha) {
  const body = { message: 'tg: subscriber prefs update', content: Buffer.from(JSON.stringify(subs)).toString('base64'), branch: 'main' };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${SUBS_PATH}`, { method: 'PUT', headers: gh(ghToken), body: JSON.stringify(body) });
  return r.ok;
}
async function reply(tg, chat, text) {
  await fetch(`https://api.telegram.org/bot${tg}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
}

const HELP = `<b>🐟 Basefish alerts</b>
Alerts arrive with each data refresh (~every 2h).

/start — subscribe (all tokens, all events)
/stop — unsubscribe
/tokens BRETT,AERO — only these tokens (/tokens all resets)
/events whale,cex — only these kinds (/events all resets)
   kinds: whale · entry · exit · cex · school
/watch 0x… TOKEN — custom: every tx of that wallet in that token (max ${MAX_WATCHES})
/unwatch 0x… — remove a watch
/list — your current setup
/link CODE — connect to your basefish.netlify.app account (code from the Alerts tab); watches then sync both ways
/unlink — disconnect
/help — this message`;

// global pause: subs.pause = { on: true, allow: [chatId...] } — admins + allowlisted chats keep receiving
const ADMIN_HELP = `<b>🛠 Admin commands</b>
/pauseall [id,id] — stop alerts for everyone except admins (+ optional ids)
/resumeall — lift the pause
/allow id — add an exception while paused
/disallow id — remove an exception
/users — list subscribers with chat ids
/broadcast msg — service message to all subscribers
/stats — subscriber counts + pause state
/id — your chat id
/admin — this list`;
const isAllowed = (subs, chat) => !(subs.pause && subs.pause.on) || ADMINS.has(chat) || ((subs.pause.allow || []).includes(chat));
const pauseLine = (subs) => (subs.pause && subs.pause.on) ? `⏸ <b>Global pause ON</b> — receiving: admins${(subs.pause.allow || []).length ? ' + ' + subs.pause.allow.map((c) => `<code>${c}</code>`).join(', ') : ''}` : '▶️ Global pause off — everyone receives alerts';

function fmtPrefs(p) {
  return `<b>Your setup</b>
tokens: ${p.tokens && p.tokens.length ? p.tokens.join(', ') : 'all'}
events: ${p.events && p.events.length ? p.events.join(', ') : 'all'}
watches: ${(p.watches || []).length ? p.watches.map((w) => `${w.w.slice(0, 8)}… → $${w.t}`).join('\n         ') : 'none'}
status: ${p.muted ? 'paused (/start to resume)' : 'active'}`;
}

export default async (req) => {
  const url = new URL(req.url);
  const TG = process.env.TG_BOT_TOKEN, GH = process.env.GH_DISPATCH_TOKEN;
  if (!TG || !GH) return new Response('TG_BOT_TOKEN / GH_DISPATCH_TOKEN not configured in Netlify env', { status: 500 });

  if (url.searchParams.get('setup')) { // idempotent webhook registration
    const hook = `${url.origin}/api/tg`;
    const r = await fetch(`https://api.telegram.org/bot${TG}/setWebhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: hook, secret_token: hookSecret(TG), allowed_updates: ['message'] }),
    });
    return new Response(JSON.stringify(await r.json()), { headers: { 'content-type': 'application/json' } });
  }

  if (req.method !== 'POST') return new Response('ok');
  if (req.headers.get('x-telegram-bot-api-secret-token') !== hookSecret(TG)) return new Response('nope', { status: 403 });

  const update = await req.json().catch(() => null);
  const msg = update && update.message;
  if (!msg || !msg.text || !msg.chat) return new Response('ok');
  const chat = String(msg.chat.id);
  const [cmd, ...args] = msg.text.trim().split(/\s+/);
  const arg = args.join(' ');

  const { subs, sha } = await loadSubs(GH);
  subs.chats = subs.chats || {};
  const p = subs.chats[chat] || (subs.chats[chat] = { tokens: [], events: [], watches: [] });
  let dirty = false, out = null;
  // remember who this is (handle + name) so /users can show people, not just ids
  const f = msg.from || {}, who = { u: f.username || '', n: [f.first_name, f.last_name].filter(Boolean).join(' ') };
  if (JSON.stringify(p.who || {}) !== JSON.stringify(who)) { p.who = who; dirty = true; }

  switch ((cmd || '').toLowerCase().replace(/@\w+$/, '')) {
    case '/start': p.muted = false; dirty = true;
      out = `You're in. Alerts for <b>all tokens, all events</b> will land here after each refresh.\n\n${HELP}`; break;
    case '/stop': p.muted = true; dirty = true; out = 'Paused. /start to resume — your setup is kept.'; break;
    case '/tokens': {
      if (!arg || arg.toLowerCase() === 'all') { p.tokens = []; out = 'Tokens: all.'; }
      else { const want = arg.toUpperCase().split(/[\s,]+/).filter((x) => TOKENS.includes(x));
        if (!want.length) { out = `None recognized. Tracked: ${TOKENS.join(', ')}`; break; }
        p.tokens = want; out = `Tokens: ${want.join(', ')}`; }
      dirty = true; break; }
    case '/events': {
      if (!arg || arg.toLowerCase() === 'all') { p.events = []; out = 'Events: all.'; }
      else { const want = arg.toLowerCase().split(/[\s,]+/).filter((x) => EVENTS.includes(x));
        if (!want.length) { out = `None recognized. Kinds: ${EVENTS.join(', ')}`; break; }
        p.events = want; out = `Events: ${want.join(', ')}`; }
      dirty = true; break; }
    case '/watch': {
      const m = arg.match(/(0x[0-9a-fA-F]{40})\s+(\S{2,12})/);
      if (!m) { out = 'Usage: /watch 0xWALLET TOKEN — e.g. /watch 0x388e…c997 BRETT'; break; }
      const entry = { w: m[1].toLowerCase(), t: m[2].toUpperCase() };
      if (!TOKENS.includes(entry.t)) { out = `Unknown token. Tracked: ${TOKENS.join(', ')}`; break; }
      if (p.uid) { // linked account: the account's list is the source of truth
        let msg = null;
        await updateJson(USERS_PATH, { users: {} }, (d) => { const u = d.users && d.users[p.uid]; if (!u) { msg = 'Your linked account no longer exists — /unlink and try again.'; return false; }
          u.watches = u.watches || [];
          if (u.watches.some((x) => x.w === entry.w && x.t === entry.t)) { msg = 'Already watching that.'; return false; }
          if (u.watches.length >= ACCT_MAX) { msg = `Watch limit is ${ACCT_MAX} — remove one first.`; return false; }
          u.watches.push({ ...entry, added: Date.now() }); }, 'users: watch via tg');
        out = msg || `Watching <code>${entry.w.slice(0, 10)}…</code> for $${entry.t} txs — live, and it shows in your account on the site too.`;
        if (!msg) await webhookAddresses([entry.w]);
        break;
      }
      p.watches = p.watches || [];
      if (p.watches.length >= MAX_WATCHES) { out = `Watch limit is ${MAX_WATCHES} — /unwatch one first.`; break; }
      if (p.watches.some((x) => x.w === entry.w && x.t === entry.t)) { out = 'Already watching that.'; break; }
      p.watches.push(entry); dirty = true;
      await webhookAddresses([entry.w]);
      out = `Watching <code>${entry.w.slice(0, 10)}…</code> for $${entry.t} txs — live alerts from now on.`; break; }
    case '/unwatch': {
      const m = arg.match(/0x[0-9a-fA-F]{40}/);
      if (!m) { out = 'Usage: /unwatch 0xWALLET'; break; }
      const w = m[0].toLowerCase();
      if (p.uid) {
        let removed = false;
        await updateJson(USERS_PATH, { users: {} }, (d) => { const u = d.users && d.users[p.uid]; if (!u) return false; const n = (u.watches || []).length; u.watches = (u.watches || []).filter((x) => x.w !== w); removed = u.watches.length !== n; return removed ? undefined : false; }, 'users: unwatch via tg');
        out = removed ? 'Removed.' : 'That wallet was not on your watch list.'; break;
      }
      const before = (p.watches || []).length;
      p.watches = (p.watches || []).filter((x) => x.w !== w);
      dirty = p.watches.length !== before;
      out = dirty ? 'Removed.' : 'That wallet was not on your watch list.'; break; }
    case '/link': {
      const code = arg.trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) { out = 'Usage: /link CODE — get the code from the Alerts tab on basefish.netlify.app (sign in → Link Telegram).'; break; }
      let linked = null, moved = 0;
      await updateJson(USERS_PATH, { users: {} }, (d) => {
        const hit = Object.entries(d.users || {}).find(([, u]) => u.link && u.link.code === code && u.link.exp > Date.now());
        if (!hit) return false;
        const [uid, u] = hit; u.tg = chat; u.link = null; u.watches = u.watches || [];
        for (const w of p.watches || []) if (!u.watches.some((x) => x.w === w.w && x.t === w.t) && u.watches.length < ACCT_MAX) { u.watches.push({ ...w, added: Date.now() }); moved++; }
        linked = { uid, label: u.label, n: u.watches.length };
      }, 'users: link telegram');
      if (!linked) { out = 'Code not found or expired (codes last 15 min). Generate a new one in the Alerts tab.'; break; }
      p.uid = linked.uid; p.watches = []; p.muted = false; dirty = true;
      out = `Linked to <b>${linked.label}</b> ✅ Your ${linked.n} watch${linked.n === 1 ? '' : 'es'}${moved ? ` (${moved} moved over from this chat)` : ''} now alert here and on the site. /list to see them.`; break; }
    case '/unlink': {
      if (!p.uid) { out = 'This chat is not linked to a site account.'; break; }
      try { await updateJson(USERS_PATH, { users: {} }, (d) => { const u = d.users && d.users[p.uid]; if (!u) return false; u.tg = null; }, 'users: unlink telegram'); } catch {}
      delete p.uid; dirty = true; out = 'Unlinked. Watches stay on your site account; this chat starts fresh.'; break; }
    case '/list': case '/settings': {
      if (p.uid) { try { const { data } = await readJson(USERS_PATH, { users: {} }); const u = data.users && data.users[p.uid]; if (u) { out = fmtPrefs({ ...p, watches: u.watches || [] }) + `\nlinked account: <b>${u.label}</b>`; break; } } catch {} }
      out = fmtPrefs(p); break; }
    case '/id': case '/whoami': out = `Your chat id: <code>${chat}</code>${who.u ? ' · @' + who.u : ''}${ADMINS.has(chat) ? ' (admin)' : ''}`; break;
    case '/broadcast': { // admin: service message to every subscriber (paused ones included)
      if (!ADMINS.has(chat)) { out = HELP; break; }
      if (!arg) { out = 'Usage: /broadcast your message (HTML ok: <b>bold</b>, <a href="...">link</a>)'; break; }
      const targets = Object.keys(subs.chats).filter((c) => c !== chat);
      let sent = 0;
      for (const c of targets) {
        try { await reply(TG, c, `📢 <b>Basefish</b>\n${arg}`); sent++; } catch (e) {}
        await new Promise((s) => setTimeout(s, 40));
      }
      out = `Broadcast sent to ${sent}/${targets.length} subscriber${targets.length === 1 ? '' : 's'}.`; break; }
    case '/stats': {
      if (!ADMINS.has(chat)) { out = HELP; break; }
      const all = Object.values(subs.chats), active = all.filter((x) => !x.muted).length, watches = all.reduce((n, x) => n + (x.watches || []).length, 0);
      out = `<b>Bot stats</b>\nsubscribers: ${all.length} (${active} active, ${all.length - active} paused)\ncustom watches: ${watches}\n${pauseLine(subs)}`; break; }
    case '/pauseall': { // admin: nobody but admins (+ listed ids) gets alerts until /resumeall
      if (!ADMINS.has(chat)) { out = HELP; break; }
      const ids = (arg.match(/\d{5,}/g) || []);
      subs.pause = { on: true, allow: [...new Set([...((subs.pause && subs.pause.allow) || []), ...ids])] }; dirty = true;
      out = `${pauseLine(subs)}\nEveryone else is muted (their setups are kept). /allow id to add exceptions, /resumeall to lift.`; break; }
    case '/resumeall': {
      if (!ADMINS.has(chat)) { out = HELP; break; }
      subs.pause = { on: false, allow: (subs.pause && subs.pause.allow) || [] }; dirty = true;
      out = 'Pause lifted — all subscribers receive alerts again.'; break; }
    case '/allow': case '/disallow': {
      if (!ADMINS.has(chat)) { out = HELP; break; }
      const ids = (arg.match(/\d{5,}/g) || []);
      if (!ids.length) { out = `Usage: ${cmd} chatId — ids from /users (or the user sends /id)`; break; }
      subs.pause = subs.pause || { on: false, allow: [] };
      const set = new Set(subs.pause.allow || []);
      ids.forEach((i) => (cmd.toLowerCase().startsWith('/allow') ? set.add(i) : set.delete(i)));
      subs.pause.allow = [...set]; dirty = true;
      out = pauseLine(subs); break; }
    case '/users': {
      if (!ADMINS.has(chat)) { out = HELP; break; }
      const label = (x) => x.who ? (x.who.u ? '@' + x.who.u : '') + (x.who.n ? ` ${x.who.n.replace(/</g, '&lt;')}` : '') : '';
      const rows = Object.entries(subs.chats).map(([c, x]) => `<code>${c}</code> ${label(x) || '<i>unknown yet</i>'} ${ADMINS.has(c) ? '👑' : ''}${x.muted ? '⏹' : '✅'}${(x.watches || []).length ? ' 👁' + x.watches.length : ''}${isAllowed(subs, c) ? '' : ' 🔇'}`);
      out = `<b>Subscribers</b> (${rows.length})\n${rows.join('\n')}\n\n👑 admin · ✅ active · ⏹ self-paused · 👁 watches · 🔇 muted by global pause\n${pauseLine(subs)}`; break; }
    case '/admin': out = ADMINS.has(chat) ? ADMIN_HELP : HELP; break;
    default: out = HELP;
  }
  if (dirty) await saveSubs(GH, subs, sha);
  if (out && !ADMINS.has(chat) && !isAllowed(subs, chat) && out !== HELP) out += '\n\n⏸ Alerts are currently paused by the admin — your setup is saved and resumes automatically.';
  if (out) await reply(TG, chat, out);
  return new Response('ok');
};
export const config = { path: '/api/tg' };
