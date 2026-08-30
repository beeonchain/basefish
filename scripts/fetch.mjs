// Basefish data fetcher — pulls top holders + prices from Moralis, writes static JSON into data/.
// Runs in GitHub Actions on a schedule. Requires MORALIS_API_KEY env var.
import fs from 'node:fs';
import path from 'node:path';
import { namehash } from './keccak.mjs';

const KEY = process.env.MORALIS_API_KEY || '';
const BQ_TOKEN = process.env.BITQUERY_TOKEN || '';
if (!KEY && !BQ_TOKEN) { console.error('No data keys (MORALIS_API_KEY / BITQUERY_TOKEN)'); process.exit(1); }

const cfg = JSON.parse(fs.readFileSync('tokens.config.json', 'utf8'));
const M = 'https://deep-index.moralis.io/api/v2.2';
const H = { 'X-API-Key': KEY, accept: 'application/json' };

// ---- Arkham label enrichment (optional; skipped when no key) ----
const ARKHAM_KEY = process.env.ARKHAM_API_KEY || '';
const ARKHAM_BASES = ['https://api.arkm.com', 'https://api.arkhamintelligence.com'];
const LABELS_PATH = 'data/labels.json';
let labelCache = {};
try { labelCache = JSON.parse(fs.readFileSync(LABELS_PATH, 'utf8')); } catch {}
{ // heal cached labels stored before the template sanitizer existed
  for (const r of Object.values(labelCache)) if (r && Array.isArray(r.labels)) r.labels = cleanLabels(r.labels);
}
const LABEL_TTL_DAYS = 30, ARKHAM_MAX_LOOKUPS = 300;
let arkhamBudget = ARKHAM_MAX_LOOKUPS, arkhamBase = null;

// Arkham/Frontrun tag templates sometimes arrive with raw token JSON un-substituted,
// e.g. `Early {"pricing_id":"based-brett","symbol":"BRETT"} Holder` → normalize to `Early BRETT Holder`
function cleanLabel(s) {
  let t = String(s == null ? '' : s);
  t = t.replace(/\{[^{}]*?"symbol"\s*:\s*"([^"]+)"[^{}]*\}/g, '$1');
  t = t.replace(/\s+/g, ' ').trim();
  if (!t || t.includes('{') || t.includes('}')) return null; // still malformed — drop it
  return t.slice(0, 60);
}
function cleanLabels(arr) {
  const out = [], seen = new Set();
  for (const x of arr || []) { const k = cleanLabel(x); if (k && !seen.has(k.toLowerCase())) { seen.add(k.toLowerCase()); out.push(k); } }
  return out;
}

function parseArkham(payload) {
  // response may be flat or keyed per-chain; walk it for arkhamEntity/arkhamLabel (+ id, socials)
  // collects EVERY distinct label across all chains (Arkham-style multi-label)
  const found = { name: null, type: null, label: null, id: null, twitter: null, website: null, labels: [] };
  const seenL = new Set();
  const addL = (s) => {
    if (!s) return;
    const k = cleanLabel(s);
    if (k && !seenL.has(k.toLowerCase())) { seenL.add(k.toLowerCase()); found.labels.push(k); }
  };
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 4) return;
    if (Array.isArray(o)) { for (const v of o) walk(v, depth + 1); return; }
    if (o.arkhamEntity) {
      const e = o.arkhamEntity;
      if (!found.name) {
        found.name = e.name || null; found.type = e.type || null; found.id = e.id || null;
        found.twitter = e.twitter || e.twitterUsername || null; found.website = e.website || e.websiteLink || null;
      }
      if (Array.isArray(e.populatedTags)) for (const tg of e.populatedTags) addL(tg && (tg.label || tg.name || tg.id));
    }
    if (o.arkhamLabel) { if (!found.label) found.label = o.arkhamLabel.name || null; addL(o.arkhamLabel.name); }
    if (Array.isArray(o.populatedTags)) for (const tg of o.populatedTags) addL(tg && (tg.label || tg.name || tg.id));
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(payload, 0);
  found.labels = found.labels.slice(0, 24);
  return found;
}
function pickSocials(payload) {
  const out = { twitter: null, website: null };
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 3) return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && v) {
        const kl = k.toLowerCase();
        if (!out.twitter && (kl === 'twitter' || kl === 'twitterusername' || kl === 'x')) out.twitter = v;
        if (!out.website && (kl === 'website' || kl === 'websitelink' || kl === 'site' || kl === 'url') && /^https?:/.test(v)) out.website = v;
      } else if (typeof v === 'object') walk(v, depth + 1);
    }
  };
  walk(payload, 0);
  return out;
}

async function arkhamLookup(addr) {
  const a = addr.toLowerCase();
  const hit = labelCache[a];
  if (hit && (Date.now() - (hit.ts || 0)) < LABEL_TTL_DAYS * 864e5) {
    // labels-upgrade: older cache entries predate multi-label collection — refetch named ones once
    const wantsLabels = hit.labels === undefined && (hit.name || hit.label) && ARKHAM_KEY && arkhamBudget > 60;
    if (!wantsLabels) return hit;
  } else if (!ARKHAM_KEY || arkhamBudget <= 0) return hit || null;
  const bases = arkhamBase ? [arkhamBase] : ARKHAM_BASES;
  for (const base of bases) {
    for (const path of [`/intelligence/address/${addr}/all`, `/intelligence/address/${addr}`]) {
      try {
        const r = await fetch(base + path, { headers: { 'API-Key': ARKHAM_KEY, accept: 'application/json' } });
        if (r.status === 429) { console.log('  arkham rate-limited, pausing'); await new Promise(s => setTimeout(s, 2000)); continue; }
        if (!r.ok) continue;
        arkhamBase = base; arkhamBudget--;
        const info = parseArkham(await r.json());
        const rec = { ...(hit || {}),
          name: info.name || (hit && hit.name) || null, type: info.type || (hit && hit.type) || null,
          label: info.label || (hit && hit.label) || null, id: info.id || (hit && hit.id) || null,
          twitter: info.twitter || (hit && hit.twitter) || null, website: info.website || (hit && hit.website) || null,
          labels: (info.labels && info.labels.length) ? info.labels : ((hit && hit.labels) || []),
          ts: Date.now() };
        labelCache[a] = rec;
        await new Promise(s => setTimeout(s, 250)); // be polite
        return rec;
      } catch (e) { /* try next */ }
    }
  }
  arkhamBudget--; // avoid hammering a dead endpoint
  return hit || null;
}

// entity types that should never count as a "holder fish"
const EXCLUDE_TYPES = new Set(['cex', 'exchange', 'bridge', 'dex', 'staking', 'burn', 'locker']);

