/* Reference data — copied verbatim from spec §6, §7, §10. The first agent of each department is its manager. Money in halalas. */
import type { ActionType, DeptId, Freq, OpsDeptId, Policy, StageId, ToolDef, ConnectorMethod } from './types.js';

export type MetricSpec = number | '=approvals' | '=kpi.ordersToday' | '=lowStock' | '=stage.shipping' | '=acos' | '=busyAgents';

export interface DeptDef {
  id: DeptId;
  name: string;
  agents: string[];
  tools: string[];
  metrics: [[string, MetricSpec], [string, MetricSpec]] | null;
}

export const DEPTS_REF: readonly DeptDef[] = [
  { id: 'exec', name: 'الإدارة التنفيذية', agents: ['المدير التنفيذي', 'المساعد التنفيذي', 'التخطيط والمشاريع'],
    tools: ['gcal', 'gdrive', 'gsheets', 'gmail', 'notion', 'gtasks'], metrics: [['مهام اليوم', 14], ['قرارات بانتظارك', '=approvals']] },
  { id: 'research', name: 'البحث عن المنتجات', agents: ['مدير البحث', 'باحث المنتجات', 'السوق والمنافسين', 'تطوير المنتج'],
    tools: ['helium10', 'amazonsa', 'sellersprite', 'keepa', 'trends', 'gsheets', 'websearch', 'files'], metrics: [['منتجات قيد الدراسة', 6], ['فرص مؤهلة', 2]] },
  { id: 'amazon', name: 'أمازون', agents: ['مدير أعمال أمازون', 'عمليات أمازون', 'التسعير والربحية', 'القوائم والكلمات المفتاحية', 'المبيعات والتوقعات'],
    tools: ['sellercentral', 'amazonsa', 'helium10', 'keepa', 'gsheets', 'amazonads', 'gdrive'], metrics: [['طلبات اليوم', '=kpi.ordersToday'], ['مخزون منخفض', '=lowStock']] },
  { id: 'supply', name: 'التوريد والاستيراد', agents: ['مدير سلسلة الإمداد', 'التوريد والتفاوض', 'الاستيراد والتكلفة الواصلة', 'تخطيط المخزون'],
    tools: ['alibaba', 's1688', 'mic', 'gsources', 'websearch', 'gsheets', 'forwarders', 'calc', 'saber', 'zatca'], metrics: [['موردون قيد التفاوض', 4], ['شحنات في الطريق', '=stage.shipping']] },
  { id: 'marketing', name: 'التسويق والإعلانات', agents: ['مدير التسويق', 'الإعلانات', 'الاستراتيجية والعروض', 'المحتوى المرئي'],
    tools: ['amazonads', 'helium10', 'canva', 'ga4', 'trends', 'gsheets', 'aimedia'], metrics: [['حملات نشطة', 9], ['نسبة الإعلان للمبيعات %', '=acos']] },
  { id: 'finance', name: 'المالية', agents: ['المدير المالي', 'مالية الأعمال', 'المالية الشخصية'],
    tools: ['gsheets', 'gdrive', 'calc', 'sellercentral', 'bank'], metrics: [['هامش صافي الشهر %', 18.5], ['مصروفات الشهر', 2865000]] },
  { id: 'tech', name: 'التقنية والذكاء الاصطناعي', agents: ['مدير التقنية', 'بناء الوكلاء', 'الأتمتة وسير العمل', 'الأنظمة والبيانات', 'الجودة والاختبار'],
    tools: ['replit', 'base44', 'github', 'vercel', 'figma', 'postgres', 'gdrive', 'browser'], metrics: [['وكلاء يعملون', '=busyAgents'], ['اختبارات فاشلة', 1]] },
  { id: 'personal', name: 'الإدارة الشخصية', agents: ['مدير الإدارة الشخصية', 'التخطيط والإنتاجية', 'التعلم والتطوير'],
    tools: ['gcal', 'gtasks', 'gdrive', 'gsheets', 'files', 'notion'], metrics: [['أهداف الأسبوع', 5], ['مهامي اليوم', 7]] },
  { id: 'core', name: 'المركز', agents: ['حارس المعرفة'], tools: ['notion', 'gdrive'], metrics: null }
];

