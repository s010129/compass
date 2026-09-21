import { chromium } from 'playwright';
const OUT = '/tmp/claude-0/-home-user-compass/e2b253a9-f69b-537b-a803-d16c4026de9c/scratchpad';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
p.on('pageerror', e => console.log('pageerror:', e.message));
await p.goto('http://127.0.0.1:8126/index.html', { waitUntil: 'networkidle' });
await p.click('#tabTest');
await p.click('#btnFull');
await p.waitForTimeout(700);

// 原點記號（#7d879e 的直角）應該只出現在左上角
const corner = await p.evaluate(() => {
  const c = document.getElementById('view');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const s = c.width / c.getBoundingClientRect().width;
  const quad = { 左上: 0, 右上: 0, 左下: 0, 右下: 0 };
  const W = c.width, H = c.height;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (Math.abs(d[i] - 125) < 10 && Math.abs(d[i+1] - 135) < 10 && Math.abs(d[i+2] - 158) < 10) {
      // 只看離角落 30 CSS px 內的像素
      const nx = x / s, ny = y / s, w = W / s, h = H / s;
      if (nx < 30 && ny < 30) quad.左上++;
      else if (nx > w - 30 && ny < 30) quad.右上++;
      else if (nx < 30 && ny > h - 30) quad.左下++;
      else if (nx > w - 30 && ny > h - 30) quad.右下++;
    }
  }
  return quad;
});
console.log('原點直角記號的像素分佈:', JSON.stringify(corner));
const others = corner.右上 + corner.左下 + corner.右下;
console.log(corner.左上 > 50 && corner.左上 > others * 20
  ? `✅ 原點記號集中在左上角（其他角合計 ${others} 個抗鋸齒雜點）` : '❌ 位置不對');

const st = await p.evaluate(() => ({ x: window.__test.x, y: window.__test.y }));
console.log(`燈的初始位置 (${st.x}, ${st.y})   ${st.x === 0 && st.y === 0 ? '✅' : '❌'}`);
await p.screenshot({ path: `${OUT}/origin-fs.png` });
await b.close();
