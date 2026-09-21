import { chromium } from 'playwright';
const OUT = '/tmp/claude-0/-home-user-compass/e2b253a9-f69b-537b-a803-d16c4026de9c/scratchpad';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errs = [];

// 真實情境：圓心固定在裝置 +x、逆時針(ω>0)、r = 0.25 m
//   0–2s   加速到 4 rad/s   → α>0，a_t 應為正
//   2–5s   等速             → a_t ≈ 0，a_c = 16×0.25 = 4.0
//   5–7s   煞車到 0.5 rad/s → α<0，a_t 應為負
// t̂ = (ĉy, −ĉx) = (0,−1)，所以 h = (a_c, −a_t)
async function run(gyroFlip, label) {
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  p.on('pageerror', (e) => errs.push(label + ' pageerror: ' + e.message));
  await p.goto('http://127.0.0.1:8126/index.html', { waitUntil: 'networkidle' });
  await p.click('#btnStart');

  await p.evaluate((flip) => {
    const G = 9.80665;
    const r = 0.25;
    let w = 0;
    let last = performance.now() / 1000;
    const t0 = last;
    (function frame() {
      const now = performance.now() / 1000;
      const dt = Math.min(0.05, Math.max(1e-3, now - last));
      last = now;
      const el = now - t0;
      const target = el < 2 ? 4 * (el / 2) : el < 5 ? 4 : Math.max(0.5, 4 - (el - 5) * 1.75);
      const prev = w;
      w += (target - w) * Math.min(1, dt * 6);
      const al = (w - prev) / dt;
      const e = new Event('devicemotion');
      e.accelerationIncludingGravity = { x: w * w * r, y: -(al * r), z: G };
      e.rotationRate = { alpha: (w * 180 / Math.PI) * (flip ? -1 : 1), beta: 0, gamma: 0 };
      window.dispatchEvent(e);
      if (el < 9) requestAnimationFrame(frame);
    })();
  }, gyroFlip);

  const read = () => p.evaluate(() => ({
    ac: +document.getElementById('rdAc').textContent,
    at: +document.getElementById('rdAt').textContent,
    rpm: +document.getElementById('rdRpm').textContent,
    r: +document.getElementById('rdR').textContent,
    gyro: document.getElementById('sbGyro').textContent.trim(), tilt: document.getElementById('sbTilt').textContent.trim(),
  }));

  await p.waitForTimeout(1400);
  const spinup = await read();
  await p.waitForTimeout(2600);
  const steady = await read();
  await p.waitForTimeout(2600);
  const brake = await read();

  console.log(label);
  console.log('  加速中 (a_t 應 > 0):', JSON.stringify(spinup));
  console.log('  等速   (a_t 應 ≈ 0):', JSON.stringify(steady));
  console.log('  煞車中 (a_t 應 < 0):', JSON.stringify(brake));
  await p.screenshot({ path: `${OUT}/gyro-${gyroFlip ? 'flip' : 'normal'}.png` });
  await p.close();
}

await run(false, '【Android 慣例】陀螺儀正常');
await run(true, '【iOS 假設反號】陀螺儀讀值整個取負，只取 |ω| 故應完全不受影響');
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : '沒有 JS 錯誤');
await b.close();
