/*
 * 示範模式的端到端驗證。示範模式的真值：
 *   圓心方向 = (sin28°, cos28°) → 從 +x 量起 62.0°
 *   r = 0.25 m、逆時針、桌面傾斜 2°
 * 時序（cycle = t % 26）：0–4 靜止、4–9 加速、9–21 等速、21–24 煞車
 */
import { chromium } from 'playwright';
const OUT = '/tmp/claude-0/-home-user-compass/e2b253a9-f69b-537b-a803-d16c4026de9c/scratchpad';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errs = [];
const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

await p.goto('http://127.0.0.1:8123/index.html', { waitUntil: 'networkidle' });
// 螢幕視角現在是向心力模式、沒有校正鈕；校正改從鳥瞰視角進
await p.click('#tabBird');
await p.click('#btnDemo');
await p.click('#btnCalib');          // 靜止段就開始校正

const read = () => p.evaluate(() => {
  const s = window.__state;
  return {
    dir: s.cHat ? +(Math.atan2(s.cHat.y, s.cHat.x) * 180 / Math.PI).toFixed(1) : null,
    ac: +document.getElementById('rdAc').textContent,
    at: +document.getElementById('rdAt').textContent,
    r: +document.getElementById('rdR').textContent,
    rpm: +document.getElementById('rdRpm').textContent,
    spin: s.spin, calibrated: s.calibrated,
    tableTilt: +s.tableTiltDeg.toFixed(1),
    status: document.getElementById('statusLine').textContent.slice(0, 46),
  };
});

// 校正需要：靜止 1.5s + 加速到起轉 + 3 圈（1.2 rev/s → 2.5s），約在 t≈13s 完成
await p.waitForTimeout(17000);
const done = await read();
console.log('校正完成後:', JSON.stringify(done));
console.log(`  圓心方向 ${done.dir}°（真值 62.0°）、r=${done.r}（真值 0.25）、` +
  `轉盤傾斜 ${done.tableTilt}°（真值 2.0）、${done.spin > 0 ? '逆時針' : '順時針'}（真值 逆時針）`);
await p.screenshot({ path: `${OUT}/demo-calibrated.png` });

await p.waitForTimeout(4000);
console.log('等速 (t≈18s, a_t 應 ≈ 0):', JSON.stringify(await read()));
await p.waitForTimeout(4500);
console.log('煞車 (t≈22s, a_t 應 < 0):', JSON.stringify(await read()));
await p.screenshot({ path: `${OUT}/demo-brake.png` });

console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : '沒有 JS 錯誤');
await b.close();
