/* Pure business rules: routing (§14), action inference (§14), permission gate (§9, §12), scheduling (§9, §16), products (§13). */
import { ACTION_LABEL, ROUTE_WORDS } from './catalog.js';
import type { Org } from './config.js';
import { DAY, addDays, arDigits, atTime, dayStart, sar, words } from './format.js';
import type { ActionType, DeptId, OpsDeptId, Policy, PolicyOverride, Product, Routine, StageId, Task } from './types.js';

/* ---------- routing ---------- */

/** First department whose routing words appear in the text (in spec order), skipping disabled departments. */
export function routeDept(text: string, org?: Org): OpsDeptId | null {
  for (const [d, ws] of ROUTE_WORDS) if ((!org || org.deptOn(d)) && ws.some(w => text.includes(w))) return d;
  return null;
}

/**
 * Pick the agent for a task (§14 step 3): team tasks go to the manager; otherwise the first active specialist
 * whose name shares a word (> 3 letters, article stripped) with the title; otherwise the least-loaded active specialist.
 */
export function pickAgent(org: Org, dept: DeptId, title: string, team = false, load: Record<string, number> = {}): string {
  if (team || dept === 'core') return org.manager(dept);
  const sp = org.specialists(dept).filter(a => org.agentOn(a));
  if (!sp.length) return org.manager(dept);
  for (const a of sp) if (words(a).filter(w => w.length > 3).some(w => title.includes(w))) return a;
  return sp.slice().sort((a, b) => (load[a] || 0) - (load[b] || 0))[0]!;
}

/** Action type from free text (§14 step 4). */
export function inferAction(s: string): ActionType {
  if (/سعر/.test(s)) return 'price_change';
  if (/ميزانية|حملة/.test(s)) return 'ad_budget';
  if (/قائمة|عنوان/.test(s)) return 'listing_edit';
  if (/مورد|مصنع/.test(s)) return 'supplier_msg';
  if (/أمر شراء/.test(s)) return 'purchase_order';
  if (/دفعة|تحويل/.test(s)) return 'payment';
  if (/بريد|رسالة/.test(s)) return 'external_email';
  if (/تقرير/.test(s)) return 'report';
  return 'internal';
}

/** First "N%" becomes a percentage; "N ريال" becomes an amount in halalas. */
export function inferValue(s: string): number | undefined {
  const t = arDigits(s).replace(/−/g, '-');
  let m = t.match(/([+-]?\d+(?:\.\d+)?)\s*[%٪]/);
  if (m) return parseFloat(m[1]!);
  m = t.match(/(\d[\d,]*)\s*ريال/);
  if (m) return parseInt(m[1]!.replace(/,/g, ''), 10) * 100;
  return undefined;
}

/** Link a title to a product by its first two words, or by a unique first word. */
export function linkProduct(title: string, products: readonly Pick<Product, 'id' | 'name'>[]): string | null {
  const w = words(title);
  for (const p of products) { const pw = words(p.name).slice(0, 2); if (pw.length === 2 && pw.every(x => w.includes(x))) return p.id; }
  const c = products.filter(p => { const f = words(p.name)[0]; return f !== undefined && w.includes(f); });
  return c.length === 1 ? c[0]!.id : null;
}

/* ---------- permission gate ---------- */

export type PolicyLike = Pick<Policy, 'mode' | 'limit' | 'unit'> & { action: ActionType; label?: string; locked?: boolean };

/** Effective policy for (action, agent, dept): agent override → dept override → global. Payment is always the locked global policy. */
export function policyFor(policies: readonly Policy[], overrides: readonly PolicyOverride[], action: ActionType, agentId?: string, dept?: DeptId): PolicyLike | undefined {
  const g = policies.find(p => p.action === action);
  if (action === 'payment') return { ...(g ?? { action, label: ACTION_LABEL.payment }), mode: 'always', locked: true };
  return overrides.find(o => o.action === action && o.scope === 'agent' && agentId && o.target === agentId)
    || overrides.find(o => o.action === action && o.scope === 'dept' && dept && o.target === dept)
    || g;
}

