// Instant alerts — Alchemy Address Activity webhook receiver.
// Alchemy pushes every transfer touching a tracked wallet within seconds of the block;
// this classifies it (custom watch / whale-sized / exchange inflow) and fires Telegram
// + appends to the site feed immediately. Snapshot-based alerts (entries/exits/schools)
// stay with the 2h pipeline — they only exist per-ranking.
import crypto from 'node:crypto';

const REPO = 'beeonchain/basefish';
const SITE = 'https://basefish.netlify.app';
const TH = { whale: 50_000, cex: 100_000 }; // instant thresholds (lower than the 2h digest)
const CEX_RX = /coinbase|binance|kraken|okx|bybit|upbit|bithumb|\bgate\b|kucoin|mexc|bitget|htx|crypto\.com|bitpanda|bitvavo|bitstamp|gemini|robinhood|exchange|deposit/i;

let ctx = null, ctxAt = 0; // tokens/prices/top100/excluded/subs, cached ~90s per instance
const seen = new Set(); // tx-hash dedupe per instance
const recent = new Map(); // addr -> [ts...] public alerts fired by this instance
const THROTTLE = { minGapMs: 30 * 60e3, maxPerDay: 6 }; // one public alert per wallet per 30 min; >6/day = market-maker noise, muted
function throttled(addr, feed) {
  const now = Date.now();
  const mine = (recent.get(addr) || []).filter((t) => now - t < 864e5);
  const inFeed = feed.filter((a) => a.addr && a.addr.toLowerCase() === addr && now - a.ts < 864e5).map((a) => a.ts);
  const all = [...mine, ...inFeed];
  if (all.some((t) => now - t < THROTTLE.minGapMs)) return true;
  if (all.length >= THROTTLE.maxPerDay) return true;
  mine.push(now); recent.set(addr, mine);
  return false;
}
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const musd = (v) => { const x = Math.abs(v); return x >= 1e6 ? '$' + (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? '$' + (x / 1e3).toFixed(0) + 'K' : '$' + x.toFixed(0); };

async function loadCtx() {
  if (ctx && Date.now() - ctxAt < 90e3) return ctx;
  const g = async (p) => { try { const r = await fetch(`${SITE}/data/${p}?t=${Date.now()}`); return r.ok ? r.json() : null; } catch { return null; } };
  const index = await g('index.json');
  const tokens = {}; // contract -> {sym, price, top:Set, names:{addr:label}}
  for (const t of (index && index.tokens) || []) {
    const d = await g(t.sym.toLowerCase() + '.json');
    if (!d) continue;
    const names = {};
    (d.holdersTop || []).forEach((h) => { if (h.entity || h.basename) names[h.addr.toLowerCase()] = h.entity || h.basename; });
    tokens[t.contract.toLowerCase()] = { sym: t.sym, price: d.price || 0, top: new Set((d.holdersTop || []).map((h) => h.addr.toLowerCase())), names };
  }
  const excludedRaw = (await g('excluded.json')) || {};
  const cex = {}; for (const [a, l] of Object.entries(excludedRaw)) if (CEX_RX.test(String(l))) cex[a] = l;
  const subs = (await g('tg_subs.json')) || { chats: {} };
  const feed = ((await g('alerts.json')) || {}).alerts || [];
  ctx = { tokens, cex, subs, feed };
  ctxAt = Date.now();
  return ctx;
}

async function tg(chat, text) {
  const token = process.env.TG_BOT_TOKEN; if (!token) return;
  try { await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }) }); } catch {}
}

