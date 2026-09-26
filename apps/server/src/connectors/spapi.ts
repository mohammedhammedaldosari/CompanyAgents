/* Amazon Selling Partner API — Saudi marketplace (EU region endpoint).
   Read: today's orders, FBA inventory. Write (only after the permission gate): price and listing attributes via Listings Items API. */
import { lwaAccessToken, withBackoff } from './lwa.js';

export interface SpApiConfig { clientId: string; clientSecret: string; endpoint: string; marketplaceId: string; sellerId?: string; language?: string }

export const spConfigured = (c: SpApiConfig, refresh: string | null): boolean => !!(c.clientId && c.clientSecret && refresh);

async function call<T>(c: SpApiConfig, refresh: string, method: string, p: string, body?: unknown): Promise<T> {
  const tok = await lwaAccessToken(c.clientId, c.clientSecret, refresh, 'أمازون');
  const r = await withBackoff(() => fetch(c.endpoint + p, {
    method,
    headers: { 'x-amz-access-token': tok, accept: 'application/json', 'user-agent': 'agents-company/0.1 (Language=TypeScript)', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000)
  }));
  const j = (await r.json().catch(() => ({}))) as T & { errors?: { message?: string }[] };
  if (!r.ok) throw new Error(`مركز البائع ${r.status}: ${j.errors?.[0]?.message ?? ''}`.trim());
  return j;
}

export async function spTest(c: SpApiConfig, refresh: string): Promise<{ ok: boolean; latency: number; note?: string; error?: string }> {
  const t0 = Date.now();
  try {
    await call(c, refresh, 'GET', '/sellers/v1/marketplaceParticipations');
    const latency = Date.now() - t0;
    return { ok: true, latency, note: `نجح الاتصال بمركز البائع · ${latency} مللي ثانية${c.sellerId ? '' : ' · للكتابة اضبط SPAPI_SELLER_ID'}` };
  } catch (e) { return { ok: false, latency: Date.now() - t0, error: (e as Error).message }; }
}

interface OrdersPayload { payload?: { Orders?: { OrderStatus: string; OrderTotal?: { Amount?: string } }[]; NextToken?: string } }
interface InventoryPayload { payload?: { inventorySummaries?: { sellerSku: string; asin: string; totalQuantity?: number }[] } }

export async function spSyncToday(c: SpApiConfig, refresh: string, dayStartMs: number): Promise<{ salesToday: number; ordersToday: number; inventory: { sku: string; asin: string; stock: number }[] }> {
  let next: string | undefined, sales = 0, orders = 0, pages = 0;
  do {
    const q = new URLSearchParams({ MarketplaceIds: c.marketplaceId });
    if (next) q.set('NextToken', next); else q.set('CreatedAfter', new Date(dayStartMs).toISOString());
    const P = (await call<OrdersPayload>(c, refresh, 'GET', '/orders/v0/orders?' + q)).payload || {};
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
    const j = await call<InventoryPayload>(c, refresh, 'GET', '/fba/inventory/v1/summaries?' + q);
    inventory = (j.payload?.inventorySummaries || []).map(x => ({ sku: x.sellerSku, asin: x.asin, stock: x.totalQuantity || 0 }));
  } catch { /* inventory is optional (role may be missing) */ }
  return { salesToday: sales, ordersToday: orders, inventory };
}

/* ---------- writes (Listings Items API 2021-08-01) ---------- */

interface PatchResult { status?: 'ACCEPTED' | 'INVALID'; submissionId?: string; issues?: { message: string; severity: string }[] }

async function patchListing(c: SpApiConfig, refresh: string, sku: string, productType: string, patches: unknown[]): Promise<PatchResult> {
  if (!c.sellerId) throw new Error('SPAPI_SELLER_ID غير مضبوط؛ لا يمكن الكتابة في مركز البائع');
  const q = new URLSearchParams({ marketplaceIds: c.marketplaceId, issueLocale: 'ar_AE' });
  const r = await call<PatchResult>(c, refresh, 'PATCH', `/listings/2021-08-01/items/${encodeURIComponent(c.sellerId)}/${encodeURIComponent(sku)}?${q}`, { productType, patches });
  const errs = (r.issues || []).filter(i => i.severity === 'ERROR');
  if (r.status !== 'ACCEPTED' || errs.length) throw new Error(`رفض مركز البائع التعديل: ${errs.map(i => i.message).join('؛ ') || r.status}`);
  return r;
}

async function productTypeOf(c: SpApiConfig, refresh: string, sku: string): Promise<string> {
  const q = new URLSearchParams({ marketplaceIds: c.marketplaceId, includedData: 'summaries' });
  const r = await call<{ summaries?: { productType?: string }[] }>(c, refresh, 'GET', `/listings/2021-08-01/items/${encodeURIComponent(c.sellerId!)}/${encodeURIComponent(sku)}?${q}`);
  return r.summaries?.[0]?.productType || 'PRODUCT';
}

/** Our price (tax inclusive), in halalas. Offer-only patches accept the generic PRODUCT type. */
export async function spSetPrice(c: SpApiConfig, refresh: string, sku: string, priceHalalas: number): Promise<string> {
  const r = await patchListing(c, refresh, sku, 'PRODUCT', [{
    op: 'replace', path: '/attributes/purchasable_offer',
    value: [{ marketplace_id: c.marketplaceId, currency: 'SAR', our_price: [{ schedule: [{ value_with_tax: Math.round(priceHalalas) / 100 }] }] }]
  }]);
  return r.submissionId || 'ACCEPTED';
}

export async function spEditListing(c: SpApiConfig, refresh: string, sku: string, e: { title?: string; bullets?: string[]; keywords?: string[] }): Promise<string> {
  const lang = c.language || 'ar_AE'; const mp = c.marketplaceId;
  const v = (value: string) => ({ value, language_tag: lang, marketplace_id: mp });
  const patches: unknown[] = [];
  if (e.title) patches.push({ op: 'replace', path: '/attributes/item_name', value: [v(e.title)] });
  if (e.bullets?.length) patches.push({ op: 'replace', path: '/attributes/bullet_point', value: e.bullets.slice(0, 5).map(v) });
  if (e.keywords?.length) patches.push({ op: 'replace', path: '/attributes/generic_keyword', value: [v(e.keywords.join(' '))] });
  if (!patches.length) throw new Error('لا توجد تعديلات للقائمة');
  const r = await patchListing(c, refresh, sku, await productTypeOf(c, refresh, sku), patches);
  return r.submissionId || 'ACCEPTED';
}
