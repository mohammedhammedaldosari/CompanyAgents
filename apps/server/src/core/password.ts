import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** scrypt$N$r$p$salt$hash — memory-hard password hashing (no native dependency). */
export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw.normalize('NFKC'), salt, 32, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${h.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const h = await scrypt(pw.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, { N: +N!, r: +r!, p: +p!, maxmem: 64 * 1024 * 1024 });
  return h.length === expected.length && crypto.timingSafeEqual(h, expected);
}

export const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (): string => crypto.randomBytes(32).toString('base64url');

/** Minimum strength for the single owner account (spec §20: strong password). */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 12) return 'كلمة المرور يجب ألا تقل عن 12 حرفًا';
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  if (kinds < 3 && pw.length < 20) return 'استخدم مزيجًا من الأحرف الكبيرة والصغيرة والأرقام والرموز، أو عبارة من 20 حرفًا فأكثر';
  return null;
}