export const OPS_IDS: readonly OpsDeptId[] = ['exec', 'research', 'amazon', 'supply', 'marketing', 'finance', 'tech', 'personal'];

/** Scene placement and accent colours (spec §7). */
export const META: Record<DeptId, { x: number; z: number; top?: number; side?: number; c: string; scr: string }> = {
  exec: { x: 11, z: 11, top: 0x8a7440, side: 0x5c4d2a, c: '#FFD27A', scr: 'cal' },
  marketing: { x: 0, z: 11, top: 0x7a4f7a, side: 0x503350, c: '#FF8AD0', scr: 'line' },
  amazon: { x: 11, z: 0, top: 0xa0683a, side: 0x6b4526, c: '#FFB066', scr: 'orders' },
  personal: { x: -11, z: 11, top: 0x8a5a52, side: 0x5a3934, c: '#FFB08A', scr: 'check' },
  finance: { x: 11, z: -11, top: 0x3f7a52, side: 0x28503a, c: '#7FE0A0', scr: 'table' },
  research: { x: -11, z: 0, top: 0x2b7372, side: 0x1a4a4a, c: '#5FE0C8', scr: 'bars' },
  supply: { x: 0, z: -11, top: 0x3e62a8, side: 0x273f70, c: '#8FD3FF', scr: 'map' },
  tech: { x: -11, z: -11, top: 0x5b4f86, side: 0x3a3358, c: '#C3A6FF', scr: 'code' },
  core: { x: 0, z: 0, c: '#8FD3FF', scr: 'nodes' }
};

export const METHOD_LABEL: Record<ConnectorMethod, string> = {
  mcp: 'موصل MCP', api: 'واجهة برمجية رسمية', browser: 'متصفح آلي', import: 'استيراد ملفات', manual: 'إدخال يدوي'
};

/** Tool catalog (spec §10, §19). The first ten are the core tools shown in the header, in this order. */
export const TOOLS_REF: readonly ToolDef[] = ([
  ['gmail', 'البريد', 1, 'mail.google.com', '#EA4335', 'mcp', 2],
  ['gcal', 'التقويم', 1, 'calendar.google.com', '#4285F4', 'mcp', 2],
  ['gdrive', 'المستندات السحابية', 1, 'drive.google.com', '#0F9D58', 'mcp', 2],
  ['gsheets', 'الجداول', 1, 'sheets.google.com', '#0F9D58', 'api', 2],
  ['notion', 'قاعدة المعرفة', 1, 'notion.so', '#111111', 'mcp', 2],
  ['helium10', 'هيليوم 10', 1, 'helium10.com', '#1A2B6D', 'mcp', 2],
  ['sellercentral', 'مركز البائع', 1, 'sellercentral.amazon.sa', '#FF9900', 'api', 2],
  ['amazonads', 'إعلانات أمازون', 1, 'advertising.amazon.com', '#FF9900', 'api', 2],
  ['alibaba', 'علي بابا', 1, 'alibaba.com', '#FF6A00', 'browser', 3],
  ['websearch', 'البحث في الويب', 1, 'google.com', '#4FC3F7', 'api', 2],
  ['gtasks', 'مهام جوجل', 0, 'tasks.google.com', '#4285F4', 'api', 3],
  ['amazonsa', 'متجر أمازون السعودية', 0, 'amazon.sa', '#FF9900', 'api', 2],
  ['keepa', 'كيبا', 0, 'keepa.com', '#2E7D32', 'api', 3],
  ['sellersprite', 'سيلر سبرايت', 0, 'sellersprite.com', '#1E63D6', 'import', 3],
  ['trends', 'اتجاهات جوجل', 0, 'trends.google.com', '#4285F4', 'import', 3],
  ['s1688', '1688', 0, '1688.com', '#FF6A00', 'browser', 3],
  ['mic', 'صنع في الصين', 0, 'made-in-china.com', '#D32F2F', 'browser', 3],
  ['gsources', 'المصادر العالمية', 0, 'globalsources.com', '#1565C0', 'browser', 3],
  ['forwarders', 'شركات الشحن', 0, 'freightos.com', '#1B2A4A', 'import', 2],
  ['saber', 'سابر', 0, 'saber.sa', '#2E7D32', 'browser', 3],
  ['zatca', 'هيئة الزكاة', 0, 'zatca.gov.sa', '#1B5E20', 'manual', 3],
  ['canva', 'كانفا', 0, 'canva.com', '#7D2AE8', 'api', 3],
  ['ga4', 'تحليلات الموقع', 0, 'analytics.google.com', '#F9AB00', 'api', 3],
  ['aimedia', 'توليد الصور والفيديو', 0, 'runwayml.com', '#E91E63', 'api', 3],
  ['bank', 'كشوف البنوك', 0, 'sama.gov.sa', '#607D8B', 'import', 2],
  ['replit', 'ريبلت', 0, 'replit.com', '#F26207', 'mcp', 3],
  ['base44', 'بيس 44', 0, 'base44.com', '#111111', 'mcp', 3],
  ['github', 'جيت هب', 0, 'github.com', '#111111', 'api', 3],
  ['vercel', 'فيرسل', 0, 'vercel.com', '#111111', 'api', 3],
  ['figma', 'فيجما', 0, 'figma.com', '#A259FF', 'mcp', 3],
  ['postgres', 'قاعدة البيانات', 0, 'postgresql.org', '#336791', 'api', 2],
  ['browser', 'المتصفح الآلي', 0, 'browserbase.com', '#607D8B', 'browser', 3],
  ['files', 'ملفاتك المرفوعة', 0, '', '#F4B400', 'import', 2],
  ['calc', 'الحاسبة', 0, '', '#607D8B', 'manual', 2]
] as const).map(([id, name, core, dom, color, m, phase]) => ({ id, name, core: !!core, dom, color, m, phase }));

