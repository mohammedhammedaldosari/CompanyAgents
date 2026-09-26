/* Operations: engine on/off, KPI ingestion, manual metrics, export/import, first-boot initialisation, demo seed. */
import { DEMO_PRODUCTS, H, OPS_IDS, ROUTINES_REF, DEPTS_REF, type Kpi, type State } from '@agents/domain';
import type { Ctx } from '../context.js';
import type { Tx } from '../db/db.js';
import { bad } from '../core/errors.js';
import { saveProduct, saveRoutine } from '../repo/rows.js';
import { act, audit, emitKpi, mkAlert, patchCompany, setKpiDay } from './common.js';
import { currentConfig, initConfig } from './config.js';
import { ensureConnectorRows } from './connectors.js';
import { ensureRoutines } from './routines.js';

/** Engine switch (spec §20: stopping halts the queue immediately and blocks any new call). */
export async function setRunning(ctx: Ctx, on: boolean): Promise<void> {
  await ctx.db.tx(async tx => {
    await patchCompany(tx, { running: on });
    tx.emit({ type: 'running', on });
    await act(tx, 'exec', ctx.org().manager('exec'), 'route', on ? 'استُؤنف عمل الوكلاء' : 'أُوقف عمل الوكلاء');
    await audit(tx, 'التشغيل', on ? 'استئناف الوكلاء' : 'إيقاف الوكلاء');
  });
  if (!on) ctx.jobs.abortAll();
  else {
    // re-queue everything that was in progress when the engine stopped
    const r = await ctx.db.query(`select id from tasks where status = 'progress' and routing is null`);
    for (const x of r.rows) await ctx.jobs.enqueueTask(x.id);
  }
}

/** Totals for today from an integration (amounts in halalas). Cash is a balance, not a daily figure. */
export async function ingestKpi(ctx: Ctx, k: Partial<Kpi>): Promise<Kpi> {
  const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? undefined : Math.round(Number(v)));
  const v = { sales: num(k.salesToday), profit: num(k.profitToday), ad_spend: num(k.adSpendToday), orders: num(k.ordersToday) };
  const cash = num(k.cash);
  if (Object.values(v).every(x => x === undefined) && cash === undefined) throw bad('لا توجد قيم صالحة');
  await ctx.db.tx(async tx => {
    await setKpiDay(tx, Date.now(), v);
    if (cash !== undefined) await patchCompany(tx, { cash });
    await emitKpi(tx);
  });
  ctx.refreshMetrics();
  const { kpi } = await import('./common.js');
  return kpi(ctx.db);
}

/** Owner-entered values for the fixed card metrics (e.g. active campaigns, suppliers in negotiation). */
export async function setMetricBase(ctx: Ctx, dept: string, values: [number, number]): Promise<void> {
  if (!(OPS_IDS as readonly string[]).includes(dept)) throw bad('قسم غير معروف');
  const [a, b] = values.map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw bad('قيم غير صالحة');
  await ctx.db.tx(async tx => {
    await tx.query('insert into metrics_base (dept, v0, v1) values ($1,$2,$3) on conflict (dept) do update set v0 = excluded.v0, v1 = excluded.v1', [dept, a, b]);
    await audit(tx, 'الإعدادات', 'تحديث مقاييس القسم', ctx.org().dept(dept as never).name, `${a} · ${b}`);
  });
  ctx.refreshMetrics();
}

/** Idempotent first-boot setup: company row, config v1, reference routines, connector rows, metric rows. */
export async function bootstrap(ctx: Ctx): Promise<void> {
  await ctx.db.tx(async tx => {
    await tx.query('select pg_advisory_xact_lock(727003)');
    const fresh = !(await tx.query('select 1 from company_state where id = 1')).rowCount;
    if (fresh) {
      await tx.query('insert into company_state (id, last_day) values (1, $1)', [H.dayKey(Date.now())]);
      const cfg = (await currentConfig(tx)) ?? (await initConfig(tx));
      ctx.setConfig(cfg);
      for (const r of ROUTINES_REF) await saveRoutine(tx, { ...r, paused: false });
      // fixed card metrics start at zero until the owner (or the demo seed) sets them
      for (const d of DEPTS_REF) if (d.metrics) await tx.query('insert into metrics_base (dept) values ($1) on conflict do nothing', [d.id]);
      await audit(tx, 'الإصدارات', 'الإعداد الأولي', 'الإصدار 1', null, 'النظام');
    } else {
      const cfg = await currentConfig(tx);
      if (cfg) ctx.setConfig(cfg);
    }
    await ensureConnectorRows(ctx, tx);
    await ensureRoutines(ctx, tx);
  });
}

