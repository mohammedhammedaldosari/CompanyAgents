/* Versioned configuration (admin console): draft → publish as a numbered version with a change list; revert = new version. */
import {
  defaultConfig, diffConfig, validateConfig, type CompanyConfig, type ConfigHistoryEntry, type Policy
} from '@agents/domain';
import type { Ctx } from '../context.js';
import type { Queryable, Tx } from '../db/db.js';
import { bad, notFound } from '../core/errors.js';
import { audit } from './common.js';
import { ensureRoutines } from './routines.js';
import { ensureConnectorRows } from './connectors.js';

export async function currentConfig(db: Queryable): Promise<CompanyConfig | null> {
  const r = await db.query<{ config: CompanyConfig; version: number; published_at: Date; note: string; changes: string[] }>(
    'select * from config_versions order by version desc limit 1');
  const x = r.rows[0];
  return x ? { ...x.config, version: x.version, publishedAt: x.published_at.getTime(), note: x.note, changes: x.changes } : null;
}

export async function configHistory(db: Queryable, n = 15): Promise<ConfigHistoryEntry[]> {
  const r = await db.query('select * from config_versions order by version desc offset 1 limit $1', [n]);
  return r.rows.map(x => ({ version: x.version, publishedAt: x.published_at.getTime(), note: x.note, changes: x.changes,
    config: { ...x.config, version: x.version, publishedAt: x.published_at.getTime(), note: x.note, changes: x.changes } }));
}

async function insertVersion(tx: Tx, c: CompanyConfig): Promise<void> {
  const { version, publishedAt, note, changes, reassign: _r, ...rest } = c;
  await tx.query('insert into config_versions (version, config, published_at, note, changes) values ($1,$2,$3,$4,$5)',
    [version, JSON.stringify({ ...rest, version, publishedAt, note, changes }), new Date(publishedAt), note, JSON.stringify(changes)]);
}

/** First boot: the default organisation from spec §6/§10 as version 1. */
export async function initConfig(tx: Tx): Promise<CompanyConfig> {
  const c = defaultConfig(Date.now());
  await insertVersion(tx, c);
  return c;
}

const normPolicies = (p: Policy[]): Policy[] => p.map(x => (x.action === 'payment' ? { ...x, mode: 'always', locked: true } : x));

export interface PublishOptions {
  /** replaces the custom tool list (connectors added/removed from the admin console) */
  customTools?: CompanyConfig['customTools'];
  /** change lines not derivable from the diff */
  changes?: string[];
}