export type TitleSeed = readonly [string, ActionType] | readonly [string, ActionType, number];

export const TITLES: Record<DeptId, readonly TitleSeed[]> = {
  exec: [['تجهيز الإيجاز الصباحي', 'report'], ['ترتيب اجتماع مع وكيل الشحن', 'internal'], ['متابعة القرارات المعلّقة', 'internal'],
    ['تحديث خطة الربع الرابع', 'internal'], ['الرد على بريد مورد الأقمشة', 'external_email'], ['جدولة مراجعة المنتجات الأسبوعية', 'internal']],
  research: [['تحليل 40 فرصة من هيليوم 10', 'read'], ['دراسة منافسي منظم الأدراج', 'read'], ['حساب حجم الطلب لحامل الجوال', 'report'],
    ['اقتراح تحسين لتصميم الغطاء', 'internal'], ['فلترة منتجات موسم العودة للمدارس', 'read'], ['تحديث ملف الفرص المؤهلة', 'internal']],
  amazon: [['تحديث سعر منظم الأدراج', 'price_change', 4], ['معالجة حالة مرتجع لطلب متأخر', 'internal'], ['تحسين الكلمات المفتاحية لقائمة الحقيبة', 'listing_edit'],
    ['توقع مبيعات الشهر القادم', 'report'], ['مراجعة صندوق الشراء لكل المنتجات', 'read'], ['تعديل عنوان قائمة حامل الجوال', 'listing_edit'],
    ['خفض سعر الفرشاة لمواجهة منافس', 'price_change', -7]],
  supply: [['طلب عينات من ثلاثة مصانع', 'supplier_msg'], ['التفاوض على سعر 1000 قطعة', 'supplier_msg'], ['حساب التكلفة الواصلة للشحنة البحرية', 'report'],
    ['متابعة تخليص الشحنة في الميناء', 'internal'], ['اقتراح كمية إعادة الطلب لمنظم الأدراج', 'report'],
    ['إصدار أمر شراء للدفعة الثانية', 'purchase_order', 1850000], ['تجديد شهادة سابر لحامل الجوال', 'internal']],
  marketing: [['رفع ميزانية حملة منظم الأدراج', 'ad_budget', 15], ['إضافة كلمات سلبية للحملة التلقائية', 'internal'],
    ['تصميم صور المحتوى المتقدم للحقيبة', 'internal'], ['خطة عروض اليوم الوطني', 'internal'], ['تقرير أداء الإعلانات الأسبوعي', 'report'],
    ['إنتاج فيديو قصير لحامل الجوال', 'internal']],
  finance: [['تحديث التدفق النقدي الأسبوعي', 'report'], ['مطابقة تسوية أمازون الأخيرة', 'read'], ['تجهيز أرقام إقرار ضريبة القيمة المضافة', 'report'],
    ['تجهيز تحويل دفعة المورد الثانية', 'payment', 1850000], ['مراجعة الميزانية الشخصية للشهر', 'report'], ['تذكير بالالتزام الشهري', 'internal']],
  tech: [['اختبار وكيل التسعير على بيانات أمس', 'internal'], ['أتمتة تقرير المبيعات اليومي', 'internal'], ['ربط جدول المخزون بقاعدة البيانات', 'internal'],
    ['إصلاح خطأ في سير عمل التنبيهات', 'internal'], ['مراجعة سجلات تشغيل الوكلاء', 'read'], ['تحديث تعليمات وكيل القوائم', 'internal']],
  personal: [['ترتيب أولويات الغد', 'internal'], ['مراجعة أهداف الأسبوع', 'report'], ['جلسة تعلم: إعلانات أمازون المتقدمة', 'internal'],
    ['تلخيص كتاب إدارة المخزون', 'report'], ['حجز موعد الفحص الدوري للسيارة', 'internal'], ['تحديث خطة التعلم الشهرية', 'internal']],
  core: [['تنظيم ملاحظات الموردين', 'internal'], ['ربط ملاحظات المنتجات بمهامها', 'internal'], ['أرشفة نتائج الأسبوع', 'internal']]
};