// ---- Frontrun labels (wallet → X identity, KOL labels, cross-token tags) ----
const FRONTRUN_KEY = process.env.FRONTRUN_API_KEY || '';
const FR_PATH = 'data/frlabels.json';
let frCache = { updated: null, wallets: {} };
try { frCache = JSON.parse(fs.readFileSync(FR_PATH, 'utf8')); frCache.wallets = frCache.wallets || {}; } catch {}
{ // seed records may lack per-record timestamps — stamp them with the file's updated time
  const st = Date.parse(frCache.updated) || Date.now();
  for (const k of Object.keys(frCache.wallets)) if (!frCache.wallets[k].ts) frCache.wallets[k].ts = st;
}
const FR_TTL_MATCH_D = 30, FR_TTL_MISS_D = 7, FR_BATCH = 25, FR_MAX_PER_RUN = 150; // ~150 lookups/run keeps credit burn tiny
let frBudget = FR_MAX_PER_RUN;
const OWN_SYMS = new Set(cfg.tokens.map(t => t.sym.toUpperCase()));
// drop self-referential tags like "BRETT Top 100 Holder" — being on our list already says that
const frKeepTag = (t) => { const m = String(t).match(/^(\S+) Top \d+ Holder$/i); return !(m && OWN_SYMS.has(m[1].toUpperCase())); };
const frHasData = (r) => !!(r && (r.x || r.pl || (r.l || []).length || (r.t || []).length));
const frFresh = (r) => r && r.ts && (Date.now() - r.ts) < (frHasData(r) ? FR_TTL_MATCH_D : FR_TTL_MISS_D) * 864e5;

async function frontrunBatch(addrs) {
  if (!FRONTRUN_KEY || !addrs.length || frBudget <= 0) return;
  for (let i = 0; i < addrs.length; i += FR_BATCH) {
    if (frBudget <= 0) break;
    const chunk = addrs.slice(i, i + FR_BATCH);
    try {
      const r = await fetch('https://api.frontrun.pro/api/v1/pro/twitter/wallets-batch-query', {
        method: 'POST',
        headers: { accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + FRONTRUN_KEY },
        body: JSON.stringify({ wallets: chunk.map(a => ({ chain: 'EVM', address: a })) }),
      });
      if (r.status === 429) { await new Promise(s => setTimeout(s, 3000)); i -= FR_BATCH; continue; }
      if (!r.ok) { console.log('  frontrun', r.status, (await r.text()).slice(0, 100)); break; }
      const d = await r.json();
      for (const w of (d.data && d.data.wallets) || []) {
        const a = String(w.address || '').toLowerCase();
        if (!a) continue;
        frCache.wallets[a] = {
          x: w.twitterUsername || null, n: w.name || null, f: w.followersCount || 0,
          pl: w.primaryLabel ? cleanLabel(w.primaryLabel) : null,
          l: cleanLabels((w.labels || []).map(l => (l && l.name) || l).filter(x => typeof x === 'string')).slice(0, 6),
          t: cleanLabels((w.tags || []).map(t => t && t.name).filter(Boolean)).filter(frKeepTag).slice(0, 8),
          ts: Date.now(),
        };
      }
      frBudget -= chunk.length;
      await new Promise(s => setTimeout(s, 1100));
    } catch (e) { console.log('  frontrun err', e.message.slice(0, 60)); break; }
  }
}
// ---- Funding source: a wallet's FIRST inbound transfer (Arkham, sortDir=asc) ----
// First funding is immutable, so cache hits are permanent. Backfills ~150 wallets/run.
const FUND_PATH = 'data/funding.json';
let fundCache = {}; try { fundCache = JSON.parse(fs.readFileSync(FUND_PATH, 'utf8')); } catch {}
let fundBudget = 150;
const CEX_RX = /coinbase|binance|kraken|okx|bybit|upbit|bithumb|\bgate\b|kucoin|mexc|bitget|htx|crypto\.com|bitpanda|bitvavo|bitstamp|gemini|robinhood|exchange|deposit/i;
const BRIDGE_RX = /bridge|stargate|across|hop protocol|wormhole|layerzero|relay|orbiter|debridge|synapse|portal/i;
async function fundingFor(addr) {
  const a = addr.toLowerCase();
  if (fundCache[a] !== undefined) return fundCache[a]; // null means checked: no usable data
  if (!ARKHAM_KEY || fundBudget <= 0 || profileBudget <= 10) return undefined; // try again next run
  fundBudget--;
  const t = await arkhamGet(`/transfers?base=${addr}&limit=6&sortDir=asc`);
  if (!t) return undefined; // transient — do not cache a failure
  const arr = (t.transfers || t.result || (Array.isArray(t) ? t : [])) || [];
  let first = null;
  for (const x of arr) {
    const to = String((x.toAddress && (x.toAddress.address || x.toAddress)) || x.to || '').toLowerCase();
    if (to === a) { first = x; break; }
  }
  if (!first) { fundCache[a] = null; return null; }
  const from = String((first.fromAddress && (first.fromAddress.address || first.fromAddress)) || first.from || '').toLowerCase();
  const fEnt = first.fromAddress && first.fromAddress.arkhamEntity;
  const fLbl = (fEnt && fEnt.name) || (first.fromAddress && first.fromAddress.arkhamLabel && first.fromAddress.arkhamLabel.name) || null;
  const fType = (fEnt && fEnt.type) || null;
  const hay = [fLbl, fType].filter(Boolean).join(' ');
  let kind = 'private';
  if (fType === 'cex' || CEX_RX.test(hay)) kind = 'cex';
  else if (BRIDGE_RX.test(hay)) kind = 'bridge';
  const rec = { funder: /^0x[0-9a-f]{40}$/.test(from) ? from : null, funderLabel: cleanLabel(fLbl), kind,
    firstTs: first.blockTimestamp || first.timestamp || first.time || null };
  fundCache[a] = rec;
  return rec;
}
function fundingLabels(rec) {
  if (!rec) return [];
  const out = [];
  if (rec.kind === 'cex') out.push(rec.funderLabel ? `${rec.funderLabel.replace(/[:·].*$/, '').trim()} funded` : 'CEX funded');
  else if (rec.kind === 'bridge') out.push('Bridge funded');
  if (rec.firstTs && Date.now() - new Date(rec.firstTs).getTime() < 30 * 864e5) out.push('Fresh wallet');
  return out.filter(Boolean);
}

// ---- Base RPC (free public endpoints, rotated) ----
const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.llamarpc.com'];
let rpcIdx = 0, rpcBudget = 400;
async function rpc(method, params) {
  if (rpcBudget <= 0) return null;
  for (let tries = 0; tries < RPCS.length; tries++) {
    const url = RPCS[(rpcIdx + tries) % RPCS.length];
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (!r.ok) continue;
      const d = await r.json();
      if (d.error) return null; // call-level error (e.g. revert) — a real answer, don't rotate
      rpcIdx = (rpcIdx + tries) % RPCS.length; rpcBudget--;
      return d.result;
    } catch (e) { /* rotate */ }
  }
  rpcBudget -= 5; // all endpoints down — back off
  return null;
}
const hexToStr = (h) => { // ABI-decoded string return
  try {
    if (!h || h === '0x' || h.length < 130) return null;
    const len = parseInt(h.slice(66, 130), 16);
    if (!len || len > 100) return null;
    let s = ''; for (let i = 0; i < len; i++) s += String.fromCharCode(parseInt(h.substr(130 + i * 2, 2), 16));
    return /^[\x20-\x7e]+$/.test(s) ? s : null;
  } catch (e) { return null; }
};

