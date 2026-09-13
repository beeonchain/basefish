// Flows — exact, on-chain, two-block arithmetic. No snapshots, no price history, no reconstruction.
//
//   Net(window)  = Σ balanceOf(wallet, now) − Σ balanceOf(wallet, block at now − window)   over the 100 biggest holders right now
//
// Balances are read from the chain at both blocks in one Multicall3 call each (Alchemy archive data), so the window is
// exactly 24h / 7d / 30d, every wallet's change is exact, and "where the coins went" reconciles to the Net by construction:
//   Net = Σ(traced destinations, netted per wallet) + Δ of high-churn wallets (bots/routers, not broken down) + Δ not traced.
// Entries / exits still need to know who was in the top 100 back then — that comes from the snapshot nearest the reference
// time (membership only, never amounts). The chart is the same arithmetic at hourly / 6-hourly / daily blocks.
import fs from 'node:fs';
import path from 'node:path';
import { traceToken, BOT_N } from './trace.mjs';

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
export const WINDOWS = [['1d', 1], ['7d', 7], ['30d', 30]];
const MOVER_MIN_USD = 500;
const pad = (h) => String(h).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hex = (n) => '0x' + n.toString(16);

export async function latestBlock(rpc) {
  const b = await rpc('eth_getBlockByNumber', ['latest', false]);
  return { number: parseInt(b.number, 16), ts: parseInt(b.timestamp, 16) };
}

// Base seals a block every 2 s — estimate, then correct against the real timestamp (normally one lookup)
export async function blockAt(rpc, targetTs, latest) {
  let n = latest.number - Math.round((latest.ts - targetTs) / 2);
  for (let i = 0; i < 5; i++) {
    n = Math.max(1, Math.min(latest.number, n));
    const b = await rpc('eth_getBlockByNumber', [hex(n), false]);
    const ts = parseInt(b.timestamp, 16);
    if (Math.abs(ts - targetTs) <= 4) return { number: n, ts };
    n -= Math.round((ts - targetTs) / 2);
  }
  return { number: n, ts: targetTs };
}

export async function tokenDecimals(rpc, token) {
  try { const r = await rpc('eth_call', [{ to: token, data: '0x313ce567' }, 'latest']); const d = parseInt(r, 16); return d >= 0 && d <= 36 ? d : 18; } catch { return 18; }
}

// balanceOf for many wallets at one block in ONE eth_call (Multicall3.aggregate) → Map(addr → tokens). null = could not read.
export async function balancesAt(rpc, token, addrs, block, decimals) {
  const out = new Map(); const div = 10 ** decimals;
  for (let i = 0; i < addrs.length; i += 120) {
    const chunk = addrs.slice(i, i + 120), n = chunk.length;
    // aggregate((address target, bytes callData)[]) — each tuple is 160 bytes: target, offset(0x40), len(0x24), calldata padded to 64
    const tuples = chunk.map((a) => pad(token) + pad('40') + pad('24') + '70a08231' + pad(a) + '0'.repeat(56)).join('');
    const data = '0x252dba42' + pad('20') + pad(n.toString(16)) + chunk.map((_, k) => pad((32 * n + 160 * k).toString(16))).join('') + tuples;
    let res = null;
    try { res = await rpc('eth_call', [{ to: MULTICALL3, data }, hex(block)]); } catch (e) { res = null; }
    if (res && res.length > 2 + 64 * 3) {
      const w = (k) => res.slice(2 + k * 64, 2 + (k + 1) * 64);
      const arr = parseInt(w(1), 16) / 32, len = parseInt(w(arr), 16);
      for (let k = 0; k < Math.min(len, n); k++) {
        const base = arr + 1 + parseInt(w(arr + 1 + k), 16) / 32;
        const blen = parseInt(w(base), 16);
        out.set(chunk[k], blen >= 32 ? Number(BigInt('0x' + w(base + 1))) / div : 0);
      }
      continue;
    }
    for (const a of chunk) { // fallback: one call per wallet
      try { const r = await rpc('eth_call', [{ to: token, data: '0x70a08231' + pad(a) }, hex(block)]); out.set(a, Number(BigInt(r)) / div); } catch { out.set(a, null); }
    }
  }
  return out;
}

