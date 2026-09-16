/**
 * 轉盤向心力感測器
 *
 * 手機螢幕朝上平放在旋轉桌上，用加速度計把水平方向的加速度分解成
 * 向心分量（紅）與切線分量（綠）。
 *
 * 座標約定（全篇一致）：
 *   裝置座標 device frame：+x 螢幕右、+y 螢幕上、+z 穿出螢幕
 *   螢幕座標 screen frame：同上，但已用 screen.orientation.angle 補償橫豎屏
 *   canvas 座標：+x 向右、+y 向下 —— 所以畫圖時 y 要取負號
 */
import { COMPASS_BASE_SIZE, renderCompass } from './mc-compass.js';

const G = 9.80665;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------- 狀態

const state = {
  running: false,
  mode: null,          // 'sensor' | 'demo'

  /** accelerationIncludingGravity 的正負號慣例：+1 為規範、-1 為 iOS */
  signConv: 1,
  gzLP: 0,             // 原始 z 的低通，用來判斷慣例與是否平放
  convReady: false,    // 慣例是否已判定

  offX: 0,             // 歸零校正的水平偏移（裝置座標）
  offY: 0,

  h: { x: 0, y: 0 },   // 扣掉偏移後的水平加速度（裝置座標）
  raw: { x: 0, y: 0, z: 0 },

  omega: 0,            // 繞裝置 z 軸的角速度 rad/s（+ 為逆時針）
  alpha: 0,            // 角加速度 rad/s²
  hasGyro: false,

  cHat: null,          // 圓心方向單位向量（裝置座標）
  centerLocked: false,
  spin: 1,             // +1 逆時針、-1 順時針

  ac: 0,
  at: 0,

  range: 5,            // 目前量程 m/s²
  rangeMode: 'auto',
  spinMode: 'auto',

  lastT: 0,
  sampleCount: 0,
  hz: 0,
};

const chartData = [];   // {t, ac, at, w}，只留最近幾秒
const csvRows = [];     // 完整紀錄，供匯出
const CHART_SPAN = 12;  // 秒
const CSV_LIMIT = 40000;

// ---------------------------------------------------------------- DOM

const $ = (id) => document.getElementById(id);
const els = {
  view: $('view'),
  chart: $('chart'),
  compass: $('compassIcon'),
  status: $('statusLine'),
  sensorInfo: $('sensorInfo'),
  btnStart: $('btnStart'),
  btnTare: $('btnTare'),
  btnLock: $('btnLock'),
  btnDemo: $('btnDemo'),
  btnCsv: $('btnCsv'),
  selSpin: $('selSpin'),
  selRange: $('selRange'),
  rdAc: $('rdAc'),
  rdAt: $('rdAt'),
  rdRpm: $('rdRpm'),
  rdR: $('rdR'),
  rdV: $('rdV'),
  rdAh: $('rdAh'),
};

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = `status ${kind}`;
}

// ---------------------------------------------------------------- 計算

/**
 * 螢幕方向補償：把裝置座標的向量轉到使用者眼中的螢幕座標。
 * 相當於繞 z 軸轉 −θ，θ 為 screen.orientation.angle。
 */
function toScreen(v) {
  const angle = (screen.orientation?.angle ?? window.orientation ?? 0) * DEG;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c + v.y * s, y: -v.x * s + v.y * c };
}

