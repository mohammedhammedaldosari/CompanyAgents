/* Products board (spec §13) and alerts (spec §12). */
import { STAGE_IDS, cover, type Alert, type Product, type StageId, type Task } from '@agents/domain';
import type { Ctx } from '../context.js';
import { bad } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { getAlert, getProduct, insertTask, saveProduct, publicTask } from '../repo/rows.js';
import { audit, mkAlert } from './common.js';
import { setStage } from './effects.js';
import { makeTask, startTask } from './tasks.js';

export interface NewProduct { name: string; sku?: string; stage?: StageId; cost?: number; price?: number }

const riyalsToHalalas = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0; };

export async function createProduct(ctx: Ctx, i: NewProduct): Promise<Product> {
  const name = String(i.name || '').trim();
  if (!name) throw bad('اكتب اسم المنتج');
  const stage = i.stage && STAGE_IDS.includes(i.stage) ? i.stage : 'research';
  return ctx.db.tx(async tx => {
    const sku = String(i.sku || '').trim() || `NEW-${Date.now().toString(36).toUpperCase()}`;
    if ((await tx.query('select 1 from products where sku = $1', [sku])).rowCount) throw bad('الرمز مستخدم لمنتج آخر');
    const now = Date.now();
    const p: Product = { id: newId('p'), name, sku, asin: null, stage, stageSince: now, cost: riyalsToHalalas(i.cost), price: riyalsToHalalas(i.price),
      stock: 0, sales7d: 0, note: '', stages: [{ stage, at: now }], flags: {} };
    await saveProduct(tx, p);
    await tx.query('insert into product_stages (product_id, stage, at) values ($1,$2,$3)', [p.id, stage, new Date(now)]);
    tx.emit({ type: 'product.upsert', product: p });
    const t = await makeTask(ctx, tx, { title: `دراسة أولية: ${p.name}`, dept: 'research', agent: ctx.org().specialists('research')[0], action: 'report',
      productId: p.id, status: 'progress', at: now });
    await insertTask(tx, t); await startTask(ctx, tx, t, now);
    await audit(tx, 'المنتجات', 'إضافة', p.name);
    return p;
  });
}

export async function updateProduct(ctx: Ctx, id: string, patch: Partial<Product>): Promise<void> {
  await ctx.db.tx(async tx => {
    const p = await getProduct(tx, id);
    const nums = ['price', 'cost', 'stock', 'sales7d'] as const;
    for (const k of nums) if (patch[k] != null && Number.isFinite(Number(patch[k]))) p[k] = Math.max(0, Math.round(Number(patch[k])));
    if (patch.name && String(patch.name).trim()) p.name = String(patch.name).trim();
    if (patch.asin !== undefined) p.asin = patch.asin ? String(patch.asin).trim() : null;
    if (patch.note != null) p.note = String(patch.note).slice(0, 5000);
    await saveProduct(tx, p); tx.emit({ type: 'product.upsert', product: p });
    if (patch.stage && patch.stage !== p.stage) {
      if (!STAGE_IDS.includes(patch.stage)) throw bad('مرحلة غير معروفة');
      await setStage(ctx, tx, p, patch.stage, 'المالك');
      await audit(tx, 'المنتجات', `نقل إلى ${ctx.org().stage(patch.stage).name}`, p.name);
    } else if (patch.note != null) await audit(tx, 'المنتجات', 'تعديل ملاحظة', p.name);
    else await audit(tx, 'المنتجات', 'تعديل', p.name);
  });
  ctx.refreshMetrics();
}

/** Stock update coming from an integration: also raises the low-stock alert once (spec §17). */
export async function ingestProduct(ctx: Ctx, i: { sku?: string; asin?: string; stock?: number; sales7d?: number; price?: number; cost?: number }): Promise<Product> {
  const out = await ctx.db.tx(async tx => {
    const r = await tx.query('select id from products where sku = $1 or ($2::text is not null and asin = $2) limit 1', [i.sku ?? '', i.asin ?? null]);
    if (!r.rows[0]) throw bad(`منتج غير معروف: ${i.sku || i.asin}`);
    const p = await getProduct(tx, r.rows[0].id);
    for (const k of ['stock', 'sales7d', 'price', 'cost'] as const) if (i[k] != null && Number.isFinite(Number(i[k]))) p[k] = Math.max(0, Math.round(Number(i[k])));
    const S = ctx.org().settings; const c = cover(p);
    if (p.stage === 'live' && c < S.lowStockDays && !p.flags.low) {
      p.flags.low = true;
      await mkAlert(tx, { level: 'warning', dept: 'supply', agent: ctx.org().manager('supply'), title: `مخزون ${p.name} يكفي ${Math.floor(c)} يومًا فقط`, productId: p.id });
      const t = await makeTask(ctx, tx, { title: `اقتراح كمية إعادة الطلب لـ${p.name}`, dept: 'supply', action: 'report', productId: p.id,
        status: 'progress', at: Date.now(), source: 'تنبيه' });
      await insertTask(tx, t); await startTask(ctx, tx, t);
    }
    if (c >= S.warnStockDays) p.flags.low = false;
    await saveProduct(tx, p); tx.emit({ type: 'product.upsert', product: p });
    return p;
  });
  ctx.refreshMetrics();
  return out;
}

export async function dismissAlert(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.tx(async tx => {
    const a = await getAlert(tx, id);
    await tx.query('update alerts set dismissed = true where id = $1', [id]);
    tx.emit({ type: 'alert.upsert', alert: { ...a, dismissed: true } });
    await audit(tx, 'التنبيهات', 'تجاهل', a.title);
  });
}

export async function taskFromAlert(ctx: Ctx, id: string): Promise<Task> {
  return ctx.db.tx(async tx => {
    const a: Alert = await getAlert(tx, id);
    if (a.taskId) throw bad('أُنشئت مهمة لهذا التنبيه من قبل');
    const t = await makeTask(ctx, tx, { title: `معالجة: ${a.title}`.slice(0, 300), dept: a.dept === 'core' ? 'exec' : a.dept, action: 'internal',
      productId: a.productId, status: 'progress', at: Date.now(), source: 'تنبيه' });
    await insertTask(tx, t); await startTask(ctx, tx, t);
    await tx.query('update alerts set task_id = $2 where id = $1', [a.id, t.id]);
    tx.emit({ type: 'alert.upsert', alert: { ...a, taskId: t.id } });
    await audit(tx, 'التنبيهات', 'إنشاء مهمة من تنبيه', a.title);
    return publicTask(t);
  });
}