// destinations for one window from the traced transfers, netted per wallet, reconciled against the exact per-wallet change
function destForWindow(st, fromTs, deltas, price) {
  const dest = { out: { dex: 0, cex: 0, bridge: 0, contract: 0, wallet: 0, burn: 0 }, in: { dex: 0, cex: 0, bridge: 0, contract: 0, wallet: 0, burn: 0 },
    n: 0, wallets: 0, bots: { n: 0, amt: 0 }, rest: { n: 0, amt: 0 }, traced: true, netted: true };
  const via = {}, per = {};
  for (const t of st.transfers || []) {
    if (t.ts < fromTs || !deltas.has(t.addr)) continue;
    const w = per[t.addr] = per[t.addr] || { n: 0, net: {}, tok: 0 };
    const sign = t.dir === 'in' ? 1 : -1;
    w.n++; w.net[t.kind || 'wallet'] = (w.net[t.kind || 'wallet'] || 0) + sign * (t.amount || 0); w.tok += sign * (t.amount || 0);
  }
  for (const [addr, delta] of deltas) {
    const w = per[addr];
    if (!w) { if (Math.abs(delta * price) >= 1) { dest.rest.n++; dest.rest.amt += delta; } continue; } // small moves + movers beyond the trace cap
    if (w.n >= BOT_N) { dest.bots.n++; dest.bots.amt += delta; continue; } // router / bot: exact change counted, not broken down
    dest.wallets++; dest.n += w.n;
    const v = via[addr] = { in: {}, out: {} };
    for (const [k, net] of Object.entries(w.net)) { if (!net) continue; const side = net > 0 ? 'in' : 'out'; dest[side][k] += Math.abs(net); v[side][k] = Math.round(Math.abs(net) * price); }
    const gap = delta - w.tok; if (Math.abs(gap * price) >= 50) { dest.rest.n++; dest.rest.amt += gap; } // transfers we could not see (truncated history)
  }
  for (const s of ['in', 'out']) for (const k of Object.keys(dest[s])) { dest[s][k] = { amt: Math.round(dest[s][k]), usd: Math.round(dest[s][k] * price) }; }
  dest.bots.usd = Math.round(dest.bots.amt * price); dest.bots.amt = Math.round(dest.bots.amt);
  dest.rest.usd = Math.round(dest.rest.amt * price); dest.rest.amt = Math.round(dest.rest.amt);
  return { dest, via };
}

const j = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

