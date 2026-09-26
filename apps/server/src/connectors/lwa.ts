/* Login with Amazon: refresh token → short-lived access token (shared by SP-API and the Amazon Ads API). */
const LWA = 'https://api.amazon.com/auth/o2/token';
const cache = new Map<string, { tok: string; exp: number }>();

export async function lwaAccessToken(clientId: string, clientSecret: string, refresh: string, label = 'أمازون'): Promise<string> {
  const key = `${clientId}:${refresh.slice(-12)}`;
  const c = cache.get(key);
  if (c && c.exp > Date.now() + 60_000) return c.tok;
  const r = await fetch(LWA, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(20_000)
  });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!r.ok || !j.access_token) throw new Error(`تفويض ${label}: ${j.error_description || j.error || r.status}`);
  cache.set(key, { tok: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
  return j.access_token;
}

/** Retries 429/5xx with exponential backoff (spec §20: 3 attempts per connector call). */
export async function withBackoff(fn: () => Promise<Response>, attempts = 3): Promise<Response> {
  for (let i = 0; ; i++) {
    const r = await fn();
    if ((r.status === 429 || r.status >= 500) && i < attempts - 1) {
      const ra = Number(r.headers.get('retry-after'));
      await new Promise(res => setTimeout(res, Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 20_000) : 1000 * 2 ** (i + 1)));
      continue;
    }
    return r;
  }
}
