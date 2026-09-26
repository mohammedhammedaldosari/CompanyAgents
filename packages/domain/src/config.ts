/* Company configuration (structure, agents, settings, policies, budget) and the read model derived from it. */
import {
  DEPTS_REF, MAX_AGENTS, MODEL_LABEL, ON_CAP_LABEL, POLICIES_REF, SETTING_LABEL, STAGES_REF, TOOLS_REF,
  type DeptDef, type MetricSpec, type StageDef
} from './catalog.js';
import { sar } from './format.js';
import type { AgentConfig, CompanyConfig, DeptConfig, DeptId, ModelKey, Policy, Settings, ToolDef } from './types.js';

export const BASE_SETTINGS: Settings = {
  briefTime: '08:00', lowStockDays: 10, warnStockDays: 20, acosWarn: 25, alertRetentionDays: 7,
  stageLimits: { research: 14, sourcing: 21, shipping: 30 }, defaultModel: 'SONNET', managerModel: 'OPUS'
};

export const DEFAULT_INSTRUCTIONS =
  '- اقرأ الملاحظات المرتبطة في العقل قبل البدء.\n- التزم بصلاحيات الشركة، ولا تنفذ فعلًا يحتاج موافقة المالك.\n- اكتب النتيجة بالعربية، مختصرة وبالأرقام.';

export function defaultRole(agent: string, d: { id: DeptId; name: string }, mgr: boolean): string {
  if (mgr) return `يقود ${d.name}، يوزّع العمل على الفريق ويرفع القرارات للمالك.`;
  if (d.id === 'core') return 'يحفظ معرفة الشركة وينظمها ويربط الملاحظات بالمهام والمنتجات.';
  return `مختص «${agent}» ضمن ${d.name}.`;
}

const clone = <T>(o: T): T => structuredClone(o);

export function defaultConfig(now = Date.now()): CompanyConfig {
  let n = 0;
  return {
    version: 1, publishedAt: now, note: 'الإعداد الأولي', changes: [],
    depts: DEPTS_REF.map(d => ({ id: d.id, name: d.name, enabled: true, tools: d.tools.slice() })),
    agents: DEPTS_REF.flatMap(d => d.agents.map((a, i): AgentConfig => {
      const mgr = i === 0 && d.id !== 'core';
      return { id: `ag${++n}`, name: a, dept: d.id, mgr, role: defaultRole(a, d, mgr), instructions: DEFAULT_INSTRUCTIONS,
        model: mgr ? 'OPUS' : 'SONNET', tools: d.tools.slice(), status: 'active' };
    })),
    settings: clone(BASE_SETTINGS), policies: clone(POLICIES_REF) as Policy[], overrides: [],
    budget: { monthlyCap: 300000, warnAt: 80, onCap: 'downgrade' }, customTools: []
  };
}

/* ---------- read model ---------- */

export interface DeptView {
  id: DeptId;
  name: string;
  enabled: boolean;
  tools: string[];
  /** agent names, manager first */
  agents: string[];
  metrics: DeptDef['metrics'];
}

export interface Org {
  config: CompanyConfig;
  depts: DeptView[];
  settings: Settings;
  stages: StageDef[];
  tools: ToolDef[];
  dept(id: DeptId): DeptView;
  tool(id: string): ToolDef | undefined;
  stage(id: string): StageDef;
  deptOf(agent: string): DeptId | undefined;
  agent(name: string): AgentConfig | undefined;
  isMgr(agent: string): boolean;
  /** manager (or the single core agent) of a department */
  manager(id: DeptId): string;
  /** specialists (every agent but the manager; the manager alone when it is the only one) */
  specialists(id: DeptId): string[];
  deptOn(id: DeptId): boolean;
  agentOn(name: string): boolean;
  metricSpec(id: DeptId, i: 0 | 1): MetricSpec | undefined;
}