/** 收到一筆感測器資料（或示範模式的模擬資料）。 */
function handleSample(raw, rotZdeg, t) {
  const dt = state.lastT ? Math.min(Math.max(t - state.lastT, 1e-3), 0.2) : 0.016;
  state.lastT = t;
  state.sampleCount++;
  state.hz += (1 / dt - state.hz) * 0.05;

  state.raw = raw;

  // 1) 判斷正負號慣例。平放螢幕朝上時，規範下 z 應為 +9.8，iOS 為 −9.8。
  //    慣例確定之前不能往下算，否則圓心方向會先被錯誤的正負號帶偏。
  state.gzLP += (raw.z - state.gzLP) * 0.05;
  if (Math.abs(state.gzLP) > 3) {
    state.signConv = state.gzLP > 0 ? 1 : -1;
    state.convReady = true;
  }
  if (!state.convReady) {
    setStatus('判斷感測器座標慣例中…（請確認手機螢幕朝上平放）', 'warn');
    return;
  }

  const s = state.signConv;
  const fz = s * raw.z;

  // 2) 水平分量。手機平放時重力只有 z 分量，所以 (x, y) 就是真實加速度的
  //    水平分量，方向直接指向圓心。offX/offY 補掉桌面沒完全水平的殘留。
  const h = { x: s * raw.x - state.offX, y: s * raw.y - state.offY };
  state.h = h;
  const hMag = Math.hypot(h.x, h.y);

  // 3) 角速度：陀螺儀繞 z 軸的分量
  if (rotZdeg !== null && rotZdeg !== undefined) {
    state.hasGyro = true;
    const w = rotZdeg * DEG;
    const prev = state.omega;
    state.omega += (w - prev) * 0.25;
    state.alpha += ((state.omega - prev) / dt - state.alpha) * 0.1;
  }

  // 4) 旋轉方向：決定切線要指哪一邊
  if (state.spinMode === 'auto') {
    if (state.hasGyro && Math.abs(state.omega) > 0.25) {
      state.spin = state.omega > 0 ? 1 : -1;
    }
  } else {
    state.spin = state.spinMode === 'ccw' ? 1 : -1;
  }

  // 5) 圓心方向。手機鎖在轉盤上，圓心方向在裝置座標中是固定的。
  //
  //    圓周運動的加速度是  h = r·[ ω²·ĉ + ω̇·rotate(ĉ, −90°) ]
  //    也就是 h 的方向從 ĉ 偏了 φ = atan2(ω̇, ω²)（和半徑 r 無關）。
  //    所以把 ĥ 轉回 +φ 就直接得到圓心方向 —— 轉盤在加速或煞車時，
  //    圓心方向的估計也不會被切線分量帶歪。沒有陀螺儀時退回 φ = 0，
  //    純靠低通慢慢收斂。
  const usable = hMag > 0.25 && (!state.hasGyro || Math.abs(state.omega) > 0.5);
  if (usable) {
    const phi = state.hasGyro
      ? Math.atan2(state.alpha, state.omega * state.omega)
      : 0;
    const cs = Math.cos(phi);
    const sn = Math.sin(phi);
    const u = {
      x: (h.x * cs - h.y * sn) / hMag,
      y: (h.x * sn + h.y * cs) / hMag,
    };
    const flipped = state.cHat && u.x * state.cHat.x + u.y * state.cHat.y < 0;
    if (!state.cHat || (flipped && !state.centerLocked)) {
      // 幾乎反向時低通會卡在反方向（正規化後是個不動點），直接翻過去
      state.cHat = u;
    } else if (!state.centerLocked) {
      const k = state.hasGyro ? 0.06 : 0.02;
      const cx = state.cHat.x + (u.x - state.cHat.x) * k;
      const cy = state.cHat.y + (u.y - state.cHat.y) * k;
      const n = Math.hypot(cx, cy) || 1;
      state.cHat = { x: cx / n, y: cy / n };
    }
  }

  // 6) 分解成向心與切線分量
  if (state.cHat) {
    const c = state.cHat;
    // ω > 0（從螢幕上方往下看為逆時針）時 t̂ = (ĉy, −ĉx)
    const tHat = state.spin > 0
      ? { x: c.y, y: -c.x }
      : { x: -c.y, y: c.x };
    state.ac = h.x * c.x + h.y * c.y;
    state.at = h.x * tHat.x + h.y * tHat.y;
  }

  // 7) 平放檢查
  const flat = fz / G;
  if (state.mode === 'demo') {
    setStatus('示範模式：模擬轉盤加速 → 等速 → 煞車', 'warn');
  } else if (state.mode === 'sensor') {
    if (flat < 0.9) {
      setStatus(`手機沒有平放（z = ${fz.toFixed(1)} m/s²），請放平再量`, 'warn');
    } else {
      setStatus(
        state.hasGyro ? '量測中' : '量測中（無陀螺儀，請手動選旋轉方向）',
        state.hasGyro ? 'ok' : 'warn',
      );
    }
  }

  // 8) 記錄
  chartData.push({ t, ac: state.ac, at: state.at, w: state.omega });
  while (chartData.length && t - chartData[0].t > CHART_SPAN) chartData.shift();
  if (csvRows.length < CSV_LIMIT) {
    csvRows.push([t, raw.x, raw.y, raw.z, h.x, h.y, state.ac, state.at, state.omega]);
    if (csvRows.length === 1) els.btnCsv.disabled = false;
  }
}

