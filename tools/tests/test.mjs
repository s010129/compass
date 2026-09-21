import { chromium } from 'playwright';

const OUT = '/tmp/claude-0/-home-user-compass/e2b253a9-f69b-537b-a803-d16c4026de9c/scratchpad';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto('http://127.0.0.1:8123/index.html', { waitUntil: 'networkidle' });

// ---- 用注入的假 DeviceMotion 事件驗證方向，不走示範模式 ----
// 情境：圓心在手機的「螢幕右側」(+x)，等速逆時針旋轉。
// 預期：紅箭頭往右、綠箭頭往下（因為 ω>0 時 t̂ = (ĉy, −ĉx) = (0,−1)，即 −y = 螢幕下方）
await page.evaluate(() => {
  window.__fire = (ax, ay, az, rotZ) => {
    const e = new Event('devicemotion');
    e.accelerationIncludingGravity = { x: ax, y: ay, z: az };
    e.acceleration = { x: 0, y: 0, z: 0 };
    e.rotationRate = { alpha: rotZ, beta: 0, gamma: 0 };
    e.interval = 16;
    window.dispatchEvent(e);
  };
});
await page.click('#btnStart');
await page.waitForTimeout(200);

// 等速：a_c = 5 指向 +x，ω = +120 deg/s（逆時針）
for (let i = 0; i < 260; i++) {
  await page.evaluate(() => window.__fire(5, 0, 9.80665, 120));
  if (i % 40 === 0) await page.waitForTimeout(30);
}
await page.waitForTimeout(300);

const steady = await page.evaluate(() => ({
  ac: +document.getElementById('rdAc').textContent,
  at: +document.getElementById('rdAt').textContent,
  rpm: +document.getElementById('rdRpm').textContent,
  r: +document.getElementById('rdR').textContent,
  v: +document.getElementById('rdV').textContent,
}));
console.log('等速 (圓心在 +x, ω=+120°/s):', JSON.stringify(steady));
await page.screenshot({ path: `${OUT}/shot-steady.png` });

// iOS 慣例：整組取負號，結果應該完全一樣
await page.reload({ waitUntil: 'networkidle' });
await page.evaluate(() => {
  window.__fire = (ax, ay, az, rotZ) => {
    const e = new Event('devicemotion');
    e.accelerationIncludingGravity = { x: ax, y: ay, z: az };
    e.rotationRate = { alpha: rotZ, beta: 0, gamma: 0 };
    window.dispatchEvent(e);
  };
});
await page.click('#btnStart');
for (let i = 0; i < 300; i++) {
  await page.evaluate(() => window.__fire(-5, 3, -9.80665, 120));
  if (i % 50 === 0) await page.waitForTimeout(30);
}
await page.waitForTimeout(300);
const ios = await page.evaluate(() => ({
  ac: +document.getElementById('rdAc').textContent,
  at: +document.getElementById('rdAt').textContent,
  conv: document.getElementById('sensorInfo').textContent,
}));
console.log('iOS 慣例 (全部取負):', JSON.stringify(ios));

// 示範模式截圖
await page.reload({ waitUntil: 'networkidle' });
await page.click('#btnDemo');
await page.waitForTimeout(4500);
await page.screenshot({ path: `${OUT}/shot-demo.png`, fullPage: true });

// PWA 檢查
const pwa = await page.evaluate(async () => {
  const m = await (await fetch('manifest.webmanifest')).json();
  return { name: m.name, icons: m.icons.length, sw: !!navigator.serviceWorker.controller || 'registering' };
});
console.log('PWA:', JSON.stringify(pwa));

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : '沒有 JS 錯誤');
await browser.close();