export interface RoutineSeed { id: string; title: string; dept: DeptId; agent: string; freq: Freq; dow?: number; time: string; action: ActionType }

export const ROUTINES_REF: readonly RoutineSeed[] = ([
  ['r1', 'تجهيز الإيجاز الصباحي', 'exec', 'المدير التنفيذي', 'daily', null, '08:00', 'report'],
  ['r2', 'تقرير المبيعات اليومي', 'amazon', 'المبيعات والتوقعات', 'daily', null, '09:00', 'report'],
  ['r3', 'مراجعة صندوق الشراء', 'amazon', 'عمليات أمازون', 'workdays', null, '10:00', 'read'],
  ['r4', 'فحص المخزون المنخفض', 'supply', 'تخطيط المخزون', 'daily', null, '11:00', 'report'],
  ['r5', 'مراقبة أسعار المنافسين', 'amazon', 'التسعير والربحية', 'workdays', null, '12:00', 'read'],
  ['r6', 'تعديل الأسعار حسب المنافسة', 'amazon', 'التسعير والربحية', 'workdays', null, '12:30', 'price_change'],
  ['r7', 'مراجعة الإعلانات اليومية', 'marketing', 'الإعلانات', 'workdays', null, '13:00', 'read'],
  ['r8', 'تحسين ميزانيات الحملات', 'marketing', 'الإعلانات', 'weekly', 0, '14:00', 'ad_budget'],
  ['r9', 'متابعة الموردين المعلّقين', 'supply', 'التوريد والتفاوض', 'workdays', null, '10:30', 'supplier_msg'],
  ['r10', 'تتبع الشحنات', 'supply', 'الاستيراد والتكلفة الواصلة', 'workdays', null, '15:00', 'read'],
  ['r11', 'بحث الفرص الأسبوعي', 'research', 'باحث المنتجات', 'weekly', 1, '09:30', 'read'],
  ['r12', 'تقرير المنافسين الأسبوعي', 'research', 'السوق والمنافسين', 'weekly', 3, '11:00', 'report'],
  ['r13', 'التدفق النقدي الأسبوعي', 'finance', 'مالية الأعمال', 'weekly', 4, '16:00', 'report'],
  ['r14', 'أرقام ضريبة القيمة المضافة', 'finance', 'المدير المالي', 'monthly1', null, '10:00', 'report'],
  ['r15', 'مراجعة الميزانية الشخصية', 'finance', 'المالية الشخصية', 'monthly1', null, '20:00', 'report'],
  ['r16', 'فحص صحة الوكلاء', 'tech', 'الجودة والاختبار', 'daily', null, '07:00', 'read'],
  ['r17', 'تخطيط اليوم التالي', 'personal', 'التخطيط والإنتاجية', 'workdays', null, '21:00', 'internal'],
  ['r18', 'أرشفة المعرفة اليومية', 'core', 'حارس المعرفة', 'daily', null, '23:00', 'internal']
] as const).map(([id, title, dept, agent, freq, dow, time, action]) => {
  const r: RoutineSeed = { id, title, dept, agent, freq, time, action };
  if (dow != null) r.dow = dow;
  return r;
});

