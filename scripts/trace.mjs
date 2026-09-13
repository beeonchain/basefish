// Coin tracing — where did a top-100 wallet's coins of THIS token go / come from, for every wallet whose balance moved.
// Source: Alchemy getAssetTransfers (erc20, filtered to the token contract, from/to the wallet, block window since the
// last trace). Cheap (~150 CU a call), full coverage of the movers, no per-wallet history budget needed.
// Counterparties are classified with what we already know: excluded.json labels (exchanges, pools, bridges, lockers),
// the token's DEX pools, name heuristics, and finally "does the address have code?" (contract) vs plain wallet.
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'data/flows';
const KEEP_DAYS = 9;
const CEX_RX = /coinbase|binance|kraken|okx|bybit|upbit|bithumb|\bgate\b|kucoin|mexc|bitget|htx|huobi|crypto\.com|bitpanda|bitvavo|bitstamp|gemini|robinhood|exchange|deposit/i;
const DEX_RX = /uniswap|aerodrome|pancake|sushi|baseswap|alien.?base|velodrome|curve|balancer|\bpool\b|liquidity|\blp\b|router|swap|1inch|0x protocol|paraswap|kyber|odos|matcha|\bdex\b|universal router|permit2|clanker|virtuals|bonding|zora|cowswap|cow protocol|settlement/i;
const BRIDGE_RX = /bridge|stargate|across|hop protocol|wormhole|layerzero|relay|orbiter|debridge|synapse|portal|axelar|celer|socket|li\.fi|lifi/i;
const jread = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