// ---- Basename reverse resolution (verified: L2Resolver.name(namehash(addr.80002105.reverse))) ----
const L2_RESOLVER = '0xC6d566A56A1aFf6508b41f6c90ff131615583BCD';
const BN_PATH = 'data/basenames.json';
let bnCache = {}; try { bnCache = JSON.parse(fs.readFileSync(BN_PATH, 'utf8')); } catch {}
const BN_TTL_D = 7;
async function basenameFor(addr) {
  const a = addr.toLowerCase();
  const hit = bnCache[a];
  if (hit && Date.now() - hit.ts < BN_TTL_D * 864e5) return hit.n;
  const node = namehash(a.slice(2) + '.80002105.reverse');
  const res = await rpc('eth_call', [{ to: L2_RESOLVER, data: '0x691f3431' + node.slice(2) }, 'latest']);
  const n = hexToStr(res);
  bnCache[a] = { n: n || null, ts: Date.now() };
  return n;
}

// ---- contract classification: LP pool / proxy for unlabeled contracts ----
const CT_PATH = 'data/contracts.json';
let ctCache = {}; try { ctCache = JSON.parse(fs.readFileSync(CT_PATH, 'utf8')); } catch {}
const EIP1967 = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
async function contractKind(addr) {
  const a = addr.toLowerCase();
  if (ctCache[a]) return ctCache[a].k;
  // token0() → it's an AMM pair/pool
  const t0 = await rpc('eth_call', [{ to: a, data: '0x0dfe1681' }, 'latest']);
  let k = null;
  if (t0 && t0.length === 66 && /^0x0{24}[0-9a-f]{40}$/.test(t0) && !/^0x0+$/.test(t0)) k = 'lp';
  else {
    const impl = await rpc('eth_getStorageAt', [a, EIP1967, 'latest']);
    if (impl && !/^0x0+$/.test(impl)) k = 'proxy';
  }
  ctCache[a] = { k, ts: Date.now() };
  return k;
}

function frLabelsFor(addr) {
  const r = frCache.wallets[(addr || '').toLowerCase()];
  if (!frHasData(r)) return null;
  const out = [];
  if (r.x) out.push('@' + r.x);
  if (r.pl && !r.pl.includes(r.x || ' ')) out.push(r.pl);
  (r.l || []).forEach(x => out.push(x));
  (r.t || []).forEach(x => out.push(x));
  return { labels: [...new Set(out)].slice(0, 10), x: r.x || null };
}

// ---- Arkham wallet profile enrichment (top wallets only) ----
const WALLET_DIR = 'data/wallets';
const WALLET_DETAIL_PER_TOKEN = 25;
const WALLET_TTL_H = 12;
let profileBudget = 600; // total arkham profile calls per run
let loggedShapes = false;

async function arkhamGet(pathname) {
  if (!ARKHAM_KEY || profileBudget <= 0) return null;
  const bases = arkhamBase ? [arkhamBase] : ARKHAM_BASES;
  for (const base of bases) {
    try {
      const r = await fetch(base + pathname, { headers: { 'API-Key': ARKHAM_KEY, accept: 'application/json' } });
      if (r.status === 429) { await new Promise(s => setTimeout(s, 2500)); continue; }
      if (!r.ok) { if (!loggedShapes) console.log(`  arkham ${r.status} on ${pathname.split('?')[0]} :: ${(await r.text()).slice(0, 140)}`); continue; }
      arkhamBase = base; profileBudget--;
      await new Promise(s => setTimeout(s, 300));
      return r.json();
    } catch (e) { /* next base */ }
  }
  return null;
}

function num2(x) { const n = Number(x); return isFinite(n) ? n : 0; }

function parsePortfolio(p) {
  if (!p) return null;
  // walk for arrays of balance-like objects
  const holdings = [];
  let totalUsd = 0;
  const walk = (o, chainHint, depth) => {
    if (!o || depth > 4) return;
    if (Array.isArray(o)) { o.forEach(v => walk(v, chainHint, depth + 1)); return; }
    if (typeof o !== 'object') return;
    const usd = num2(o.usd ?? o.usdValue ?? o.balanceUsd ?? o.valueUsd);
    const symb = o.symbol ?? o.tokenSymbol ?? (o.token && o.token.symbol);
    if (symb && usd > 0) {
      holdings.push({ sym: String(symb).toUpperCase().slice(0, 12), name: o.name || (o.token && o.token.name) || null,
        amount: num2(o.balance ?? o.amount ?? o.formattedBalance), usd, chain: o.chain || chainHint || null });
      return;
    }
    for (const [k, v] of Object.entries(o)) walk(v, /^[a-z0-9_]+$/.test(k) && typeof v === 'object' ? k : chainHint, depth + 1);
  };
  walk(p, null, 0);
  holdings.sort((a, b) => b.usd - a.usd);
  const seen = new Set(); const dedup = [];
  for (const h of holdings) { const k = h.sym + '|' + (h.chain || ''); if (seen.has(k)) continue; seen.add(k); dedup.push(h); }
  totalUsd = num2(p.totalBalance ?? p.totalUsd ?? p.total) || dedup.reduce((s, h) => s + h.usd, 0);
  return { totalUsd, holdings: dedup.slice(0, 15) };
}

function parseTransfers(t, self) {
  let arr = (t && (t.transfers || t.result || (Array.isArray(t) ? t : []))) || [];
  const meaningful = arr.filter(x => num2(x.historicalUSD ?? x.usd ?? x.usdValue) >= 1);
  if (meaningful.length >= 3) arr = meaningful;
  return arr.slice(0, 40).map(x => {
    const from = (x.fromAddress && (x.fromAddress.address || x.fromAddress)) || x.from || '';
    const to = (x.toAddress && (x.toAddress.address || x.toAddress)) || x.to || '';
    const fromLbl = (x.fromAddress && x.fromAddress.arkhamEntity && x.fromAddress.arkhamEntity.name) || (x.fromAddress && x.fromAddress.arkhamLabel && x.fromAddress.arkhamLabel.name) || null;
    const toLbl = (x.toAddress && x.toAddress.arkhamEntity && x.toAddress.arkhamEntity.name) || (x.toAddress && x.toAddress.arkhamLabel && x.toAddress.arkhamLabel.name) || null;
    const out = String(from).toLowerCase() === self.toLowerCase();
    return { ts: x.blockTimestamp || x.timestamp || x.time || null, dir: out ? 'out' : 'in',
      cp: out ? to : from, cpLabel: out ? toLbl : fromLbl,
      token: x.tokenSymbol || (x.token && x.token.symbol) || x.symbol || x.tokenName || (x.token && x.token.name) || x.asset || (x.type === 'external' || x.tokenAddress == null ? 'ETH' : null),
      amount: num2(x.unitValue ?? x.amount ?? x.value), usd: num2(x.historicalUSD ?? x.usd ?? x.usdValue),
      hash: x.transactionHash || x.txHash || x.hash || null, chain: x.chain || null };
  });
}

