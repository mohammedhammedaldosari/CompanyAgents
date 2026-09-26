/* Amazon Selling Partner API — Saudi marketplace (EU region endpoint). Read-only sync of today's orders and FBA inventory.
   Auth: Login with Amazon refresh token → short-lived access token sent as x-amz-access-token. */

export interface SpApiConfig { clientId: string; clientSecret: string; endpoint: string; marketplaceId: string }

const LWA = 'https://api.amazon.com/auth/o2/token';
let cache: { tok: string; exp: number; rt: string } | null = null;

export const spConfigured = (c: SpApiConfig, refresh: string | null): boolean => !!(c.clientId && c.clientSecret && refresh);

async function accessToken(c: SpApiConfig, refresh: string): Promise<string> {
  if (cache && cache.rt === refresh && cache.exp > Date.now() + 60_000) return cache.tok;
  const r = await fetch(LWA, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: c.clientId, client_secret: c.clientSecret }),
    signal: AbortSignal.timeout(20_000)
  });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!r.ok || !j.access_token) throw new Error(`تفويض أمازون: ${j.error_description || j.error || r.status}`);
  cache = { tok: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000, rt: refresh };
  return cache.tok;
}

async function get<T>(c: SpApiConfig, refresh: string, p: string, attempt = 0): Promise<T> {
  const tok = await accessToken(c, refresh);
  const r = await fetch(c.endpoint + p, {
    headers: { 'x-amz-access-token': tok, accept: 'application/json', 'user-agent': 'agents-company/0.1 (Language=TypeScript)' },
    signal: AbortSignal.timeout(30_000)
  });
  if (r.status === 429 && attempt < 3) { await new Promise(res => setTimeout(res, 2000 * 2 ** attempt)); return get(c, refresh, p, attempt + 1); }
  const j = (await r.json().catch(() => ({}))) as T & { errors?: { message?: string }[] };
  if (!r.ok) throw new Error(`مركز البائع ${r.status}: ${j.errors?.[0]?.message ?? ''}`.trim());
  return j;
}

export async function spTest(c: SpApiConfig, refresh: string): Promise<{ ok: boolean; latency: number; note?: string; error?: string }> {
  const t0 = Date.now();
  try {
    await get(c, refresh, '/sellers/v1/marketplaceParticipations');
    const latency = Date.now() - t0;
    return { ok: true, latency, note: `نجح الاتصال بمركز البائع · ${latency} مللي ثانية` };
  } catch (e) { return { ok: false, latency: Date.now() - t0, error: (e as Error).message }; }
}

interface OrdersPayload { payload?: { Orders?: { OrderStatus: string; OrderTotal?: { Amount?: string } }[]; NextToken?: string } }
interface InventoryPayload { payload?: { inventorySummaries?: { sellerSku: string; asin: string; totalQuantity?: number }[] } }

export async function spSyncToday(c: SpApiConfig, refresh: string, dayStartMs: number): Promise<{ salesToday: number; ordersToday: number; inventory: { sku: string; asin: string; stock: number }[] }> {
  let next: string | undefined, sales = 0, orders = 0, pages = 0;
  do {
    const q = new URLSearchParams({ MarketplaceIds: c.marketplaceId });
    if (next) q.set('NextToken', next); else q.set('CreatedAfter', new Date(dayStartMs).toISOString());
    const P = (await get<OrdersPayload>(c, refresh, '/orders/v0/orders?' + q)).payload || {};
    for (const o of P.Orders || []) {
      if (o.OrderStatus === 'Canceled') continue;
      orders++;
      if (o.OrderTotal?.Amount) sales += Math.round(parseFloat(o.OrderTotal.Amount) * 100);
    }
    next = P.NextToken; pages++;
    if (next) await new Promise(r => setTimeout(r, 2200)); // getOrders: 0.0167 req/s burst 20
  } while (next && pages < 20);
  let inventory: { sku: string; asin: string; stock: number }[] = [];
  try {
    const q = new URLSearchParams({ details: 'false', granularityType: 'Marketplace', granularityId: c.marketplaceId, marketplaceIds: c.marketplaceId });
    const j = await get<InventoryPayload>(c, refresh, '/fba/inventory/v1/summaries?' + q);
    inventory = (j.payload?.inventorySummaries || []).map(x => ({ sku: x.sellerSku, asin: x.asin, stock: x.totalQuantity || 0 }));
  } catch { /* inventory is optional (role may be missing) */ }
  return { salesToday: sales, ordersToday: orders, inventory };
}