/** Demo products (spec §10) — [id, name, sku, stage, days in stage, cost SAR, price SAR, stock, sales7d]. Used only by the demo seed. */
export const DEMO_PRODUCTS: readonly (readonly [string, string, string, StageId, number, number, number, number, number])[] = [
  ['p1', 'منظم أدراج مطبخ قابل للتمديد', 'KD-ORG-01', 'live', 120, 21, 79, 64, 41],
  ['p2', 'حامل جوال مغناطيسي للسيارة', 'CH-MAG-02', 'live', 90, 14.5, 59, 210, 58],
  ['p3', 'حقيبة لابتوب مقاومة للماء', 'BG-LAP-03', 'live', 60, 42, 149, 18, 22],
  ['p4', 'فرشاة تنظيف كهربائية', 'BR-ELC-04', 'live', 45, 33, 99, 95, 17],
  ['p5', 'غطاء مقعد سيارة مبرّد', 'SC-COOL-05', 'shipping', 12, 52, 169, 0, 0],
  ['p6', 'منظم كابلات مكتبي', 'OF-CBL-06', 'sourcing', 24, 9, 39, 0, 0],
  ['p7', 'زجاجة ماء ذكية بمؤشر', 'DR-SMT-07', 'research', 5, 0, 0, 0, 0],
  ['p8', 'مصباح مكتب قابل للطي', 'LP-FLD-08', 'paused', 30, 26, 89, 12, 0]
];

export const POLICIES_REF: readonly Policy[] = [
  { action: 'read', label: 'قراءة البيانات', mode: 'auto' },
  { action: 'report', label: 'إعداد التقارير', mode: 'auto' },
  { action: 'internal', label: 'عمل داخلي', mode: 'auto' },
  { action: 'price_change', label: 'تغيير سعر منتج', mode: 'limit', limit: 5, unit: '%' },
  { action: 'ad_budget', label: 'تغيير ميزانية إعلان', mode: 'limit', limit: 10, unit: '%' },
  { action: 'listing_edit', label: 'تعديل قائمة منتج', mode: 'always' },
  { action: 'supplier_msg', label: 'مراسلة مورد', mode: 'always' },
  { action: 'purchase_order', label: 'أمر شراء', mode: 'always', unit: 'SAR' },
  { action: 'external_email', label: 'بريد لجهة خارجية', mode: 'always' },
  { action: 'payment', label: 'تجهيز دفعة مالية', mode: 'always', unit: 'SAR', locked: true }
];

export const ACTION_LABEL = Object.fromEntries(POLICIES_REF.map(p => [p.action, p.label])) as Record<ActionType, string>;

export interface StageDef { id: StageId; name: string; c: string; limit: number | null }
export const STAGES_REF: readonly StageDef[] = [
  { id: 'research', name: 'بحث', c: '#5FE0C8', limit: 14 },
  { id: 'sourcing', name: 'توريد', c: '#8FD3FF', limit: 21 },
  { id: 'shipping', name: 'شحن', c: '#C3A6FF', limit: 30 },
  { id: 'live', name: 'نشط', c: '#7FE0A0', limit: null },
  { id: 'paused', name: 'متوقف', c: '#7C81B3', limit: null }
];

export const NOTES_REF: readonly string[] = ['خريطة-المنتجات', 'الموردون', 'أسعار-الشحن', 'قواعد-التسعير', 'الكلمات-المفتاحية',
  'نتائج-الحملات', 'التدفق-النقدي', 'أهداف-الربع', 'سجل-القرارات', 'دليل-سابر'];