let loggedEntity = false, loggedEntityFull = false;
async function fixSocials(addr, prof) {
  // resolve entity id + socials even for fresh profiles (runs once per address)
  const a = addr.toLowerCase();
  const lc = labelCache[a];
  if (!lc || !lc.name) return prof;
  if (lc.idChecked && lc.slugTried) return prof;
  if (profileBudget < 3) return prof;
  lc.idChecked = true;
  const re = await arkhamGet(`/intelligence/address/${addr}/all`);
  if (re) {
    const pi = parseArkham(re);
    if (!loggedEntity) { loggedEntity = true;
      const findEnt = (o,d)=>{if(!o||typeof o!=='object'||d>3)return null;if(o.arkhamEntity)return o.arkhamEntity;for(const v of Object.values(o)){const r2=findEnt(v,d+1);if(r2)return r2}return null};
      console.log('  [shape] arkhamEntity:', JSON.stringify(findEnt(re,0)||{}).slice(0, 400));
    }
    lc.id = lc.id || pi.id; lc.twitter = lc.twitter || pi.twitter; lc.website = lc.website || pi.website;
    if (pi.labels && pi.labels.length) lc.labels = pi.labels;
  }
  if (!lc.twitter && !lc.website && !lc.slugTried) {
    lc.slugTried = true;
    const slug = lc.id || String(lc.name).toLowerCase().replace(/:.*$/, '').trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const ei = await arkhamGet(`/intelligence/entity/${encodeURIComponent(slug)}`);
    if (ei) {
      if (!loggedEntityFull) { loggedEntityFull = true; console.log('  [shape] entity(' + slug + '):', JSON.stringify(ei).slice(0, 600)); }
      const s2 = pickSocials(ei); lc.twitter = lc.twitter || s2.twitter; lc.website = lc.website || s2.website;
      lc.id = lc.id || slug;
    }
  }
  if (prof && prof.entity && (lc.twitter || lc.website)) {
    prof.entity.twitter = prof.entity.twitter || lc.twitter;
    prof.entity.website = prof.entity.website || lc.website;
    prof.entity.id = prof.entity.id || lc.id;
    return prof;
  }
  return prof;
}
const PF_POINTS = 10, PF_DAYS = 60;
async function backfillPortfolioHistory(addr, prof) {
  // real portfolio-value history from Arkham (portfolio?time= accepts historical timestamps)
  if (!prof || prof.pfB || (prof.history || []).length >= PF_POINTS - 2 || profileBudget < PF_POINTS + 5) return prof;
  const pts = [];
  for (let i = PF_POINTS - 1; i >= 1; i--) {
    const ts = Date.now() - i * (PF_DAYS / (PF_POINTS - 1)) * 864e5;
    const pf = await arkhamGet(`/portfolio/address/${addr}?time=${Math.round(ts)}`);
    const parsed = parsePortfolio(pf);
    if (parsed && parsed.totalUsd > 0) pts.push({ ts: new Date(ts).toISOString(), usd: Math.round(parsed.totalUsd) });
  }
  if (pts.length >= 3) {
    const merged = [...pts, ...(prof.history || [])].sort((a, b) => new Date(a.ts) - new Date(b.ts));
    const dedup = merged.filter((x, i) => i === 0 || new Date(x.ts) - new Date(merged[i-1].ts) > 36e5);
    prof.history = dedup.slice(-400);
    prof.pfB = true;
    console.log(`  pf-history backfilled ${addr.slice(0, 10)} (${pts.length} pts)`);
  }
  return prof;
}
async function enrichWalletProfile(addr) {
  fs.mkdirSync(WALLET_DIR, { recursive: true });
  const p = path.join(WALLET_DIR, addr.toLowerCase() + '.json');
  let oldHistory = [], oldPos = {}, oldProf = null;
  try {
    const old = JSON.parse(fs.readFileSync(p, 'utf8'));
    oldHistory = old.history || []; oldPos = old.posHistory || {}; oldProf = old;
    if (old.v === 3 && Date.now() - new Date(old.updated).getTime() < WALLET_TTL_H * 36e5) {
      // fresh profile: still run the cheap upgrade + heal passes
      const before = JSON.stringify({ e: old.entity, h: (old.history||[]).length, b: old.pfB, pf: !!old.portfolio, tr: (old.transfers||[]).length });
      await fixSocials(addr, old);
      // heal template-JSON labels written before the sanitizer existed
      if (old.entity && (old.entity.labels || []).length) old.entity.labels = cleanLabels(old.entity.labels);
      // copy multi-labels from the label cache into the profile (free)
      { const lc2 = labelCache[addr.toLowerCase()];
        if (lc2 && lc2.labels && lc2.labels.length && old.entity && !(old.entity.labels || []).length) old.entity.labels = lc2.labels; }
      await backfillPortfolioHistory(addr, old);
      // heal: restore portfolio/transfers lost to an exhausted-budget run
      if (!old.portfolio && profileBudget >= 5) {
        const pf2 = parsePortfolio(await arkhamGet(`/portfolio/address/${addr}?time=${Date.now()}`));
        if (pf2 && pf2.totalUsd > 0) old.portfolio = pf2;
      }
      if (!(old.transfers || []).length && profileBudget >= 5) {
        const tr2 = await arkhamGet(`/transfers?base=${addr}&limit=40&sortDir=desc&usdGte=1`);
        const p2 = tr2 ? parseTransfers(tr2, addr) : [];
        if (p2.length) old.transfers = p2;
      }
      if (JSON.stringify({ e: old.entity, h: (old.history||[]).length, b: old.pfB, pf: !!old.portfolio, tr: (old.transfers||[]).length }) !== before) fs.writeFileSync(p, JSON.stringify(old));
      return;
    }
  } catch {}
  if (profileBudget < 15) return; // not enough budget to finish properly — keep old data intact
  // entity comes from the label cache (filled by arkhamLookup) — no duplicate intel call
  const cached = labelCache[addr.toLowerCase()] || null;
  const intel = cached ? null : await arkhamGet(`/intelligence/address/${addr}/all`);
  const portfolio = await arkhamGet(`/portfolio/address/${addr}?time=${Date.now()}`)
    || await arkhamGet(`/portfolio/address/${addr}`);
  const transfers = await arkhamGet(`/transfers?base=${addr}&limit=40&sortDir=desc&usdGte=1`);
  if (!cached && !intel && !portfolio && !transfers) return;
  if (!loggedShapes && (portfolio || transfers)) {
    loggedShapes = true;
    if (portfolio) console.log('  [shape] portfolio keys:', Object.keys(portfolio).slice(0, 12).join(','));
    if (transfers) console.log('  [shape] transfers keys:', Object.keys(transfers).slice(0, 12).join(','));
  }
  let ent = cached ? { name: cached.name, type: cached.type, label: cached.label, id: cached.id || null, twitter: cached.twitter || null, website: cached.website || null, labels: cached.labels || [] } : parseArkham(intel || {});
  // older cache entries lack the entity id — refresh intel once for named entities so socials can resolve
  if (cached && ent.name && !ent.id && !cached.idChecked) {
    const re = await arkhamGet(`/intelligence/address/${addr}/all`);
    if (re) { const pi = parseArkham(re); ent.id = pi.id; ent.twitter = ent.twitter || pi.twitter; ent.website = ent.website || pi.website; }
    const lc = labelCache[addr.toLowerCase()]; if (lc) { lc.idChecked = true; lc.id = ent.id || lc.id; lc.twitter = lc.twitter || ent.twitter; lc.website = lc.website || ent.website; }
  }
  // fetch entity-level socials once when we know the entity but lack socials
  if (ent.id && !ent.twitter && !ent.website) {
    const ei = await arkhamGet(`/intelligence/entity/${encodeURIComponent(ent.id)}`);
    if (ei) { const s2 = pickSocials(ei); ent.twitter = ent.twitter || s2.twitter; ent.website = ent.website || s2.website;
      const lc = labelCache[addr.toLowerCase()]; if (lc) { lc.twitter = lc.twitter || s2.twitter; lc.website = lc.website || s2.website; } }
  }
  // Frontrun fallback: X handle when Arkham has no socials for this wallet
  { const fr = frCache.wallets[addr.toLowerCase()];
    if (fr && fr.x && !ent.twitter) { ent.twitter = fr.x; if (!ent.name && fr.n) ent.label = ent.label || fr.n; } }
  const port = parsePortfolio(portfolio);
  // own balance-history: one point per refresh cycle, grows forever (capped)
  const history = oldHistory.slice(-400);
  if (port && port.totalUsd > 0) {
    const last = history[history.length - 1];
    if (!last || Date.now() - new Date(last.ts).getTime() > 6 * 36e5) history.push({ ts: new Date().toISOString(), usd: Math.round(port.totalUsd) });
  }
  const newTr = transfers ? parseTransfers(transfers, addr) : [];
  let prof = ({
    v: 3, addr, updated: new Date().toISOString(),
    posHistory: oldPos, pfB: oldProf ? !!oldProf.pfB : false,
    entity: (ent && (ent.name || ent.label)) ? ent : ((oldProf && oldProf.entity) || ent),
    portfolio: port || (oldProf && oldProf.portfolio) || null,
    history,
    transfers: newTr.length ? newTr : ((oldProf && oldProf.transfers) || []),
  });
  await fixSocials(addr, prof);
  await backfillPortfolioHistory(addr, prof);
  fs.writeFileSync(p, JSON.stringify(prof));
}

