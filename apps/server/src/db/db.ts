import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { ServerEvent } from '@agents/domain';

// int8 (bigint) money columns fit safely in a JS number (halalas < 2^53)
pg.types.setTypeParser(20, v => Number(v));

export type Queryable = Pick<pg.PoolClient, 'query'>;

/** A unit of work: one SQL transaction plus the events to publish after it commits. */
export interface Tx extends Queryable {
  emit(e: ServerEvent): void;
  /** runs after a successful commit (e.g. enqueue jobs, publish derived events) */
  after(fn: () => void | Promise<void>): void;
}

export interface Db {
  pool: pg.Pool;
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<pg.QueryResult<R>>;
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createDb(url: string, publish: (events: ServerEvent[]) => void, onError?: (e: unknown) => void): Db {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  pool.on('error', e => onError?.(e));
  return {
    pool,
    query: (sql, params) => pool.query(sql, params as unknown[]),
    async tx(fn) {
      const client = await pool.connect();
      const events: ServerEvent[] = []; const afters: (() => void | Promise<void>)[] = [];
      const tx: Tx = { query: client.query.bind(client) as Tx['query'], emit: e => events.push(e), after: f => afters.push(f) };
      try {
        await client.query('begin');
        const out = await fn(tx);
        await client.query('commit');
        client.release();
        if (events.length) publish(events);
        for (const f of afters) { try { await f(); } catch (e) { onError?.(e); } }
        return out;
      } catch (e) {
        await client.query('rollback').catch(() => {});
        client.release();
        throw e;
      }
    },
    close: () => pool.end()
  };
}

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Applies numbered .sql migrations once each, under an advisory lock (safe with several instances). */
export async function migrate(db: Db, log: (m: string) => void = () => {}): Promise<number> {
  const client = await db.pool.connect();
  try {
    await client.query('select pg_advisory_lock(727001)');
    await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await client.query<{ name: string }>('select name from schema_migrations')).rows.map(r => r.name));
    const files = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
    let n = 0;
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [f]);
        await client.query('commit');
      } catch (e) { await client.query('rollback'); throw new Error(`فشل الترحيل ${f}: ${(e as Error).message}`); }
      log(`✓ ترحيل ${f}`); n++;
    }
    return n;
  } finally {
    await client.query('select pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}
