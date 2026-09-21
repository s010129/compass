/*
 * 鳥瞰視角驗證。
 *
 * 原版的 bug：alpha 逆時針遞增，但 canvas 角度順時針遞增，直接相加導致
 * 畫面轉向和實際相反。這裡用已知的旋轉方向注入，掃描畫面上手機圖示的
 * 實際位置，確認轉向正確。
 *
 * 逆時針(spin=+1) → canvas 角度應「遞減」；順時針 → 應「遞增」。
 */
import { chromium } from 'playwright';
const OUT = '/tmp/claude-0/-home-user-compass/e2b253a9-f69b-537b-a803-d16c4026de9c/scratchpad';
const G = 9.80665;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errs = [];

// 掃描手機外框的顏色 #7d879e 求重心，換算成 canvas 角度
const phoneAngle = (p) => p.evaluate(() => {
  const c = document.getElementById('view');
  const g = c.getContext('2d');
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const i = (y * c.width + x) * 4;
    if (Math.abs(d[i] - 125) < 14 && Math.abs(d[i + 1] - 135) < 14 && Math.abs(d[i + 2] - 158) < 14) {
      sx += x; sy += y; n++;
    }
  }
  if (!n) return null;
  const cx = c.width / 2, cy = c.height / 2;
  return +(Math.atan2(sy / n - cy, sx / n - cx) * 180 / Math.PI).toFixed(0);
});

async function run(ccw, label) {
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await p.goto('http://127.0.0.1:8126/index.html', { waitUntil: 'networkidle' });
  await p.click('#tabBird');
  await p.click('#btnStart');

  await p.evaluate(({ cw, g }) => {
    const wT = 1.6;                       // rad/s
    const dir = cw ? 1 : -1;
    const r = 0.2;
    const leak = g * Math.sin(3 * Math.PI / 180);
    let w = 0, psi = 0;
    let last = performance.now() / 1000;
    const t0 = last;
    (function frame() {
      const now = performance.now() / 1000;
      const dt = Math.min(0.05, Math.max(1e-3, now - last));
      last = now;
      const el = now - t0;
      const prev = w;
      w += ((el < 4 ? 0 : wT) - w) * Math.min(1, dt * 1.2);
      psi += w * dt;
      const al = (w - prev) / dt;
      const ang = -dir * psi;
      window.dispatchEvent(Object.assign(new Event('devicemotion'), {
        accelerationIncludingGravity: {
          x: w * w * r + leak * Math.cos(ang),
          y: -(al * r) * dir + leak * Math.sin(ang),
          z: g * Math.cos(3 * Math.PI / 180),
        },
        rotationRate: { alpha: w * 180 / Math.PI * dir, beta: 0, gamma: 0 },
      }));
      if (el < 60) requestAnimationFrame(frame);
    })();
  }, { cw: ccw, g: G });

  await p.click('#btnCalib');
  await p.waitForTimeout(26000);          // 靜止 + 起轉 + 3 圈

  const st = await p.evaluate(() => ({
    spin: window.__state.spin,
    calibrated: window.__state.calibrated,
    ac: +document.getElementById('rdAc').textContent,
  }));

  const angles = [];
  for (let i = 0; i < 6; i++) {
    const a = await phoneAngle(p);
    if (a !== null) angles.push(a);
    await p.waitForTimeout(160);
  }
  // 解開 ±180 的跳變後看趨勢
  let unwrapped = [angles[0]];
  for (let i = 1; i < angles.length; i++) {
    let d = angles[i] - angles[i - 1];
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    unwrapped.push(unwrapped[i - 1] + d);
  }
  const trend = unwrapped[unwrapped.length - 1] - unwrapped[0];
  const moving = trend > 0 ? '遞增（畫面順時針）' : '遞減（畫面逆時針）';
  const expect = ccw ? '遞減（畫面逆時針）' : '遞增（畫面順時針）';
  console.log(`${label}`);
  console.log(`  校正判定 ${st.spin > 0 ? '逆時針' : '順時針'}（真值 ${ccw ? '逆時針' : '順時針'}）` +
    `、a_c=${st.ac}${st.calibrated ? '' : ' ⚠未校正'}`);
  console.log(`  畫面上手機的 canvas 角度：${angles.join(' → ')}`);
  console.log(`  ⇒ ${moving}，預期 ${expect}   ${moving === expect ? '✅' : '❌ 鏡像了'}`);
  await p.screenshot({ path: `${OUT}/bird-${ccw ? 'ccw' : 'cw'}.png` });
  await p.close();
}

await run(true, '【逆時針】');
await run(false, '【順時針】');
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : '沒有 JS 錯誤');
await b.close();
