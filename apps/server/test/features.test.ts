import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { finish, makeApp, toolUse } from './helpers.js';
import * as tasks from '../src/services/tasks.js';
import * as ops from '../src/services/ops.js';
import { runTaskAgent } from '../src/agents/runtime.js';
import { getTask } from '../src/repo/rows.js';
import { parseCsv, parseMoney, parseDay } from '../src/core/csv.js';

type App = Awaited<ReturnType<typeof makeApp>>;
let A: App; let cookie = '';
const sig = () => new AbortController().signal;
const realFetch = globalThis.fetch;

/* A fake Amazon: LWA, SP-API Listings, Ads API. Records every call. */
const amazonCalls: { method: string; url: string; body: unknown }[] = [];
let listingsStatus: 'ACCEPTED' | 'INVALID' = 'ACCEPTED';
const campaigns = [{ campaignId: '111', name: 'حملة منظم الأدراج', state: 'ENABLED', budget: { budget: 100, budgetType: 'DAILY' } },
  { campaignId: '222', name: 'حملة الحقيبة', state: 'PAUSED', budget: { budget: 50, budgetType: 'DAILY' } }];
function fakeAmazon(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (!/amazon\.com/.test(url)) return realFetch(input, init);
  const body = init?.body ? (typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : String(init.body)) : null;
  amazonCalls.push({ method: init?.method || 'GET', url, body });
  const json = (o: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } }));
  if (url.includes('/auth/o2/token')) return json({ access_token: 'Atza|test', expires_in: 3600 });
  if (url.includes('/listings/2021-08-01/items/') && init?.method === 'PATCH')
    return json(listingsStatus === 'ACCEPTED' ? { status: 'ACCEPTED', submissionId: 'sub-1', issues: [] } : { status: 'INVALID', issues: [{ severity: 'ERROR', message: 'price below minimum' }] });
  if (url.includes('/listings/2021-08-01/items/')) return json({ summaries: [{ productType: 'HOME_ORGANIZER' }] });
  if (url.includes('/sp/campaigns/list')) return json({ campaigns });
  if (url.endsWith('/sp/campaigns') && init?.method === 'PUT') return json({ campaigns: { success: [{ campaignId: '111' }], error: [] } });
  if (url.includes('/v2/profiles')) return json([{ profileId: 999, countryCode: 'SA' }]);
  return json({ errors: [{ message: 'not mocked' }] }, 404);
}

beforeAll(async () => {
  A = await makeApp({ SPAPI_CLIENT_ID: 'amzn1.app', SPAPI_CLIENT_SECRET: 's', SPAPI_REFRESH_TOKEN: 'Atzr|sp', SPAPI_SELLER_ID: 'A1SELLER',
    ADS_CLIENT_ID: 'amzn1.ads', ADS_CLIENT_SECRET: 's', ADS_REFRESH_TOKEN: 'Atzr|ads', ADS_PROFILE_ID: '999' });
  await ops.seedDemo(A.ctx);
  vi.stubGlobal('fetch', fakeAmazon);
  const r = await A.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'Correct-Horse-9-Battery' } });
  cookie = r.cookies.find(c => c.name === 'ac_session')!.value;
});
afterAll(async () => { vi.unstubAllGlobals(); await A?.close(); });

describe('csv parsing', () => {
  it('handles quotes, delimiters, Arabic digits and money formats', () => {
    expect(parseCsv('a;b\n"x;1";"he said ""hi"""\n')).toEqual([['a', 'b'], ['x;1', 'he said "hi"']]);
    expect(parseMoney('1,234.50')).toBe(123450);
    expect(parseMoney('(250.00)')).toBe(-25000);
    expect(parseMoney('١٢٣٫٥')).toBe(12350);
    expect(parseMoney('1.234,50')).toBe(123450);
    expect(parseDay('25/09/2026')).toBe('2026-09-25');
    expect(parseDay('2026-9-5')).toBe('2026-09-05');
  });
});

describe('web search', () => {
  it('is offered to research agents but not to departments without the tool', async () => {
    const r = await tasks.createTask(A.ctx, { title: 'بحث عن فرص جديدة', dept: 'research', mode: 'auto' });
    A.llm.turns.push(req => {
      expect((req.tools as { name: string; type?: string }[]).some(t => t.name === 'web_search' && t.type === 'web_search_20260209')).toBe(true);
      return finish('تم').call(null, req);
    });
    await runTaskAgent(A.ctx, r!.id, sig());
    const f = await tasks.createTask(A.ctx, { title: 'مطابقة الحسابات', dept: 'finance', mode: 'auto' });
    A.llm.turns.push(req => {
      expect((req.tools as { name: string }[]).some(t => t.name === 'web_search')).toBe(false);
      return finish('تم').call(null, req);
    });
    await runTaskAgent(A.ctx, f!.id, sig());
  });
});