export const QUESTIONS: Record<OpsDeptId, readonly string[]> = {
  exec: ['ماذا يحتاجني اليوم؟', 'ما القرارات المعلّقة؟', 'لخّص أداء الأسبوع'],
  research: ['ما أفضل الفرص الحالية؟', 'من أقوى منافس لمنتجنا الأول؟', 'ما المنتجات قيد الدراسة؟'],
  amazon: ['كيف المبيعات اليوم؟', 'أي منتج مخزونه منخفض؟', 'هل خسرنا صندوق الشراء في شيء؟'],
  supply: ['ما الشحنات في الطريق؟', 'أين وصلنا مع الموردين؟', 'متى نعيد طلب منظم الأدراج؟'],
  marketing: ['كيف أداء الإعلانات اليوم؟', 'أي حملة تخسر؟', 'ما خطة العروض القادمة؟'],
  finance: ['كم النقد المتاح؟', 'ما هامش الربح هذا الشهر؟', 'ما المدفوعات القادمة؟'],
  tech: ['هل كل الوكلاء يعملون؟', 'ما آخر اختبار فشل؟', 'ما الأتمتة الجارية؟'],
  personal: ['ما أولوياتي اليوم؟', 'كيف تقدمي في أهداف الأسبوع؟', 'ماذا أتعلم هذا الأسبوع؟']
};

/** Routing words, checked in order; first match wins (spec §10). */
export const ROUTE_WORDS: readonly (readonly [OpsDeptId, readonly string[]])[] = [
  ['supply', ['مورد', 'مصنع', 'عينة', 'شحن', 'تخليص', 'مخزون', 'إعادة طلب', 'سابر', 'أمر شراء']],
  ['marketing', ['إعلان', 'حملة', 'صور', 'فيديو', 'عروض', 'خصم', 'محتوى']],
  ['amazon', ['سعر', 'قائمة', 'صندوق الشراء', 'مرتجع', 'أمازون', 'مبيعات', 'كلمات مفتاحية']],
  ['research', ['فرصة', 'منتج جديد', 'منافس', 'طلب السوق', 'هيليوم']],
  ['finance', ['ربح', 'نقد', 'مصروف', 'ضريبة', 'فاتورة', 'دفعة', 'ميزانية', 'تسوية']],
  ['tech', ['وكيل', 'أتمتة', 'ربط', 'قاعدة بيانات', 'اختبار', 'خطأ']],
  ['personal', ['شخصي', 'تعلم', 'هدف', 'موعد', 'كتاب', 'أولوياتي']]
];

export const STATUS_LABEL = { scheduled: 'مجدولة', progress: 'قيد التنفيذ', waiting: 'بانتظار الموافقة', done: 'منجزة', backlog: 'مؤجلة', cancelled: 'ملغاة' } as const;
export const MODEL_LABEL = { SONNET: 'سونيت', OPUS: 'أوبس', HAIKU: 'هايكو' } as const;
export const LVL_LABEL = { critical: 'حرج', warning: 'تحذير', info: 'معلومة' } as const;
export const MODE_LABEL = { auto: 'تلقائي', limit: 'بحد', always: 'دائمًا بموافقتي' } as const;
export const ON_CAP_LABEL = { alert: 'تنبيه فقط', downgrade: 'التحويل إلى هايكو', pause: 'إيقاف المهام غير الأساسية' } as const;
export const CONN_LABEL = { connected: 'متصل', simulated: 'محاكاة', needs_auth: 'يحتاج تفويضًا', connecting: 'جارٍ الربط', disabled: 'معطّل', manual: 'يدوي', unavailable: 'غير متاح' } as const;
export const SETTING_LABEL = {
  briefTime: 'وقت الإيجاز الصباحي', lowStockDays: 'حد المخزون الحرج', warnStockDays: 'حد تحذير المخزون', acosWarn: 'حد نسبة الإعلان للمبيعات',
  alertRetentionDays: 'مدة الاحتفاظ بالتنبيهات المتجاهلة', defaultModel: 'نموذج الوكلاء الجدد', managerModel: 'نموذج المدراء الجدد'
} as const;
export const MAX_AGENTS = 6;
