/*
 * 假設：轉盤平面沒有完全水平（桌子歪 θ 度）。
 *
 * 手機跟著轉盤轉，但重力固定在房間座標系。所以「下坡方向」在裝置座標裡
 * 會以 −ω 的速率轉圈 —— 也就是說，重力洩漏 g·sinθ 是一個在裝置座標中
 * 每轉一圈就繞一圈的向量，而向心加速度在裝置座標中是不動的。
 *
 * 歸零校正扣不掉它（那只能扣常數偏移），低通也濾不掉（時間常數 0.27 s
 * 遠短於一圈的週期）。所以紅箭頭會跟著轉。
 */
import { chromium } from 'playwright';
const G = 9.80665;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

async function run({ tiltDeg, rpm, r, label }) {
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  p.on('pageerror', (e) => console.log('pageerror:', e.message));
  await p.goto('http://127.0.0.1:8126/index.html', { waitUntil: 'networkidle' });
  await p.click('#btnStart');

  await p.evaluate(({ tiltDeg: td, rpm: rp, r: rr, G: g }) => {
    const wTarget = rp * 2 * Math.PI / 60;
    const leak = g * Math.sin(td * Math.PI / 180);
    let w = 0;
    let psi = 0;                    // 累積轉角
    let last = performance.now() / 1000;
    const t0 = last;
    window.__dirs = [];
    (function frame() {
      const now = performance.now() / 1000;
      const dt = Math.min(0.05, Math.max(1e-3, now - last));
      last = now;
      const el = now - t0;
      const prev = w;
      w += (wTarget - w) * Math.min(1, dt * 1.2);
      psi += w * dt;
      const al = (w - prev) / dt;

      // 圓心方向固定在裝置 +x，切線 t̂_ccw = (0,−1)
      const ac = w * w * rr;
      const at = al * rr;
      // 重力洩漏：在裝置座標中以 −ψ 旋轉
      const lx = leak * Math.cos(-psi);
      const ly = leak * Math.sin(-psi);

      const e = new Event('devicemotion');
      e.accelerationIncludingGravity = {
        x: ac + lx,
        y: -at + ly,
        z: g * Math.cos(td * Math.PI / 180),
      };
      e.rotationRate = { alpha: w * 180 / Math.PI, beta: 0, gamma: 0 };
      window.dispatchEvent(e);

      // 記錄程式估出來的圓心方向角度
      const s = window.__state;
      if (s.cHat && el > 4) {
        window.__dirs.push(Math.atan2(s.cHat.y, s.cHat.x) * 180 / Math.PI);
      }
      if (el < 16) requestAnimationFrame(frame);
    })();
  }, { tiltDeg, rpm, r, G });

  await p.waitForTimeout(16500);
  const dirs = await p.evaluate(() => window.__dirs);
  const st = await p.evaluate(() => ({
    ac: document.getElementById('rdAc').textContent,
    tilt: document.getElementById('sbTilt').textContent.trim(),
  }));
  // 正確答案是 0°（圓心在 +x）。看估計值的擺動範圍
  const min = Math.min(...dirs);
  const max = Math.max(...dirs);
  console.log(
    `${label}\n` +
    `  桌面傾斜 ${tiltDeg}° → 重力洩漏 ${(G * Math.sin(tiltDeg * Math.PI / 180)).toFixed(2)} m/s²` +
    `  ｜向心 ${(((rpm * 2 * Math.PI / 60) ** 2) * r).toFixed(2)} m/s²\n` +
    `  圓心方向估計（正確答案 0°）：${min.toFixed(0)}° ~ ${max.toFixed(0)}°` +
    `，擺動 ${(max - min).toFixed(0)}°   [a_c 顯示 ${st.ac}, ${st.tilt}]`,
  );
  await p.close();
}

await run({ tiltDeg: 0, rpm: 28, r: 0.12, label: '【對照】桌面完全水平' });
await run({ tiltDeg: 2, rpm: 28, r: 0.12, label: '【實際】桌面歪 2°、28 rpm' });
await run({ tiltDeg: 4, rpm: 15, r: 0.12, label: '【實際】桌面歪 4°、15 rpm（慢轉）' });
await b.close();
