import crypto from 'node:crypto';

/** Time-sortable, collision-resistant id with a readable prefix, e.g. `t_m1abc2x9f3k2`. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
}
