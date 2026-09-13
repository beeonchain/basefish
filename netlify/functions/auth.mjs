// GET /api/auth — public config for the browser: Privy app id + bot handle. Sign-in itself happens with Privy
// (email code / Google / X / wallet) in the browser; the server only verifies Privy access tokens (lib/store.mjs).
import { json, PRIVY_APP_ID } from '../lib/store.mjs';
export default async (req) => {
  if (req.method !== 'GET') return json({ error: 'method' }, 405);
  return json({ privy: PRIVY_APP_ID, bot: process.env.TG_BOT_HANDLE || 'aquariumtest_bot' });
};
export const config = { path: '/api/auth' };
