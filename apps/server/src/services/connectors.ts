/* Connectors (spec §19, admin "الموصلات"). A tool is "connected" only after a real test succeeds.
   Any tool can be bound to an MCP server URL; Seller Central also has a native SP-API client. Secrets go to the vault. */
import { H, type ConnectorStatus, type ToolDef } from '@agents/domain';
import type { Ctx } from '../context.js';
import type { Queryable, Tx } from '../db/db.js';
import { bad, notFound } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { toConnector } from '../repo/rows.js';
import { testMcp, type McpAuth } from '../connectors/mcp.js';
import { VaultOAuthProvider, clearOAuth, startOAuth } from '../connectors/oauth.js';

/** Credentials for an MCP connector: OAuth provider when authorised that way, else the stored key. */
export async function mcpAuthFor(ctx: Ctx, tool: string, auth: string): Promise<McpAuth> {
  return auth === 'oauth' ? new VaultOAuthProvider(ctx, tool) : ctx.vault.get(ctx.db, secretId(tool));
}
import { spConfigured, spSyncToday, spTest, type SpApiConfig } from '../connectors/spapi.js';
import { adsCampaigns, adsConfigured, adsTest, type AdsConfig } from '../connectors/amazonads.js';
import { audit, emitKpi, setKpiDay } from './common.js';

type Row = { tool: string; state: string; log: ConnectorStatus['log'] };

/** Initial state per method: MCP/API need credentials, import/manual work through files and data entry, browser is phase 3. */
function initialState(t: ToolDef): ConnectorStatus['state'] {
  if (t.m === 'import' || t.m === 'manual') return 'manual';
  if (t.m === 'browser') return 'unavailable';
  return 'needs_auth';
}

export async function ensureConnectorRows(ctx: Ctx, tx: Queryable): Promise<void> {
  for (const t of ctx.org().tools) {
    await tx.query(`insert into connectors (tool, state, scopes, auth) values ($1,$2,$3,$4) on conflict (tool) do nothing`,
      [t.id, initialState(t), 'read', t.m === 'mcp' ? 'oauth' : t.m === 'api' ? 'key' : 'none']);
  }
  // web search is provided by the model API itself: available whenever a model key is configured
  if (ctx.env.ANTHROPIC_API_KEY) {
    const r = await tx.query(`update connectors set state = 'connected', auth = 'none', last_error = '' where tool = 'websearch' and state = 'needs_auth' returning tool`);
    if (r.rowCount) await tx.query(`update connectors set log = $1 where tool = 'websearch'`,
      [JSON.stringify([{ at: Date.now(), level: 'ok', text: 'البحث في الويب مزوَّد عبر واجهة Claude (أداة خادم)؛ لا يحتاج مفتاحًا منفصلًا' }])]);
  }
}

export async function connectorMap(ctx: Ctx, db: Queryable): Promise<Record<string, ConnectorStatus>> {
  const secrets = new Set((await db.query<{ id: string }>('select id from secrets')).rows.map(r => r.id));
  const rows = (await db.query('select * from connectors')).rows;
  const ids = new Set(ctx.org().tools.map(t => t.id));
  return Object.fromEntries(rows.filter(r => ids.has(r.tool)).map(r => [r.tool, toConnector(r, secrets.has(`conn:${r.tool}`))]));
}

export async function connectorsList(ctx: Ctx, db: Queryable) {
  const m = await connectorMap(ctx, db);
  return ctx.org().tools.map(t => ({ tool: t.id, method: t.m, phase: t.phase, ...(m[t.id] || {}) }));
}

async function log(tx: Tx, id: string, level: ConnectorStatus['log'][number]['level'], text: string): Promise<void> {
  const r = await tx.query<Row>('select log from connectors where tool = $1 for update', [id]);
  const l = [{ at: Date.now(), level, text }, ...(r.rows[0]?.log || [])].slice(0, 12);
  await tx.query('update connectors set log = $2 where tool = $1', [id, JSON.stringify(l)]);
}