// ---- Schools: connected-wallet graph across every tracked top-100 ----
// Evidence rules (deliberately conservative — overclaiming identity links is worse than missing them):
//   HIGH: direct transfer ≥$100 between two top-100 wallets · one first-funded the other ·
//         both first-funded by the same PRIVATE wallet (2–8 siblings; more = a service, not a person)
//   Shared CEX/bridge/deposit funding is NOT evidence and never creates an edge.
//   Contracts, LP pools, proxies and infra-labeled wallets are excluded from the graph entirely.
const PIPE_INFRA_RX = /\bdeposit\b|\bpool\b|bridge|exchange|router|locker|timelock/i;
function pipeInfra(h) {
  if (h.contractKind === 'lp' || h.contractKind === 'proxy') return true;
  if (['cex', 'dex', 'bridge', 'exchange', 'staking', 'locker'].includes(String(h.entityType || '').toLowerCase())) return true;
  const hay = [h.entity, h.label, ...(h.labels || [])].filter(Boolean).join(' ').replace(/gnosis safe( proxy)?/gi, '').replace(/\S+ deployer/gi, '');
  return PIPE_INFRA_RX.test(hay);
}
function buildSchools(allTops) {
  const universe = new Map(); // lower addr -> display info
  for (const top of Object.values(allTops)) for (const h of top || []) {
    if (h.isContract && h.contractKind) continue;
    if (pipeInfra(h)) continue;
    const a = h.addr.toLowerCase();
    if (!universe.has(a)) universe.set(a, { addr: a, name: h.entity || h.basename || h.label || null });
  }
  const inU = (a) => a && universe.has(a);
  const edges = []; const seenE = new Set();
  const addEdge = (a, b, type, detail) => {
    if (!a || !b || a === b || !inU(a) || !inU(b)) return;
    const k = [a, b].sort().join('|');
    if (seenE.has(k + type)) return; seenE.add(k + type);
    edges.push({ a, b, type, detail });
  };
  // funding evidence
  const byFunder = {};
  for (const a of universe.keys()) {
    const f = fundCache[a];
    if (!f || !f.funder || f.kind !== 'private') continue;
    if (inU(f.funder)) addEdge(f.funder, a, 'funded', 'first-funded this wallet directly');
    (byFunder[f.funder] = byFunder[f.funder] || []).push(a);
  }
  for (const [funder, kids] of Object.entries(byFunder)) {
    if (inU(funder) || kids.length < 2 || kids.length > 8) continue;
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++)
      addEdge(kids[i], kids[j], 'co-funded', `both first-funded by the same private wallet ${funder.slice(0, 8)}…`);
  }
  // direct-transfer evidence from enriched wallet profiles
  for (const a of universe.keys()) {
    let p = null;
    try { p = JSON.parse(fs.readFileSync(path.join(WALLET_DIR, a + '.json'), 'utf8')); } catch (e) { continue; }
    for (const tr of (p.transfers || [])) {
      const cp = String(tr.cp || '').toLowerCase();
      if (inU(cp) && (tr.usd || 0) >= 100)
        addEdge(a, cp, 'transfer', `${tr.dir === 'out' ? 'sent' : 'received'} $${Math.round(tr.usd).toLocaleString('en-US')} ${tr.dir === 'out' ? 'to' : 'from'} it directly`);
    }
  }
  // connected components (union-find)
  const parent = {};
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const a of universe.keys()) parent[a] = a;
  for (const e of edges) { const ra = find(e.a), rb = find(e.b); if (ra !== rb) parent[ra] = rb; }
  const comps = {};
  for (const a of universe.keys()) { const r = find(a); (comps[r] = comps[r] || []).push(a); }
  const schools = [];
  for (const members of Object.values(comps)) {
    if (members.length < 2 || members.length > 12) continue; // >12 members = almost certainly an artifact
    const mset = new Set(members);
    const ev = edges.filter(e => mset.has(e.a) && mset.has(e.b));
    // combined share per token
    const perToken = {};
    for (const [sym, top] of Object.entries(allTops)) {
      let pct = 0, n = 0;
      for (const h of top || []) if (mset.has(h.addr.toLowerCase())) { pct += h.pct || 0; n++; }
      if (n >= 1) perToken[sym] = { members: n, pct: +pct.toFixed(2) };
    }
    schools.push({
      id: schools.length + 1,
      members: members.map(a => ({ addr: a, name: universe.get(a).name })),
      evidence: ev.map(e => ({ a: e.a, b: e.b, type: e.type, detail: e.detail })),
      confidence: 'high', // every edge type we admit is high-grade evidence by construction
      perToken,
    });
  }
  schools.sort((x, y) => y.members.length - x.members.length);
  schools.forEach((s, i) => s.id = i + 1);
  return schools;
}

