import { chromium } from 'playwright';
// 螢幕視角 → 向心力模式（讀 e.acceleration）。注入已知的 e.acceleration，掃紅色箭頭像素確認方向。
const OUT = process.env.OUT || '/tmp';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errs = [];
const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.goto('http://127.0.0.1:8126/index.html', { waitUntil: 'networkidle' });
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: 'networkidle' });

await p.click('#tabScreen');
await p.click('#btnStart');

// 用 rAF 以真實時間持續注入，vec 可以隨時從外面換掉
await p.evaluate(() => {
  window.__vec = { x: 0, y: 0 };
  (function f() {
    window.dispatchEvent(Object.assign(new Event('devicemotion'), {
      acceleration: { x: window.__vec.x, y: window.__vec.y, z: 0 },
      accelerationIncludingGravity: { x: window.__vec.x, y: window.__vec.y, z: 9.8 },
      rotationRate: { alpha: 0, beta: 0, gamma: 0 },
    }));
    requestAnimationFrame(f);
  })();
});

const setVec = (x, y) => p.evaluate(([x, y]) => { window.__vec = { x, y }; }, [x, y]);

/** 掃紅色箭頭（#ff4d55）的像素形心，回傳相對畫布中心的 CSS px 位移（+y 朝上）。 */
async function redCentroid() {
  return p.evaluate(() => {
    const c = document.getElementById('view');
    const ctx = c.getContext('2d');
    const { width: W, height: H } = c;
    const d = ctx.getImageData(0, 0, W, H).data;
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (d[i] > 230 && d[i + 1] > 60 && d[i + 1] < 95 && d[i + 2] > 70 && d[i + 2] < 100) {
          sx += x; sy += y; n++;
        }
      }
    }
    const dpr = W / c.getBoundingClientRect().width;
    return { dx: (sx / n - W / 2) / dpr, dy: -(sy / n - H / 2) / dpr, n };
  });
}

const read = () => p.evaluate(() => ({
  ax: document.getElementById('rlAx').textContent,
  ay: document.getElementById('rlAy').textContent,
  mag: document.getElementById('rlMag').textContent,
  ang: document.getElementById('rlAngle').textContent,
  peak: document.getElementById('rlPeak').textContent,
  status: document.getElementById('statusLine').textContent,
}));

const results = [];
const check = (name, ok, info) => { results.push([ok, name]); console.log(`${ok ? '✓' : '✗'} ${name}  ${info ?? ''}`); };

// 版面：平面加速度的讀數與按鈕出現，向心的收起來
const vis = await p.evaluate(() => Object.fromEntries(
  ['readouts', 'readoutsLinear', 'controlsLinear', 'controlsOpts', 'btnCalib', 'screenTabs', 'legendMain']
    .map((id) => [id, getComputedStyle(document.getElementById(id)).display !== 'none'])));
check('版面切換', !vis.readouts && vis.readoutsLinear && vis.controlsLinear && !vis.controlsOpts
  && !vis.btnCalib && vis.screenTabs && !vis.legendMain, JSON.stringify(vis));

// 1) 桌機 Chromium 不是 iOS → 預設不反轉：+x 朝右，θ = 0
await setVec(2, 0);
await p.waitForTimeout(600);
let c = await redCentroid();
let r = await read();
check('非 iOS 預設不反轉：+x 朝右', c.dx > 10 && Math.abs(c.dy) < 5 && r.ax === '2.00', `dx=${c.dx.toFixed(1)} dy=${c.dy.toFixed(1)} ax=${r.ax} θ=${r.ang}`);

// 2) 按反轉 X：+x → 朝左；再按一次回來
await p.click('#btnInvX');
await p.waitForTimeout(600);
c = await redCentroid();
check('反轉 X：+x 朝左', c.dx < -10, `dx=${c.dx.toFixed(1)}`);
await p.screenshot({ path: `${OUT}/linear-invx.png` });
await p.click('#btnInvX');
await p.waitForTimeout(600);
c = await redCentroid();
r = await read();
check('未反轉：+x 朝右', c.dx > 10 && Math.abs(c.dy) < 5 && r.ax === '2.00' && r.ang === '0.0', `dx=${c.dx.toFixed(1)} θ=${r.ang}`);

// 3) +y → 朝上（canvas y 要取負號），θ = 90
await setVec(0, 2);
await p.waitForTimeout(600);
c = await redCentroid();
r = await read();
check('+y 朝上', c.dy > 10 && Math.abs(c.dx) < 5 && r.ang === '90.0', `dx=${c.dx.toFixed(1)} dy=${c.dy.toFixed(1)} θ=${r.ang}`);
await p.screenshot({ path: `${OUT}/linear-up.png` });

// 4) 反轉 Y：+y → 朝下
await p.click('#btnInvY');
await p.waitForTimeout(600);
c = await redCentroid();
check('反轉 Y：+y 朝下', c.dy < -10, `dy=${c.dy.toFixed(1)}`);
await p.click('#btnInvY');

// 5) 斜向 (3,4) → |a|=5、θ=53.1、箭頭長 5×22=110 px 附近
await setVec(3, 4);
await p.waitForTimeout(800);
r = await read();
check('合成 |a| 與 θ', r.mag === '5.00' && r.ang === '53.1', `|a|=${r.mag} θ=${r.ang}`);