export async function computeFlows({ rpc, sym, contract, top, price, snaps = [], classify, codes, priceAt = () => null, full = false, log = () => {} }) {
  const token = contract.toLowerCase();
  const decimals = await tokenDecimals(rpc, token);
  const latest = await latestBlock(rpc);
  const cohort = top.map((h) => h.addr.toLowerCase());
  const nowBal = await balancesAt(rpc, token, cohort, latest.number, decimals);
  const win = {}; const deltasByWin = {};
  for (const [key, days] of WINDOWS) {
    const ref = await blockAt(rpc, latest.ts - days * 86400, latest);
    // who was in the top 100 back then: nearest snapshot (membership only), accepted if within 25% of the window
    const target = ref.ts * 1000; let snap = null;
    for (const s of snaps) if (!snap || Math.abs(s.ts - target) < Math.abs(snap.ts - target)) snap = s;
    if (snap && Math.abs(snap.ts - target) > days * 864e5 * 0.25) snap = null;
    const thenSet = snap ? new Set(Object.entries(snap.h).filter(([, o]) => o.r <= 100).map(([a]) => a.toLowerCase())) : null;
    const exitAddrs = thenSet ? [...thenSet].filter((a) => !nowBal.has(a)) : [];
    const refBal = await balancesAt(rpc, token, [...cohort, ...exitAddrs], ref.number, decimals);
    const exitNow = exitAddrs.length ? await balancesAt(rpc, token, exitAddrs, latest.number, decimals) : new Map();
    let refAmt = 0, nowAmt = 0, unknown = 0; const movers = [], deltas = new Map();
    for (const a of cohort) {
      const b0 = refBal.get(a), b1 = nowBal.get(a);
      if (b0 == null || b1 == null) { unknown++; continue; }
      refAmt += b0; nowAmt += b1; const d = b1 - b0;
      deltas.set(a, d);
      if (Math.abs(d * price) >= MOVER_MIN_USD) movers.push({ addr: a, amt: Math.round(d), usd: Math.round(d * price), now: Math.round(b1) });
    }
    movers.sort((x, y) => Math.abs(y.usd) - Math.abs(x.usd));
    const amt = nowAmt - refAmt;
    const entries = thenSet ? cohort.filter((a) => !thenSet.has(a) && deltas.has(a)).map((a) => ({ addr: a, amt: Math.round(nowBal.get(a)), usd: Math.round(nowBal.get(a) * price), added: Math.round(deltas.get(a)) })).sort((x, y) => y.usd - x.usd) : null;
    const exits = thenSet ? exitAddrs.map((a) => { const b0 = refBal.get(a) || 0, b1 = exitNow.get(a) || 0; return { addr: a, then: Math.round(b0), now: Math.round(b1), amt: Math.round(b1 - b0), usd: Math.round((b1 - b0) * price), thenUsd: Math.round(b0 * price) }; }).sort((x, y) => x.usd - y.usd) : null;
    win[key] = { days, refBlock: ref.number, refTs: ref.ts * 1000, nowBlock: latest.number, nowTs: latest.ts * 1000,
      refAmt: Math.round(refAmt), nowAmt: Math.round(nowAmt), amt: Math.round(amt), pct: refAmt ? +((100 * amt) / refAmt).toFixed(3) : 0, usd: Math.round(amt * price),
      movers, nMovers: movers.length, entries, exits, membership: !!thenSet, unknown };
    deltasByWin[key] = deltas;
    log(`flows ${sym} ${key}: block ${ref.number} → ${latest.number}, ${tokAmt(refAmt)} → ${tokAmt(nowAmt)} (${amt >= 0 ? '+' : ''}${tokAmt(amt)}), ${movers.length} movers, ${entries ? entries.length + ' in / ' + exits.length + ' out' : 'no membership snapshot'}`);
  }
  // coin tracing (Alchemy transfers) for the wallets that moved in the last 7 days — biggest first
  let st = null;
  try {
    const who = win['7d'].movers.map((m) => m.addr);
    for (const m of win['1d'].movers) if (!who.includes(m.addr)) who.push(m.addr);
    st = await traceToken({ rpc, sym, contract: token, addrs: who, price, classify, codes, maxAddrs: full ? 120 : 80, log });
  } catch (e) { log(`trace err ${sym}: ${e.message.slice(0, 80)}`); }
  for (const key of ['1d', '7d']) {
    const W = win[key]; if (!st) { W.dest = null; continue; }
    const { dest, via } = destForWindow(st, W.refTs, deltasByWin[key], price);
    W.dest = dest;
    W.movers = W.movers.map((m) => { const v = via[m.addr]; if (!v) return m; const side = m.usd >= 0 ? 'in' : 'out'; return { ...m, via: v[side] }; });
    W.cex = { in: dest.in.cex.usd, out: dest.out.cex.usd, n: (st.transfers || []).filter((t) => t.kind === 'cex' && t.ts >= W.refTs && deltasByWin[key].has(t.addr)).length };
  }
  win['30d'].dest = null; win['30d'].cex = null; // tracing keeps 9 days of transfers
  // chart: the same arithmetic at hourly (24h) / 6-hourly (7d) / daily (30d) blocks — the exact combined balance of today's
  // top 100. Per-wallet detail is stored sparsely (only the wallets whose balance changed between two points) so the file stays small.
  const anchors = [latest, ...Object.values(win).map((W) => ({ number: W.refBlock, ts: W.refTs / 1000 }))];
  const blockFor = (ts) => { const a = anchors.reduce((b, x) => Math.abs(x.ts - ts) < Math.abs(b.ts - ts) ? x : b); return Math.max(1, a.number - Math.round((a.ts - ts) / 2)); };
  const want = new Map();
  for (let k = 30; k >= 1; k--) want.set(latest.ts - k * 86400, 'd');
  for (let k = 28; k >= 1; k--) if (!want.has(latest.ts - k * 21600)) want.set(latest.ts - k * 21600, 'q');
  for (let k = 24; k >= 1; k--) if (!want.has(latest.ts - k * 3600)) want.set(latest.ts - k * 3600, 'h');
  const times = [...want.keys()].sort((a, b) => a - b);
  const raw = [];
  for (let i = 0; i < times.length; i += 6) {
    await Promise.all(times.slice(i, i + 6).map(async (ts) => {
      const bal = await balancesAt(rpc, token, cohort, blockFor(ts), decimals);
      raw.push({ ts, block: blockFor(ts), bal, kind: want.get(ts) });
    }));
  }
  raw.push({ ts: latest.ts, block: latest.number, bal: nowBal, kind: 'now' });
  raw.sort((a, b) => a.ts - b.ts);
  const pts = []; let prev = null;
  for (const r of raw) {
    let tot = 0; for (const a of cohort) tot += r.bal.get(a) || 0;
    const pt = { ts: r.ts * 1000, block: r.block, amt: Math.round(tot), p: r.kind === 'now' ? price : priceAt(r.ts * 1000), k: r.kind };
    if (prev) { const d = {}; for (const a of cohort) { const x = (r.bal.get(a) || 0) - (prev.bal.get(a) || 0); if (Math.abs(x * price) >= 1) d[a] = Math.round(x); } pt.d = d; }
    pts.push(pt); prev = r;
  }
  fs.mkdirSync('data/hist', { recursive: true });
  fs.writeFileSync(path.join('data/hist', sym.toLowerCase() + '.json'), JSON.stringify({ sym, updated: Date.now(), decimals, block: latest.number, cohort, now: Object.fromEntries(cohort.map((a) => [a, Math.round(nowBal.get(a) || 0)])), points: pts }));
  return { updated: Date.now(), decimals, block: latest.number, win, series: pts.filter((q) => q.k === 'd' || q.k === 'now').map(({ ts, amt, p }) => ({ ts, amt, p })) };
}

function tokAmt(v) { const x = Math.abs(v); return (v < 0 ? '−' : '') + (x >= 1e9 ? (x / 1e9).toFixed(2) + 'B' : x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'K' : x.toFixed(0)); }
