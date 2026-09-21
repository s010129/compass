import { chromium } from 'playwright';
const OUT = '/tmp/claude-0/-home-user-compass/e2b253a9-f69b-537b-a803-d16c4026de9c/scratchpad';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errs = [];
p.on('pageerror', e => errs.push('pageerror: ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.goto('http://127.0.0.1:8125/index.html', { waitUntil: 'networkidle' });
await p.evaluate(() => {
  window.__fire = (ax, ay, az, rotZ) => {
    const e = new Event('devicemotion');
    e.accelerationIncludingGravity = { x: ax, y: ay, z: az };
    e.rotationRate = { alpha: rotZ, beta: 0, gamma: 0 };
    window.dispatchEvent(e);
  };
});
await p.click('#btnStart');

const G = 9.80665;
const read = async () => p.evaluate(() => ({
  ac: document.getElementById('rdAc').textContent,
  at: document.getElementById('rdAt').textContent,
  tilt: document.getElementById('sbTilt').textContent.trim(),
  status: document.getElementById('statusLine').textContent.trim().slice(0, 44),
}));
const feed = async (ax, ay, az, w, n = 200) => {
  for (let i = 0; i < n; i++) {
    await p.evaluate(([a, b2, c, d]) => window.__fire(a, b2, c, d), [ax, ay, az, w]);
    if (i % 50 === 0) await p.waitForTimeout(25);
  }
  await p.waitForTimeout(250);
};

// A) 平放、轉盤慢轉：r=10cm、12 rpm → a_c = 0.16 m/s²（舊版的 0.25 門檻擋掉）
await feed(0.16, 0, G, 72);
console.log('A 平放慢轉 a_c=0.16:', JSON.stringify(await read()));
await p.screenshot({ path: `${OUT}/fix-slow.png` });

// B) 平放、完全靜止
await p.reload({ waitUntil: 'networkidle' });
await p.evaluate(() => { window.__fire = (ax,ay,az,w)=>{const e=new Event('devicemotion');e.accelerationIncludingGravity={x:ax,y:ay,z:az};e.rotationRate={alpha:w,beta:0,gamma:0};window.dispatchEvent(e);}; });
await p.click('#btnStart');
await feed(0.005, 0.005, G, 0);
console.log('B 平放靜止        :', JSON.stringify(await read()));

// C) 拿起來傾斜 30°：f = (g sin30, 0, g cos30)
await feed(G * 0.5, 0, G * Math.cos(Math.PI / 6), 0);
console.log('C 傾斜 30°        :', JSON.stringify(await read()));
await p.screenshot({ path: `${OUT}/fix-tilt.png` });

console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : '沒有 JS 錯誤');
await b.close();
