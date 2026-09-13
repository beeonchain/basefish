// GET /api/fetchstatus?sym=SYM&since=<ISO>  → progress of a single-token fetch run ("fetch SYM" workflow run)
// { state: 'queued' | 'running' | 'done' | 'failed' | 'unknown', started, updated, elapsed, step, data: bool }
import { json } from '../lib/store.mjs';

const REPO = 'beeonchain/basefish';
const gh = (t) => ({ Authorization: 'Bearer ' + t, Accept: 'application/vnd.github+json', 'User-Agent': 'whalarium-status', 'X-GitHub-Api-Version': '2022-11-28' });

export default async (req) => {
  const q = new URL(req.url).searchParams;
  const sym = String(q.get('sym') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  const since = q.get('since') || new Date(Date.now() - 36e5).toISOString();
  if (!sym) return json({ error: 'sym' }, 400);
  const out = { sym, state: 'unknown', started: null, updated: null, elapsed: 0, data: false };
  // is the token's data file already there (written after the request)?
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/data/${sym.toLowerCase()}.json?t=${Date.now()}`, { method: 'GET' });
    if (r.ok) { const d = await r.json(); if (d && d.generated_at && d.generated_at >= since) { out.data = true; out.state = 'done'; out.generated = d.generated_at; return json(out); } }
  } catch {}
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/actions/runs?event=workflow_dispatch&created=%3E%3D${encodeURIComponent(since.slice(0, 19))}&per_page=30`, { headers: gh(process.env.GH_DISPATCH_TOKEN) });
    if (r.ok) {
      const j = await r.json();
      const runs = (j.workflow_runs || []).filter((x) => (x.name === `fetch ${sym}` || x.display_title === `fetch ${sym}`)).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const run = runs[0];
      if (run) {
        out.started = run.run_started_at || run.created_at; out.updated = run.updated_at; out.runId = run.id;
        out.elapsed = Math.max(0, Math.round((Date.now() - new Date(run.run_started_at || run.created_at)) / 1000));
        if (run.status === 'completed') out.state = run.conclusion === 'success' ? 'finishing' : 'failed'; // success but data not yet visible on the CDN → finishing
        else if (run.status === 'in_progress') out.state = 'running';
        else out.state = 'queued';
      } else out.state = 'queued';
    }
  } catch {}
  return json(out);
};
export const config = { path: '/api/fetchstatus' };
