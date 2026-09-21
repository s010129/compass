import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
p.on('pageerror', e => errs.push('pageerror: ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.goto('http://127.0.0.1:8127/compass/', { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
const info = await p.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  const mf = document.querySelector('link[rel=manifest]');
  const m = await (await fetch(mf.href)).json();
  return {
    swScope: reg?.scope,
    swState: reg?.active?.state ?? reg?.installing?.state,
    startUrl: new URL(m.start_url, mf.href).pathname,
    iconUrl: new URL(m.icons[0].src, mf.href).pathname,
  };
});
console.log(JSON.stringify(info, null, 1));
// 離線重載，確認快取真的能用
await p.waitForTimeout(1200);
await p.context().setOffline(true);
await p.reload({ waitUntil: 'domcontentloaded' });
const offlineOk = await p.evaluate(() => !!document.getElementById('view') && document.title);
console.log('離線重載:', offlineOk);
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : '沒有 JS 錯誤');
await b.close();