/** 半徑與線速度：a_c = ω²r */
function derived() {
  const w = Math.abs(state.omega);
  const r = w > 0.35 ? state.ac / (w * w) : NaN;
  const v = Number.isFinite(r) ? w * r : NaN;
  return { w, r, v };
}

// ---------------------------------------------------------------- 感測器

async function startSensor() {
  if (typeof DeviceMotionEvent === 'undefined') {
    setStatus('這個瀏覽器不支援 DeviceMotion，請改用「示範模式」', 'err');
    return false;
  }
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    let res;
    try {
      res = await DeviceMotionEvent.requestPermission();
    } catch {
      setStatus('要求感測器權限失敗，請重新整理後再按一次', 'err');
      return false;
    }
    if (res !== 'granted') {
      setStatus('沒有取得動作感測器權限', 'err');
      return false;
    }
  }
  window.addEventListener('devicemotion', onDeviceMotion);

  // 有些瀏覽器需要 HTTPS 才會送出事件；三秒內沒資料就提示
  setTimeout(() => {
    if (state.running && state.mode === 'sensor' && state.sampleCount === 0) {
      setStatus('收不到感測器資料，請確認使用 HTTPS 開啟，或改用示範模式', 'err');
    }
  }, 3000);
  return true;
}

function onDeviceMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x === null || a.x === undefined) return;
  const rr = e.rotationRate;
  handleSample(
    { x: a.x, y: a.y, z: a.z },
    rr && rr.alpha !== null ? rr.alpha : undefined,
    performance.now() / 1000,
  );
}

// ---------------------------------------------------------------- 示範模式

const demo = { w: 0, t: 0, cx: Math.sin(28 * DEG), cy: Math.cos(28 * DEG) };

function demoSample(t) {
  const dt = demo.t ? Math.min(Math.max(t - demo.t, 1e-3), 0.1) : 0.016;
  demo.t = t;

  // 轉速先加速、再等速、再煞車，用來看綠色箭頭何時出現
  const cycle = t % 18;
  let target;
  if (cycle < 5) target = 1.2 * (cycle / 5);
  else if (cycle < 13) target = 1.2;
  else target = 1.2 * Math.max(0, 1 - (cycle - 13) / 3);
  target *= 2 * Math.PI; // rad/s

  const prev = demo.w;
  demo.w += (target - demo.w) * Math.min(1, dt * 1.5);
  const alpha = (demo.w - prev) / dt;
  const r = 0.25;

  const c = { x: demo.cx, y: demo.cy };           // 圓心方向
  const tHat = { x: c.y, y: -c.x };               // 逆時針的切線方向
  const ac = demo.w * demo.w * r;
  const at = alpha * r;
  const n = () => (Math.random() - 0.5) * 0.06;

  handleSample(
    {
      x: ac * c.x + at * tHat.x + n(),
      y: ac * c.y + at * tHat.y + n(),
      z: G + n(),
    },
    (demo.w / DEG) + n(),
    t,
  );
}

// ---------------------------------------------------------------- 繪圖

function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const rect = canvas.getBoundingClientRect();
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: rect.width, h: rect.height };
}

const RANGE_LADDER = [0.5, 1, 2, 5, 10, 20, 50, 100];

function updateRange() {
  if (state.rangeMode !== 'auto') {
    state.range = parseFloat(state.rangeMode);
    return;
  }
  const peak = Math.max(Math.abs(state.ac), Math.abs(state.at), 0.3) * 1.3;
  const want = RANGE_LADDER.find((v) => v >= peak) ?? 100;
  // 只在需要時才跳檔，避免數字一直抖
  if (want > state.range || peak < state.range * 0.35) state.range = want;
}

