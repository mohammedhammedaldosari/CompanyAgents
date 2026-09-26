/* Internal effects of approved or auto-allowed actions (spec §12 "آثار الموافقة").
   The platform mirrors the decision in its own records; pushing it to the external system is the job of the matching
   write connector. Until one is connected, the summary says so explicitly — nothing is silently claimed as done. */
import { H, type Product } from '@agents/domain';
import type { Ctx } from '../context.js';
import type { Tx } from '../db/db.js';
import { getProduct, saveProduct } from '../repo/rows.js';
import { act } from './common.js';

export async function setStage(ctx: Ctx, tx: Tx, p: Product, stage: Product['stage'], by: string): Promise<void> {
  p.stage = stage; p.stageSince = Date.now(); p.flags = {};
  await saveProduct(tx, p);
  await tx.query('insert into product_stages (product_id, stage, at) values ($1,$2,$3)', [p.id, stage, new Date(p.stageSince)]);
  p.stages = [...(p.stages || []), { stage, at: p.stageSince }];
  tx.emit({ type: 'product.upsert', product: p });
  const dept = stage === 'research' ? 'research' : stage === 'live' || stage === 'paused' ? 'amazon' : 'supply';
  await act(tx, dept, by, 'stage', `نقل «${p.name}» إلى مرحلة ${ctx.org().stage(stage).name}`);
}

export interface PriceChange { product: Product; old: number; next: number }

/** New price rounded to the whole riyal, as in the spec. */
export async function applyPriceChange(tx: Tx, productId: string, percent: number): Promise<PriceChange> {
  const p = await getProduct(tx, productId);
  const old = p.price, next = Math.round((old * (1 + percent / 100)) / 100) * 100;
  p.price = next; await saveProduct(tx, p);
  tx.emit({ type: 'product.upsert', product: p });
  return { product: p, old, next };
}

/** Effect of a task-level approval (a draft approved without a stored tool call). Returns the result summary. */
export async function applyApprovedEffect(ctx: Ctx, tx: Tx, t: { action: string; value?: number; productId: string | null; title: string }): Promise<string | null> {
  if (t.action === 'price_change' && t.productId && t.value != null) {
    const r = await applyPriceChange(tx, t.productId, t.value);
    return `تغيّر سعر ${r.product.name} من ${H.sarN(r.old)} إلى ${H.sarN(r.next)} ر.س في المنصة · حدّثه في مركز البائع أو اربط موصل الكتابة`;
  }
  if (t.action === 'purchase_order') {
    if (t.productId) {
      const p = await getProduct(tx, t.productId);
      if (p.stage === 'sourcing') await setStage(ctx, tx, p, 'shipping', ctx.org().manager('supply'));
    }
    return `صدر أمر الشراء${t.value ? ` بقيمة ${H.sar(t.value)}` : ''} · أرسله للمورد من بريدك أو عبر موصل البريد`;
  }
  if (t.action === 'payment') return 'جُهّزت الدفعة وتنتظر التنفيذ منك في البنك';
  if (t.action === 'ad_budget') return `اعتُمد تغيير الميزانية ${t.value != null ? `بنسبة ${t.value}%` : ''} · يُطبَّق عند ربط إعلانات أمازون`;
  if (t.action === 'listing_edit') return 'اعتُمد تعديل القائمة · يُطبَّق في مركز البائع';
  if (t.action === 'supplier_msg' || t.action === 'external_email') return 'اعتُمدت الرسالة وحُفظ نصها · تُرسل عبر موصل البريد عند ربطه';
  return null;
}
