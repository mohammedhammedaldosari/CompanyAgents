/* Amazon Ads API (EU region) — Sponsored Products v3: list campaigns, change daily budgets (writes only after the gate). */
import { lwaAccessToken, withBackoff } from './lwa.js';

export interface AdsConfig { clientId: string; clientSecret: string; endpoint: string; profileId: string }
export interface AdCampaign { campaignId: string; name: string; state: string; budget: number /* SAR */ }

export const adsConfigured = (c: AdsConfig, refresh: string | null): boolean => !!(c.clientId && c.clientSecret && c.profileId && refresh);
const SP = 'application/vnd.spCampaign.v3+json';

async function call<T>(c: AdsConfig, refresh: string, method: string, p: string, body?: unknown, media = 'application/json', scoped = true): Promise<T> {
  const tok = await lwaAccessToken(c.clientId, c.clientSecret, refresh, 'إعلانات أمازون');
  const r = await withBackoff(() => fetch(c.endpoint + p, {
    method,
    headers: { authorization: `Bearer ${tok}`, 'amazon-advertising-api-clientid': c.clientId, ...(scoped ? { 'amazon-advertising-api-scope': c.profileId } : {}),
      accept: media, ...(body ? { 'content-type': media } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000)
  }));
  const j = (await r.json().catch(() => ({}))) as T & { message?: string; details?: string; detail?: string };
  if (!r.ok) throw new Error(`إعلانات أمازون ${r.status}: ${j.message || j.detail || j.details || ''}`.trim());
  return j;
}

export async function adsTest(c: AdsConfig, refresh: string): Promise<{ ok: boolean; latency: number; note?: string; error?: string }> {
  const t0 = Date.now();
  try {
    const profiles = await call<{ profileId: number; countryCode: string }[]>(c, refresh, 'GET', '/v2/profiles', undefined, 'application/json', false);
    const mine = profiles.find(p => String(p.profileId) === String(c.profileId));
    if (!mine) return { ok: false, latency: Date.now() - t0, error: `الملف الإعلاني ${c.profileId} غير موجود في هذا الحساب` };
    return { ok: true, latency: Date.now() - t0, note: `نجح الاتصال بإعلانات أمازون (${mine.countryCode}) · ${Date.now() - t0} مللي ثانية` };
  } catch (e) { return { ok: false, latency: Date.now() - t0, error: (e as Error).message }; }
}

export async function adsCampaigns(c: AdsConfig, refresh: string): Promise<AdCampaign[]> {
  const out: AdCampaign[] = []; let nextToken: string | undefined;
  do {
    const r = await call<{ campaigns?: { campaignId: string; name: string; state: string; budget?: { budget: number } }[]; nextToken?: string }>(
      c, refresh, 'POST', '/sp/campaigns/list', { stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 100, ...(nextToken ? { nextToken } : {}) }, SP);
    for (const x of r.campaigns || []) out.push({ campaignId: String(x.campaignId), name: x.name, state: x.state, budget: x.budget?.budget ?? 0 });
    nextToken = r.nextToken;
  } while (nextToken && out.length < 1000);
  return out;
}

/** Finds a campaign by exact id or name (then unique partial name) and scales its daily budget by `percent`. */
export async function adsChangeBudget(c: AdsConfig, refresh: string, campaign: string, percent: number): Promise<{ name: string; old: number; next: number }> {
  const all = await adsCampaigns(c, refresh);
  const q = campaign.trim();
  let hit = all.find(x => x.campaignId === q || x.name === q);
  if (!hit) { const part = all.filter(x => x.name.includes(q)); if (part.length === 1) hit = part[0]; else if (part.length > 1) throw new Error(`اسم الحملة «${q}» يطابق ${part.length} حملات؛ حدّد الاسم كاملًا`); }
  if (!hit) throw new Error(`لم أجد حملة باسم «${q}»`);
  const next = Math.max(1, Math.round(hit.budget * (1 + percent / 100) * 100) / 100);
  const r = await call<{ campaigns?: { error?: { errors?: { errorValue?: { message?: string } }[] }[] } }>(
    c, refresh, 'PUT', '/sp/campaigns', { campaigns: [{ campaignId: hit.campaignId, budget: { budget: next, budgetType: 'DAILY' } }] }, SP);
  const err = r.campaigns?.error?.[0]?.errors?.[0]?.errorValue?.message;
  if (err) throw new Error(`رفضت إعلانات أمازون التعديل: ${err}`);
  return { name: hit.name, old: hit.budget, next };
}

/* ---------- daily spend (Reporting API v3, asynchronous) ---------- */

const REPORT = 'application/vnd.createasyncreportrequest.v3+json';

/** Requests today's Sponsored Products spend; a duplicate request returns the existing report id. */
export async function adsRequestSpend(c: AdsConfig, refresh: string, day: string): Promise<string> {
  try {
    const r = await call<{ reportId: string }>(c, refresh, 'POST', '/reporting/reports', {
      name: `agents-company spend ${day}`, startDate: day, endDate: day,
      configuration: { adProduct: 'SPONSORED_PRODUCTS', groupBy: ['campaign'], columns: ['campaignId', 'cost'], reportTypeId: 'spCampaigns', timeUnit: 'SUMMARY', format: 'GZIP_JSON' }
    }, REPORT);
    return r.reportId;
  } catch (e) {
    const m = /duplicate of\s*:?\s*([\w-]+)/i.exec((e as Error).message);
    if (m) return m[1]!;
    throw e;
  }
}

export async function adsReportStatus(c: AdsConfig, refresh: string, id: string): Promise<{ status: string; url?: string; failureReason?: string }> {
  return call(c, refresh, 'GET', `/reporting/reports/${encodeURIComponent(id)}`, undefined, 'application/json');
}

/** Downloads a completed report (pre-signed URL, no auth headers) and sums the cost, in halalas. */
export async function adsReportCost(url: string): Promise<number> {
  const { gunzipSync } = await import('node:zlib');
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`تعذّر تنزيل تقرير الإعلانات (${r.status})`);
  const rows = JSON.parse(gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8')) as { cost?: number }[];
  return Math.round(rows.reduce((s, x) => s + (Number(x.cost) || 0), 0) * 100);
}
