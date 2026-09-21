/*
 * 座標測試畫面（原始像素版）的驗證。
 *
 * 關鍵：程式「說」燈在哪，和燈「實際被畫在哪」必須一致 ——
 * 所以掃描 canvas 的亮點像素求重心，跟 __test.x/y 比對，而不是只讀變數。
 */
import { chromium } from 'playwright';
const OUT = '/tmp/claude-0/-home-user-compass/e2b253a9-f69b-537b-a803-d16c4026de9c/scratchpad';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await p.goto('http://127.0.0.1:8126/index.html', { waitUntil: 'networkidle' });
await p.click('#tabTest');
await p.waitForTimeout(400);

const lamp = () => p.evaluate(() => {
  const c = document.getElementById('view');
  const g = c.getContext('2d');
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const i = (y * c.width + x) * 4;
    if (d[i] > 245 && d[i + 1] > 220 && d[i + 1] < 250 && d[i + 2] > 140 && d[i + 2] < 190) {
      sx += x; sy += y; n++;
    }
  }
  const s = c.width / c.getBoundingClientRect().width;
  return n ? { x: +(sx / n / s).toFixed(1), y: +(sy / n / s).toFixed(1) } : null;
});

const st = () => p.evaluate(() => ({
  x: window.__test.x, y: window.__test.y,
  w: Math.round(window.__test.w), h: Math.round(window.__test.h),
  fs: window.__test.fs,
}));

const rect = () => p.evaluate(() => {
  const r = document.getElementById('view').getBoundingClientRect();
  return { left: r.left, top: r.top, w: +r.width.toFixed(0), h: +r.height.toFixed(0) };
});

console.log('=== 進入畫面的初始狀態 ===');
let s0 = await st();
let l0 = await lamp();
console.log(`  __test = (${s0.x}, ${s0.y})，畫布 ${s0.w}×${s0.h}`);
// (0,0) 的燈只露出四分之一圓，可見像素的形心理論值是 4r/3π ≈ 3.8
console.log(`  燈實際畫在 (${l0.x}, ${l0.y})（角落只露 1/4 圓，形心理論值 ≈3.8）   ` +
  `${l0.x < 6 && l0.y < 6 ? '✅ 原點在左上角' : '❌ 不在角落'}`);

console.log('\n=== 點畫面任一處，燈要跳到該點的原始座標 ===');
const r = await rect();
for (const [fx, fy] of [[0.25, 0.2], [0.8, 0.65], [0.5, 0.9]]) {
  const tx = Math.round(r.w * fx);
  const ty = Math.round(r.h * fy);
  await p.mouse.click(r.left + tx, r.top + ty);
  await p.waitForTimeout(200);
  const s = await st();
  const l = await lamp();
  const okState = Math.abs(s.x - tx) <= 1 && Math.abs(s.y - ty) <= 1;
  const okDraw = l && Math.abs(l.x - s.x) < 3 && Math.abs(l.y - s.y) < 3;
  console.log(`  點 (${tx}, ${ty}) → 回報 (${s.x}, ${s.y})${okState ? ' ✅' : ' ❌'}` +
    `　實際畫在 (${l.x}, ${l.y})${okDraw ? ' ✅' : ' ❌'}`);
}

console.log('\n=== 十字鍵：一次一像素，方向正確 ===');
await p.mouse.click(r.left + 200, r.top + 250);   // 要點在畫布內
await p.waitForTimeout(200);
for (const [key, label, dx, dy] of [
  ['up', '上', 0, -1], ['down', '下', 0, 1], ['left', '左', -1, 0], ['right', '右', 1, 0],
]) {
  const before = await st();
  const box = await p.evaluate((k) => {
    const h = window.__test.hits[k];
    return { x: h.x + h.w / 2, y: h.y + h.h / 2 };
  }, key);
  await p.mouse.click(r.left + box.x, r.top + box.y);
  await p.waitForTimeout(200);
  const after = await st();
  const gx = after.x - before.x;
  const gy = after.y - before.y;
  console.log(`  按「${label}」→ Δ(${gx}, ${gy})，預期 (${dx}, ${dy})` +
    `   ${gx === dx && gy === dy ? '✅' : '❌'}`);
}

console.log('\n=== 邊界夾制 ===');
await p.mouse.click(r.left + 5, r.top + 5);
await p.waitForTimeout(150);
for (let i = 0; i < 12; i++) {
  const box = await p.evaluate(() => {
    const h = window.__test.hits.up;
    return { x: h.x + h.w / 2, y: h.y + h.h / 2 };
  });
  await p.mouse.click(r.left + box.x, r.top + box.y);
}
await p.waitForTimeout(200);
const edge = await st();
console.log(`  往上壓到底：y=${edge.y}   ${edge.y === 0 ? '✅ 夾在 0' : '❌'}`);

console.log('\n=== 全螢幕按鈕 ===');
const beforeFs = await rect();
await p.click('#btnFull');
await p.waitForTimeout(600);
const afterFs = await rect();
const sFs = await st();
console.log(`  按下前畫布 ${beforeFs.w}×${beforeFs.h}，按下後 ${afterFs.w}×${afterFs.h}` +
  `（視窗 390×844）`);
console.log(`  ${afterFs.w === 390 && afterFs.h === 844 ? '✅ 已填滿整個視窗' : '❌ 沒有填滿'}` +
  `　fs 旗標 ${sFs.fs}`);
await p.mouse.click(60, 700);
await p.waitForTimeout(200);
const sAny = await st();
const lAny = await lamp();
console.log(`  全螢幕下點 (60, 700) → 回報 (${sAny.x}, ${sAny.y})` +
  `   ${Math.abs(sAny.x - 60) <= 1 && Math.abs(sAny.y - 700) <= 1 ? '✅' : '❌'}` +
  `　實際畫在 (${lAny.x}, ${lAny.y})`);
await p.screenshot({ path: `${OUT}/coord-fs.png` });

// 離開全螢幕
const exitBox = await p.evaluate(() => {
  const h = window.__test.hits.exit;
  return h ? { x: h.x + h.w / 2, y: h.y + h.h / 2 } : null;
});
if (exitBox) {
  await p.mouse.click(exitBox.x, exitBox.y);
  await p.waitForTimeout(600);
  const back = await rect();
  console.log(`  按「離開」→ 畫布回到 ${back.w}×${back.h}` +
    `   ${back.w === beforeFs.w ? '✅' : '❌'}`);
}

console.log(errs.length ? '\nERRORS:\n' + errs.join('\n') : '\n沒有 JS 錯誤');
await b.close();
