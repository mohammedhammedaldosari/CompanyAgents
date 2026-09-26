/* Browser runtime shared by the UI modules: the reference catalog and business helpers come from @agents/domain
   (the same code the server runs); this module only adds the live, mutable view of the published configuration
   (departments, agents, settings) that the scene and panels read while rendering. */
import * as D from '@agents/domain';

/** The browser only ever talks to the server (live adapter). */
export const CONFIG = { mode: 'live', apiBase: '' };

export const H = {
  ...D.H,
  at: D.H.atTime,
  hmMs: s => { const [h, m] = s.split(':').map(Number); return (h * 60 + m) * 60000; },
  rand: (a, b) => a + Math.random() * (b - a),
  randi: (a, b) => Math.floor(a + Math.random() * (b - a + 1)),
  pick: a => a[Math.floor(Math.random() * a.length)]
};

export const clone = o => (o == null ? o : JSON.parse(JSON.stringify(o)));
export const reduced = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();

export const {
  META, METHOD_LABEL: METHOD, TITLES, POLICIES_REF: POLICIES, ACTION_LABEL, NOTES_REF: NOTES, QUESTIONS, ROUTE_WORDS,
  STATUS_LABEL, MODEL_LABEL, LVL_LABEL, MODE_LABEL, ON_CAP_LABEL, CONN_LABEL, SETTING_LABEL, MAX_AGENTS,
  runsOn, cover, margin, validateConfig, diffConfig, defaultConfig, defaultRole, DEFAULT_INSTRUCTIONS: DEFAULT_INSTR
} = D;

/** Relative model price used only to rank cost in the admin UI (the server computes the real cost). */
export const MODEL_COST = { HAIKU: 4, SONNET: 15, OPUS: 75 };
export const FREQ_LABEL = r => (r.freq === 'daily' ? 'كل يوم' : r.freq === 'workdays' ? 'أيام العمل' : r.freq === 'weekly' ? 'كل ' + H.DAYS[r.dow || 0] : 'أول كل شهر');
export const polDesc = p => (p ? (p.mode === 'limit' ? 'بحد ' + p.limit + (p.unit === 'SAR' ? ' ر.س' : '%') : MODE_LABEL[p.mode]) : '—');

/* ---------- live, mutable organisation view (rebuilt by applyConfig) ---------- */

export const BASE_DEPTS = clone(D.DEPTS_REF);
export const BASE_SETTINGS = clone(D.BASE_SETTINGS);
export const DEPTS = clone(D.DEPTS_REF).map(d => ({ ...d, enabled: true }));
export const DEPT = Object.fromEntries(DEPTS.map(d => [d.id, d]));
export const OPS = DEPTS.filter(d => d.id !== 'core');
export const AGENT_DEPT = {};
export const AGENT_META = {};
export const SETTINGS = clone(D.BASE_SETTINGS);
export const STAGES = clone(D.STAGES_REF);
export const STAGE = Object.fromEntries(STAGES.map(s => [s.id, s]));
export const TOOLS = D.TOOLS_REF.map(t => ({ ...t }));
export const TOOL = Object.fromEntries(TOOLS.map(t => [t.id, t]));
export const CORE_TOOLS = TOOLS.filter(t => t.core).map(t => t.id);
DEPTS.forEach(d => d.agents.forEach(a => { AGENT_DEPT[a] = d.id; }));

export const isMgr = a => { const d = DEPT[AGENT_DEPT[a]]; return !!d && d.id !== 'core' && d.agents[0] === a; };

/** Mirrors a published configuration into the live view (same derivation as buildOrg on the server). */
export function applyConfig(cfg) {
  if (!cfg) return;
  (cfg.customTools || []).forEach(t => { if (!TOOL[t.id]) { const x = { ...t }; TOOLS.push(x); TOOL[t.id] = x; } });
  for (const id of Object.keys(TOOL)) if (TOOL[id].custom && !(cfg.customTools || []).some(t => t.id === id)) { TOOLS.splice(TOOLS.indexOf(TOOL[id]), 1); delete TOOL[id]; }
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

const GLYPH = {
  files: '<svg viewBox="0 0 16 16" width="15" height="15"><path d="M1.5 4.5h5l1.5 1.5h6.5v7h-13z" fill="#F4B400" stroke="#b58300" stroke-width=".8"/></svg>',
  calc: '<svg viewBox="0 0 16 16" width="15" height="15"><rect x="3" y="1.5" width="10" height="13" rx="1.6" fill="#607D8B"/><rect x="4.5" y="3" width="7" height="3" rx=".6" fill="#dfe6ea"/><g fill="#fff"><circle cx="5.7" cy="8.6" r=".9"/><circle cx="8" cy="8.6" r=".9"/><circle cx="10.3" cy="8.6" r=".9"/><circle cx="5.7" cy="11.5" r=".9"/><circle cx="8" cy="11.5" r=".9"/><circle cx="10.3" cy="11.5" r=".9"/></g></svg>'
};
export const toolIcon = t => (t.dom
  ? `<img src="https://www.google.com/s2/favicons?domain=${t.dom}&sz=64" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"><span class="fb" style="background:${t.color}">${H.esc(t.name.replace(/^ال/, '')[0])}</span>`
  : (GLYPH[t.id] || `<span class="fb" style="display:grid;background:${t.color}">${H.esc(t.name[0])}</span>`));
