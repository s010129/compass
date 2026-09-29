/*
 * 轉盤傾斜的模擬下，比較「未校正」與「已校正」的圓心方向穩定度與讀值準確度。
 * 真值：圓心在裝置 +x（0°）。注入序列：0–6s 靜止 → 加速 → 等速。
 */
import { chromium } from 'playwright';
const OUT = '/tmp/claude-0/-home-user-compass/e2b253a9-f69b-537b-a803-d16c4026de9c/scratchpad';
const G = 9.80665;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errs = [];

function inject(p, { tiltDeg, rpm, r, ccw }) {
  return p.evaluate(({ td, rp, rr, cw, g }) => {
    const wTarget = rp * 2 * Math.PI / 60;
    const leak = g * Math.sin(td * Math.PI / 180);
    const dir = cw ? 1 : -1;                 // +1 逆時針
    let w = 0;
    let psi = 0;
    let last = performance.now() / 1000;
    const t0 = last;
    (function frame() {
      const now = performance.now() / 1000;
      const dt = Math.min(0.05, Math.max(1e-3, now - last));
      last = now;
      const el = now - t0;
      const target = el < 6 ? 0 : wTarget;   // 前 6 秒靜止，給校正抓
      const prev = w;
      w += (target - w) * Math.min(1, dt * 0.9);
      psi += w * dt;
      const al = (w - prev) / dt;
      const ang = -dir * psi;                // 洩漏在裝置座標中反向旋轉
      window.dispatchEvent(Object.assign(new Event('devicemotion'), {
        accelerationIncludingGravity: {
          x: w * w * rr + leak * Math.cos(ang),
          y: -(al * rr) * dir + leak * Math.sin(ang),
          z: g * Math.cos(td * Math.PI / 180),
        },
        rotationRate: { alpha: w * 180 / Math.PI * dir, beta: 0, gamma: 0 },
      }));
      if (el < 90) requestAnimationFrame(frame);
    })();
  }, { td: tiltDeg, rp: rpm, rr: r, cw: ccw, g: G });
}

const read = (p) => p.evaluate(() => {
  const s = window.__state;
  return {
    dir: s.cHat ? +(Math.atan2(s.cHat.y, s.cHat.x) * 180 / Math.PI).toFixed(1) : null,
    ac: +document.getElementById('rdAc').textContent,
    r: +document.getElementById('rdR').textContent,
    spin: s.spin,
    calibrated: s.calibrated,
    tableTilt: +s.tableTiltDeg.toFixed(1),
    status: document.getElementById('statusLine').textContent.slice(0, 30),
  };
});

async function sweep(p, n = 12, gap = 250) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push((await read(p)).dir);
    await p.waitForTimeout(gap);
  }
  return out.filter((v) => v !== null);
}

async function run(cfg, doCalib) {
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await p.goto('http://127.0.0.1:8126/index.html', { waitUntil: 'networkidle' });
  // 螢幕視角現在是向心力模式、沒有校正鈕；校正改從鳥瞰視角進
  await p.click('#tabBird');
  await p.click('#btnStart');
  await inject(p, cfg);
  if (doCalib) {
    await p.waitForTimeout(400);
    await p.click('#btnCalib');        // 在靜止段就開始校正
  }
  // 等加速 + 等速 + 校正三圈完成
  await p.waitForTimeout(cfg.rpm < 20 ? 42000 : 30000);
  const dirs = await sweep(p);
  const st = await read(p);
  await p.screenshot({ path: `${OUT}/calib-${cfg.tiltDeg}-${doCalib ? 'after' : 'before'}.png` });
  await p.close();
  return {
    min: Math.min(...dirs), max: Math.max(...dirs), st,
  };
}

for (const cfg of [
  { tiltDeg: 4, rpm: 15, r: 0.12, ccw: true },
  { tiltDeg: 2, rpm: 28, r: 0.12, ccw: false },
]) {
  const trueAc = ((cfg.rpm * 2 * Math.PI / 60) ** 2) * cfg.r;
  console.log(`\n轉盤傾斜 ${cfg.tiltDeg}°、${cfg.rpm} rpm、r=${cfg.r} m、` +
    `${cfg.ccw ? '逆時針' : '順時針'}（真值 a_c=${trueAc.toFixed(2)}）`);
  const before = await run(cfg, false);
  console.log(`  未校正：圓心方向 ${before.min}° ~ ${before.max}°` +
    `（擺動 ${(before.max - before.min).toFixed(0)}°），a_c=${before.st.ac}, r=${before.st.r}`);
  const after = await run(cfg, true);
  console.log(`  已校正：圓心方向 ${after.min}° ~ ${after.max}°` +
    `（擺動 ${(after.max - after.min).toFixed(1)}°），a_c=${after.st.ac}, r=${after.st.r}`);
  console.log(`         偵測轉盤傾斜 ${after.st.tableTilt}°（真值 ${cfg.tiltDeg}°）、` +
    `旋轉方向 ${after.st.spin > 0 ? '逆時針' : '順時針'}（真值 ${cfg.ccw ? '逆時針' : '順時針'}）` +
    `${after.st.calibrated ? '' : `  ⚠ 校正未完成：${after.st.status}`}`);
}
console.log(errs.length ? '\nERRORS:\n' + errs.join('\n') : '\n沒有 JS 錯誤');
await b.close();
