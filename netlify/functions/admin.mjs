// /api/admin — founder console (ADMIN_IDS in Netlify env: comma-separated Privy DIDs / emails / wallet addresses).
// GET  → users (usage per account), tokens, bot pause state, last run, proposals
// POST {op:'setPlan',uid,plan} | {op:'setLimit',uid,limit} | {op:'addCredits',uid,n} | {op:'addToken',ca} | {op:'curate',sym,on}
//      | {op:'removeToken',sym} | {op:'pause',on} | {op:'proposal',id,decision:'approve'|'reject'}
import { readSession, readRaw, updateJson, USERS_PATH, SUBS_PATH, json, isAdmin, fetchLimit, PLANS } from '../lib/store.mjs';

const CFG = 'tokens.config.json', PROPS = 'data/proposals.json', TAGS = 'data/tags_manual.json';
const PALETTE = ['#4C8DFF', '#F2C14E', '#A78BFA', '#22C55E', '#F97316', '#EC4899', '#14B8A6', '#EAB308', '#8B5CF6', '#EF4444', '#06B6D4', '#84CC16'];

async function dispatch(tier = 'hot') {
  try { const r = await fetch('https://api.github.com/repos/beeonchain/basefish/actions/workflows/refresh.yml/dispatches', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.GH_DISPATCH_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'whalarium-admin', 'X-GitHub-Api-Version': '2022-11-28' }, body: JSON.stringify({ ref: 'main', inputs: { tier } }) }); return r.status === 204; } catch { return false; }
}

