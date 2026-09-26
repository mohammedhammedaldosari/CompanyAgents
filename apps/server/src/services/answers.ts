/* Data-driven department replies (spec §15): the opening message and the rule-based answer engine.
   Used as-is when no model key is configured, and as the factual fallback when the model is unavailable. */
import { H, STATUS_LABEL, cover, margin, valueDesc, type Alert, type DeptId, type Kpi, type Product, type Task } from '@agents/domain';
import type { Org } from '@agents/domain';

export interface AnswerData {
  org: Org; tasks: Task[]; products: Product[]; alerts: Alert[]; kpi: Kpi;
  metrics: Partial<Record<DeptId, [number, number]>>; base: Partial<Record<DeptId, [number, number]>>; now: number;
}

const list = (a: string[]) => (a.length ? a.map(x => `• ${x}`).join('\n') : '• لا شيء الآن.');

export function opener(d: DeptId, D: AnswerData): string {
  const s = D.tasks, dt = H.dayStart(D.now), m = D.metrics[d] || [0, 0], K = D.kpi;
  const prog = s.filter(t => t.dept === d && t.status === 'progress').length;
  const done = s.filter(t => t.dept === d && t.status === 'done' && (t.doneAt ?? 0) >= dt).length;
  const w = s.filter(t => t.dept === d && t.status === 'waiting').length;
  const next = s.filter(t => t.status === 'scheduled' && (t.at ?? 0) > D.now).sort((a, b) => a.at! - b.at!)[0];
  const first: Partial<Record<DeptId, string>> = {
    exec: `${s.filter(t => t.status === 'waiting').length} موافقات و${D.alerts.filter(a => !a.dismissed).length} تنبيهات تنتظرك. أهم ما اليوم: ${next ? next.title : 'لا شيء مجدول'}.`,
    research: `ندرس ${m[0]} منتجات، و${m[1]} منها مؤهلة للانتقال للتوريد.`,
    amazon: `${K.ordersToday} طلبًا اليوم بقيمة ${H.sarN(K.salesToday)} ر.س. ${m[1]} منتجات مخزونها منخفض.`,
    supply: `نتفاوض مع ${m[0]} موردين، و${m[1]} شحنة في الطريق.`,
    marketing: `${m[0]} حملة نشطة، ونسبة الإعلان للمبيعات ${H.p1(m[1])}%.`,
    finance: `النقد المتاح ${H.sarN(K.cash)} ر.س، وهامش صافي الشهر ${H.p1(m[0])}%.`,
    tech: `${m[0]} وكيلًا يعمل الآن، و${m[1]} اختبار فاشل.`,
    personal: `${m[0]} أهداف لهذا الأسبوع و${m[1]} مهام لك اليوم.`
  };
  return `${first[d] || ''}\n${prog} مهام قيد التنفيذ، و${done} منجزة اليوم.${w ? `\nبانتظار موافقتك: ${w}.` : ''}`;
}