export function buildOrg(cfg: CompanyConfig): Org {
  const tools: ToolDef[] = [...TOOLS_REF.map(t => ({ ...t })), ...(cfg.customTools || []).filter(t => !TOOLS_REF.some(r => r.id === t.id))];
  const toolMap = new Map(tools.map(t => [t.id, t]));
  const settings: Settings = { ...clone(BASE_SETTINGS), ...(cfg.settings || {}) };
  settings.stageLimits = { ...BASE_SETTINGS.stageLimits, ...(cfg.settings?.stageLimits || {}) };
  const stages = STAGES_REF.map(s => ({ ...s, limit: s.id in settings.stageLimits ? settings.stageLimits[s.id as keyof Settings['stageLimits']] : s.limit }));
  const refById = new Map(DEPTS_REF.map(d => [d.id, d]));
  const depts: DeptView[] = DEPTS_REF.map(ref => {
    const c: DeptConfig = cfg.depts.find(x => x.id === ref.id) || { id: ref.id, name: ref.name, enabled: true, tools: ref.tools.slice() };
    const agents = cfg.agents.filter(a => a.dept === ref.id).sort((a, b) => Number(b.mgr) - Number(a.mgr)).map(a => a.name);
    return { id: ref.id, name: c.name, enabled: c.enabled !== false, tools: c.tools.filter(x => toolMap.has(x)), agents, metrics: ref.metrics };
  });
  const deptMap = new Map(depts.map(d => [d.id, d]));
  const agentMap = new Map(cfg.agents.map(a => [a.name, a]));
  const deptOfAgent = new Map<string, DeptId>();
  depts.forEach(d => d.agents.forEach(a => deptOfAgent.set(a, d.id)));

  const org: Org = {
    config: cfg, depts, settings, stages, tools,
    dept: id => deptMap.get(id)!,
    tool: id => toolMap.get(id),
    stage: id => stages.find(s => s.id === id) || stages[0]!,
    deptOf: a => deptOfAgent.get(a),
    agent: n => agentMap.get(n),
    isMgr: a => { const d = deptOfAgent.get(a); return !!d && d !== 'core' && deptMap.get(d)!.agents[0] === a; },
    manager: id => { const d = deptMap.get(id)!; return d.agents[0] || deptMap.get('exec')!.agents[0]!; },
    specialists: id => { const a = deptMap.get(id)!.agents; return a.length > 1 ? a.slice(1) : a.slice(); },
    deptOn: id => deptMap.get(id)?.enabled !== false,
    agentOn: n => agentMap.get(n)?.status !== 'paused',
    metricSpec: (id, i) => refById.get(id)?.metrics?.[i]?.[1]
  };
  return org;
}

/* ---------- validation & diff (admin console, spec README §admin) ---------- */

export function validateConfig(c: CompanyConfig): string[] {
  const E: string[] = []; const names = new Set<string>();
  c.depts.forEach(d => {
    if (!d.name.trim()) E.push('اسم قسم فارغ');
    const ags = c.agents.filter(a => a.dept === d.id);
    if (!ags.length) E.push(`قسم «${d.name}» بلا وكلاء`);
    if (ags.length > MAX_AGENTS) E.push(`قسم «${d.name}» تجاوز ${MAX_AGENTS} وكلاء`);
    if (d.id !== 'core' && ags.filter(a => a.mgr).length !== 1) E.push(`قسم «${d.name}» يحتاج مديرًا واحدًا`);
  });
  const dn = c.depts.map(d => d.name.trim());
  if (new Set(dn).size !== dn.length) E.push('أسماء الأقسام مكررة');
  c.agents.forEach(a => {
    const n = a.name.trim();
    if (!n) E.push('وكيل بلا مسمى');
    else if (n.length > 40) E.push(`المسمى «${n.slice(0, 20)}…» أطول من 40 حرفًا`);
    else if (names.has(n)) E.push(`المسمى «${n}» مكرر`);
    names.add(n);
    if (!['SONNET', 'OPUS', 'HAIKU'].includes(a.model)) E.push(`نموذج غير معروف للوكيل «${n}»`);
  });
  const s = c.settings;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.briefTime)) E.push('وقت الإيجاز غير صالح');
  if (!(s.lowStockDays > 0 && s.warnStockDays > s.lowStockDays)) E.push('حد تحذير المخزون يجب أن يكون أكبر من الحد الحرج');
  if (!(s.acosWarn > 0 && s.acosWarn < 100)) E.push('حد نسبة الإعلان بين 1 و99');
  if (!(s.alertRetentionDays >= 1)) E.push('مدة الاحتفاظ بالتنبيهات يوم واحد على الأقل');
  Object.entries(s.stageLimits).forEach(([k, v]) => { if (!(v > 0)) E.push(`حد مرحلة ${STAGES_REF.find(x => x.id === k)?.name ?? k} غير صالح`); });
  if (!(c.budget.monthlyCap > 0)) E.push('السقف الشهري يجب أن يكون أكبر من صفر');
  if (!(c.budget.warnAt > 0 && c.budget.warnAt < 100)) E.push('نسبة تنبيه الاستهلاك بين 1 و99');
  c.policies.forEach(p => { if (p.mode === 'limit' && !((p.limit ?? -1) >= 0)) E.push(`حد «${p.label}» غير صالح`); });
  (c.overrides || []).forEach(o => {
    if (!o.target) E.push('استثناء صلاحية بلا جهة');
    else if (o.scope === 'agent' && !c.agents.some(a => a.id === o.target)) E.push('استثناء لوكيل محذوف');
  });
  return E;
}

const MODEL_NAME = (m: string) => (MODEL_LABEL as Record<string, string>)[m] ?? m;
const polDesc = (p: Policy | undefined): string =>
  p ? (p.mode === 'limit' ? `بحد ${p.limit}${p.unit === 'SAR' ? ' ر.س' : '%'}` : ({ auto: 'تلقائي', limit: 'بحد', always: 'دائمًا بموافقتي' })[p.mode]) : '—';