const BURN = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);
// Labels/entities we exclude from the top-100 (pools, CEXs, bridges, lockers)
const EXCLUDE_RX = /uniswap|aerodrome|pancake|sushi|baseswap|alien.?base|pool|liquidity|\blp\b|exchange|binance|coinbase|bybit|okx|gate|kucoin|mexc|bitget|htx|kraken|crypto\.com|bridge|locker|timelock|vesting|multisig deployer|wintermute|market maker/i;

async function j(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: H });
    if (r.ok) return r.json();
    if (r.status === 429) { await new Promise(s => setTimeout(s, 1500 * (i + 1))); continue; }
    throw new Error(`${r.status} ${url} :: ${(await r.text()).slice(0, 200)}`);
  }
  throw new Error(`rate-limited ${url}`);
}

// ---- Bitquery: top holders (primary source when token present) ----
async function bqHolders(t, limit = 220) {
  if (!BQ_TOKEN) return null;
  const today = new Date().toISOString().slice(0, 10);
  const q = `query { EVM(dataset: archive, network: base) {
    TokenHolders(date: "${today}", tokenSmartContract: "${t.contract}",
      limit: { count: ${limit} }, orderBy: { descendingByField: "Balance_Amount" },
      where: { Balance: { Amount: { gt: "0" } } }) {
      Holder { Address }
      Balance { Amount }
    } } }`;
  for (const url of ['https://streaming.bitquery.io/graphql', 'https://graphql.bitquery.io']) {
    try {
      const r = await fetch(url, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + BQ_TOKEN, 'X-API-KEY': BQ_TOKEN },
        body: JSON.stringify({ query: q }) });
      if (!r.ok) { console.log(`  bitquery ${r.status} @ ${url.split('/')[2]} :: ${(await r.text()).slice(0, 140)}`); continue; }
      const d = await r.json();
      if (d.errors) { console.log('  bitquery errors:', JSON.stringify(d.errors).slice(0, 200)); continue; }
      const rows = d.data && d.data.EVM && d.data.EVM.TokenHolders;
      if (rows && rows.length) return rows.map(x => ({ addr: x.Holder.Address, amount: Number(x.Balance.Amount) || 0 }));
    } catch (e) { console.log('  bitquery fail:', e.message.slice(0, 80)); }
  }
  return null;
}
// ---- CoinGecko market data (price/chg/mcap/supply for all tokens in ONE call) ----
let cgMarkets = null;
async function cgMarketFor(t) {
  if (cgMarkets === null) {
    try {
      const ids = cfg.tokens.map(x => x.coingecko).filter(Boolean).join(',');
      const r = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&price_change_percentage=24h`);
      cgMarkets = r.ok ? await r.json() : [];
    } catch (e) { cgMarkets = []; }
  }
  return cgMarkets.find(x => x.id === t.coingecko) || null;
}

fs.mkdirSync('data', { recursive: true });
if (ARKHAM_KEY) {
  const named = Object.entries(labelCache).find(([, v]) => v && v.name);
  if (named) {
    try {
      const dbg = await arkhamGet(`/intelligence/address/${named[0]}/all`);
      console.log(`[debug] /all for ${named[1].name} (${named[0].slice(0, 10)}):`, JSON.stringify(dbg).slice(0, 700));
    } catch (e) {}
  }
}
let logoCache = {};
try { logoCache = JSON.parse(fs.readFileSync('data/logos.json', 'utf8')); } catch {}
async function tokenLogo(t) {
  const hit = logoCache[t.sym];
  if (hit && Date.now() - (hit.ts || 0) < 7 * 864e5) return hit.url;
  if (!t.coingecko) return hit ? hit.url : null;
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/coins/${t.coingecko}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`);
    if (r.ok) { const d = await r.json(); const url = (d.image && (d.image.small || d.image.large)) || null;
      if (url) { logoCache[t.sym] = { url, ts: Date.now() }; return url; } }
  } catch (e) {}
  return hit ? hit.url : null;
}
const index = { generated_at: new Date().toISOString(), tokens: [] };
const ALLTOPS = {}; // sym -> holdersTop, for the cross-token schools graph