export async function publishConfig(ctx: Ctx, draftIn: CompanyConfig, noteIn?: string, opts: PublishOptions = {}): Promise<{ version: number; changes: string[]; moved: number }> {
  if (!draftIn || !Array.isArray(draftIn.agents) || !Array.isArray(draftIn.depts)) throw bad('إعداد غير صالح');
  const draft: CompanyConfig = structuredClone(draftIn);
  draft.agents.forEach(a => { a.name = String(a.name || '').trim(); a.tools = Array.isArray(a.tools) ? a.tools : []; });
  draft.depts.forEach(d => { d.name = String(d.name || '').trim(); });
  const re = draft.reassign || {}; delete draft.reassign;
  draft.overrides = (draft.overrides || []).filter(o => o.scope !== 'agent' || draft.agents.some(a => a.id === o.target));
  draft.policies = normPolicies(draft.policies || []);
  const errs = validateConfig(draft);
  if (errs.length) throw bad(errs[0]!);

  const out = await ctx.db.tx(async tx => {
    await tx.query('select pg_advisory_xact_lock(727002)');
    const prev = await currentConfig(tx);
    if (!prev) throw bad('لا يوجد إعداد منشور');
    const changes = [...(opts.changes || []), ...diffConfig(prev, { ...draft, reassign: re })];
    if (!changes.length) throw bad('لا تغييرات للنشر');
    const N = new Map(draft.agents.map(a => [a.id, a]));
    const mgrOf = (d: string) => (draft.agents.find(a => a.dept === d && (a.mgr || d === 'core')) || draft.agents.find(a => a.dept === 'exec' && a.mgr))!.name;
    const ren: Record<string, string> = {}, gone: Record<string, string> = {};
    prev.agents.forEach(o => {
      const n = N.get(o.id);
      if (!n) gone[o.name] = re[o.id] && N.get(re[o.id]!) ? N.get(re[o.id]!)!.name : mgrOf(o.dept);
      else if (n.name !== o.name) ren[o.name] = n.name;
    });
    const deptOf = Object.fromEntries(draft.agents.map(a => [a.name, a.dept]));
    for (const [o, n] of Object.entries(ren)) {
      for (const t of ['tasks', 'routines', 'alerts', 'events', 'usage_records', 'tool_calls']) await tx.query(`update ${t} set agent = $2 where agent = $1`, [o, n]);
    }
    let moved = 0;
    for (const [o, n] of Object.entries(gone)) {
      const r = await tx.query(`update tasks set agent = $2 where agent = $1 and status in ('scheduled','progress','waiting','backlog')`, [o, n]);
      moved += r.rowCount ?? 0;
      await tx.query('update routines set agent = $2 where agent = $1', [o, n]);
    }
    // open tasks and routines follow their agent's department
    for (const [name, dept] of Object.entries(deptOf)) {
      await tx.query(`update tasks set dept = $2 where agent = $1 and dept <> $2 and status in ('scheduled','progress','waiting','backlog')`, [name, dept]);
      await tx.query('update routines set dept = $2 where agent = $1 and dept <> $2', [name, dept]);
    }
    draft.version = prev.version + 1; draft.publishedAt = Date.now(); draft.note = (noteIn || '').trim().slice(0, 500);
    draft.changes = changes; draft.customTools = opts.customTools ?? prev.customTools ?? [];
    await insertVersion(tx, draft);
    await audit(tx, 'الإصدارات', `نشر الإصدار ${draft.version}`, draft.note || `${changes.length} تغييرات`, changes);
    tx.after(() => ctx.setConfig(draft));
    return { version: draft.version, changes, moved };
  });
  await afterConfigChange(ctx);
  return out;
}

/** Re-sync derived state and push a fresh snapshot after the organisation changed. */
export async function afterConfigChange(ctx: Ctx): Promise<void> {
  await ctx.db.tx(async tx => {
    await ensureConnectorRows(ctx, tx);
    await ensureRoutines(ctx, tx);
  });
  const { snapshot } = await import('./snapshot.js');
  const s = await snapshot(ctx);
  ctx.bus.publish([{ type: 'snapshot', state: s }, { type: 'config', config: s.config }, { type: 'policies', policies: s.policies }]);
  ctx.refreshMetrics();
}

export async function revertConfig(ctx: Ctx, version: number): Promise<{ version: number; changes: string[]; moved: number }> {
  const r = await ctx.db.query('select config from config_versions where version = $1', [version]);
  if (!r.rows[0]) throw notFound('الإصدار غير موجود');
  return publishConfig(ctx, r.rows[0].config, `تراجع إلى الإصدار ${version}`);
}

/** The ⚙ permissions window publishes a new version with the edited policies (spec §12: applies to new tasks only). */
export async function setPolicies(ctx: Ctx, policies: Policy[]): Promise<void> {
  if (!Array.isArray(policies)) throw bad('صلاحيات غير صالحة');
  const cur = ctx.org().config;
  const merged = cur.policies.map(p => {
    const n = policies.find(x => x.action === p.action);
    if (!n || p.action === 'payment') return p;
    const mode = ['auto', 'limit', 'always'].includes(n.mode) ? n.mode : p.mode;
    const out: Policy = { ...p, mode };
    if (mode === 'limit') { const l = Number(n.limit); if (!(l >= 0)) throw bad(`حد «${p.label}» غير صالح`); out.limit = l; }
    return out;
  });
  try { await publishConfig(ctx, { ...structuredClone(cur), policies: merged }, 'تعديل الصلاحيات'); }
  catch (e) { if ((e as Error).message !== 'لا تغييرات للنشر') throw e; }
}