export function answer(d: DeptId, q: string, D: AnswerData): string {
  const has = (...w: string[]) => w.some(x => q.includes(x));
  const s = D.tasks, K = D.kpi, now = D.now, li = D.products.filter(p => p.stage === 'live');
  const base = (k: DeptId, i: 0 | 1) => D.base[k]?.[i] ?? 0;
  if ((d === 'personal' && has('أولوياتي', 'أهداف', 'أتعلم')) || has('أولوياتي', 'أتعلم')) {
    const wk = s.filter(t => t.dept === 'personal' && t.status === 'scheduled' && (t.at ?? 0) < now + 7 * H.DAY).sort((a, b) => a.at! - b.at!);
    return `مهامك القادمة:\n${list(wk.slice(0, 6).map(t => `${H.rel(t.at!, now)} ${H.hm(t.at!)} ${t.title}`))}\nأهداف الأسبوع: ${base('personal', 0)}.`;
  }
  if (has('يحتاجني', 'قرارات', 'معلّق', 'معلق', 'موافق')) {
    const W = s.filter(t => t.status === 'waiting'); const C = D.alerts.filter(a => !a.dismissed && a.level === 'critical');
    return `بانتظار موافقتك ${W.length}:\n${list(W.map(t => `${t.title} — ${valueDesc(t)}`))}${C.length ? `\nتنبيهات حرجة:\n${list(C.map(a => a.title))}` : ''}`;
  }
  if (has('لخّص', 'لخص', 'الأسبوع')) {
    const n = s.filter(t => t.status === 'done' && (t.doneAt ?? 0) > now - 7 * H.DAY).length;
    return `خلال 7 أيام أنجز الوكلاء ${n} مهمة.\n• مبيعات الأسبوع التقديرية ${H.sar(K.salesYesterday * 7)}\n• الأرباح التقديرية ${H.sar(K.profitYesterday * 7)}`;
  }
  if (has('فرص', 'قيد الدراسة')) return `منتجات مرحلة البحث:\n${list(D.products.filter(p => p.stage === 'research').map(p => `${p.name} — منذ ${H.daysSince(p.stageSince, now)} يومًا`))}`;
  if (has('المبيعات', 'مبيعات')) {
    const f = (now - H.dayStart(now)) / H.DAY, y = K.salesYesterday * f;
    return `مبيعات اليوم ${H.sar(K.salesToday)} من ${K.ordersToday} طلبًا.\nأمس في الساعة نفسها ${H.sar(y)} (${y ? (K.salesToday >= y ? '▲ ' : '▼ ') + H.p1(Math.abs(K.salesToday - y) / y * 100) + '%' : '—'}).`;
  }
  if (has('نعيد طلب')) {
    const p = li.find(x => q.includes(H.words(x.name)[0] ?? '\u0000')) || li.slice().sort((a, b) => cover(a) - cover(b))[0];
    return p ? `${p.name}: المخزون يكفي ${Math.floor(cover(p))} يومًا.\nالكمية المقترحة: ${p.sales7d * 8} قطعة.` : 'لا منتجات نشطة.';
  }
  if (has('مخزون')) return `أيام تغطية المخزون:\n${list(li.slice().sort((a, b) => cover(a) - cover(b)).map(p => `${p.name}: ${p.stock} قطعة · ${Math.floor(cover(p))} يومًا`))}`;
  if (has('صندوق الشراء')) {
    const C = D.alerts.filter(a => !a.dismissed && a.level === 'critical' && a.productId);
    return `حالة صندوق الشراء:\n${list(li.map(p => `${p.name}: ${C.some(a => a.productId === p.id) ? 'مفقود — تنبيه حرج' : 'لا تنبيه'}`))}`;
  }
  if (has('شحنات', 'الشحنة')) return `في مرحلة الشحن:\n${list(D.products.filter(p => p.stage === 'shipping').map(p => `${p.name} — منذ ${H.daysSince(p.stageSince, now)} يومًا`))}`;
  if (has('موردين', 'الموردين', 'مورد')) {
    return `منتجات التوريد:\n${list(D.products.filter(p => p.stage === 'sourcing').map(p => p.name))}\nآخر مهام التفاوض:\n${list(s.filter(t => t.action === 'supplier_msg' && t.status !== 'cancelled')
      .sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 3).map(t => `${t.title} · ${STATUS_LABEL[t.status]}`))}`;
  }
  if (has('إعلان', 'الإعلانات', 'حملة')) return `إنفاق اليوم ${H.sar(K.adSpendToday)} بنسبة ${H.p1(K.salesToday ? K.adSpendToday / K.salesToday * 100 : 0)}% من المبيعات.`;
  if (has('عروض')) return `مهام العروض المجدولة:\n${list(s.filter(t => t.agent === 'الاستراتيجية والعروض' && t.status === 'scheduled').map(t => `${H.rel(t.at!, now)} ${t.title}`))}`;
  if (has('النقد', 'نقد')) {
    const daily = base('finance', 1) / 30;
    return daily > 0 ? `النقد المتاح ${H.sar(K.cash)}، يكفي ${Math.floor(K.cash / daily)} يومًا بمتوسط المصروف الحالي.` : `النقد المتاح ${H.sar(K.cash)}.`;
  }
  if (has('هامش')) return `هامش صافي الشهر ${H.p1(base('finance', 0))}%.\n${list(li.map(p => `${p.name}: ${H.p1(margin(p))}%`))}`;
  if (has('مدفوعات', 'دفعة')) {
    return `المدفوعات وأوامر الشراء:\n${list(s.filter(t => (t.action === 'payment' || t.action === 'purchase_order') && (t.status === 'waiting' || t.status === 'scheduled'))
      .map(t => `${t.title} — ${H.sar(t.value || 0)} · ${STATUS_LABEL[t.status]}`))}`;
  }
  if (has('الوكلاء', 'اختبار')) {
    const b = new Set(s.filter(t => t.status === 'progress').map(t => t.agent)).size;
    const a = D.alerts.filter(x => x.dept === 'tech').sort((x, y) => y.at - x.at)[0];
    return `${b} وكيلًا مشغولًا الآن من ${D.org.config.agents.length}.\n${a ? `آخر تنبيه تقني: ${a.title} (${H.ago(a.at, now)})` : 'لا تنبيهات تقنية.'}`;
  }
  if (has('أتمتة')) return `الجاري في التقنية:\n${list(s.filter(t => t.dept === 'tech' && t.status === 'progress').map(t => `${t.title} · ${Math.round(t.progress)}%`))}`;
  if (has('أهداف')) return `مهام القسم الشخصي:\n${list(s.filter(t => t.dept === 'personal' && t.status === 'scheduled' && (t.at ?? 0) < now + 7 * H.DAY).map(t => `${H.rel(t.at!, now)} ${t.title}`))}`;
  return `يعمل القسم الآن على:\n${list(s.filter(t => t.dept === d && t.status === 'progress').map(t => `${t.title} · ${Math.round(t.progress)}%`))}\nلإضافة مهمة اكتب: «مهمة: …»`;
}
