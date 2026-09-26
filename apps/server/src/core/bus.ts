import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@agents/domain';

/**
 * In-process event bus. Services publish only after their transaction commits (see Db.tx).
 * Scaling to several instances means swapping this for Postgres LISTEN/NOTIFY or Redis without touching services.
 */
export class Bus {
  private em = new EventEmitter();
  constructor() { this.em.setMaxListeners(1000); }
  publish(events: ServerEvent[]): void { for (const e of events) this.em.emit('event', e); }
  subscribe(fn: (e: ServerEvent) => void): () => void { this.em.on('event', fn); return () => this.em.off('event', fn); }
}