async function emitConnectors(ctx: Ctx, tx: Tx): Promise<void> { tx.emit({ type: 'connectors', connectors: await connectorMap(ctx, tx) }); }

export const secretId = (tool: string) => `conn:${tool}`;

export function spConfig(ctx: Ctx): SpApiConfig {
  return { clientId: ctx.env.SPAPI_CLIENT_ID, clientSecret: ctx.env.SPAPI_CLIENT_SECRET, endpoint: ctx.env.SPAPI_ENDPOINT, marketplaceId: ctx.env.SPAPI_MARKETPLACE_ID,
    sellerId: ctx.env.SPAPI_SELLER_ID, language: ctx.env.SPAPI_LANGUAGE };
}
export function adsConfig(ctx: Ctx): AdsConfig {
  return { clientId: ctx.env.ADS_CLIENT_ID, clientSecret: ctx.env.ADS_CLIENT_SECRET, endpoint: ctx.env.ADS_ENDPOINT, profileId: ctx.env.ADS_PROFILE_ID };
}
export async function adsRefresh(ctx: Ctx, db: Queryable): Promise<string | null> {
  return (await ctx.vault.get(db, secretId('amazonads'))) || ctx.env.ADS_REFRESH_TOKEN || null;
}

/** A native connector may act only when it is connected AND the owner granted it write scope. */
export async function canWrite(ctx: Ctx, tool: 'sellercentral' | 'amazonads'): Promise<{ refresh: string } | null> {
  const r = (await ctx.db.query('select state, scopes, url from connectors where tool = $1', [tool])).rows[0];
  if (!r || r.state !== 'connected' || r.scopes !== 'write' || r.url) return null;
  if (tool === 'sellercentral') { const rt = await spRefresh(ctx, ctx.db); return rt && spConfigured(spConfig(ctx), rt) && ctx.env.SPAPI_SELLER_ID ? { refresh: rt } : null; }
  const rt = await adsRefresh(ctx, ctx.db); return rt && adsConfigured(adsConfig(ctx), rt) ? { refresh: rt } : null;
}
export async function canRead(ctx: Ctx, tool: 'amazonads'): Promise<{ refresh: string } | null> {
  const r = (await ctx.db.query('select state, url from connectors where tool = $1', [tool])).rows[0];
  if (!r || r.state !== 'connected' || r.url) return null;
  const rt = await adsRefresh(ctx, ctx.db); return rt && adsConfigured(adsConfig(ctx), rt) ? { refresh: rt } : null;
}

/** Active campaigns → «حملات نشطة» card metric. */
export async function syncAds(ctx: Ctx): Promise<number> {
  const a = await canRead(ctx, 'amazonads'); if (!a) return 0;
  const all = await adsCampaigns(adsConfig(ctx), a.refresh);
  const active = all.filter(x => x.state === 'ENABLED').length;
  await ctx.db.query(`insert into metrics_base (dept, v0) values ('marketing', $1) on conflict (dept) do update set v0 = excluded.v0`, [active]);
  ctx.refreshMetrics();
  return active;
}
export async function spRefresh(ctx: Ctx, db: Queryable): Promise<string | null> {
  return (await ctx.vault.get(db, secretId('sellercentral'))) || ctx.env.SPAPI_REFRESH_TOKEN || null;
}

