import { chromium } from 'playwright';
const OUT = '/tmp/claude-0/-home-user-compass/e2b253a9-f69b-537b-a803-d16c4026de9c/scratchpad';
const G = 9.80665;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errs = [];

// 真值：ĉ=(1,0)、r、rpm、桌面傾斜 tiltDeg
// 預期 軌跡平均 = ω²r，洩漏RMS = g·sin(tilt)
async function run({ tiltDeg, rpm, r }) {
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  await p.goto('http://127.0.0.1:8126/index.html', { waitUntil: 'networkidle' });
  await p.click('#tabRaw');
  await p.click('#btnStart');
  await p.evaluate(({ td, rp, rr, g }) => {
    const wT = rp * 2 * Math.PI / 60;
    const leak = g * Math.sin(td * Math.PI / 180);
    let w = 0, psi = 0, last = performance.now() / 1000;
    const t0 = last;
    (function f() {
      const now = performance.now() / 1000;
      const dt = Math.min(0.05, Math.max(1e-3, now - last)); last = now;
      const el = now - t0;
      w += (wT - w) * Math.min(1, dt * 1.5);
      psi += w * dt;
      window.dispatchEvent(Object.assign(new Event('devicemotion'), {
        accelerationIncludingGravity: {
          x: w * w * rr + leak * Math.cos(-psi),
          y: leak * Math.sin(-psi),
          z: g * Math.cos(td * Math.PI / 180),
        },
        rotationRate: { alpha: w * 180 / Math.PI, beta: 0, gamma: 0 },
      }));
      if (el < 30) requestAnimationFrame(f);
    })();
  }, { td: tiltDeg, rp: rpm, rr: r, g: G });

  await p.waitForTimeout(14000);
  const v = await p.evaluate(() => {
    const trail = window.__state ? null : null;
    return null;
  });
  // 從畫面上的讀數文字判讀不方便，改用 canvas 截圖 + 內部緩衝
  await p.screenshot({ path: `${OUT}/raw-${tiltDeg}deg.png` });
  const truthAc = ((rpm * 2 * Math.PI / 60) ** 2) * r;
  const truthLeak = G * Math.sin(tiltDeg * Math.PI / 180);
  console.log(`桌面傾斜 ${tiltDeg}°、${rpm} rpm、r=${r} m`);
  console.log(`  真值：向心 ${truthAc.toFixed(2)}、洩漏 ${truthLeak.toFixed(2)}、` +
    `比值 ${(truthLeak / truthAc).toFixed(2)}`);
  await p.close();
}

await run({ tiltDeg: 2, rpm: 28, r: 0.12 });
await run({ tiltDeg: 4, rpm: 15, r: 0.12 });
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : '沒有 JS 錯誤');
await b.close();