/** Does this action/value need the owner's approval under the policy? (§9 table) */
export function needsApproval(p: PolicyLike | undefined, value: number | undefined): boolean {
  if (!p || p.mode === 'auto') return false;
  if (p.mode === 'always') return true;
  if (value == null) return false;
  const v = p.unit === 'SAR' ? Math.abs(value) / 100 : Math.abs(value);
  return v > (p.limit ?? 0);
}

export function approvalReason(p: PolicyLike | undefined, action: ActionType, value: number | undefined, forced: boolean): string {
  const label = ACTION_LABEL[action] ?? action;
  if (forced && !needsApproval(p, value)) return 'طلبت تنفيذ هذه المهمة بعد موافقتك';
  if (!p || p.mode === 'always') return action === 'payment' ? 'تجهيز الدفعات يحتاج موافقتك دائمًا، والوكلاء لا ينفذون التحويل' : `${label} يحتاج موافقتك دائمًا`;
  if (p.mode === 'limit') {
    const shown = p.unit === 'SAR' ? sar(value ?? 0) : `${(value ?? 0) > 0 ? '+' : ''}${value ?? 0}%`;
    const lim = p.unit === 'SAR' ? `${p.limit} ر.س` : `${p.limit}%`;
    return `تحتاج موافقتك لأن ${label} (${shown}) تجاوز الحد ${lim}`;
  }
  return `${label} يحتاج موافقتك`;
}

export function valueDesc(t: Pick<Task, 'action' | 'value'>): string {
  if (t.value == null) return ACTION_LABEL[t.action];
  if (t.action === 'price_change') return `سعر ${t.value > 0 ? '+' : ''}${t.value}%`;
  if (t.action === 'ad_budget') return `ميزانية ${t.value > 0 ? '+' : ''}${t.value}%`;
  return sar(t.value);
}

/* ---------- scheduling ---------- */

/** Work week is Sunday–Thursday (0..4). */
export const isWorkday = (t: number): boolean => new Date(t).getDay() <= 4;

export function runsOn(r: Pick<Routine, 'freq' | 'dow'>, day: number): boolean {
  const d = new Date(day), w = d.getDay();
  return r.freq === 'daily' || (r.freq === 'workdays' && w <= 4) || (r.freq === 'weekly' && w === (r.dow ?? 0)) || (r.freq === 'monthly1' && d.getDate() === 1);
}

/** Planned run times of a routine in [from, from + days). */
export function routineRuns(r: Pick<Routine, 'freq' | 'dow' | 'time'>, from: number, days: number): number[] {
  const out: number[] = []; const today = dayStart(from);
  for (let k = 0; k < days; k++) { const day = addDays(today, k); if (runsOn(r, day)) out.push(atTime(day, r.time)); }
  return out;
}

export function nextRun(r: Pick<Routine, 'freq' | 'dow' | 'time' | 'paused'>, now = Date.now()): number | null {
  if (r.paused) return null;
  return routineRuns(r, now, 40).find(t => t > now) ?? null;
}

/* ---------- products & metrics ---------- */

/** Days of stock cover = stock ÷ (7-day sales ÷ 7). */
export const cover = (p: Pick<Product, 'stock' | 'sales7d'>): number => (p.sales7d > 0 ? p.stock / (p.sales7d / 7) : p.stock > 0 ? 999 : 0);
export const margin = (p: Pick<Product, 'price' | 'cost'>): number => (p.price > 0 ? ((p.price - p.cost) / p.price) * 100 : 0);
export const isStalled = (org: Org, p: Pick<Product, 'stage' | 'stageSince'>, now = Date.now()): boolean => {
  const lim = org.stage(p.stage).limit; return lim != null && Math.floor((now - p.stageSince) / DAY) > lim;
};
export const hasAsinStage = (s: StageId): boolean => s === 'live' || s === 'paused' || s === 'shipping';