function arrow(ctx, x0, y0, x1, y1, color, width) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (len < 4) {
    ctx.beginPath();
    ctx.arc(x0, y0, width * 0.7, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const ux = dx / len;
  const uy = dy / len;
  const head = Math.min(width * 3.2, len * 0.55);
  const bx = x1 - ux * head;
  const by = y1 - uy * head;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(bx, by);
  ctx.stroke();
  const hw = head * 0.42;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(bx - uy * hw, by + ux * hw);
  ctx.lineTo(bx + uy * hw, by - ux * hw);
  ctx.closePath();
  ctx.fill();
}

function drawPhone(ctx, cx, cy, size) {
  const w = size * 0.23;
  const h = size * 0.45;
  const r = w * 0.16;
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#39405a';
  ctx.fillStyle = 'rgba(30, 36, 54, .55)';
  ctx.beginPath();
  ctx.roundRect(cx - w / 2, cy - h / 2, w, h, r);
  ctx.fill();
  ctx.stroke();
  // 聽筒：標示手機的「上方」
  ctx.fillStyle = '#4a536e';
  ctx.beginPath();
  ctx.roundRect(cx - w * 0.14, cy - h / 2 + h * 0.045, w * 0.28, 3, 2);
  ctx.fill();
  ctx.restore();
}

/** 角落的小座標軸：顯示裝置的 +X / +Y 在畫面上的實際指向。 */
function drawAxisGizmo(ctx, gx, gy) {
  const L = 16;
  const ax = toScreen({ x: 1, y: 0 });
  const ay = toScreen({ x: 0, y: 1 });
  ctx.save();
  ctx.font = '9px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [v, label] of [[ax, '+X'], [ay, '+Y']]) {
    arrow(ctx, gx, gy, gx + v.x * L, gy - v.y * L, '#46506b', 1.5);
    ctx.fillStyle = '#5d6577';
    ctx.fillText(label, gx + v.x * (L + 9), gy - v.y * (L + 9));
  }
  ctx.restore();
}

/** 把文字畫在畫布內，貼邊時自動往內縮。 */
function labelAt(ctx, x, y, text, color, w, h) {
  ctx.save();
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width;
  const cx2 = Math.min(Math.max(x, tw / 2 + 6), w - tw / 2 - 6);
  const cy2 = Math.min(Math.max(y, 12), h - 12);
  ctx.textAlign = 'center';
  ctx.fillText(text, cx2, cy2);
  ctx.restore();
}

function drawView() {
  const { ctx, w, h } = fitCanvas(els.view);
  const size = Math.min(w, h);
  const cx = w / 2;
  const cy = h / 2;
  const R = size * 0.40;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#10131b';
  ctx.fillRect(0, 0, w, h);

  updateRange();
  const k = R / state.range; // px per (m/s²)

  // 刻度圈
  ctx.save();
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, R * frac, 0, Math.PI * 2);
    ctx.strokeStyle = frac === 1 ? '#2f3648' : '#222838';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (frac === 0.5 || frac === 1) {
      // 標在左上對角線上，避開手機外框與右上角的旋轉方向指示
      const d = R * frac * 0.707;
      ctx.fillStyle = '#5d6577';
      ctx.fillText(`${+(state.range * frac).toFixed(2)}`, cx - d, cy - d);
    }
  }
  ctx.textAlign = 'right';
  ctx.fillText('刻度：m/s²', w - 10, h - 10);
  ctx.restore();

  drawPhone(ctx, cx, cy, size);
  drawAxisGizmo(ctx, 26, h - 30);

  if (!state.cHat) {
    ctx.save();
    ctx.fillStyle = '#5d6577';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('轉動轉盤以取得圓心方向…', cx, cy + R + 22);
    ctx.restore();
    return;
  }

  const c = toScreen(state.cHat);
  const tHat = state.spin > 0
    ? { x: state.cHat.y, y: -state.cHat.x }
    : { x: -state.cHat.y, y: state.cHat.x };
  const tS = toScreen(tHat);

  // 軸線：紅色指向圓心、綠色為切線軸
  ctx.save();
  ctx.setLineDash([4, 5]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,77,85,.35)';
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + c.x * R * 1.08, cy - c.y * R * 1.08);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(61,220,132,.3)';
  ctx.beginPath();
  ctx.moveTo(cx - tS.x * R, cy + tS.y * R);
  ctx.lineTo(cx + tS.x * R * 1.08, cy - tS.y * R * 1.08);
  ctx.stroke();
  ctx.restore();

  // 「圓心」標記
  labelAt(ctx, cx + c.x * (R + 16), cy - c.y * (R + 16), '圓心',
    'rgba(255,77,85,.8)', w, h);

  const clampLen = (a) => Math.min(Math.abs(a) * k, R);

  // 綠色：切線分量（先畫，讓紅色疊在上面）
  const atLen = clampLen(state.at);
  const tSign = state.at >= 0 ? 1 : -1;
  arrow(ctx, cx, cy,
    cx + tS.x * atLen * tSign, cy - tS.y * atLen * tSign,
    '#3ddc84', 5);

  // 紅色：向心分量
  const acLen = clampLen(state.ac);
  const cSign = state.ac >= 0 ? 1 : -1;
  arrow(ctx, cx, cy,
    cx + c.x * acLen * cSign, cy - c.y * acLen * cSign,
    '#ff4d55', 6);

  // 旋轉方向指示
  ctx.save();
  const rr = size * 0.075;
  const rx = w - rr - 14;
  const ry = rr + 14;
  ctx.strokeStyle = '#5aa9ff';
  ctx.lineWidth = 2;
  // canvas 角度隨順時針增加，所以螢幕上的逆時針 = anticlockwise: true
  const ccw = state.spin > 0;
  const a0 = ccw ? 1.55 * Math.PI : 0.25 * Math.PI;
  const endA = ccw ? 0.25 * Math.PI : 1.55 * Math.PI;
  ctx.beginPath();
  ctx.arc(rx, ry, rr, a0, endA, ccw);
  ctx.stroke();
  const ex = rx + Math.cos(endA) * rr;
  const ey = ry + Math.sin(endA) * rr;
  const tx = ccw ? Math.sin(endA) : -Math.sin(endA);
  const ty = ccw ? -Math.cos(endA) : Math.cos(endA);
  arrow(ctx, ex - tx * 4, ey - ty * 4, ex + tx * 9, ey + ty * 9, '#5aa9ff', 3);
  ctx.fillStyle = '#5aa9ff';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(state.spin > 0 ? '逆時針' : '順時針', rx, ry);
  ctx.restore();

  if (state.centerLocked) {
    ctx.save();
    ctx.fillStyle = '#c9a227';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText('圓心方向已鎖定', 12, 20);
    ctx.restore();
  }
}