// ---- 30d position-history backfill (real on-chain data via to_block) ----
const HIST_POINTS = 10, HIST_DAYS = 30, HIST_TOP = 15;
let histBlocks = null; // shared dates→blocks across tokens
async function getHistBlocks() {
  if (histBlocks) return histBlocks;
  histBlocks = [];
  for (let i = HIST_POINTS - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * (HIST_DAYS / (HIST_POINTS - 1)) * 864e5);
    try {
      const r = await j(`${M}/dateToBlock?chain=${cfg.chain}&date=${encodeURIComponent(d.toISOString())}`);
      histBlocks.push({ ts: d.toISOString(), block: r.block });
    } catch (e) { console.log('  dateToBlock failed:', e.message.slice(0, 80)); }
  }
  return histBlocks;
}
async function backfillPositions(t, top) {
  const c = t.contract.toLowerCase();
  const blocks = await getHistBlocks();
  if (!blocks.length) return;
  // token price at each block (shared across wallets)
  const prices = [];
  for (const b of blocks) {
    try { prices.push(Number((await j(`${M}/erc20/${c}/price?chain=${cfg.chain}&to_block=${b.block}`)).usdPrice) || 0); }
    catch (e) { prices.push(0); }
  }
  fs.mkdirSync(WALLET_DIR, { recursive: true });
  let done = 0;
  for (const h of top.slice(0, HIST_TOP)) {
    const p = path.join(WALLET_DIR, h.addr.toLowerCase() + '.json');
    let cur2 = {}; try { cur2 = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    const ph = cur2.posHistory || {};
    if (ph[t.sym] && ph[t.sym].length >= HIST_POINTS - 2) continue; // already backfilled
    const pts = [];
    for (let i = 0; i < blocks.length; i++) {
      try {
        let amt = 0;
        try {
          const bal = await j(`${M}/wallets/${h.addr}/tokens?chain=${cfg.chain}&token_addresses%5B0%5D=${c}&to_block=${blocks[i].block}`);
          const row = (bal.result || [])[0];
          amt = row ? Number(row.balance_formatted) || 0 : 0;
        } catch (e1) {
          // fallback: classic erc20 balances endpoint (raw balance + decimals)
          const bal2 = await j(`${M}/${h.addr}/erc20?chain=${cfg.chain}&token_addresses%5B0%5D=${c}&to_block=${blocks[i].block}`);
          const row2 = (Array.isArray(bal2) ? bal2 : bal2.result || [])[0];
          amt = row2 ? Number(row2.balance) / Math.pow(10, Number(row2.decimals) || 18) : 0;
        }
        pts.push({ ts: blocks[i].ts, usd: Math.round(amt * (prices[i] || 0)), amount: amt });
      } catch (e) { /* skip point */ }
    }
    if (pts.length >= 3) {
      ph[t.sym] = pts;
      cur2.posHistory = ph; cur2.addr = cur2.addr || h.addr;
      fs.writeFileSync(p, JSON.stringify(cur2));
      done++;
    }
  }
  if (done) console.log(`  backfilled 30d position history for ${done} wallets`);
}

for (const t of cfg.tokens) {
  const c = t.contract.toLowerCase();
  console.log(`\n== ${t.sym} ${c}`);
  try {
    // market data: CoinGecko first (one call for all tokens), Moralis fallback
    let usd = 0, chg = 0, supply = 0, mcap = 0, vol = 0;
    const mk = await cgMarketFor(t);
    if (mk) { usd = mk.current_price || 0; chg = mk.price_change_percentage_24h || 0; supply = mk.total_supply || 0; mcap = mk.market_cap || (usd * supply); vol = mk.total_volume || 0; }
    if (!usd && KEY) {
      const price = await j(`${M}/erc20/${c}/price?chain=${cfg.chain}&include=percent_change`);
      usd = Number(price.usdPrice) || 0; chg = Number(price['24hrPercentChange']) || 0;
    }
    if (!supply && KEY) {
      try { const meta = (await j(`${M}/erc20/metadata?chain=${cfg.chain}&addresses%5B0%5D=${c}`))[0] || {}; supply = Number(meta.total_supply_formatted) || 0; if (!mcap) mcap = usd * supply; } catch (e) {}
    }
    if (!usd) throw new Error('no price source available');

    // holder count (best effort, Moralis, cheap)
    let holders = null;
    if (KEY) { try { holders = (await j(`${M}/erc20/${c}/holders?chain=${cfg.chain}`)).totalHolders ?? null; } catch (e) {} }

    const perToken = new Set((t.exclude || []).map(a => a.toLowerCase()));
    const knownLabel = (a) => { const lc = labelCache[a]; return (lc && (lc.name || lc.label)) || ''; };
    let kept = [], seen = 0;

    // holders: Bitquery primary
    const bq = await bqHolders(t);
    if (bq) {
      console.log(`  holders via bitquery: ${bq.length}`);
      for (const o of bq) {
        seen++;
        const a = o.addr.toLowerCase();
        if (BURN.has(a) || a === c || perToken.has(a)) continue;
        const kl = knownLabel(a);
        if (kl && EXCLUDE_RX.test(kl)) { console.log('  excluded:', a.slice(0, 10), kl); continue; }
        kept.push({ addr: o.addr, amount: o.amount, pct: supply ? o.amount / supply * 100 : 0, usd: o.amount * usd, label: kl || null, isContract: false });
      }
    } else if (KEY) {
      // fallback: Moralis owners (paged)
      let cursor = '', pages = 0;
      while (pages < 3 && kept.length < 130) {
        const q = `${M}/erc20/${c}/owners?chain=${cfg.chain}&order=DESC&limit=100${cursor ? `&cursor=${cursor}` : ''}`;
        const page = await j(q);
        for (const o of page.result || []) {
          seen++;
          const a = (o.owner_address || '').toLowerCase();
          const label = o.owner_address_label || o.entity || '';
          if (BURN.has(a) || a === c || perToken.has(a)) continue;
          if (label && EXCLUDE_RX.test(label)) { console.log('  excluded:', a.slice(0, 10), label); continue; }
          const amount = Number(o.balance_formatted) || 0;
          kept.push({ addr: o.owner_address, amount, pct: Number(o.percentage_relative_to_total_supply) || (supply ? amount / supply * 100 : 0), usd: Number(o.usd_value) || amount * usd, label: label || null, isContract: !!o.is_contract });
        }
        cursor = page.cursor || ''; pages++; if (!cursor) break;
      }
    } else throw new Error('no holders source available');
    kept.sort((a, b) => b.usd - a.usd);
    // Arkham enrichment for the head of the list (cache-first, budgeted)
    if (ARKHAM_KEY || Object.keys(labelCache).length) {
      const head = kept.slice(0, 120);
      for (const h of head) {
        const info = await arkhamLookup(h.addr);
        if (!info) continue;
        const name = info.name || info.label;
        if (name) h.label = h.label ? h.label : name;
        if (info.name) h.entity = info.name;
        if (info.type) h.entityType = info.type;
        if (info.labels && info.labels.length) h.labels = info.labels.slice(0, 12);
      }
    }
    const filtered = kept.filter(h => !(h.entityType && EXCLUDE_TYPES.has(String(h.entityType).toLowerCase())));
    const dropped = kept.length - filtered.length;
    if (dropped) console.log(`  arkham-excluded ${dropped} CEX/bridge/dex wallets`);
    const top = filtered.slice(0, 100);
    console.log(`  scanned ${seen}, kept ${kept.length}, top ${top.length}`);
    // Frontrun enrichment: X identities + KOL labels + cross-token tags (cache-first, budgeted)
    if (FRONTRUN_KEY) {
      const need = top.map(h => h.addr.toLowerCase()).filter(a => !frFresh(frCache.wallets[a]));
      if (need.length) { console.log(`  frontrun lookup: ${need.length} wallets (budget ${frBudget})`); await frontrunBatch(need); }
    }
    for (const h of top) {
      const fr = frLabelsFor(h.addr);
      if (!fr) continue;
      h.labels = [...new Set([...(h.labels || []), ...fr.labels])].slice(0, 14);
      if (fr.x && !h.entity && !h.label) h.label = '@' + fr.x; // fish bubble shows the X handle
    }
    // Basenames (EOAs) + LP/proxy classification (unlabeled contracts) — budgeted public RPC, cached
    for (const h of top) {
      if (rpcBudget <= 0) break;
      try {
        if (h.isContract && !h.entityType && !h.entity) {
          const k = await contractKind(h.addr);
          if (k === 'lp') { h.contractKind = 'lp'; if (!h.label) h.label = 'LP Pool'; h.labels = [...new Set([...(h.labels || []), 'LP Pool'])]; }
          else if (k === 'proxy') { h.contractKind = 'proxy'; h.labels = [...new Set([...(h.labels || []), 'Proxy contract'])]; }
        } else if (!h.isContract) {
          const bn = await basenameFor(h.addr);
          if (bn) { h.basename = bn; if (!h.entity && !h.label) h.label = bn; h.labels = [...new Set([bn, ...(h.labels || [])])].slice(0, 14); }
        }
      } catch (e) {}
    }
    // funding source (cached forever once resolved; ~150 lookups/run backfill)
    for (const h of top) {
      if (h.isContract && h.contractKind) continue; // funding of an LP/proxy is meaningless
      try {
        const f = await fundingFor(h.addr);
        if (f !== undefined) h.funding = f;
        const fl = fundingLabels(f);
        if (fl.length) h.labels = [...new Set([...(h.labels || []), ...fl])].slice(0, 14);
      } catch (e) {}
    }
    // snapshot history → rank & balance change vs the snapshot closest to 24h ago
    let changeRefH = null;
    {
      fs.mkdirSync('data/snapshots', { recursive: true });
      const spath = path.join('data/snapshots', t.sym.toLowerCase() + '.json');
      let snaps = []; try { snaps = JSON.parse(fs.readFileSync(spath, 'utf8')); } catch {}
      const nowTs = Date.now(), want = nowTs - 864e5;
      const ref = snaps.length ? snaps.reduce((b, s) => Math.abs(s.ts - want) < Math.abs(b.ts - want) ? s : b) : null;
      if (ref) {
        changeRefH = Math.max(1, Math.round((nowTs - ref.ts) / 36e5));
        top.forEach((h, i) => {
          const o = ref.h[h.addr.toLowerCase()];
          if (!o) { h.rankChange = 'new'; h.usdChange = null; }
          else { h.rankChange = o.r - (i + 1); h.usdChange = Math.round(h.usd - o.u); }
        });
      }
      snaps.push({ ts: nowTs, h: Object.fromEntries(top.map((h, i) => [h.addr.toLowerCase(), { r: i + 1, u: Math.round(h.usd) }])) });
      while (snaps.length > 15) snaps.shift();
      fs.writeFileSync(spath, JSON.stringify(snaps));
    }
    if (ARKHAM_KEY) {
      for (const h of top.slice(0, WALLET_DETAIL_PER_TOKEN)) { try { await fixSocials(h.addr, null); } catch (e) {} }
      for (const h of top.slice(0, WALLET_DETAIL_PER_TOKEN)) {
        try { await enrichWalletProfile(h.addr); } catch (e) { console.log('  profile err', h.addr.slice(0, 10), e.message.slice(0, 60)); }
      }
      console.log(`  wallet profiles refreshed (budget left ${profileBudget})`);
    }
    // Moralis 30d position backfill retired — Arkham portfolio history covers charts

    // recent meaningful transfers (Moralis, cheap; skipped without key)
    let recent = [];
    try {
      if (!KEY) throw new Error('no moralis');
      const tr = await j(`${M}/erc20/${c}/transfers?chain=${cfg.chain}&limit=50`);
      recent = (tr.result || [])
        .map(x => ({
          hash: x.transaction_hash,
          from: x.from_address,
          to: x.to_address,
          amount: Number(x.value_decimal) || 0,
          usd: (Number(x.value_decimal) || 0) * usd,
          ts: x.block_timestamp,
        }))
        .filter(x => x.usd >= (cfg.minTransferUsd || 1000))
        .slice(0, 15);
    } catch (e) { console.log('transfers unavailable:', e.message.slice(0, 80)); }

    const logo = await tokenLogo(t);
    const out = {
      sym: t.sym, name: t.name, color: t.color, contract: t.contract, logo,
      price: usd, chg, mcap, vol, holders, changeRefH,
      generated_at: index.generated_at,
      holdersTop: top, recent,
    };
    fs.writeFileSync(path.join('data', `${t.sym.toLowerCase()}.json`), JSON.stringify(out));
    ALLTOPS[t.sym] = top;
    index.tokens.push({ sym: t.sym, name: t.name, color: t.color, contract: t.contract, logo, price: usd, chg, mcap, vol, holders });
    console.log(`  ok: price=$${usd} mcap=$${Math.round(mcap).toLocaleString()} holders=${holders}`);
  } catch (e) {
    console.error(`  FAILED ${t.sym}:`, e.message.slice(0, 160));
    // Moralis down (quota etc): keep previous data, but Arkham + logos still work
    const p = path.join('data', `${t.sym.toLowerCase()}.json`);
    if (fs.existsSync(p)) {
      const old = JSON.parse(fs.readFileSync(p, 'utf8'));
      const logo = await tokenLogo(t);
      if (logo && !old.logo) { old.logo = logo; fs.writeFileSync(p, JSON.stringify(old)); }
      index.tokens.push({ sym: old.sym, name: old.name, color: old.color, contract: old.contract, logo: old.logo || logo, price: old.price, chg: old.chg, mcap: old.mcap, holders: old.holders });
      ALLTOPS[old.sym] = old.holdersTop || [];
      if (ARKHAM_KEY) {
        for (const h of (old.holdersTop || []).slice(0, WALLET_DETAIL_PER_TOKEN)) { try { await fixSocials(h.addr, null); } catch (e2) {} }
        for (const h of (old.holdersTop || []).slice(0, WALLET_DETAIL_PER_TOKEN)) {
          try { await enrichWalletProfile(h.addr); } catch (e2) { }
        }
        console.log(`  arkham-only enrichment done (profile budget left ${profileBudget})`);
      }
    }
  }
}

if (!index.tokens.length) { console.error('No token data fetched at all — aborting without writing index.'); process.exit(1); }
fs.writeFileSync(LABELS_PATH, JSON.stringify(labelCache));
fs.writeFileSync(FR_PATH, JSON.stringify({ updated: new Date().toISOString(), wallets: frCache.wallets }));
fs.writeFileSync(BN_PATH, JSON.stringify(bnCache));
fs.writeFileSync(CT_PATH, JSON.stringify(ctCache));
fs.writeFileSync(FUND_PATH, JSON.stringify(fundCache));

// ---- schools: build the cross-token graph and annotate token files ----
try {
  const schools = buildSchools(ALLTOPS);
  fs.writeFileSync('data/schools.json', JSON.stringify({ updated: new Date().toISOString(), schools }));
  const bySchool = {};
  schools.forEach(s => s.members.forEach(m => bySchool[m.addr] = s.id));
  for (const sym of Object.keys(ALLTOPS)) {
    const p = path.join('data', sym.toLowerCase() + '.json');
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      let touched = false;
      for (const h of d.holdersTop || []) {
        const sid = bySchool[h.addr.toLowerCase()] ?? null;
        if ((h.school ?? null) !== sid) { h.school = sid; touched = true; }
      }
      if (touched) fs.writeFileSync(p, JSON.stringify(d));
    } catch (e) {}
  }
  const fundDone = Object.keys(fundCache).length;
  console.log(`Schools: ${schools.length} detected (${schools.reduce((s, x) => s + x.members.length, 0)} wallets) · funding cached for ${fundDone} wallets (budget left ${fundBudget})`);
} catch (e) { console.log('schools build failed:', e.message.slice(0, 120)); }
fs.writeFileSync('data/logos.json', JSON.stringify(logoCache));
fs.writeFileSync('data/index.json', JSON.stringify(index));
console.log(`\nWrote data/index.json with ${index.tokens.length} tokens. Label cache: ${Object.keys(labelCache).length} addresses${ARKHAM_KEY ? '' : ' (no ARKHAM_API_KEY — enrichment skipped)'}.`);
