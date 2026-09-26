/** Safe arithmetic evaluator for the calculator tool: numbers, + - * / ^ %, parentheses. No eval. */
export function calculate(expr: string): number {
  const s = String(expr).replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[×x]/g, '*').replace(/÷/g, '/').replace(/,/g, '').replace(/\s+/g, '');
  if (s.length > 500) throw new Error('التعبير طويل جدًا');
  let i = 0;
  const peek = () => s[i];
  const num = (): number => {
    const m = /^\d+(\.\d+)?/.exec(s.slice(i));
    if (!m) throw new Error(`رمز غير متوقع عند الموضع ${i + 1}`);
    i += m[0].length; return parseFloat(m[0]);
  };
  const factor = (): number => {
    if (peek() === '-') { i++; return -factor(); }
    if (peek() === '+') { i++; return factor(); }
    let v: number;
    if (peek() === '(') { i++; v = expr0(); if (peek() !== ')') throw new Error('قوس غير مغلق'); i++; }
    else v = num();
    if (peek() === '%') { i++; v = v / 100; }
    if (peek() === '^') { i++; v = Math.pow(v, factor()); }
    return v;
  };
  const term = (): number => {
    let v = factor();
    while (peek() === '*' || peek() === '/') { const op = s[i++]; const r = factor(); v = op === '*' ? v * r : v / r; }
    return v;
  };
  const expr0 = (): number => {
    let v = term();
    while (peek() === '+' || peek() === '-') { const op = s[i++]; const r = term(); v = op === '+' ? v + r : v - r; }
    return v;
  };
  const v = expr0();
  if (i < s.length) throw new Error(`رمز غير متوقع عند الموضع ${i + 1}`);
  if (!Number.isFinite(v)) throw new Error('النتيجة غير محددة');
  return Math.round(v * 1e6) / 1e6;
}
