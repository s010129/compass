import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ deviceScaleFactor: 2 });
await p.setContent('<canvas id="c"></canvas>');

const out = await p.evaluate(() => {
  const c = document.getElementById('c');
  const ctx = c.getContext('2d');
  const m = () => { const t = ctx.getTransform(); return `a=${t.a} d=${t.d}`; };
  const log = [];

  c.width = 300; c.height = 300;
  ctx.scale(2, 2);
  log.push(`scale(2,2) 之後            → ${m()}`);

  c.width = 300;                       // 指定「相同」的寬度
  log.push(`c.width = 300（同值）後   → ${m()}`);

  ctx.scale(2, 2);
  c.width = 400;                       // 指定「不同」的寬度
  log.push(`c.width = 400（不同值）後 → ${m()}`);

  // 模擬那份程式：沒有 setTransform，連續呼叫兩次 resize
  const resizeNoReset = () => { c.width = 400; ctx.scale(2, 2); };
  resizeNoReset();
  const after1 = m();
  resizeNoReset();
  log.push(`無 setTransform：第1次 ${after1}／第2次 ${m()}`);

  // 加上 setTransform 的版本
  const resizeWithReset = () => {
    c.width = 400;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(2, 2);
  };
  resizeWithReset(); resizeWithReset(); resizeWithReset();
  log.push(`有 setTransform：連呼叫三次 → ${m()}`);

  // 寬度沒變的情況（全螢幕切換時很常見）
  const r2 = () => { ctx.scale(2, 2); };   // 假設瀏覽器略過同值重設
  return log;
});
out.forEach(l => console.log(' ', l));
await b.close();
