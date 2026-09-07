// POST /api/refresh — kicks the GitHub Actions data pipeline. Token stays server-side (Netlify env).
let lastDispatch = 0; // per-instance guard; the client adds its own 5-min cooldown
export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const token = process.env.GH_DISPATCH_TOKEN;
  if (!token) return json({ ok: false, error: 'GH_DISPATCH_TOKEN not configured in Netlify env' }, 500);
  if (Date.now() - lastDispatch < 60e3) return json({ ok: true, note: 'already dispatched moments ago' }, 200);
  const r = await fetch('https://api.github.com/repos/beeonchain/basefish/actions/workflows/refresh.yml/dispatches', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'basefish-refresh', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ ref: 'main' }),
  });
  if (r.status === 204) { lastDispatch = Date.now(); return json({ ok: true }, 200); }
  return json({ ok: false, error: 'github said ' + r.status + ' ' + (await r.text()).slice(0, 140) }, 502);
};
const json = (o, s) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
export const config = { path: '/api/refresh' };