/** Optional demo data (spec §10 sample products, metrics and KPI) — never runs automatically. */
export async function seedDemo(ctx: Ctx): Promise<void> {
  await ctx.db.tx(async (tx: Tx) => {
    if ((await tx.query('select 1 from products limit 1')).rowCount) throw bad('توجد منتجات بالفعل؛ بيانات العرض تُضاف لقاعدة فارغة فقط');
    const now = Date.now();
    for (const [id, name, sku, stage, days, cost, price, stock, sales7d] of DEMO_PRODUCTS) {
      const since = now - days * H.DAY;
      await saveProduct(tx, { id, name, sku, asin: ['live', 'paused', 'shipping'].includes(stage) ? `B0SA0000${id.slice(1)}` : null, stage, stageSince: since,
        cost: Math.round(cost * 100), price: Math.round(price * 100), stock, sales7d, note: '', stages: [], flags: {} });
      await tx.query('insert into product_stages (product_id, stage, at) values ($1,$2,$3)', [id, stage, new Date(since)]);
    }
    for (const d of DEPTS_REF) if (d.metrics) {
      const v = d.metrics.map(m => (typeof m[1] === 'number' ? m[1] : 0));
      await tx.query('insert into metrics_base (dept, v0, v1) values ($1,$2,$3) on conflict (dept) do update set v0 = excluded.v0, v1 = excluded.v1', [d.id, v[0], v[1]]);
    }
    await setKpiDay(tx, H.addDays(now, -1), { sales: 164500, profit: 38200, ad_spend: Math.round(164500 * 0.14), orders: Math.floor(164500 / 8000) });
    await patchCompany(tx, { cash: 6850000 });
    await mkAlert(tx, { level: 'warning', dept: 'supply', agent: ctx.org().manager('supply'), title: 'مخزون حقيبة لابتوب مقاومة للماء يكفي 5 أيام فقط', productId: 'p3' });
    await mkAlert(tx, { level: 'info', dept: 'finance', agent: 'مالية الأعمال', title: 'وصلت تسوية أمازون: 12,480 ر.س' });
    await tx.query(`update products set flags = '{"low":true}' where id = 'p3'`);
    await audit(tx, 'النظام', 'إضافة بيانات العرض', '', null, 'النظام');
  });
  const { afterConfigChange } = await import('./config.js');
  await afterConfigChange(ctx);
}

/** Export: the full snapshot plus the knowledge base (import target for a fresh install). */
export async function exportState(ctx: Ctx): Promise<State & { notesDocs: unknown[]; exportedAt: number }> {
  const { snapshot } = await import('./snapshot.js');
  const s = await snapshot(ctx);
  const notes = (await ctx.db.query('select slug, title, body, tags, created_by, created_at, updated_at from notes order by created_at')).rows;
  return { ...s, notesDocs: notes, exportedAt: Date.now() };
}

/** Import restores products, routines, open tasks and notes into an empty database (no secrets, no history). */
export async function importState(ctx: Ctx, raw: Partial<State> & { notesDocs?: { slug: string; title: string; body: string; tags?: string[]; created_by?: string }[] }): Promise<void> {
  if (!raw || raw.v !== 4 || !Array.isArray(raw.products) || !Array.isArray(raw.routines) || !Array.isArray(raw.tasks)) throw bad('ملف غير صالح أو من إصدار مختلف');
  await ctx.db.tx(async tx => {
    if ((await tx.query(`select 1 from tasks where status <> 'scheduled' or routine_id is null limit 1`)).rowCount
      || (await tx.query('select 1 from products limit 1')).rowCount) throw bad('الاستيراد متاح لقاعدة بيانات جديدة فقط');
    await tx.query('delete from tasks'); await tx.query('delete from routines');
    for (const p of raw.products!) await saveProduct(tx, { ...p, flags: p.flags || {}, stages: [] });
    for (const p of raw.products!) for (const s of p.stages || []) await tx.query('insert into product_stages (product_id, stage, at) values ($1,$2,$3)', [p.id, s.stage, new Date(s.at)]);
    for (const r of raw.routines!) await saveRoutine(tx, r);
    const { insertTask, blankTask } = await import('../repo/rows.js');
    for (const t of raw.tasks!) if (['scheduled', 'backlog', 'done'].includes(t.status)) await insertTask(tx, { ...blankTask(t), ...t, pendingCall: null, routing: null, ownerNote: null, fix: false, attempts: 0 });
    for (const n of raw.notesDocs || []) await tx.query(`insert into notes (id, slug, title, body, tags, created_by) values ($1,$2,$3,$4,$5,$6) on conflict (slug) do nothing`,
      [`n_${n.slug}`, n.slug, n.title, n.body, n.tags || [], n.created_by || 'استيراد']);
    if (raw.kpi) await patchCompany(tx, { cash: Math.round(raw.kpi.cash || 0) });
    await audit(tx, 'النظام', 'استيراد نسخة احتياطية', '');
  });
  const { afterConfigChange } = await import('./config.js');
  await afterConfigChange(ctx);
}