/** Real connectivity test. Returns null when no real client exists for this tool. */
export async function realTest(ctx: Ctx, id: string): Promise<{ ok: boolean; latency: number; note?: string; error?: string } | null> {
  const row = (await ctx.db.query('select url, auth from connectors where tool = $1', [id])).rows[0];
  if (id === 'sellercentral' && !row?.url) {
    const rt = await spRefresh(ctx, ctx.db);
    if (!spConfigured(spConfig(ctx), rt)) return { ok: false, latency: 0, error: 'اضبط SPAPI_CLIENT_ID وSPAPI_CLIENT_SECRET في الخادم، والصق رمز التحديث كمفتاح' };
    return spTest(spConfig(ctx), rt!);
  }
  if (id === 'amazonads' && !row?.url) {
    const rt = await adsRefresh(ctx, ctx.db);
    if (!adsConfigured(adsConfig(ctx), rt)) return { ok: false, latency: 0, error: 'اضبط ADS_CLIENT_ID وADS_CLIENT_SECRET وADS_PROFILE_ID في الخادم، والصق رمز التحديث كمفتاح' };
    return adsTest(adsConfig(ctx), rt!);
  }
  if (row?.url) return testMcp(row.url, await mcpAuthFor(ctx, id, row.auth));
  return null;
}

export async function report(ctx: Ctx, id: string, r: { ok: boolean; latency: number; note?: string; error?: string }): Promise<void> {
  await ctx.db.tx(async tx => {
    if (r.ok) {
      await tx.query(`update connectors set state = 'connected', last_error = '', latency = $2, last_sync = now() where tool = $1`, [id, r.latency]);
      await log(tx, id, 'ok', r.note || `نجح الاختبار · ${r.latency} مللي ثانية`);
    } else {
      await tx.query(`update connectors set last_error = $2, latency = $3, state = case when state in ('connected','connecting') then 'needs_auth' else state end where tool = $1`,
        [id, r.error || 'فشل الاتصال', r.latency || null]);
      await log(tx, id, 'error', `فشل: ${r.error || 'فشل الاتصال'}`);
    }
    await emitConnectors(ctx, tx);
  });
}

export interface ConnectInput { url?: string; auth?: 'oauth' | 'key' | 'none'; secret?: string; scopes?: 'read' | 'write' }