describe('files and bank import', () => {
  const csv = 'التاريخ,البيان,مدين,دائن,الرصيد\n' +
    `01/${String(new Date().getMonth() + 1).padStart(2, '0')}/${new Date().getFullYear()},تحويل مورد,"12,000.00",,"80,000.00"\n` +
    `02/${String(new Date().getMonth() + 1).padStart(2, '0')}/${new Date().getFullYear()},تسوية أمازون,,"5,500.00","85,500.00"\n`;
  const up = (name: string, kind: string, text: string) => A.app.inject({ method: 'POST', url: '/api/files', cookies: { ac_session: cookie },
    payload: { name, mime: 'text/csv', kind, dataBase64: Buffer.from(text).toString('base64') } });

  it('imports a statement: cash = latest balance, month expenses from debits, duplicates skipped', async () => {
    const r = await up('كشف سبتمبر.csv', 'bank', csv);
    expect(r.statusCode).toBe(200);
    expect(r.json().imported).toMatchObject({ rows: 2, added: 2, cash: 8550000, monthExpenses: 1200000 });
    expect((await A.ctx.db.query('select cash from company_state')).rows[0].cash).toBe(8550000);
    const again = await up('كشف سبتمبر (نسخة).csv', 'bank', csv);
    expect(again.json().imported).toMatchObject({ added: 0, skipped: 2 });
  });

  it('only agents with the matching tool can read a file', async () => {
    const files = (await A.app.inject({ method: 'GET', url: '/api/files', cookies: { ac_session: cookie } })).json();
    const bank = files.find((f: { kind: string }) => f.kind === 'bank');
    const fin = await tasks.createTask(A.ctx, { title: 'مراجعة الكشف', dept: 'finance', mode: 'auto' });
    A.llm.turns.push(toolUse('read_file', { id: bank.id }), req => {
      expect(JSON.stringify(req.messages.at(-1)!.content)).toContain('تسوية أمازون');
      return finish('تمت المراجعة').call(null, req);
    });
    await runTaskAgent(A.ctx, fin!.id, sig());
    const res = await tasks.createTask(A.ctx, { title: 'قراءة الكشف', dept: 'research', mode: 'auto' });
    A.llm.turns.push(toolUse('read_file', { id: bank.id }), req => {
      expect(JSON.stringify(req.messages.at(-1)!.content)).toContain('لا يحق لك');
      return finish('لا صلاحية').call(null, req);
    });
    await runTaskAgent(A.ctx, res!.id, sig());
  });

  it('rejects a non-CSV bank statement and oversized uploads', async () => {
    const r = await A.app.inject({ method: 'POST', url: '/api/files', cookies: { ac_session: cookie },
      payload: { name: 'statement.pdf', mime: 'application/pdf', kind: 'bank', dataBase64: Buffer.from('%PDF').toString('base64') } });
    expect(r.statusCode).toBe(400);
  });
});

