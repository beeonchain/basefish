// Scheduled: once a day 04:47 UTC, kick the full daily refresh (discovery + every token) on GitHub Actions.
// GitHub's own cron was skipping slots (only 4 of 9 fired on Sep 12–13); Netlify's scheduler is dependable.
export default async () => {
  const token = process.env.GH_DISPATCH_TOKEN; if (!token) return new Response('no token', { status: 500 });
  const r = await fetch('https://api.github.com/repos/beeonchain/basefish/actions/workflows/refresh.yml/dispatches', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'whalarium-cron', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ ref: 'main', inputs: { tier: 'all' } }),
  });
  console.log('cron_all dispatch', r.status);
  return new Response(String(r.status));
};
export const config = { schedule: '47 4 * * *' };
