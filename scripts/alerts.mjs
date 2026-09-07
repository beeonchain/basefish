// Basefish alert engine — runs inside fetch.mjs each refresh.
// Detects events from snapshot deltas + cached wallet transfers, writes the public
// feed (data/alerts.json) for the site, and pushes to Telegram subscribers
// (data/tg_subs.json, maintained by the bot webhook at netlify/functions/tg.mjs).
import fs from 'node:fs';
import path from 'node:path';

const FEED = 'data/alerts.json';
const STATE = 'data/alerts_state.json'; // dedupe memory: sent tx hashes + per-watch cursors
const SUBS = 'data/tg_subs.json';
const FEED_CAP = 300;
const TH = { whale: 100_000, cexIn: 250_000, schoolPct: 10, entryTop: 20, exitTop: 10 };

const jread = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const musd = (v) => { const x = Math.abs(v); return x >= 1e6 ? '$' + (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? '$' + (x / 1e3).toFixed(0) + 'K' : '$' + x.toFixed(0); };

function nameFor(h) { return h.entity || h.basename || short(h.addr); }

// ctx: { [sym]: { prev, cur, top, price } }  prev/cur = snapshot objects {ts,h:{addr:{r,u}}}
export function buildAlerts(ctx, schools, { CEX_RX, WALLET_DIR }) {
  const state = jread(STATE, { tx: {}, school: {}, watch: {} });
  const now = Date.now();
  const alerts = [];
  const push = (a) => alerts.push({ id: a.kind + ':' + (a.addr || a.school || '') + ':' + a.sym + ':' + Math.round(now / 36e5), ts: now, ...a });

  for (const [sym, c] of Object.entries(ctx)) {
    if (!c || !c.top) continue;
    const prev = c.prev, byAddr = Object.fromEntries(c.top.map((h) => [h.addr.toLowerCase(), h]));
    if (prev) {
      // whale moves: balance change since the previous snapshot (~2h) worth ≥ $100k
      for (const h of c.top) {
        const o = prev.h[h.addr.toLowerCase()];
        if (!o) continue;
        const d = Math.round((h.usd || 0) - o.u);
        if (Math.abs(d) >= TH.whale) push({ kind: 'whale', sym, addr: h.addr, usd: d, title: `${nameFor(h)} ${d > 0 ? 'accumulated' : 'sold'} ${musd(d)} of $${sym}`, sub: `rank #${c.top.indexOf(h) + 1} · now holds ${musd(h.usd || 0)}` });
      }
      // entries into the top 20 / exits from the top 10
      const prevRank = (a) => (prev.h[a] ? prev.h[a].r : Infinity);
      c.top.slice(0, TH.entryTop).forEach((h, i) => {
        if (prevRank(h.addr.toLowerCase()) > TH.entryTop) push({ kind: 'entry', sym, addr: h.addr, usd: h.usd || 0, title: `${nameFor(h)} entered the $${sym} top ${TH.entryTop} at #${i + 1}`, sub: `holding ${musd(h.usd || 0)}` });
      });
      for (const [a, o] of Object.entries(prev.h)) {
        if (o.r <= TH.exitTop && !byAddr[a]) push({ kind: 'exit', sym, addr: a, usd: -o.u, title: `Top-${TH.exitTop} wallet ${short(a)} left the $${sym} top 100`, sub: `was #${o.r} with ${musd(o.u)}` });
      }
    }
    // CEX inflows: cached transfers with exchange-labeled counterparties, recent + unseen
    for (const h of c.top) {
      const pw = jread(path.join(WALLET_DIR, h.addr.toLowerCase() + '.json'), null);
      if (!pw || !pw.transfers) continue;
      for (const tr of pw.transfers) {
        if (tr.token !== sym || tr.dir !== 'out' || !tr.hash || state.tx[tr.hash]) continue;
        if (!CEX_RX.test(tr.cpLabel || '')) continue;
        if ((tr.usd || 0) < TH.cexIn || now - new Date(tr.ts).getTime() > 26 * 36e5) continue;
        state.tx[tr.hash] = now;
        push({ kind: 'cex', sym, addr: h.addr, usd: -(tr.usd || 0), hash: tr.hash, title: `${nameFor(h)} sent ${musd(tr.usd)} of $${sym} to ${tr.cpLabel}`, sub: 'exchange inflow — possible sell pressure' });
      }
    }
    // school combined position swings ≥10% since the previous snapshot
    if (prev) for (const s of schools || []) {
      const mem = (s.members || []).map((m) => m.addr);
      const cur = mem.reduce((t2, a) => t2 + ((byAddr[a] && byAddr[a].usd) || 0), 0);
      const was = mem.reduce((t2, a) => t2 + ((prev.h[a] && prev.h[a].u) || 0), 0);
      if (was > 50_000 && Math.abs(cur - was) / was >= TH.schoolPct / 100) {
        const k = s.id + ':' + sym, lastPct = state.school[k] || 0, pct = Math.round(((cur - was) / was) * 100);
        if (Math.sign(pct) !== Math.sign(lastPct) || Math.abs(pct) > Math.abs(lastPct) + 5) {
          state.school[k] = pct;
          push({ kind: 'school', sym, school: s.id, usd: Math.round(cur - was), title: `A ${mem.length}-wallet school moved ${pct > 0 ? '+' : ''}${pct}% on $${sym}`, sub: `combined position now ${musd(cur)}` });
        }
      }
    }
  }
  // prune dedupe memory
  for (const [h, t2] of Object.entries(state.tx)) if (now - t2 > 7 * 864e5) delete state.tx[h];
  fs.writeFileSync(STATE, JSON.stringify(state));
  return alerts;
}

// custom per-user wallet watches: any tx of <wallet> touching <TOKEN>
export async function checkWatches(arkhamGet, maxLookups = 20) {
  const subs = jread(SUBS, { chats: {} });
  const state = jread(STATE, { tx: {}, school: {}, watch: {} });
  const out = []; let used = 0;
  const seen = new Set();
  for (const [chat, prefs] of Object.entries(subs.chats || {})) {
    for (const w of prefs.watches || []) {
      const key = w.w.toLowerCase() + ':' + w.t.toUpperCase();
      if (seen.has(chat + key)) continue; seen.add(chat + key);
      if (used >= maxLookups) break;
      used++;
      let tr = null;
      try { tr = await arkhamGet(`/transfers?base=${w.w}&limit=20&sortDir=desc&usdGte=1`); } catch (e) {}
      if (!tr) continue;
      const rows = (tr.transfers || tr.data || (Array.isArray(tr) ? tr : [])) || [];
      const cursor = state.watch[key] || Date.now() - 26 * 36e5;
      let newest = cursor;
      for (const x of rows) {
        const ts = new Date(x.blockTimestamp || x.timestamp || x.time || 0).getTime();
        const tok = String(x.tokenSymbol || x.symbol || (x.tokenName || '')).toUpperCase();
        const hash = x.transactionHash || x.txHash || x.hash;
        if (!ts || ts <= cursor || !hash || state.tx['w' + hash + chat]) continue;
        if (tok !== w.t.toUpperCase()) continue;
        newest = Math.max(newest, ts);
        state.tx['w' + hash + chat] = Date.now();
        const usd = Number(x.historicalUSD || x.usd || 0);
        const dir = String(x.fromAddress?.address || x.fromAddress || '').toLowerCase() === w.w.toLowerCase() ? 'sent' : 'received';
        out.push({ chat, kind: 'watch', sym: w.t.toUpperCase(), addr: w.w, hash, usd, ts: Date.now(), title: `Watched wallet ${short(w.w)} ${dir} ${usd ? musd(usd) + ' of ' : ''}$${w.t.toUpperCase()}`, sub: 'your custom watch' });
      }
      state.watch[key] = newest;
    }
  }
  fs.writeFileSync(STATE, JSON.stringify(state));
  return out;
}

export async function writeFeed(alerts) {
  // merge with the LIVE feed (instant webhook alerts may have landed since this run checked out)
  let feed = jread(FEED, { alerts: [] });
  try {
    const r = await fetch('https://basefish.netlify.app/data/alerts.json?t=' + Date.now());
    if (r.ok) { const live = await r.json(); const ids = new Set((feed.alerts || []).map((a) => a.id));
      for (const a of live.alerts || []) if (!ids.has(a.id)) feed.alerts.push(a);
      feed.alerts.sort((a, b) => b.ts - a.ts); }
  } catch (e) {}
  const have = new Set((feed.alerts || []).map((a) => a.id));
  const fresh = alerts.filter((a) => !have.has(a.id));
  feed.alerts = [...fresh, ...(feed.alerts || [])].slice(0, FEED_CAP);
  feed.generated_at = new Date().toISOString();
  fs.writeFileSync(FEED, JSON.stringify(feed));
  return fresh.length;
}

const ICON = { whale: '🐋', entry: '🎣', exit: '🏃', cex: '🏦', school: '🕸', watch: '👁' };
export async function sendTelegram(publicAlerts, watchAlerts, siteUrl = 'https://basefish.netlify.app') {
  const token = process.env.TG_BOT_TOKEN;
  if (!token) return 0;
  const subs = jread(SUBS, { chats: {} });
  const send = async (chat, a) => {
    const link = a.hash ? `https://basescan.org/tx/${a.hash}` : a.addr ? `${siteUrl}/#w=${a.addr}` : siteUrl;
    const text = `${ICON[a.kind] || '🔔'} <b>${a.title.replace(/</g, '&lt;')}</b>\n${(a.sub || '').replace(/</g, '&lt;')}\n<a href="${link}">${a.hash ? 'view tx' : 'open in Basefish'}</a>`;
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      });
      return r.ok;
    } catch (e) { return false; }
  };
  let sent = 0;
  for (const [chat, prefs] of Object.entries(subs.chats || {})) {
    if (prefs.muted) continue;
    for (const a of publicAlerts) {
      if (prefs.tokens && prefs.tokens.length && !prefs.tokens.includes(a.sym)) continue;
      if (prefs.events && prefs.events.length && !prefs.events.includes(a.kind)) continue;
      if (await send(chat, a)) sent++;
      await new Promise((s) => setTimeout(s, 60));
    }
  }
  for (const a of watchAlerts) { if (await send(a.chat, a)) sent++; await new Promise((s) => setTimeout(s, 60)); }
  if (sent) console.log(`telegram: ${sent} messages sent`);
  return sent;
}
