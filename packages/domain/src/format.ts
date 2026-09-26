/* Time and formatting helpers (spec §5, §21). Day boundaries use the process time zone;
   the server runs with TZ=Asia/Riyadh (no DST), so "today" means today in Riyadh. */

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'] as const;
export const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'] as const;

export const pad = (n: number): string => String(n).padStart(2, '0');
export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

export function dayStart(t: number): number { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
/** yyyymmdd as a number */
export function dayKey(t: number): number { const d = new Date(t); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
/** yyyy-mm-dd, for SQL date columns */
export function isoDay(t: number): string { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function monthKey(t: number): string { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
export function addDays(t: number, n: number): number { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); }
export function hm(t: number): string { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
export function isHm(s: string): boolean { return /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }
/** timestamp of HH:MM on the day containing `day` */
export function atTime(day: number, s: string): number {
  const d = new Date(day); const [h, m] = s.split(':').map(Number); d.setHours(h ?? 0, m ?? 0, 0, 0); return d.getTime();
}
export function clock(t: number): string {
  const d = new Date(t); let h = d.getHours(); const ap = h < 12 ? 'ص' : 'م'; h = h % 12 || 12;
  return `${pad(h)}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${ap}`;
}

export const num = (n: number): string => Math.round(n).toLocaleString('en-US');
/** halalas -> "1,234 ر.س" or "1.2 مليون ر.س" */
export function sar(h: number | null | undefined): string {
  const r = (h || 0) / 100;
  if (Math.abs(r) >= 1e6) return (r / 1e6).toFixed(1).replace(/\.0$/, '') + ' مليون ر.س';
  return num(r) + ' ر.س';
}
export function sarN(h: number | null | undefined): string {
  const r = (h || 0) / 100;
  if (Math.abs(r) >= 1e6) return (r / 1e6).toFixed(1).replace(/\.0$/, '') + ' مليون';
  return num(r);
}
export const sar2 = (h: number | null | undefined): string =>
  ((h || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ر.س';
export const p1 = (n: number | null | undefined): string => (Math.round((n || 0) * 10) / 10).toFixed(1);

export function rel(t: number, now = Date.now()): string {
  const d = Math.round((dayStart(t) - dayStart(now)) / DAY);
  return d === 0 ? 'اليوم' : d === 1 ? 'غدًا' : d === -1 ? 'أمس' : DAYS[new Date(t).getDay()]!;
}
export function date(t: number): string { const d = new Date(t); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
export function ago(t: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 60) return `منذ ${m} دقيقة`;
  const h = Math.round(m / 60);
  if (h < 24) return `منذ ${h} ساعة`;
  return `منذ ${Math.round(h / 24)} يوم`;
}
export const daysSince = (t: number, now = Date.now()): number => Math.max(0, Math.floor((now - t) / DAY));

/** Arabic-Indic and Persian digits -> western digits */
export const arDigits = (s: string): string =>
  String(s).replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)));
/** strip the definite article and attached prepositions (keeps at least two letters) */
export const strip = (w: string): string => w.replace(/^(وال|بال|فال|كال|لل|ال)(?=..)/, '');
export const words = (s: string): string[] => String(s).split(/[\s،,.:؛؟?!«»()\-]+/).filter(Boolean).map(strip);
export const initials = (n: string): string => n.split(' ').filter(Boolean).slice(0, 2).map(w => strip(w)[0] || '').join('');
export const slug = (s: string): string => String(s).replace(/[^؀-ۿa-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
export const esc = (s: unknown): string =>
  String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