export function makeRpc(key) {
  return async (method, params) => {
    const r = await fetch(`https://base-mainnet.g.alchemy.com/v2/${key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
  };
}

// classify a counterparty address → 'cex' | 'dex' | 'bridge' | 'contract' | 'wallet'
export function classifier({ excluded = {}, labels = {}, poolSet = new Set(), codes = {} }) {
  return (addr) => {
    const a = String(addr || '').toLowerCase();
    if (!a || a === '0x0000000000000000000000000000000000000000' || a === '0x000000000000000000000000000000000000dead') return 'burn';
    const l = String(excluded[a] || labels[a] || '');
    if (poolSet.has(a)) return 'dex';
    if (l) { if (CEX_RX.test(l)) return 'cex'; if (BRIDGE_RX.test(l)) return 'bridge'; if (DEX_RX.test(l)) return 'dex'; }
    if (codes[a] === true) return 'contract';
    return 'wallet';
  };
}

// trace the movers of one token since the last trace; appends to data/flows/<sym>.json; returns the rolling file
export async function traceToken({ rpc, sym, contract, addrs, price, classify, codes, maxAddrs = 40, log = () => {} }) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, sym.toLowerCase() + '.json');
  const st = jread(file, { transfers: [], last: {} });
  const now = Date.now();
  const latest = parseInt(await rpc('eth_blockNumber', []), 16);
  const blockAt = (ts) => Math.max(0, latest - Math.ceil((now - ts) / 2000) - 300); // Base ≈ 2s blocks, with slack
  const seen = new Set(st.transfers.map((t) => t.hash + ':' + t.addr + ':' + t.dir));
  let calls = 0, added = 0, unknownCps = new Set();
  const list = addrs.slice(0, maxAddrs);
  for (let i = 0; i < list.length; i += 6) {
    await Promise.all(list.slice(i, i + 6).map(async (a) => {
      const since = st.last[a] || (now - 7 * 864e5);
      const fromBlock = '0x' + blockAt(since).toString(16);
      for (const dir of ['out', 'in']) {
        try {
          let pageKey, transfers = [];
          for (let page = 0; page < 5; page++) { // follow pagination so busy wallets (>100 transfers since last trace) are not truncated
            calls++;
            const res = await rpc('alchemy_getAssetTransfers', [{ fromBlock, toBlock: 'latest', contractAddresses: [contract], category: ['erc20'], [dir === 'out' ? 'fromAddress' : 'toAddress']: a, withMetadata: true, maxCount: '0x64', excludeZeroValue: true, ...(pageKey ? { pageKey } : {}) }]);
            transfers.push(...((res && res.transfers) || []));
            pageKey = res && res.pageKey; if (!pageKey) break;
          }
          for (const tr of transfers) {
            const k = tr.hash + ':' + a + ':' + dir; if (seen.has(k)) continue; seen.add(k);
            const cp = String(dir === 'out' ? tr.to : tr.from || '').toLowerCase();
            const amount = Number(tr.value) || 0;
            const ts = tr.metadata && tr.metadata.blockTimestamp ? new Date(tr.metadata.blockTimestamp).getTime() : now;
            if (cp && codes[cp] === undefined) unknownCps.add(cp);
            st.transfers.push({ hash: tr.hash, addr: a, dir, cp, amount, usd: Math.round(amount * price), ts });
            added++;
          }
        } catch (e) { log(`trace ${sym} ${a.slice(0, 8)} ${dir}: ${e.message.slice(0, 60)}`); }
      }
      st.last[a] = now;
    }));
  }
  // learn which unknown counterparties are contracts (one eth_getCode each, cached forever)
  const cps = [...unknownCps].slice(0, 60);
  for (let i = 0; i < cps.length; i += 8) {
    await Promise.all(cps.slice(i, i + 8).map(async (cp) => { try { calls++; const code = await rpc('eth_getCode', [cp, 'latest']); codes[cp] = !!(code && code !== '0x'); } catch {} }));
  }
  for (const t of st.transfers) t.kind = classify(t.cp);
  st.transfers = st.transfers.filter((t) => now - t.ts < KEEP_DAYS * 864e5);
  fs.writeFileSync(file, JSON.stringify(st));
  log(`trace ${sym}: ${list.length} wallets, ${calls} calls, +${added} transfers, ${st.transfers.length} kept`);
  return st;
}

// 7-day destination totals + per-wallet breakdown from the traced transfers.
// Per wallet we NET each destination (in − out) before summing, so a wallet that sold $10k and bought $8k on a DEX shows
// as $2k out — the same thing its balance did — instead of $18k of gross churn. Wallets with ≥ BOT_N transfers of the token
// in the window (routers, market-maker bots, aggregators) are left out of the totals and counted in `bots`.
export const BOT_N = 100;
export function destFromTrace(st, days = 7) {
  const from = Date.now() - days * 864e5;
  const dest = { out: { dex: 0, cex: 0, bridge: 0, contract: 0, wallet: 0, burn: 0 }, in: { dex: 0, cex: 0, bridge: 0, contract: 0, wallet: 0, burn: 0 }, n: 0, wallets: 0, bots: 0, traced: true, netted: true };
  const per = {};
  for (const t of st.transfers || []) {
    if (t.ts < from) continue;
    const w = per[t.addr] = per[t.addr] || { n: 0, net: {} };
    w.n++; w.net[t.kind || 'wallet'] = (w.net[t.kind || 'wallet'] || 0) + (t.dir === 'in' ? 1 : -1) * (t.usd || 0);
  }
  const via = {};
  for (const [addr, w] of Object.entries(per)) {
    if (w.n >= BOT_N) { dest.bots++; continue; }
    dest.wallets++; dest.n += w.n;
    const v = via[addr] = { in: {}, out: {} };
    for (const [k, net] of Object.entries(w.net)) {
      if (!net) continue;
      const side = net > 0 ? 'in' : 'out', u = Math.abs(net);
      if (dest[side][k] == null) dest[side][k] = 0;
      dest[side][k] += u; v[side][k] = u;
    }
  }
  for (const s of ['in', 'out']) for (const k of Object.keys(dest[s])) dest[s][k] = Math.round(dest[s][k]);
  return { dest, via };
}
