// Basefish Telegram bot — webhook + full setup via chat commands.
// Subscriber prefs live in data/tg_subs.json in the repo (committed via GitHub API);
// the data pipeline reads that file on each run and sends the actual alerts.
// One-time setup: open  /api/tg?setup=1  once after adding TG_BOT_TOKEN + GH_DISPATCH_TOKEN in Netlify env.
import crypto from 'node:crypto';

const REPO = 'beeonchain/basefish';
const SUBS_PATH = 'data/tg_subs.json';
const TOKENS = ['BRETT', 'TOSHI', 'BASECAT', 'AERO', 'VIRTUAL'];
const EVENTS = ['whale', 'entry', 'exit', 'cex', 'school'];
const MAX_WATCHES = 5;

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
/help — this message`;

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
      p.watches = p.watches || [];
      if (p.watches.length >= MAX_WATCHES) { out = `Watch limit is ${MAX_WATCHES} — /unwatch one first.`; break; }
      const entry = { w: m[1].toLowerCase(), t: m[2].toUpperCase() };
      if (p.watches.some((x) => x.w === entry.w && x.t === entry.t)) { out = 'Already watching that.'; break; }
      p.watches.push(entry); dirty = true;
      out = `Watching <code>${entry.w.slice(0, 10)}…</code> for $${entry.t} txs. First check on the next refresh (~2h max).`; break; }
    case '/unwatch': {
      const m = arg.match(/0x[0-9a-fA-F]{40}/);
      if (!m) { out = 'Usage: /unwatch 0xWALLET'; break; }
      const before = (p.watches || []).length;
      p.watches = (p.watches || []).filter((x) => x.w !== m[0].toLowerCase());
      dirty = p.watches.length !== before;
      out = dirty ? 'Removed.' : 'That wallet was not on your watch list.'; break; }
    case '/list': case '/settings': out = fmtPrefs(p); break;
    default: out = HELP;
  }
  if (dirty) await saveSubs(GH, subs, sha);
  if (out) await reply(TG, chat, out);
  return new Response('ok');
};
export const config = { path: '/api/tg' };
