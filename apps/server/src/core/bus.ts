import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import type { ServerEvent } from '@agents/domain';

export type Control = { kind: 'abort'; taskId: string | '*' } | { kind: 'config' } | { kind: 'refetch' };

/**
 * Event bus. Services publish only after their transaction commits (see Db.tx).
 * `memory` serves one instance. `pg` fans events out to every instance through LISTEN/NOTIFY, so SSE clients
 * connected to any instance see every change; large events (snapshots) travel as a refetch signal instead.
 */
export class Bus {
  protected em = new EventEmitter();
  constructor() { this.em.setMaxListeners(1000); }
  publish(events: ServerEvent[]): void { this.local(events); }
  /** deliver to this instance's subscribers only */
  local(events: ServerEvent[]): void { for (const e of events) this.em.emit('event', e); }
  subscribe(fn: (e: ServerEvent) => void): () => void { this.em.on('event', fn); return () => this.em.off('event', fn); }
  /** cross-instance commands (abort a run, reload config) — local only for the memory bus */
  control(c: Control): void { this.em.emit('control', c); }
  onControl(fn: (c: Control) => void): () => void { this.em.on('control', fn); return () => this.em.off('control', fn); }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

const CHANNEL = 'agents_bus';
const MAX_PAYLOAD = 7000; // NOTIFY payloads are limited to 8000 bytes

export class PgBus extends Bus {
  readonly instance = crypto.randomBytes(6).toString('hex');
  private listener: pg.Client | null = null;
  private pool: pg.Pool;
  private stopped = false;
  constructor(private url: string, private onError: (e: unknown) => void = () => {}) { super(); this.pool = new pg.Pool({ connectionString: url, max: 2 }); }

  override async start(): Promise<void> {
    const c = new pg.Client({ connectionString: this.url });
    c.on('notification', m => {
      if (m.channel !== CHANNEL || !m.payload) return;
      try {
        const msg = JSON.parse(m.payload) as { o: string; e?: ServerEvent[]; c?: Control };
        if (msg.o === this.instance) return;
        if (msg.e) this.local(msg.e);
        if (msg.c) super.control(msg.c);
      } catch (e) { this.onError(e); }
    });
    c.on('error', e => { this.onError(e); if (!this.stopped) setTimeout(() => this.start().catch(this.onError), 2000); });
    await c.connect();
    await c.query(`listen ${CHANNEL}`);
    this.listener = c;
  }

  override async stop(): Promise<void> { this.stopped = true; await this.listener?.end().catch(() => {}); await this.pool.end().catch(() => {}); }

  private notify(body: object): void {
    this.pool.query('select pg_notify($1, $2)', [CHANNEL, JSON.stringify({ o: this.instance, ...body })]).catch(this.onError);
  }

  override publish(events: ServerEvent[]): void {
    this.local(events);
    const small: ServerEvent[] = []; let refetch = false;
    for (const e of events) {
      if (e.type === 'snapshot') { refetch = true; continue; }
      if (Buffer.byteLength(JSON.stringify(e)) > MAX_PAYLOAD) { refetch = true; continue; }
      small.push(e);
    }
    let batch: ServerEvent[] = []; let size = 0;
    for (const e of small) {
      const n = Buffer.byteLength(JSON.stringify(e));
      if (size + n > MAX_PAYLOAD && batch.length) { this.notify({ e: batch }); batch = []; size = 0; }
      batch.push(e); size += n;
    }
    if (batch.length) this.notify({ e: batch });
    if (refetch) this.notify({ c: { kind: 'refetch' } });
  }

  override control(c: Control): void { super.control(c); this.notify({ c }); }
}