export default async (req) => {
  const uid = await readSession(req);
  if (!uid) return json({ error: 'sign in' }, 401);
  const users = await readRaw(USERS_PATH, { users: {} });
  const me = users.users && users.users[uid];
  if (!isAdmin(uid, me)) return json({ error: 'not an admin' }, 403);

  if (req.method === 'GET') {
    const cfg = await readRaw(CFG, { tokens: [] });
    const subs = await readRaw(SUBS_PATH, { chats: {} });
    const run = await readRaw('data/run_log.json', null);
    const props = await readRaw(PROPS, { items: [] });
    const list = Object.entries(users.users || {}).map(([id, u]) => ({ id, label: u.label, email: u.email || null, x: u.x || null, wallets: u.wallets || [], plan: u.plan || 'free', fetches: u.fetches || 0, limit: fetchLimit(u), fetchLog: (u.fetchLog || []).slice(-10), watches: (u.watches || []).length, claims: Object.keys(u.claims || {}).length, tg: !!u.tg, created: u.created || null, seen: u.seen || null }))
      .sort((a, b) => (b.seen || 0) - (a.seen || 0));
    const tokens = (cfg.tokens || []).map((t) => ({ sym: t.sym, name: t.name, contract: t.contract, auto: !!t.auto, curated: !t.auto && !t.addedBy, addedBy: t.addedBy || null, tier: t.tier || 'hot', cap: t.cap || null, trending: !!t.trending }));
    return json({ users: list, tokens, plans: PLANS, pause: subs.pause || { on: false, allow: [] }, chats: Object.keys(subs.chats || {}).length, run: run ? { started: run.started, finished: run.finished, tier: run.tier, errors: run.errors, webhook: run.webhook, tokens: Object.keys(run.tokens || {}).length } : null, proposals: (props.items || []).filter((p) => p.status === 'open') });
  }
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const b = await req.json().catch(() => ({}));
  const op = String(b.op || '');
  try {
    if (['setPlan', 'setLimit', 'addCredits'].includes(op)) {
      const target = String(b.uid || ''); let out = null;
      await updateJson(USERS_PATH, { users: {} }, (d) => {
        const u = d.users && d.users[target]; if (!u) throw new Error('no such user');
        if (op === 'setPlan') { if (!PLANS[b.plan]) throw new Error('unknown plan'); u.plan = b.plan; delete u.fetchLimit; }
        if (op === 'setLimit') u.fetchLimit = Math.max(0, Number(b.limit) || 0);
        if (op === 'addCredits') u.fetchLimit = fetchLimit(u) + Math.max(0, Number(b.n) || 0);
        out = { id: target, plan: u.plan, fetches: u.fetches || 0, limit: fetchLimit(u) };
      }, `admin: ${op}`);
      return json({ ok: true, user: out });
    }
    if (op === 'addToken') {
      const ca = String(b.ca || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(ca)) return json({ error: 'bad contract address' }, 400);
      const origin = new URL(req.url).origin;
      const info = await fetch(`${origin}/api/token?ca=${ca}`).then((r) => r.json()).catch(() => null);
      if (!info || !info.isToken) return json({ error: 'not an ERC-20 token (or lookup failed)' }, 400);
      let sym = String(info.sym || 'TOKEN').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'TOKEN';
      await updateJson(CFG, { chain: 'base', tokens: [] }, (cfg) => {
        cfg.tokens = cfg.tokens || [];
        const ex = cfg.tokens.find((t) => String(t.contract).toLowerCase() === ca);
        if (ex) { delete ex.auto; delete ex.addedBy; sym = ex.sym; return; } // already there → make it curated (never dropped)
        while (cfg.tokens.some((t) => t.sym === sym)) sym = sym.slice(0, 8) + Math.floor(Math.random() * 90 + 10);
        const t = { sym, name: String(info.name || sym).slice(0, 40), color: PALETTE[cfg.tokens.length % PALETTE.length], contract: ca, exclude: [], tier: 'hot' };
        if (info.cgId) t.coingecko = info.cgId;
        cfg.tokens.push(t);
      }, `tokens: curate ${sym} (admin)`);
      return json({ ok: true, sym, dispatched: await dispatch('hot') });
    }
    if (op === 'curate' || op === 'removeToken') {
      const sym = String(b.sym || '').toUpperCase(); let hit = false;
      await updateJson(CFG, { tokens: [] }, (cfg) => {
        const i = (cfg.tokens || []).findIndex((t) => t.sym === sym); if (i < 0) throw new Error('unknown token');
        hit = true;
        if (op === 'removeToken') cfg.tokens.splice(i, 1);
        else if (b.on) { delete cfg.tokens[i].auto; delete cfg.tokens[i].addedBy; } else cfg.tokens[i].auto = true;
      }, `tokens: ${op} ${sym} (admin)`);
      return json({ ok: hit });
    }
    if (op === 'pause') {
      await updateJson(SUBS_PATH, { chats: {} }, (s) => { s.pause = { ...(s.pause || {}), on: !!b.on, allow: (s.pause && s.pause.allow) || [] }; }, `admin: pause ${b.on ? 'on' : 'off'}`);
      return json({ ok: true });
    }
    if (op === 'proposal') {
      let p = null;
      await updateJson(PROPS, { items: [] }, (d) => { p = (d.items || []).find((x) => x.id === b.id); if (!p) throw new Error('no such proposal'); p.status = b.decision === 'approve' ? 'approved' : 'rejected'; p.decided = Date.now(); p.by = uid; }, `proposals: ${b.decision}`);
      if (p.status === 'approved' && p.kind === 'tag') {
        await updateJson(TAGS, {}, (t) => { const a = p.addr.toLowerCase(); t[a] = t[a] || { tags: [] }; if (!t[a].tags.includes(p.tag)) t[a].tags.push(p.tag); t[a].note = p.note || t[a].note; t[a].by = p.uid; t[a].ts = Date.now(); }, `tags: ${p.tag} ${p.addr.slice(0, 8)} (approved proposal)`);
      }
      if (p.status === 'approved' && p.kind === 'identity') {
        await updateJson(TAGS, {}, (t) => { const a = p.addr.toLowerCase(); t[a] = t[a] || { tags: [] }; t[a].identity = { x: p.x || null, name: p.name || null, evidence: p.evidence || null, by: p.uid, ts: Date.now() }; }, `tags: identity ${p.addr.slice(0, 8)} (approved proposal)`);
      }
      return json({ ok: true, proposal: p });
    }
    return json({ error: 'unknown op' }, 400);
  } catch (e) { return json({ error: String(e.message || e).slice(0, 200) }, 400); }
};
export const config = { path: '/api/admin' };
