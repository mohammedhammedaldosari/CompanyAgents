/** RFC 4180 CSV parser (quotes, escaped quotes, CRLF, BOM) with delimiter detection (, ; tab). */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^\uFEFF/, '');
  const first = s.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t'].map(d => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(x => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => x.trim() !== '')) rows.push(row);
  return rows.map(r => r.map(x => x.trim()));
}

/** "1,234.50" / "(1,234.50)" / "-1234.5 SAR" / Arabic-Indic digits → halalas. */
export function parseMoney(v: string): number | null {
  if (!v) return null;
  let s = v.replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/٫/g, '.').replace(/٬/g, ',').trim();
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[^\d.,-]/g, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  s = s.replace(/-/g, '');
  // decimal separator = the later of '.' and ',' when followed by 1–2 digits (handles 1,234.50 and 1.234,50)
  if (s.lastIndexOf(',') > s.lastIndexOf('.') && /,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!s || Number.isNaN(Number(s))) return null;
  const h = Math.round(Number(s) * 100);
  return neg ? -h : h;
}

/** yyyy-mm-dd | dd/mm/yyyy | dd-mm-yyyy | yyyy/mm/dd → 'yyyy-mm-dd' */
export function parseDay(v: string): string | null {
  const s = v.replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return null;
}