/** Human-readable change list between two configs (drives the publish review and the version history). */
export function diffConfig(a: CompanyConfig | null, b: CompanyConfig | null): string[] {
  if (!a || !b) return [];
  const C: string[] = [];
  const toolName = (id: string) => TOOLS_REF.find(t => t.id === id)?.name ?? [...(a.customTools || []), ...(b.customTools || [])].find(t => t.id === id)?.name ?? id;
  const dn = (id: string) => (b.depts.find(d => d.id === id) || a.depts.find(d => d.id === id) || { name: id }).name;
  b.depts.forEach(d => {
    const o = a.depts.find(x => x.id === d.id); if (!o) return;
    if (o.name !== d.name) C.push(`تغيير اسم «${o.name}» إلى «${d.name}»`);
    if ((o.enabled !== false) !== (d.enabled !== false)) C.push((d.enabled !== false ? 'تفعيل ' : 'تعطيل ') + d.name);
    d.tools.filter(t => !o.tools.includes(t)).forEach(t => C.push(`إضافة ${toolName(t)} إلى ${d.name}`));
    o.tools.filter(t => !d.tools.includes(t)).forEach(t => C.push(`إزالة ${toolName(t)} من ${d.name}`));
  });
  const A = new Map(a.agents.map(x => [x.id, x])); const B = new Set(b.agents.map(x => x.id));
  b.agents.forEach(g => {
    const o = A.get(g.id);
    if (!o) { C.push(`إضافة وكيل «${g.name}» إلى ${dn(g.dept)}`); return; }
    if (o.name !== g.name) C.push(`تغيير مسمى «${o.name}» إلى «${g.name}»`);
    if (o.dept !== g.dept) C.push(`نقل «${g.name}» من ${dn(o.dept)} إلى ${dn(g.dept)}`);
    if (!o.mgr && g.mgr) C.push(`تعيين «${g.name}» مديرًا لـ${dn(g.dept)}`);
    if (o.model !== g.model) C.push(`نموذج «${g.name}»: ${MODEL_NAME(o.model)} إلى ${MODEL_NAME(g.model)}`);
    if (o.status !== g.status) C.push(`${g.status === 'paused' ? 'إيقاف ' : 'تشغيل '}«${g.name}»`);
    if (o.role !== g.role || o.instructions !== g.instructions) C.push(`تعديل دور وتعليمات «${g.name}»`);
    if (o.tools.slice().sort().join() !== g.tools.slice().sort().join()) C.push(`تعديل أدوات «${g.name}»`);
  });
  a.agents.filter(x => !B.has(x.id)).forEach(x => {
    const to = b.reassign?.[x.id]; const t = to ? b.agents.find(y => y.id === to) : undefined;
    C.push(`حذف «${x.name}»${t ? ` وإسناد مهامه إلى «${t.name}»` : ''}`);
  });
  (Object.keys(SETTING_LABEL) as (keyof typeof SETTING_LABEL)[]).forEach(k => {
    const x = a.settings[k], y = b.settings[k];
    if (x !== y) C.push(`${SETTING_LABEL[k]}: ${MODEL_NAME(String(x))} إلى ${MODEL_NAME(String(y))}`);
  });
  STAGES_REF.forEach(s => {
    const key = s.id as keyof Settings['stageLimits'];
    const x = a.settings.stageLimits?.[key], y = b.settings.stageLimits?.[key];
    if (x != null && x !== y) C.push(`حد مرحلة ${s.name}: ${x} إلى ${y} يومًا`);
  });
  b.policies.forEach(p => {
    const o = a.policies.find(x => x.action === p.action);
    if (o && (o.mode !== p.mode || (p.mode === 'limit' && o.limit !== p.limit))) C.push(`صلاحية «${p.label}»: ${polDesc(o)} إلى ${polDesc(p)}`);
  });
  if (JSON.stringify(a.overrides || []) !== JSON.stringify(b.overrides || [])) C.push(`تعديل استثناءات الصلاحيات (${(b.overrides || []).length})`);
  const x = a.budget, y = b.budget;
  if (x.monthlyCap !== y.monthlyCap) C.push(`السقف الشهري للنماذج: ${sar(x.monthlyCap)} إلى ${sar(y.monthlyCap)}`);
  if (x.warnAt !== y.warnAt) C.push(`تنبيه الاستهلاك: ${x.warnAt}% إلى ${y.warnAt}%`);
  if (x.onCap !== y.onCap) C.push(`عند بلوغ السقف: ${ON_CAP_LABEL[y.onCap]}`);
  return C;
}

export function modelFor(org: Org, agent: string): ModelKey {
  const m = org.agent(agent)?.model;
  return m ?? (org.isMgr(agent) ? 'OPUS' : 'SONNET');
}
