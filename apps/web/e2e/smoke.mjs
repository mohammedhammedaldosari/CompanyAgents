/* End-to-end smoke test against a running server (default http://localhost:8080) with the demo seed.
   Usage: E2E_URL=http://localhost:8080 E2E_PASSWORD=... pnpm --filter @agents/web e2e
   Uses a system Chromium when CHROMIUM_PATH is set (e.g. /opt/pw-browsers/chromium). */
import { chromium } from 'playwright';

const url = process.env.E2E_URL || 'http://localhost:8080';
const password = process.env.E2E_PASSWORD || '';
const shots = process.env.E2E_SHOTS || '';
const fail = m => { console.error('✗ ' + m); process.exitCode = 1; };
const ok = m => console.log('✓ ' + m);
const check = (cond, pass, failMsg) => { if (cond) ok(pass); else fail(failMsg); };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Riyadh', locale: 'ar-SA' });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto(url);
  await page.waitForSelector('#lg-t', { timeout: 15000 });
  await page.fill('#lg-t', 'not-the-password'); await page.click('#lg-go');
  await page.waitForSelector('#login .bad', { timeout: 5000 }); ok('wrong password is rejected');
  await page.fill('#lg-t', password); await page.click('#lg-go');
  await page.waitForSelector('#boot.gone', { timeout: 20000 }); ok('signed in and loaded the state');
  await page.waitForTimeout(1500);
  if (await page.locator('#modal.open').count()) { await page.keyboard.press('Escape'); ok('morning brief opened automatically'); }
  const cards = await page.locator('.dcard').count();
  check(cards === 8, '8 department cards', `expected 8 department cards, got ${cards}`);
  const tools = await page.locator('#tools .tool').count();
  check(tools === 10, '10 core tools in the header', `expected 10 header tools, got ${tools}`);
  if (shots) await page.screenshot({ path: `${shots}/overview.png` });
  await page.locator('.dcard').nth(2).click(); await page.waitForTimeout(1200);
  check((await page.textContent('#left')).includes('مدير'), 'department panel opens on focus', 'department panel missing');
  await page.fill('#c-text', 'اختبار آلي: مراجعة الملاحظات'); await page.keyboard.press('Control+Enter'); await page.waitForTimeout(1500);
  check((await page.textContent('#tasklist')).includes('اختبار آلي'), 'task created through the composer', 'created task not listed');
  await page.keyboard.press('Escape');
  await page.click('#prodbtn'); await page.waitForSelector('#products.open .kan');
  check((await page.locator('#products .kcol').count()) === 5, 'products board has 5 stages', 'products board');
  await page.click('#calbtn'); await page.waitForSelector('#cal.open .mgrid'); ok('calendar opens');
  await page.click('#policybtn'); await page.waitForSelector('#admin.open'); ok('admin console opens');
  if (shots) await page.screenshot({ path: `${shots}/admin.png` });
  if (errors.length) fail('page errors: ' + errors.join(' | ')); else ok('no page errors');
} catch (e) { fail(e.message); } finally { await browser.close(); }