function drawChart() {
  const { ctx, w, h } = fitCanvas(els.chart);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#10131b';
  ctx.fillRect(0, 0, w, h);

  if (chartData.length < 2) return;

  const t1 = chartData[chartData.length - 1].t;
  const t0 = t1 - CHART_SPAN;
  const aMax = Math.max(
    1,
    ...chartData.map((d) => Math.max(Math.abs(d.ac), Math.abs(d.at))),
  ) * 1.15;
  const wMax = Math.max(1, ...chartData.map((d) => Math.abs(d.w))) * 1.15;

  const X = (t) => ((t - t0) / CHART_SPAN) * w;
  const Ya = (v) => h / 2 - (v / aMax) * (h / 2 - 8);
  const Yw = (v) => h / 2 - (v / wMax) * (h / 2 - 8);

  ctx.strokeStyle = '#222838';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  const series = [
    ['w', Yw, 'rgba(90,169,255,.55)', 1.5],
    ['at', Ya, '#3ddc84', 2],
    ['ac', Ya, '#ff4d55', 2],
  ];
  for (const [key, Y, color, lw] of series) {
    ctx.beginPath();
    chartData.forEach((d, i) => {
      const x = X(d.t);
      const y = Y(d[key]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.stroke();
  }

  ctx.fillStyle = '#5d6577';
  ctx.font = '9px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`±${aMax.toFixed(1)} m/s²`, w - 4, 11);
  ctx.textAlign = 'left';
  ctx.fillText(`${CHART_SPAN}s`, 4, h - 4);
}

// 頂部的 Minecraft 羅盤：指針指向圓心方向
let compassCtx = null;
let compassImage = null;

function drawCompass() {
  if (!compassCtx) {
    compassCtx = els.compass.getContext('2d');
    compassCtx.imageSmoothingEnabled = false;
    compassImage = compassCtx.createImageData(COMPASS_BASE_SIZE, COMPASS_BASE_SIZE);
  }
  // 預設朝上；有圓心方向時指過去（canvas y 向下，所以 y 取負）
  let dx = 0;
  let dy = -1;
  if (state.cHat) {
    const c = toScreen(state.cHat);
    dx = c.x;
    dy = -c.y;
  }
  compassImage.data.set(renderCompass(dx, dy));
  const off = drawCompass.off ??= (() => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = COMPASS_BASE_SIZE;
    return cv;
  })();
  off.getContext('2d').putImageData(compassImage, 0, 0);
  compassCtx.clearRect(0, 0, els.compass.width, els.compass.height);
  compassCtx.drawImage(off, 0, 0, els.compass.width, els.compass.height);
}

// ---------------------------------------------------------------- 主迴圈

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '–');

function updateReadouts() {
  const { w, r, v } = derived();
  els.rdAc.textContent = fmt(state.ac);
  els.rdAt.textContent = fmt(state.at);
  els.rdRpm.textContent = state.hasGyro ? fmt((w * 60) / (2 * Math.PI), 1) : '–';
  els.rdR.textContent = fmt(r, 3);
  els.rdV.textContent = fmt(v);
  els.rdAh.textContent = fmt(Math.hypot(state.h.x, state.h.y));
  els.sensorInfo.textContent =
    `${state.sampleCount} 筆 · ${state.hz.toFixed(0)} Hz · ` +
    `慣例 ${state.signConv > 0 ? '規範(+z)' : 'iOS(−z)'} · ` +
    `螢幕 ${screen.orientation?.angle ?? 0}° · ` +
    `ax ${fmt(state.raw.x, 1)} ay ${fmt(state.raw.y, 1)} az ${fmt(state.raw.z, 1)}`;
}

function loop() {
  if (state.mode === 'demo' && state.running) demoSample(performance.now() / 1000);
  drawView();
  drawChart();
  drawCompass();
  updateReadouts();
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- 控制

let wakeLock = null;

async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    } else if (wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* 沒有就算了 */ }
}