export async function connectorAction(ctx: Ctx, id: string, action: string, p: ConnectInput = {}): Promise<ConnectorStatus & { latency?: number | null; authorizeUrl?: string }> {
  const t = ctx.org().tool(id);
  if (!t) throw notFound('موصل غير معروف');
  const name = t.name;
  if (action === 'connect') {
    if (p.url && !/^https:\/\//.test(p.url) && !(ctx.env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(p.url))) throw bad('رابط الخادم يجب أن يبدأ بـ https://');
    if (p.auth === 'oauth') {
      const cur = (await ctx.db.query('select url from connectors where tool = $1', [id])).rows[0];
      const url = p.url || cur?.url;
      if (!url) throw bad('التفويض عبر OAuth متاح لموصلات MCP: أدخل رابط خادم MCP');
      await ctx.db.tx(async tx => {
        await tx.query(`update connectors set state = 'connecting', url = $2, auth = 'oauth', last4 = '', scopes = coalesce($3, scopes) where tool = $1`, [id, url, p.scopes || null]);
        await log(tx, id, 'info', 'بدأ التفويض عبر OAuth');
        await audit(tx, 'الموصلات', 'ربط عبر OAuth', name);
        await emitConnectors(ctx, tx);
      });
      let authorizeUrl: string | null;
      try { authorizeUrl = await startOAuth(ctx, id, url); }
      catch (e) {
        await report(ctx, id, { ok: false, latency: 0, error: `تعذّر بدء التفويض: ${(e as Error).message}` });
        throw bad(`تعذّر بدء التفويض: ${(e as Error).message}`);
      }
      if (authorizeUrl) return { ...(await connectorMap(ctx, ctx.db))[id]!, authorizeUrl } as ConnectorStatus & { authorizeUrl: string };
      const r = await realTest(ctx, id); if (r) await report(ctx, id, r);
      return (await connectorMap(ctx, ctx.db))[id]!;
    }
    await ctx.db.tx(async tx => {
      const cur = (await tx.query('select url from connectors where tool = $1', [id])).rows[0];
      if (t.m === 'mcp' && !p.url && !cur?.url) throw bad('أدخل رابط خادم MCP');
      if (p.secret) await ctx.vault.set(tx, secretId(id), String(p.secret));
      await tx.query(`update connectors set state = 'connecting', url = coalesce(nullif($2,''), url), auth = coalesce($3, auth),
        last4 = case when $4::text is null then last4 else right($4, 4) end, scopes = coalesce($5, scopes) where tool = $1`,
      [id, p.url || '', p.auth || null, p.secret ? String(p.secret) : null, p.scopes || null]);
      await log(tx, id, 'info', 'بدأ الربط');
      await audit(tx, 'الموصلات', 'ربط', name);
      await emitConnectors(ctx, tx);
    });
    const r = await realTest(ctx, id);
    if (r) await report(ctx, id, r);
    else await ctx.db.tx(async tx => {
      await tx.query(`update connectors set state = 'needs_auth' where tool = $1`, [id]);
      await log(tx, id, 'warn', 'حُفظ المفتاح، لكن لا يوجد عميل مدمج لهذه الخدمة بعد؛ اربطها عبر خادم MCP لتعمل مع الوكلاء');
      await emitConnectors(ctx, tx);
    });
  } else if (action === 'test') {
    const r = await realTest(ctx, id);
    if (!r) throw bad('الاختبار الحقيقي متاح لموصلات MCP ومركز البائع؛ اربط هذه الأداة عبر خادم MCP');
    await report(ctx, id, r);
  } else if (action === 'sync') {
    if (id === 'sellercentral') await syncSellerCentral(ctx);
    else if (id === 'amazonads') { const n = await syncAds(ctx); await report(ctx, id, { ok: true, latency: 0, note: `مزامنة: ${n} حملة نشطة` }); }
    else await ctx.db.tx(async tx => { await tx.query('update connectors set last_sync = now() where tool = $1', [id]); await log(tx, id, 'ok', 'مزامنة يدوية'); await emitConnectors(ctx, tx); });
  } else if (['disable', 'enable', 'disconnect', 'scopes'].includes(action)) {
    await ctx.db.tx(async tx => {
      if (action === 'disable') { await tx.query(`update connectors set state = 'disabled' where tool = $1`, [id]); await log(tx, id, 'warn', 'عُطّل الموصل'); await audit(tx, 'الموصلات', 'تعطيل', name); }
      if (action === 'enable') {
        const has = await ctx.vault.has(tx, secretId(id));
        const url = (await tx.query('select url from connectors where tool = $1', [id])).rows[0]?.url;
        await tx.query('update connectors set state = $2 where tool = $1', [id, has || url ? 'connected' : initialState(t)]);
        await log(tx, id, 'info', 'فُعّل الموصل'); await audit(tx, 'الموصلات', 'تفعيل', name);
      }
      if (action === 'disconnect') {
        await ctx.vault.delete(tx, secretId(id));
        await clearOAuth(ctx, id);
        await tx.query(`update connectors set state = $2, last4 = '', last_sync = null, url = '' where tool = $1`, [id, initialState(t)]);
        await log(tx, id, 'warn', 'فُصل الموصل وحُذف التفويض'); await audit(tx, 'الموصلات', 'فصل', name);
      }
      if (action === 'scopes') {
        const s = p.scopes === 'write' ? 'write' : 'read';
        await tx.query('update connectors set scopes = $2 where tool = $1', [id, s]);
        await log(tx, id, 'info', `الصلاحيات: ${s === 'read' ? 'قراءة فقط' : 'قراءة وكتابة'}`); await audit(tx, 'الموصلات', 'تعديل صلاحيات', name);
      }
      await emitConnectors(ctx, tx);
    });
  } else throw bad('إجراء غير معروف');
  return (await connectorMap(ctx, ctx.db))[id]!;
}

export async function addConnector(ctx: Ctx, i: { name?: string; url?: string; domain?: string; method?: ToolDef['m']; auth?: 'oauth' | 'key' | 'none'; depts?: string[] }): Promise<ToolDef> {
  const name = String(i.name || '').trim();
  if (!name) throw bad('اكتب اسم الموصل');
  if (ctx.org().tools.some(t => t.name === name)) throw bad('يوجد موصل بنفس الاسم');
  if (i.url && !/^https:\/\//.test(i.url)) throw bad('رابط الخادم يجب أن يبدأ بـ https://');
  const dom = String(i.domain || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const t: ToolDef = { id: newId('x'), name, core: false, dom, color: '#607D8B', m: i.method || 'mcp', phase: 3, custom: true };
  const cfg = structuredClone(ctx.org().config);
  cfg.customTools = [...(cfg.customTools || []), t];
  (i.depts || []).forEach(d => { const c = cfg.depts.find(x => x.id === d); if (c && !c.tools.includes(t.id)) c.tools.push(t.id); });
  const { publishConfig } = await import('./config.js');
  await publishConfig(ctx, cfg, `إضافة موصل «${name}»`, { customTools: cfg.customTools, changes: [`إضافة موصل «${name}»`] });
  await ctx.db.tx(async tx => {
    await tx.query(`update connectors set url = $2, auth = $3 where tool = $1`, [t.id, i.url || '', i.auth || 'key']);
    await log(tx, t.id, 'info', 'أُضيف الموصل'); await audit(tx, 'الموصلات', 'إضافة موصل', name); await emitConnectors(ctx, tx);
  });
  return t;
}

export async function removeConnector(ctx: Ctx, id: string): Promise<void> {
  const t = ctx.org().tool(id);
  if (!t || !t.custom) throw bad('يمكن حذف الموصلات المخصصة فقط');
  const cfg = structuredClone(ctx.org().config);
  cfg.customTools = (cfg.customTools || []).filter(x => x.id !== id);
  cfg.depts.forEach(d => { d.tools = d.tools.filter(x => x !== id); });
  cfg.agents.forEach(a => { a.tools = a.tools.filter(x => x !== id); });
  const { publishConfig } = await import('./config.js');
  await publishConfig(ctx, cfg, `حذف موصل «${t.name}»`, { customTools: cfg.customTools, changes: [`حذف موصل «${t.name}»`] });
  await ctx.db.tx(async tx => {
    await ctx.vault.delete(tx, secretId(id));
    await tx.query('delete from connectors where tool = $1', [id]);
    await audit(tx, 'الموصلات', 'حذف موصل', t.name); await emitConnectors(ctx, tx);
  });
}

/* ---------- Seller Central sync (orders + FBA stock) ---------- */

let syncing = false;
export async function syncSellerCentral(ctx: Ctx): Promise<{ salesToday: number; ordersToday: number; matched: number } | { skipped: true }> {
  if (syncing) return { skipped: true };
  const rt = await spRefresh(ctx, ctx.db);
  if (!spConfigured(spConfig(ctx), rt)) throw bad('مركز البائع غير مضبوط: SPAPI_CLIENT_ID وSPAPI_CLIENT_SECRET ورمز التحديث');
  syncing = true;
  try {
    const r = await spSyncToday(spConfig(ctx), rt!, H.dayStart(Date.now()));
    await ctx.db.tx(async tx => { await setKpiDay(tx, Date.now(), { sales: r.salesToday, orders: r.ordersToday }); await emitKpi(tx); });
    const { ingestProduct } = await import('./products.js');
    let matched = 0;
    for (const inv of r.inventory) { try { await ingestProduct(ctx, { sku: inv.sku, asin: inv.asin, stock: inv.stock }); matched++; } catch { /* SKU not tracked */ } }
    await report(ctx, 'sellercentral', { ok: true, latency: 0, note: `مزامنة: ${r.ordersToday} طلبًا · ${matched} منتجًا مطابقًا` });
    ctx.refreshMetrics();
    return { salesToday: r.salesToday, ordersToday: r.ordersToday, matched };
  } catch (e) {
    await report(ctx, 'sellercentral', { ok: false, latency: 0, error: (e as Error).message });
    throw e;
  } finally { syncing = false; }
}
