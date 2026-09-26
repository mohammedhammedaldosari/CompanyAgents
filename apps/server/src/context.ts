import { buildOrg, type CompanyConfig, type Org } from '@agents/domain';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from './db/db.js';
import type { Bus } from './core/bus.js';
import type { Vault } from './core/vault.js';
import type { Env } from './env.js';

export type Logger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;

/** Work the services hand to the engine after a commit. Implemented by pg-boss in production and by a stub in tests. */
export interface Jobs {
  enqueueTask(taskId: string): Promise<void>;
  /** abort an in-flight execution (cancel, reject, engine stop) */
  abortTask(taskId: string): void;
  abortAll(): void;
}

export interface Ctx {
  env: Env;
  db: Db;
  bus: Bus;
  vault: Vault;
  log: Logger;
  jobs: Jobs;
  /** read model of the currently published configuration */
  org(): Org;
  setConfig(cfg: CompanyConfig): void;
  /** debounced recomputation of department metrics (emits `metric` events) */
  refreshMetrics(): void;
}

export function makeOrgHolder(initial: CompanyConfig): { org: () => Org; set: (c: CompanyConfig) => void } {
  let org = buildOrg(initial);
  return { org: () => org, set: c => { org = buildOrg(c); } };
}