// 6) 峰值與重設
check('峰值紀錄', r.peak === '5.00', r.peak);
await setVec(0, 0);
await p.waitForTimeout(600);
await p.click('#btnPeak');
await p.waitForTimeout(200);
r = await read();
check('重設最大值', r.peak === '0.00' && r.mag === '0.00' && r.ang === '0.0', `peak=${r.peak} θ=${r.ang}`);

// 7) 歸零：有固定偏移時按下去，讀值回到 0；死區內的小雜訊不應畫箭頭
await setVec(0.6, -0.4);
await p.waitForTimeout(600);
await p.click('#btnZero');
await p.waitForTimeout(600);
r = await read();
c = await redCentroid();
check('靜止歸零', r.ax === '0.00' && r.ay === '0.00' && r.status.includes('歸零完成'), `ax=${r.ax} ay=${r.ay} 「${r.status}」`);
await setVec(0.6 + 0.05, -0.4);
await p.waitForTimeout(400);
r = await read();
check('死區 0.08', r.ax === '0.00', r.ax);

// 8) 全螢幕：按鈕進入、畫布右上「離開」退出
await setVec(0.6 + 2, -0.4);
await p.click('#btnFullLinear');
await p.waitForTimeout(400);
const fsOn = await p.evaluate(() => ({ fs: window.__test.fs, cls: document.body.classList.contains('fs-test'), hit: window.__linear.exitHit }));
await p.screenshot({ path: `${OUT}/linear-fs.png` });
check('進入全螢幕', fsOn.fs && fsOn.cls && !!fsOn.hit, JSON.stringify(fsOn));
await p.mouse.click(fsOn.hit.x + 24, fsOn.hit.y + 22);
await p.waitForTimeout(300);
const fsOff = await p.evaluate(() => window.__test.fs || document.body.classList.contains('fs-test'));
check('畫布上的「離開」', !fsOff);

// 9) 向心分解已停用：子分頁只剩「向心力」
const subs = await p.evaluate(() => [...document.querySelectorAll('#screenTabs .tab')].map((t) => t.textContent));
check('子分頁只剩向心力', subs.length === 1 && subs[0] === '向心力', JSON.stringify(subs));

// 10) 其他分頁看不到子分頁
await p.click('#tabBird');
const subHidden = await p.evaluate(() => getComputedStyle(document.getElementById('screenTabs')).display === 'none');
check('其他分頁隱藏子分頁', subHidden);

// 11) 重新載入後一律是向心力模式
await p.click('#tabScreen');
await p.reload({ waitUntil: 'networkidle' });
const mode = await p.evaluate(() => window.__state.screenMode);
check('預設向心力模式', mode === 'linear', mode);

// 12) 示範模式：箭頭應朝向模擬的圓心（偏離 +y 28°）
await p.click('#btnDemo');
await p.waitForTimeout(15000);
const dm = await p.evaluate(() => ({ ax: window.__linear.ax, ay: window.__linear.ay }));
const ang = Math.atan2(dm.ax, dm.ay) * 180 / Math.PI;   // 相對 +y 的角度，模擬值為 28°
check('示範模式方向', Math.abs(ang - 28) < 12, `相對 +y ${ang.toFixed(1)}°`);
await p.screenshot({ path: `${OUT}/linear-demo.png`, fullPage: true });

// 13) 平台判定：iPhone 預設 X、Y 都反轉，Android 都不反轉
const UA = {
  iPhone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  Android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
};
for (const [name, ua, want] of [['iPhone', UA.iPhone, true], ['Android', UA.Android, false]]) {
  const ctx = await b.newContext({ userAgent: ua, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const q = await ctx.newPage();
  q.on('pageerror', (e) => errs.push(`${name} pageerror: ` + e.message));
  await q.goto('http://127.0.0.1:8126/index.html', { waitUntil: 'networkidle' });
  const st = await q.evaluate(() => ({
    x: window.__linear.invertX, y: window.__linear.invertY,
    bx: document.getElementById('btnInvX').classList.contains('on'),
    by: document.getElementById('btnInvY').classList.contains('on'),
    foot: document.getElementById('sensorInfo').textContent,
  }));
  check(`${name} 預設${want ? '兩軸都反轉' : '都不反轉'}`,
    st.x === want && st.y === want && st.bx === want && st.by === want, JSON.stringify(st));

  // 14) 手機橫放 → 蓋上「請轉回直向」
  await q.setViewportSize({ width: 844, height: 390 });
  await q.waitForTimeout(200);
  const hint = await q.evaluate(() => getComputedStyle(document.querySelector('.rotate-hint')).display);
  await q.setViewportSize({ width: 390, height: 844 });
  await q.waitForTimeout(200);
  const hint2 = await q.evaluate(() => getComputedStyle(document.querySelector('.rotate-hint')).display);
  check(`${name} 橫放提示`, hint !== 'none' && hint2 === 'none', `橫 ${hint} / 直 ${hint2}`);
  await ctx.close();
}

console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : '沒有 JS 錯誤');
const fail = results.filter(([ok]) => !ok).length;
console.log(fail ? `${fail} 項失敗` : `全部 ${results.length} 項通過`);
await b.close();
process.exit(fail || errs.length ? 1 : 0);