async function appendFeed(alerts) { // best-effort; TG already sent
  const gh = process.env.GH_DISPATCH_TOKEN; if (!gh || !alerts.length) return;
  const H = { Authorization: 'Bearer ' + gh, Accept: 'application/vnd.github+json', 'User-Agent': 'basefish-alch', 'X-GitHub-Api-Version': '2022-11-28' };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const cur = await (await fetch(`https://api.github.com/repos/${REPO}/contents/data/alerts.json?ref=main`, { headers: H })).json();
      const feed = JSON.parse(Buffer.from(cur.content, 'base64').toString('utf8'));
      const have = new Set((feed.alerts || []).map((a) => a.id));
      const fresh = alerts.filter((a) => !have.has(a.id));
      if (!fresh.length) return;
      feed.alerts = [...fresh, ...(feed.alerts || [])].slice(0, 300);
      const r = await fetch(`https://api.github.com/repos/${REPO}/contents/data/alerts.json`, { method: 'PUT', headers: H, body: JSON.stringify({ message: 'alerts: instant (webhook)', content: Buffer.from(JSON.stringify(feed)).toString('base64'), sha: cur.sha, branch: 'main' }) });
      if (r.ok) return;
    } catch {}
  }
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('ok');
  const raw = await req.text();
  const key = process.env.ALCH_SIGNING_KEY;
  if (key) {
    const sig = crypto.createHmac('sha256', key).update(raw).digest('hex');
    if (sig !== req.headers.get('x-alchemy-signature')) return new Response('bad sig', { status: 403 });
  }
  let body; try { body = JSON.parse(raw); } catch { return new Response('ok'); }
  const acts = (body.event && body.event.activity) || [];
  if (!acts.length) return new Response('ok');
  const { tokens, cex, subs, feed: feedCtx } = await loadCtx();
  const feed = []; let msgs = 0;
  for (const a of acts) {
    const contract = String((a.rawContract && a.rawContract.address) || '').toLowerCase();
    const tok = tokens[contract];
    const hash = a.hash;
    if (!tok || !hash) continue;
    const from = String(a.fromAddress || '').toLowerCase(), to = String(a.toAddress || '').toLowerCase();
    const amt = Number(a.value) || 0, usd = amt * tok.price;
    const link = `https://basescan.org/tx/${hash}`;
    // 1) custom watches — any size, straight to the owner
    for (const [chat, p] of Object.entries(subs.chats || {})) {
      if (p.muted) continue;
      for (const w of p.watches || []) {
        if (w.t.toUpperCase() !== tok.sym) continue;
        const ww = w.w.toLowerCase();
        if (ww !== from && ww !== to) continue;
        const k = 'w' + hash + chat; if (seen.has(k)) continue; seen.add(k);
        await tg(chat, `👁 <b>Watched wallet ${short(ww)} ${ww === from ? 'sent' : 'received'} ${musd(usd)} of $${tok.sym}</b>\nlive on-chain · <a href="${link}">view tx</a>`);
        msgs++;
      }
    }
    // 2) whale-sized moves touching the top 100 — public, instant
    if (usd >= TH.whale && (tok.top.has(from) || tok.top.has(to)) && !seen.has(hash)) {
      seen.add(hash);
      const whale = tok.top.has(from) ? from : to, dir = tok.top.has(from) ? 'sent' : 'received';
      if (throttled(whale, feedCtx)) continue;
      const name = tok.names[whale] || short(whale);
      const toCex = cex[to] && usd >= TH.cex, fromCex = cex[from] && usd >= TH.cex;
      const kind = toCex || fromCex ? 'cex' : 'whale';
      const title = toCex ? `${name} sent ${musd(usd)} of $${tok.sym} to ${cex[to]}`
        : fromCex ? `${name} pulled ${musd(usd)} of $${tok.sym} off ${cex[from]}`
        : `${name} ${dir} ${musd(usd)} of $${tok.sym}`;
      const sub = toCex ? 'exchange inflow — possible sell pressure · live' : fromCex ? 'exchange outflow · live' : 'live on-chain move';
      const alert = { id: kind + ':' + hash, ts: Date.now(), kind, sym: tok.sym, addr: whale, hash, usd: toCex ? -usd : usd, title, sub };
      feed.push(alert);
      for (const [chat, p] of Object.entries(subs.chats || {})) {
        if (p.muted) continue;
        if (p.tokens && p.tokens.length && !p.tokens.includes(tok.sym)) continue;
        if (p.events && p.events.length && !p.events.includes(kind)) continue;
        await tg(chat, `${kind === 'cex' ? '🏦' : '🐋'} <b>${title.replace(/</g, '&lt;')}</b>\n${sub} · <a href="${link}">view tx</a>`);
        msgs++;
      }
    }
  }
  if (seen.size > 5000) seen.clear();
  await appendFeed(feed);
  return new Response(JSON.stringify({ ok: true, feed: feed.length, msgs }), { headers: { 'content-type': 'application/json' } });
};
export const config = { path: '/api/alch' };
