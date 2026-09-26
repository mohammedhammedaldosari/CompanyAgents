/* Browser runtime shared by the UI modules: the reference catalog and business helpers come from @agents/domain
   (the same code the server runs); this module only adds the live, mutable view of the published configuration
   (departments, agents, settings) that the scene and panels read while rendering. */
import * as D from '@agents/domain';
import type { AgentConfig, CompanyConfig, DeptId, ModelKey, Policy, Routine, Settings, ToolDef } from '@agents/domain';

/** The browser only ever talks to the server (live adapter). */
export const CONFIG = { mode: 'live' as const, apiBase: '' };

export const H = {
  ...D.H,
  at: D.H.atTime,
  hmMs: (s: string): number => { const [h = 0, m = 0] = s.split(':').map(Number); return (h * 60 + m) * 60000; },
  rand: (a: number, b: number): number => a + Math.random() * (b - a),
  randi: (a: number, b: number): number => Math.floor(a + Math.random() * (b - a + 1)),
  pick: <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)]!
};

export const clone = <T>(o: T): T => (o == null ? o : JSON.parse(JSON.stringify(o)) as T);
export const reduced: boolean = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();

export const META = D.META;
export const METHOD = D.METHOD_LABEL;
export const TITLES = D.TITLES;
export const POLICIES: readonly Policy[] = D.POLICIES_REF;
export const ACTION_LABEL = D.ACTION_LABEL;
export const NOTES = D.NOTES_REF;
export const QUESTIONS = D.QUESTIONS;
export const ROUTE_WORDS = D.ROUTE_WORDS;
export const STATUS_LABEL = D.STATUS_LABEL;
export const MODEL_LABEL = D.MODEL_LABEL;
export const LVL_LABEL = D.LVL_LABEL;
export const MODE_LABEL = D.MODE_LABEL;
export const ON_CAP_LABEL = D.ON_CAP_LABEL;
export const CONN_LABEL = D.CONN_LABEL;
export const SETTING_LABEL = D.SETTING_LABEL;
export const MAX_AGENTS = D.MAX_AGENTS;
export const DEFAULT_INSTR = D.DEFAULT_INSTRUCTIONS;
export const { runsOn, cover, margin, validateConfig, diffConfig, defaultConfig, defaultRole } = D;

/** Relative model price used only to rank cost in the admin UI (the server computes the real cost). */
export const MODEL_COST: Record<ModelKey, number> = { HAIKU: 4, SONNET: 15, OPUS: 75 };
export const FREQ_LABEL = (r: Pick<Routine, 'freq' | 'dow'>): string =>
  (r.freq === 'daily' ? 'كل يوم' : r.freq === 'workdays' ? 'أيام العمل' : r.freq === 'weekly' ? `كل ${H.DAYS[r.dow || 0]}` : 'أول كل شهر');
export const polDesc = (p: Policy | undefined): string =>
  (p ? (p.mode === 'limit' ? `بحد ${p.limit}${p.unit === 'SAR' ? ' ر.س' : '%'}` : MODE_LABEL[p.mode]) : '—');

/* ---------- live, mutable organisation view (rebuilt by applyConfig) ---------- */

export interface LiveDept { id: DeptId; name: string; agents: string[]; tools: string[]; metrics: D.DeptDef['metrics']; enabled: boolean }

export const BASE_DEPTS = clone(D.DEPTS_REF);
export const BASE_SETTINGS: Settings = clone(D.BASE_SETTINGS);
export const DEPTS: LiveDept[] = clone(D.DEPTS_REF).map(d => ({ ...d, agents: [...d.agents], tools: [...d.tools], enabled: true }));
export const DEPT = Object.fromEntries(DEPTS.map(d => [d.id, d])) as Record<DeptId, LiveDept>;
export const OPS: LiveDept[] = DEPTS.filter(d => d.id !== 'core');
export const AGENT_DEPT: Record<string, DeptId> = {};
export const AGENT_META: Record<string, AgentConfig> = {};
export const SETTINGS: Settings = clone(D.BASE_SETTINGS);
export const STAGES: D.StageDef[] = clone([...D.STAGES_REF]);
export const STAGE = Object.fromEntries(STAGES.map(s => [s.id, s])) as Record<string, D.StageDef>;
export const TOOLS: ToolDef[] = D.TOOLS_REF.map(t => ({ ...t }));
export const TOOL: Record<string, ToolDef> = Object.fromEntries(TOOLS.map(t => [t.id, t]));
export const CORE_TOOLS: string[] = TOOLS.filter(t => t.core).map(t => t.id);
DEPTS.forEach(d => d.agents.forEach(a => { AGENT_DEPT[a] = d.id; }));

export const isMgr = (a: string): boolean => { const d = DEPT[AGENT_DEPT[a]!]; return !!d && d.id !== 'core' && d.agents[0] === a; };

/** Mirrors a published configuration into the live view (same derivation as buildOrg on the server). */
export function applyConfig(cfg: CompanyConfig | null): void {
  if (!cfg) return;
  (cfg.customTools || []).forEach(t => { if (!TOOL[t.id]) { const x = { ...t }; TOOLS.push(x); TOOL[t.id] = x; } });
  for (const id of Object.keys(TOOL)) {
    const t = TOOL[id]!;
    if (t.custom && !(cfg.customTools || []).some(c => c.id === id)) { TOOLS.splice(TOOLS.indexOf(t), 1); delete TOOL[id]; }
  }
  const org = D.buildOrg(cfg);
  org.depts.forEach(v => { const d = DEPT[v.id]; if (!d) return; d.name = v.name; d.tools = v.tools.filter(x => TOOL[x]); d.enabled = v.enabled; d.agents = v.agents.slice(); });
  Object.keys(AGENT_DEPT).forEach(k => delete AGENT_DEPT[k]);
  Object.keys(AGENT_META).forEach(k => delete AGENT_META[k]);
  DEPTS.forEach(d => d.agents.forEach(a => { AGENT_DEPT[a] = d.id; }));
  cfg.agents.forEach(a => { AGENT_META[a.name] = a; });
  Object.assign(SETTINGS, org.settings);
  STAGES.forEach(s => { s.limit = org.stage(s.id).limit; });
}

/* ---------- tool icons: real favicons with a drawn fallback (spec §10) ---------- */

const GLYPH: Record<string, string> = {
  files: '<svg viewBox="0 0 16 16" width="15" height="15"><path d="M1.5 4.5h5l1.5 1.5h6.5v7h-13z" fill="#F4B400" stroke="#b58300" stroke-width=".8"/></svg>',
  calc: '<svg viewBox="0 0 16 16" width="15" height="15"><rect x="3" y="1.5" width="10" height="13" rx="1.6" fill="#607D8B"/><rect x="4.5" y="3" width="7" height="3" rx=".6" fill="#dfe6ea"/><g fill="#fff"><circle cx="5.7" cy="8.6" r=".9"/><circle cx="8" cy="8.6" r=".9"/><circle cx="10.3" cy="8.6" r=".9"/><circle cx="5.7" cy="11.5" r=".9"/><circle cx="8" cy="11.5" r=".9"/><circle cx="10.3" cy="11.5" r=".9"/></g></svg>'
};
export const toolIcon = (t: ToolDef): string => (t.dom
  ? `<img src="https://www.google.com/s2/favicons?domain=${t.dom}&sz=64" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"><span class="fb" style="background:${t.color}">${H.esc(t.name.replace(/^ال/, '')[0])}</span>`
  : (GLYPH[t.id] || `<span class="fb" style="display:grid;background:${t.color}">${H.esc(t.name[0])}</span>`));
