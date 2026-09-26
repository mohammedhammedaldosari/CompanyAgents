import { describe, expect, it } from 'vitest';
import {
  POLICIES_REF, approvalReason, buildOrg, cover, defaultConfig, diffConfig, inferAction, inferValue, linkProduct, needsApproval,
  nextRun, pickAgent, policyFor, routeDept, routineRuns, runsOn, validateConfig, DEPTS_REF, TOOLS_REF, ROUTINES_REF, sar, H
} from '../src/index.js';

const org = buildOrg(defaultConfig(0));
const pol = (a: Parameters<typeof policyFor>[2]) => policyFor(POLICIES_REF, [], a);

describe('reference data', () => {
  it('has 32 agents: 8 managers + 23 specialists + the knowledge keeper', () => {
    const all = DEPTS_REF.flatMap(d => d.agents);
    expect(all).toHaveLength(32);
    expect(DEPTS_REF.filter(d => d.id !== 'core')).toHaveLength(8);
    expect(all.filter(a => org.isMgr(a))).toHaveLength(8);
  });
  it('has 10 core tools in header order and 18 routines', () => {
    expect(TOOLS_REF.filter(t => t.core).map(t => t.id)).toEqual(
      ['gmail', 'gcal', 'gdrive', 'gsheets', 'notion', 'helium10', 'sellercentral', 'amazonads', 'alibaba', 'websearch']);
    expect(ROUTINES_REF).toHaveLength(18);
  });
});

describe('permission gate (spec §22 acceptance)', () => {
  it('price +7% needs approval, +4% does not, with the default 5% limit', () => {
    expect(needsApproval(pol('price_change'), 7)).toBe(true);
    expect(needsApproval(pol('price_change'), 4)).toBe(false);
    expect(needsApproval(pol('price_change'), -7)).toBe(true);
  });
  it('payment is locked to always, even if the stored policy says auto', () => {
    const tampered = POLICIES_REF.map(p => (p.action === 'payment' ? { ...p, mode: 'auto' as const } : p));
    expect(needsApproval(policyFor(tampered, [], 'payment'), 1), 'payment').toBe(true);
  });
  it('SAR limits compare in riyals', () => {
    const p = { action: 'purchase_order' as const, mode: 'limit' as const, limit: 10000, unit: 'SAR' as const };
    expect(needsApproval(p, 1_000_000)).toBe(false);
    expect(needsApproval(p, 1_000_100)).toBe(true);
  });
  it('agent override beats dept override beats global', () => {
    const ov = [
      { action: 'price_change' as const, scope: 'dept' as const, target: 'amazon', mode: 'auto' as const },
      { action: 'price_change' as const, scope: 'agent' as const, target: 'ag9', mode: 'always' as const }
    ];
    expect(policyFor(POLICIES_REF, ov, 'price_change', 'ag9', 'amazon')?.mode).toBe('always');
    expect(policyFor(POLICIES_REF, ov, 'price_change', 'ag1', 'amazon')?.mode).toBe('auto');
    expect(policyFor(POLICIES_REF, ov, 'price_change', 'ag1', 'finance')?.mode).toBe('limit');
  });
  it('explains why approval is needed', () => {
    expect(approvalReason(pol('price_change'), 'price_change', 7, false)).toBe('تحتاج موافقتك لأن تغيير سعر منتج (+7%) تجاوز الحد 5%');
    expect(approvalReason(pol('supplier_msg'), 'supplier_msg', undefined, false)).toBe('مراسلة مورد يحتاج موافقتك دائمًا');
  });
});

describe('routing (§14)', () => {
  it('routes by the first matching word group, in order', () => {
    expect(routeDept('اطلب عينة من المصنع')).toBe('supply');
    expect(routeDept('ارفع ميزانية الحملة')).toBe('marketing');
    expect(routeDept('غيّر سعر المنظم')).toBe('amazon');
    expect(routeDept('نقاش عام')).toBeNull();
  });
  it('infers action and value', () => {
    expect(inferAction('تحديث سعر منظم الأدراج +7%')).toBe('price_change');
    expect(inferValue('تحديث سعر منظم الأدراج +7%')).toBe(7);
    expect(inferValue('خفض السعر −٨٪')).toBe(-8);
    expect(inferValue('دفعة 18,500 ريال')).toBe(1_850_000);
    expect(inferAction('اكتب تقرير المبيعات')).toBe('report');
  });
  it('picks a specialist by name word, else least loaded', () => {
    expect(pickAgent(org, 'amazon', 'مراجعة التسعير للمنتجات')).toBe('التسعير والربحية');
    expect(pickAgent(org, 'amazon', 'مهمة عامة', true)).toBe('مدير أعمال أمازون');
    expect(pickAgent(org, 'supply', 'مهمة عامة', false, { 'التوريد والتفاوض': 3, 'الاستيراد والتكلفة الواصلة': 1, 'تخطيط المخزون': 2 }))
      .toBe('الاستيراد والتكلفة الواصلة');
  });
  it('links a product by its first two words', () => {
    const P = [{ id: 'p1', name: 'منظم أدراج مطبخ قابل للتمديد' }, { id: 'p6', name: 'منظم كابلات مكتبي' }];
    expect(linkProduct('تحديث سعر منظم أدراج', P)).toBe('p1');
    expect(linkProduct('شيء آخر', P)).toBeNull();
  });
});

describe('scheduling', () => {
  // 2026-09-27 is a Sunday
  const sun = new Date(2026, 8, 27, 6, 0).getTime();
  it('work days are Sunday–Thursday', () => {
    const r = { freq: 'workdays' as const };
    expect(runsOn(r, sun)).toBe(true);
    expect(runsOn(r, sun + 5 * H.DAY)).toBe(false); // Friday
    expect(runsOn({ freq: 'monthly1' }, new Date(2026, 9, 1).getTime())).toBe(true);
  });
  it('computes run times and the next run', () => {
    const r = { freq: 'weekly' as const, dow: 3, time: '11:00', paused: false };
    const runs = routineRuns(r, sun, 14);
    expect(runs).toHaveLength(2);
    expect(new Date(runs[0]!).getDay()).toBe(3);
    expect(nextRun(r, sun)).toBe(runs[0]);
    expect(nextRun({ ...r, paused: true }, sun)).toBeNull();
  });
});

describe('config', () => {
  it('default config is valid and diff of identical configs is empty', () => {
    const c = defaultConfig(0);
    expect(validateConfig(c)).toEqual([]);
    expect(diffConfig(c, structuredClone(c))).toEqual([]);
  });
  it('rejects a department with two managers and reports renames', () => {
    const a = defaultConfig(0); const b = structuredClone(a);
    b.agents.find(x => x.name === 'عمليات أمازون')!.mgr = true;
    expect(validateConfig(b)).toContain('قسم «أمازون» يحتاج مديرًا واحدًا');
    const c = structuredClone(a); c.agents.find(x => x.name === 'عمليات أمازون')!.name = 'محلل أمازون';
    expect(diffConfig(a, c)).toEqual(['تغيير مسمى «عمليات أمازون» إلى «محلل أمازون»']);
  });
});

describe('formatting', () => {
  it('formats halalas', () => {
    expect(sar(1_850_000)).toBe('18,500 ر.س');
    expect(sar(120_000_000)).toBe('1.2 مليون ر.س');
    expect(cover({ stock: 64, sales7d: 41 })).toBeCloseTo(10.93, 1);
  });
});