function setRunning(on, mode) {
  state.running = on;
  state.mode = on ? mode : null;
  els.btnTare.disabled = !on;
  els.btnLock.disabled = !on;
  els.btnStart.textContent = on && mode === 'sensor' ? '停止' : '開始測量';
  els.btnStart.classList.toggle('stop', on && mode === 'sensor');
  els.btnDemo.classList.toggle('on', on && mode === 'demo');
  keepAwake(on);
}

els.btnStart.addEventListener('click', async () => {
  if (state.running && state.mode === 'sensor') {
    window.removeEventListener('devicemotion', onDeviceMotion);
    setRunning(false);
    setStatus('已停止');
    return;
  }
  if (state.mode === 'demo') setRunning(false);
  resetEstimators();
  setStatus('等待感測器…');
  if (await startSensor()) setRunning(true, 'sensor');
});

els.btnDemo.addEventListener('click', () => {
  if (state.mode === 'demo') {
    setRunning(false);
    setStatus('已停止');
    return;
  }
  window.removeEventListener('devicemotion', onDeviceMotion);
  resetEstimators();
  state.offX = state.offY = 0;
  setRunning(true, 'demo');
  setStatus('示範模式：模擬轉盤加速 → 等速 → 煞車', 'warn');
});

function resetEstimators() {
  state.gzLP = 0;
  state.convReady = false;
  state.cHat = null;
  state.centerLocked = false;
  state.ac = 0;
  state.at = 0;
  els.btnLock.textContent = '鎖定圓心方向';
  els.btnLock.classList.remove('on');
}

els.btnTare.addEventListener('click', () => {
  if (!state.convReady) {
    setStatus('還在判斷座標慣例，稍等一下再按', 'warn');
    return;
  }
  const s = state.signConv;
  state.offX = s * state.raw.x;
  state.offY = s * state.raw.y;
  state.cHat = null;
  state.centerLocked = false;
  els.btnLock.textContent = '鎖定圓心方向';
  els.btnLock.classList.remove('on');
  setStatus('已歸零校正', 'ok');
});

els.btnLock.addEventListener('click', () => {
  state.centerLocked = !state.centerLocked;
  els.btnLock.textContent = state.centerLocked ? '解除鎖定' : '鎖定圓心方向';
  els.btnLock.classList.toggle('on', state.centerLocked);
});

els.selSpin.addEventListener('change', (e) => {
  state.spinMode = e.target.value;
  if (state.spinMode !== 'auto') state.spin = state.spinMode === 'ccw' ? 1 : -1;
});

els.selRange.addEventListener('change', (e) => {
  state.rangeMode = e.target.value;
});

els.btnCsv.addEventListener('click', () => {
  const header = 't_s,ax,ay,az,ah_x,ah_y,a_c,a_t,omega_rad_s\n';
  const body = csvRows
    .map((r) => r.map((v) => (typeof v === 'number' ? v.toFixed(5) : v)).join(','))
    .join('\n');
  const url = URL.createObjectURL(new Blob([header + body], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `turntable-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.running) keepAwake(true);
});

// ---------------------------------------------------------------- 啟動

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

setStatus('尚未開始 — 按下「開始測量」');
requestAnimationFrame(loop);