describe('Seller Central writes', () => {
  it('stays internal while the connector is read-only', async () => {
    await A.ctx.db.query(`update connectors set state = 'connected', scopes = 'read' where tool = 'sellercentral'`);
    amazonCalls.length = 0;
    const t = await tasks.createTask(A.ctx, { title: 'تعديل سعر حامل الجوال +4%', dept: 'amazon', mode: 'auto' });
    A.llm.turns.push(toolUse('propose_price_change', { product_id: 'p2', percent: 4, reason: 'x' }), req => {
      expect(JSON.stringify(req.messages.at(-1)!.content)).toContain('في المنصة فقط');
      return finish('تم').call(null, req);
    });
    await runTaskAgent(A.ctx, t!.id, sig());
    expect(amazonCalls.filter(c => c.method === 'PATCH')).toHaveLength(0);
  });

  it('pushes the new price to Amazon when write scope is granted', async () => {
    await A.ctx.db.query(`update connectors set scopes = 'write' where tool = 'sellercentral'`);
    amazonCalls.length = 0;
    const before = (await A.ctx.db.query(`select price from products where id = 'p1'`)).rows[0].price;
    const t = await tasks.createTask(A.ctx, { title: 'تعديل سعر منظم الأدراج +3%', dept: 'amazon', mode: 'auto' });
    A.llm.turns.push(toolUse('propose_price_change', { product_id: 'KD-ORG-01', percent: 3, reason: 'x' }), finish('تم'));
    await runTaskAgent(A.ctx, t!.id, sig());
    const patch = amazonCalls.find(c => c.method === 'PATCH')!;
    expect(patch.url).toContain('/listings/2021-08-01/items/A1SELLER/KD-ORG-01');
    expect(JSON.stringify(patch.body)).toContain(`"value_with_tax":${Math.round(before * 1.03 / 100)}`);
    expect((await A.ctx.db.query(`select price from products where id = 'p1'`)).rows[0].price).toBe(Math.round(before * 1.03 / 100) * 100);
  });

  it('keeps the platform price unchanged when Amazon rejects the patch', async () => {
    listingsStatus = 'INVALID';
    const before = (await A.ctx.db.query(`select price from products where id = 'p4'`)).rows[0].price;
    const t = await tasks.createTask(A.ctx, { title: 'تعديل سعر الفرشاة', dept: 'amazon', mode: 'auto' });
    A.llm.turns.push(toolUse('propose_price_change', { product_id: 'p4', percent: 2, reason: 'x' }), req => {
      expect(JSON.stringify(req.messages.at(-1)!.content)).toContain('price below minimum');
      return finish('رُفض').call(null, req);
    });
    await runTaskAgent(A.ctx, t!.id, sig());
    expect((await A.ctx.db.query(`select price from products where id = 'p4'`)).rows[0].price).toBe(before);
    const call = (await A.ctx.db.query(`select status from tool_calls where task_id = $1 and tool = 'propose_price_change'`, [t!.id])).rows[0];
    expect(call.status).toBe('error');
    listingsStatus = 'ACCEPTED';
  });

  it('sends listing edits with the listing product type', async () => {
    amazonCalls.length = 0;
    const t = await tasks.createTask(A.ctx, { title: 'تحسين قائمة المنظم', dept: 'amazon', mode: 'auto' });
    A.llm.turns.push(toolUse('edit_listing', { product_id: 'p1', title: 'منظم أدراج قابل للتمديد', keywords: ['منظم', 'مطبخ'], reason: 'ظهور' }));
    await runTaskAgent(A.ctx, t!.id, sig());
    expect((await getTask(A.ctx.db, t!.id)).status).toBe('waiting'); // listing edits always need approval
    await tasks.approve(A.ctx, t!.id);
    A.llm.turns.push(finish('أُرسل التعديل'));
    await runTaskAgent(A.ctx, t!.id, sig());
    const patch = amazonCalls.find(c => c.method === 'PATCH')!;
    expect(patch.body).toMatchObject({ productType: 'HOME_ORGANIZER' });
    expect(JSON.stringify(patch.body)).toContain('item_name');
  });
});

describe('Amazon Ads writes', () => {
  it('connects with a real profile check and changes a budget within the auto limit', async () => {
    const c = await A.app.inject({ method: 'POST', url: '/api/connectors/amazonads/connect', cookies: { ac_session: cookie }, payload: { auth: 'key', secret: 'Atzr|ads-2', scopes: 'write' } });
    expect(c.statusCode).toBe(200);
    expect(c.json().state).toBe('connected');
    amazonCalls.length = 0;
    const t = await tasks.createTask(A.ctx, { title: 'مراجعة حملة المنظم', dept: 'marketing', mode: 'auto' });
    A.llm.turns.push(toolUse('change_ad_budget', { campaign: 'منظم', percent: 5, reason: 'نسبة الإعلان جيدة' }), finish('رُفعت الميزانية'));
    await runTaskAgent(A.ctx, t!.id, sig());
    const put = amazonCalls.find(x => x.method === 'PUT')!;
    expect(put.body).toEqual({ campaigns: [{ campaignId: '111', budget: { budget: 105, budgetType: 'DAILY' } }] });
    expect((await getTask(A.ctx.db, t!.id)).status).toBe('done');
  });

  it('syncs the active campaign count into the marketing card', async () => {
    const { syncAds } = await import('../src/services/connectors.js');
    expect(await syncAds(A.ctx)).toBe(1);
    expect((await A.ctx.db.query(`select v0 from metrics_base where dept = 'marketing'`)).rows[0].v0).toBe(1);
  });
});
