import crypto from 'node:crypto';
import type { Queryable } from '../db/db.js';

/**
 * Connector credentials encrypted at rest with AES-256-GCM (spec §20). The key comes from MASTER_KEY
 * (32 raw bytes as base64, or a passphrase stretched with scrypt). Secrets never leave the server.
 */
export class Vault {
  private key: Buffer;
  constructor(masterKey: string) {
    const raw = Buffer.from(masterKey, 'base64');
    this.key = raw.length === 32 ? raw : crypto.scryptSync(masterKey, 'agents-company-vault', 32);
  }
  seal(secret: string): { iv: string; tag: string; data: string } {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
    return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  }
  open(e: { iv: string; tag: string; data: string }, id = ''): string {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(e.iv, 'base64'));
      d.setAuthTag(Buffer.from(e.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf8');
    } catch {
      throw new Error(`تعذّر فك تشفير مفتاح «${id}»: MASTER_KEY لا يطابق المفتاح الذي شُفّر به`);
    }
  }
  async set(db: Queryable, id: string, secret: string): Promise<void> {
    const s = this.seal(secret);
    await db.query(`insert into secrets (id, iv, tag, data) values ($1,$2,$3,$4)
      on conflict (id) do update set iv = excluded.iv, tag = excluded.tag, data = excluded.data, updated_at = now()`, [id, s.iv, s.tag, s.data]);
  }
  async get(db: Queryable, id: string): Promise<string | null> {
    const r = await db.query<{ iv: string; tag: string; data: string }>('select iv, tag, data from secrets where id = $1', [id]);
    return r.rows[0] ? this.open(r.rows[0], id) : null;
  }
  async has(db: Queryable, id: string): Promise<boolean> {
    return (await db.query('select 1 from secrets where id = $1', [id])).rowCount! > 0;
  }
  async delete(db: Queryable, id: string): Promise<void> { await db.query('delete from secrets where id = $1', [id]); }
}
