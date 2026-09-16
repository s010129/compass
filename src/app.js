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
 *
 * 核心問題：轉盤平面只要沒有完全水平，重力就會漏 g·sinθ 進水平面。
 * 手機跟著轉盤轉、重力卻固定在房間裡，所以這個洩漏向量在裝置座標中
 * 每轉一圈就繞一圈，而向心加速度在裝置座標中是不動的：
 *
 *     h(t) = a_c·ĉ + a_t·t̂  +  g·sinθ·(以 −ω 旋轉的單位向量)
 *            └── 直流 ──┘      └────── 頻率 ω 的正弦 ──────┘
 *
 * 歸零校正扣不掉它（那只能扣常數偏移），一般低通也濾不掉。
 * 唯一乾淨的解法是「對整數圈取平均」—— 正弦在整數週期上積分恰好為零。
 * 所以本程式改成校正優先：先轉幾圈把方向定出來鎖住，之後才即時顯示。
 *
 * 方向一律只用加速度計決定，陀螺儀只用來取 |ω|（與正負號慣例無關），
 * 供計算轉速、半徑、以及「轉了幾圈」用。
 */
import { COMPASS_BASE_SIZE, renderCompass } from './mc-compass.js';

/** 版本號，顯示在頁尾。改程式時和 sw.js 的 VERSION 一起往上跳。 */
const BUILD = 'v7';

const G = 9.80665;
const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;

/** 校正時要取樣幾圈；越多圈殘餘洩漏越小。 */
const CALIB_REVS = 3;
/** 沒有陀螺儀時改用固定時間窗（秒），無法保證整數圈。 */
const CALIB_SECONDS_NO_GYRO = 8;
const LIVE_SECONDS_NO_GYRO = 2.5;

// ---------------------------------------------------------------- 狀態

const state = {
  running: false,
  mode: null,          // 'sensor' | 'demo'

  /** accelerationIncludingGravity 的正負號慣例：+1 為規範、-1 為 iOS */
  signConv: 1,
  gzLP: 0,
  convReady: false,
  fzLP: 0,
  tiltDeg: 0,          // 手機平面偏離水平的角度（由 f_z 推得）
  level: true,

  h: { x: 0, y: 0 },   // 水平加速度（裝置座標）
  hMag: 0,
  raw: { x: 0, y: 0, z: 0 },

  omega: 0,            // |ω|，rad/s。只取大小，不管正負號慣例
  hasGyro: false,
  psi: 0,              // 累積轉角（弧度）

  // 方向（校正後鎖定）
  cHat: null,          // 圓心方向單位向量（裝置座標）
  spin: 1,             // +1 逆時針、-1 順時針（螢幕上看）
  calibrated: false,
  spinMode: 'auto',

  // 分量
  ac: 0, at: 0,        // 瞬時
  acAvg: 0, atAvg: 0,  // 每圈平均（洩漏已抵消）
  omegaAvg: 0,         // 同一個窗內的 ω 平均，算半徑時要和 a_c 配對

  // 診斷
  leakAmp: 0,          // 重力洩漏振幅 m/s²
  tableTiltDeg: 0,     // 由洩漏振幅推得的轉盤傾斜角

  viewMode: 'screen',  // 'screen' 手機自己的座標 | 'bird' 房間的鳥瞰 | 'test' 座標測試

  range: 5,
  rangeMode: 'auto',

  lastT: 0,
  sampleCount: 0,
  hz: 0,
};

// 除錯用：在主控台打 __state 可以看到所有內部估計值
if (typeof window !== 'undefined') window.__state = state;

/** 校正流程的狀態機。 */
const calib = {
  active: false,
  phase: 'idle',       // 'still' | 'spinup' | 'collect' | 'done'
  stillBuf: [],
  stillMag: 0,
  samples: [],         // collect 階段的 {x, y}
  psi0: 0,
  t0: 0,
  sumX: 0,
  sumY: 0,
  speedBuf: [],        // 最近的轉速，用來判斷是否等速
  speed0: 0,           // 開始取樣時的轉速
};

/** 每圈平均用的環形緩衝。 */
const revBuf = { items: [], sumC: 0, sumT: 0, sumW: 0, psi: 0, secs: 0 };

const chartData = [];
const csvRows = [];
const CHART_SPAN = 12;
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
  btnCalib: $('btnCalib'),
  btnClear: $('btnClear'),
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
  sbRate: $('sbRate'),
  sbGyro: $('sbGyro'),
  sbTilt: $('sbTilt'),
  sbLeak: $('sbLeak'),
  tabScreen: $('tabScreen'),
  tabBird: $('tabBird'),
  tabTest: $('tabTest'),
  legendMain: $('legendMain'),
  readouts: $('readouts'),
  controlsMain: $('controlsMain'),
  controlsOpts: $('controlsOpts'),
  chartPanel: $('chartPanel'),
  sensorBar: $('sensorBar'),
  controlsTest: $('controlsTest'),
  btnFull: $('btnFull'),
  btnOrigin: $('btnOrigin'),
  lgRaw: $('lgRaw'),
};

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = `status ${kind}`;
}

// ---------------------------------------------------------------- 工具

/** 螢幕方向補償：把裝置座標的向量轉到使用者眼中的螢幕座標（繞 z 轉 −θ）。 */
function toScreen(v) {
  const angle = (screen.orientation?.angle ?? window.orientation ?? 0) * DEG;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c + v.y * s, y: -v.x * s + v.y * c };
}

/** ω > 0（螢幕上看逆時針）時的切線方向 t̂ = (ĉy, −ĉx)。 */
function tangentOf(c, spin) {
  return spin > 0 ? { x: c.y, y: -c.x } : { x: -c.y, y: c.x };
}

const norm = (x, y) => {
  const n = Math.hypot(x, y) || 1;
  return { x: x / n, y: y / n };
};

// ---------------------------------------------------------------- 每圈平均

/**
 * 維持「最近一整圈」的分量平均。洩漏在裝置座標中是頻率 ω 的正弦，
 * 在整數圈上積分為零，所以這個平均值就是乾淨的 a_c / a_t。
 */
function pushRevolution(ac, at, w, dpsi, dt) {
  revBuf.items.push({ ac, at, w, dpsi, dt });
  revBuf.sumC += ac;
  revBuf.sumT += at;
  revBuf.sumW += w;
  revBuf.psi += dpsi;
  revBuf.secs += dt;

  const useAngle = state.hasGyro && state.omega > 0.3;
  while (revBuf.items.length > 1) {
    const over = useAngle
      ? revBuf.psi - TWO_PI
      : revBuf.secs - LIVE_SECONDS_NO_GYRO;
    if (over <= 0) break;
    const old = revBuf.items.shift();
    revBuf.sumC -= old.ac;
    revBuf.sumT -= old.at;
    revBuf.sumW -= old.w;
    revBuf.psi -= old.dpsi;
    revBuf.secs -= old.dt;
  }
  const n = revBuf.items.length;
  state.acAvg = revBuf.sumC / n;
  state.atAvg = revBuf.sumT / n;
  state.omegaAvg = revBuf.sumW / n;
}

function resetRevolution() {
  revBuf.items.length = 0;
  revBuf.sumC = revBuf.sumT = revBuf.sumW = revBuf.psi = revBuf.secs = 0;
  state.acAvg = state.atAvg = state.omegaAvg = 0;
}

// ---------------------------------------------------------------- 校正

function startCalibration() {
  calib.active = true;
  calib.phase = 'still';
  calib.stillBuf.length = 0;
  calib.samples.length = 0;
  calib.speedBuf.length = 0;
  calib.sumX = calib.sumY = 0;
  state.calibrated = false;
  state.cHat = null;
  resetRevolution();
  els.btnCalib.classList.add('on');
  els.btnCalib.textContent = '取消校正';
}

function stopCalibration() {
  calib.active = false;
  calib.phase = 'idle';
  els.btnCalib.classList.remove('on');
  els.btnCalib.textContent = '校正方向';
}

/**
 * 校正完成時從 collect 階段的樣本一次算出所有東西。
 *
 *   平均值   → 圓心方向 ĉ 與 a_c（整數圈平均，洩漏抵消）
 *   殘差     → 重力洩漏，其振幅換算成轉盤傾斜角
 *   殘差轉向 → 旋轉方向。房間裡固定的向量在裝置座標中以 −ω 旋轉，
 *              所以洩漏轉的方向和轉盤相反。
 */
function finishCalibration() {
  const n = calib.samples.length;
  const mx = calib.sumX / n;
  const my = calib.sumY / n;
  const mean = Math.hypot(mx, my);

  if (mean < 0.05) {
    setStatus('校正失敗：向心加速度太小。手機要放在遠離圓心的位置，並轉快一點', 'err');
    stopCalibration();
    return;
  }

  state.cHat = norm(mx, my);

  // 殘差 = 重力洩漏
  let sumSq = 0;
  let cross = 0;
  let prev = null;
  for (const s of calib.samples) {
    const lx = s.x - mx;
    const ly = s.y - my;
    sumSq += lx * lx + ly * ly;
    if (prev) cross += prev.x * ly - prev.y * lx;
    prev = { x: lx, y: ly };
  }
  state.leakAmp = Math.sqrt(sumSq / n);          // 正弦的 RMS 合成即振幅
  state.tableTiltDeg = Math.asin(Math.min(1, state.leakAmp / G)) / DEG;

  // cross > 0 表示洩漏在裝置座標中逆時針轉 → 轉盤是順時針
  if (state.spinMode === 'auto') {
    if (Math.abs(cross) > 1e-4 && state.leakAmp > 0.03) {
      state.spin = cross > 0 ? -1 : 1;
    }
  }

  state.calibrated = true;
  stopCalibration();
  resetRevolution();

  setStatus(
    `校正完成：圓心方向已鎖定，${state.spin > 0 ? '逆時針' : '順時針'}；` +
    `轉盤傾斜 ${state.tableTiltDeg.toFixed(1)}°（造成 ±${state.leakAmp.toFixed(2)} m/s² 的週期誤差，已由每圈平均消除）`,
    'ok',
  );
}

function stepCalibration(dt) {
  const h = state.h;
  const mag = state.hMag;

  if (calib.phase === 'still') {
    calib.stillBuf.push({ x: h.x, y: h.y });
    if (calib.stillBuf.length > 90) calib.stillBuf.shift();
    if (calib.stillBuf.length < 90) {
      setStatus('校正 1/3：讓轉盤完全靜止…', 'warn');
      return;
    }
    // 看這段時間內的變動量，而不是大小 —— 桌面歪的時候靜止讀值也不是 0
    let mx = 0;
    let my = 0;
    for (const s of calib.stillBuf) { mx += s.x; my += s.y; }
    mx /= calib.stillBuf.length;
    my /= calib.stillBuf.length;
    let dev = 0;
    for (const s of calib.stillBuf) {
      dev = Math.max(dev, Math.hypot(s.x - mx, s.y - my));
    }
    if (dev < 0.08) {
      calib.stillMag = Math.hypot(mx, my);
      calib.phase = 'spinup';
      setStatus('校正 2/3：現在把轉盤轉起來，維持同一個方向', 'warn');
    } else {
      setStatus(`校正 1/3：讓轉盤完全靜止…（還在晃動 ${dev.toFixed(2)} m/s²）`, 'warn');
    }
    return;
  }

  // 取樣一定要等到等速才能開始。轉盤還在加速時，a_c 一路長大、a_t 又不是 0，
  // 平均值會被切線分量拉歪，殘差也會被 a_c 的變化蓋過，連帶把傾斜角估爆。
  // 摩擦造成的緩慢衰減遠在這個容差內，只有「明顯在加速」才會被擋下來。
  const speed = state.hasGyro ? state.omega : mag;
  calib.speedBuf.push(speed);
  if (calib.speedBuf.length > 90) calib.speedBuf.shift();

  if (calib.phase === 'spinup') {
    const spun = mag > calib.stillMag + 0.25 && (!state.hasGyro || state.omega > 0.6);
    if (!spun || calib.speedBuf.length < 90) {
      setStatus('校正 2/3：現在把轉盤轉起來，維持同一個方向', 'warn');
      return;
    }
    const lo = Math.min(...calib.speedBuf);
    const hi = Math.max(...calib.speedBuf);
    const mid = (lo + hi) / 2;
    if (mid > 0 && (hi - lo) / mid < 0.06) {
      calib.phase = 'collect';
      calib.psi0 = state.psi;
      calib.t0 = state.lastT;
      calib.speed0 = speed;
      calib.samples.length = 0;
      calib.sumX = calib.sumY = 0;
    } else {
      setStatus(
        `校正 2/3：轉速還在變（±${((hi - lo) / mid * 100).toFixed(0)}%），請維持等速`,
        'warn',
      );
    }
    return;
  }

  if (calib.phase === 'collect') {
    // 取樣中途轉速變太多就重來，否則平均值會混到不同轉速的資料
    if (calib.speed0 > 0 && Math.abs(speed - calib.speed0) / calib.speed0 > 0.15) {
      calib.phase = 'spinup';
      calib.samples.length = 0;
      calib.sumX = calib.sumY = 0;
      setStatus('校正 2/3：轉速變化太大，重新取樣。請維持等速', 'warn');
      return;
    }
    calib.samples.push({ x: h.x, y: h.y });
    calib.sumX += h.x;
    calib.sumY += h.y;

    const revs = (state.psi - calib.psi0) / TWO_PI;
    const secs = state.lastT - calib.t0;
    if (state.hasGyro) {
      setStatus(
        `校正 3/3：保持等速旋轉…已取樣 ${revs.toFixed(1)} / ${CALIB_REVS} 圈`,
        'warn',
      );
      if (revs >= CALIB_REVS) finishCalibration();
    } else {
      setStatus(
        `校正 3/3：保持等速旋轉…${secs.toFixed(1)} / ${CALIB_SECONDS_NO_GYRO} 秒（無陀螺儀）`,
        'warn',
      );
      if (secs >= CALIB_SECONDS_NO_GYRO) finishCalibration();
    }
  }
}

// ---------------------------------------------------------------- 取樣

function handleSample(raw, rotZdeg, t) {
  const dt = state.lastT ? Math.min(Math.max(t - state.lastT, 1e-3), 0.2) : 0.016;
  state.lastT = t;
  state.sampleCount++;
  state.hz += (1 / dt - state.hz) * 0.05;
  state.raw = raw;

  // 1) 正負號慣例：平放螢幕朝上時，規範下 z ≈ +9.8、iOS ≈ −9.8。
  //    慣例確定之前不能往下算。
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

  // 2) 手機自身的傾斜角。f_z = g·cosθ，是唯一能把「真的水平加速度」
  //    和「手機被拿歪」分開的線索。
  state.fzLP += (fz - state.fzLP) * 0.05;
  state.tiltDeg = Math.acos(Math.min(1, Math.max(-1, state.fzLP / G))) / DEG;
  state.level = state.tiltDeg < 10;

  // 3) 水平分量
  const h = { x: s * raw.x, y: s * raw.y };
  state.h = h;
  state.hMag = Math.hypot(h.x, h.y);

  // 4) 角速度。只取大小，所以 iOS / Android 的正負號慣例都無所謂。
  if (rotZdeg !== null && rotZdeg !== undefined) {
    state.hasGyro = true;
    const w = Math.abs(rotZdeg * DEG);
    state.omega += (w - state.omega) * 0.25;
  }
  state.psi += state.omega * dt;

  // 5) 旋轉方向：手動指定優先於校正結果
  if (state.spinMode !== 'auto') {
    state.spin = state.spinMode === 'ccw' ? 1 : -1;
  }

  // 6) 校正流程
  if (calib.active) {
    if (!state.level) {
      setStatus(`校正中斷：手機傾斜 ${state.tiltDeg.toFixed(1)}°，請放平`, 'err');
    } else {
      stepCalibration(dt);
    }
  }

  // 7) 分解。校正過就用鎖定的方向；沒校正過就退回慢速低通（時間常數
  //    刻意拉到一圈以上，否則洩漏會把方向帶著跑）。
  if (!state.calibrated && state.level && state.hMag > 0.08 && !calib.active) {
    const u = norm(h.x, h.y);
    if (!state.cHat) {
      state.cHat = u;
    } else {
      const period = state.hasGyro && state.omega > 0.3 ? TWO_PI / state.omega : 2.5;
      const k = Math.min(0.5, dt / Math.max(period, 1.0));
      const c = norm(
        state.cHat.x + (u.x - state.cHat.x) * k,
        state.cHat.y + (u.y - state.cHat.y) * k,
      );
      state.cHat = c;
    }
  }

  if (state.cHat) {
    const c = state.cHat;
    const tHat = tangentOf(c, state.spin);
    state.ac = h.x * c.x + h.y * c.y;
    state.at = h.x * tHat.x + h.y * tHat.y;
    pushRevolution(state.ac, state.at, state.omega, state.omega * dt, dt);
  }

  // 8) 狀態訊息
  if (!calib.active) {
    if (state.mode === 'demo') {
      setStatus('示範模式：模擬轉盤加速 → 等速 → 煞車（含 2° 桌面傾斜）', 'warn');
    } else if (state.mode === 'sensor') {
      if (!state.level) {
        setStatus(
          `手機沒有平放（傾斜 ${state.tiltDeg.toFixed(1)}°，重力洩漏約 ` +
          `${(G * Math.sin(state.tiltDeg * DEG)).toFixed(1)} m/s²）—— 讀到的是重力不是圓周運動`,
          'err',
        );
      } else if (state.hMag < 0.08) {
        setStatus('已平放，但水平加速度幾乎是 0：轉盤要轉，而且手機不能放在圓心上', 'warn');
      } else if (!state.calibrated) {
        setStatus('量測中（未校正）—— 按「校正方向」可鎖定圓心方向並消除桌面傾斜的影響', 'warn');
      } else {
        setStatus('量測中（已校正）', 'ok');
      }
    }
  }

  // 9) 記錄
  chartData.push({ t, ac: state.acAvg, at: state.atAvg, w: state.omega });
  while (chartData.length && t - chartData[0].t > CHART_SPAN) chartData.shift();
  if (csvRows.length < CSV_LIMIT) {
    csvRows.push([t, raw.x, raw.y, raw.z, h.x, h.y,
      state.ac, state.at, state.acAvg, state.atAvg, state.omega]);
    if (csvRows.length === 1) els.btnCsv.disabled = false;
  }
}

/**
 * 半徑與線速度：a_c = ω²r。
 * a_c 是「最近一整圈」的平均，所以 ω 也要取同一個窗的平均，否則轉速在變的
 * 時候會拿到不同時刻的量去相除，半徑會爆掉。
 */
function derived() {
  const wAvg = state.omegaAvg;
  // a_c 必須是正的才有物理意義（向心永遠指向圓心），否則就是還沒轉起來
  const r = wAvg > 0.35 && state.acAvg > 0.02 ? state.acAvg / (wAvg * wAvg) : NaN;
  const v = Number.isFinite(r) ? wAvg * r : NaN;
  return { w: state.omega, r, v };
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
      setStatus(
        '沒有取得動作感測器權限。iOS 請到「設定 → Safari → 動作與方向存取」打開，' +
        '再重新載入頁面',
        'err',
      );
      return false;
    }
  }
  window.addEventListener('devicemotion', onDeviceMotion);
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

const demo = { w: 0, t: 0, psi: 0, tilt: 2 * DEG, cx: Math.sin(28 * DEG), cy: Math.cos(28 * DEG) };

function demoSample(t) {
  const dt = demo.t ? Math.min(Math.max(t - demo.t, 1e-3), 0.1) : 0.016;
  demo.t = t;

  const cycle = t % 26;
  let target;
  if (cycle < 4) target = 0;              // 靜止，讓校正抓得到
  else if (cycle < 9) target = 1.2 * ((cycle - 4) / 5);
  else if (cycle < 21) target = 1.2;
  else target = 1.2 * Math.max(0, 1 - (cycle - 21) / 3);
  target *= TWO_PI;

  const prev = demo.w;
  demo.w += (target - demo.w) * Math.min(1, dt * 1.5);
  demo.psi += demo.w * dt;
  const alpha = (demo.w - prev) / dt;
  const r = 0.25;

  const c = { x: demo.cx, y: demo.cy };
  const tHat = { x: c.y, y: -c.x };           // 逆時針
  const ac = demo.w * demo.w * r;
  const at = alpha * r;

  // 桌面傾斜造成的重力洩漏：在裝置座標中以 −ψ 旋轉
  const leak = G * Math.sin(demo.tilt);
  const lx = leak * Math.cos(-demo.psi);
  const ly = leak * Math.sin(-demo.psi);
  const n = () => (Math.random() - 0.5) * 0.05;

  handleSample(
    {
      x: ac * c.x + at * tHat.x + lx + n(),
      y: ac * c.y + at * tHat.y + ly + n(),
      z: G * Math.cos(demo.tilt) + n(),
    },
    demo.w / DEG + n(),
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
  const peak = Math.max(Math.abs(state.acAvg), Math.abs(state.atAvg), state.hMag, 0.3) * 1.3;
  const want = RANGE_LADDER.find((v) => v >= peak) ?? 100;
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
    ctx.arc(x0, y0, width * 0.7, 0, TWO_PI);
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
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#39405a';
  ctx.fillStyle = 'rgba(30, 36, 54, .55)';
  ctx.beginPath();
  ctx.roundRect(cx - w / 2, cy - h / 2, w, h, w * 0.16);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#4a536e';
  ctx.beginPath();
  ctx.roundRect(cx - w * 0.14, cy - h / 2 + h * 0.045, w * 0.28, 3, 2);
  ctx.fill();
  ctx.restore();
}

function drawAxisGizmo(ctx, gx, gy) {
  const L = 16;
  ctx.save();
  ctx.font = '9px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [v, label] of [[toScreen({ x: 1, y: 0 }), '+X'], [toScreen({ x: 0, y: 1 }), '+Y']]) {
    arrow(ctx, gx, gy, gx + v.x * L, gy - v.y * L, '#46506b', 1.5);
    ctx.fillStyle = '#5d6577';
    ctx.fillText(label, gx + v.x * (L + 9), gy - v.y * (L + 9));
  }
  ctx.restore();
}

function labelAt(ctx, x, y, text, color, w, h) {
  ctx.save();
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width;
  ctx.textAlign = 'center';
  ctx.fillText(
    text,
    Math.min(Math.max(x, tw / 2 + 6), w - tw / 2 - 6),
    Math.min(Math.max(y, 12), h - 12),
  );
  ctx.restore();
}

// ---------------------------------------------------------------- 座標測試

/**
 * 座標測試畫面：整個畫面的原始像素座標。
 *
 * 原點 (0, 0) 在畫面左上角，和瀏覽器的 clientX / clientY 完全一致。
 * 點畫面任何一處燈就跳過去，十字鍵一格一格微調（按住會加速）。
 *
 * 除了原始像素，同時顯示「裝置座標」—— 也就是紅綠箭頭真正用的那個座標系
 * （原點在中心、+y 朝螢幕上方、已用 screen.orientation.angle 補償）。
 * 兩組數字並排，轉換有沒有顛倒一眼就看得出來。
 */
const test = {
  x: 0, y: 0,          // 原始 CSS 像素，原點在左上角
  w: 0, h: 0,          // 畫布的 CSS 尺寸
  hits: null,
  flash: 0,
  fs: false,           // 是否在全螢幕
  held: null,
  heldAt: 0,
  timer: null,
};
if (typeof window !== 'undefined') window.__test = test;

/** 螢幕座標 → 裝置座標：toScreen 的反向，繞 z 轉 +θ。 */
function fromScreen(v) {
  const angle = (screen.orientation?.angle ?? window.orientation ?? 0) * DEG;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

function testSetPos(x, y) {
  test.x = Math.round(Math.min(Math.max(x, 0), Math.max(0, test.w - 1)));
  test.y = Math.round(Math.min(Math.max(y, 0), Math.max(0, test.h - 1)));
  test.flash = performance.now();
}

/** 按住越久步進越大：先 1 px，0.6 秒後 5 px，1.5 秒後 20 px。 */
function testStep() {
  const held = performance.now() - test.heldAt;
  if (held > 1500) return 20;
  if (held > 600) return 5;
  return 1;
}

function testNudge(dir) {
  const s = testStep();
  const d = { up: [0, -s], down: [0, s], left: [-s, 0], right: [s, 0] }[dir];
  if (!d) return;
  testSetPos(test.x + d[0], test.y + d[1]);
  if (navigator.vibrate) { try { navigator.vibrate(4); } catch { /* 略 */ } }
}

function testStopHold() {
  if (test.timer !== null) {
    clearTimeout(test.timer);
    clearInterval(test.timer);
    test.timer = null;
  }
  test.held = null;
}

function testHold(dir) {
  testStopHold();
  test.held = dir;
  test.heldAt = performance.now();
  testNudge(dir);
  // 先等 300 ms 再開始連發，這樣輕點只會走一格
  test.timer = setTimeout(() => {
    test.timer = setInterval(() => { if (test.held) testNudge(test.held); }, 70);
  }, 300);
}

/**
 * 全螢幕。iPhone 的 Safari 沒有 Fullscreen API（只有 iPad 有），
 * 所以先套 CSS 的滿版覆蓋，再「盡量」呼叫 Fullscreen API；
 * 失敗也還是滿版，只是上面會留系統列。
 */
async function toggleTestFullscreen() {
  if (test.fs) {
    test.fs = false;
    document.body.classList.remove('fs-test');
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      try { await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.()); }
      catch { /* 略 */ }
    }
    return;
  }
  test.fs = true;
  document.body.classList.add('fs-test');
  const el = document.documentElement;
  const req = el.requestFullscreen ?? el.webkitRequestFullscreen;
  if (req) { try { await req.call(el); } catch { /* 沒有就算了 */ } }
}

// 使用者按 Esc 離開時把狀態同步回來
for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(ev, () => {
    const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (!on && test.fs) {
      test.fs = false;
      document.body.classList.remove('fs-test');
    }
  });
}

function drawTestView() {
  const { ctx, w, h } = fitCanvas(els.view);
  test.w = w;
  test.h = h;
  const cx = w / 2;
  const cy = h / 2;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0b0d12';
  ctx.fillRect(0, 0, w, h);

  // 每 50 px 一條細線、每 100 px 一條亮線並標數字
  ctx.save();
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = '#39405a';
  ctx.lineWidth = 1;
  for (let x = 0; x <= w; x += 50) {
    const major = x % 100 === 0;
    ctx.strokeStyle = major ? '#20273a' : '#161b28';
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
    if (major && x > 0) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(String(x), x + 3, 3);
    }
  }
  for (let y = 0; y <= h; y += 50) {
    const major = y % 100 === 0;
    ctx.strokeStyle = major ? '#20273a' : '#161b28';
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
    ctx.stroke();
    if (major && y > 0) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(String(y), 3, y + 3);
    }
  }
  ctx.restore();

  // 畫面中心：裝置座標的原點
  ctx.save();
  ctx.strokeStyle = 'rgba(90,169,255,.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, 9, 0, TWO_PI);
  ctx.stroke();
  ctx.font = '9px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(90,169,255,.6)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('中心', cx, cy + 12);
  ctx.restore();

  // 通過燈的十字準線，方便讀座標
  ctx.save();
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = 'rgba(255,201,60,.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, test.y + 0.5);
  ctx.lineTo(w, test.y + 0.5);
  ctx.moveTo(test.x + 0.5, 0);
  ctx.lineTo(test.x + 0.5, h);
  ctx.stroke();
  ctx.restore();

  // 十字鍵（畫在燈的下層，燈才不會被遮住）。保底 44 CSS px 觸控範圍。
  const b = Math.max(44, Math.min(w, h) * 0.12);
  const mk = (ox, oy) => ({ x: cx + ox - b / 2, y: cy + oy - b / 2, w: b, h: b });
  test.hits = {
    up: mk(0, -b), down: mk(0, b), left: mk(-b, 0), right: mk(b, 0), center: mk(0, 0),
    exit: test.fs ? { x: w - 56, y: 8, w: 48, h: 44 } : null,
  };
  ctx.save();
  ctx.strokeStyle = 'rgba(148,157,176,.4)';
  ctx.fillStyle = 'rgba(148,157,176,.34)';
  ctx.lineWidth = 1.5;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(b * 0.4)}px system-ui, sans-serif`;
  for (const [key, glyph] of [['up', '▲'], ['down', '▼'], ['left', '◀'], ['right', '▶']]) {
    const r = test.hits[key];
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, 9);
    ctx.stroke();
    ctx.fillText(glyph, r.x + r.w / 2, r.y + r.h / 2);
  }
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(148,157,176,.3)';
  ctx.fillText('歸零', cx, cy);
  if (test.hits.exit) {
    const r = test.hits.exit;
    ctx.strokeStyle = 'rgba(148,157,176,.5)';
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, 9);
    ctx.stroke();
    ctx.fillStyle = 'rgba(200,210,228,.75)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('離開', r.x + r.w / 2, r.y + r.h / 2);
  }
  ctx.restore();

  // 燈
  const pulse = 1 + 0.3 * Math.max(0, 1 - (performance.now() - test.flash) / 200);
  const rad = 9 * pulse;
  const glow = ctx.createRadialGradient(test.x, test.y, 0, test.x, test.y, rad * 4);
  glow.addColorStop(0, 'rgba(255,201,60,.8)');
  glow.addColorStop(0.35, 'rgba(255,201,60,.25)');
  glow.addColorStop(1, 'rgba(255,201,60,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(test.x, test.y, rad * 4, 0, TWO_PI);
  ctx.fill();
  ctx.fillStyle = '#ffe9a6';
  ctx.beginPath();
  ctx.arc(test.x, test.y, rad, 0, TWO_PI);
  ctx.fill();

  // 讀數面板。燈在上半部就擺下面，反之擺上面，才不會蓋到燈。
  const dpr = window.devicePixelRatio || 1;
  const dev = fromScreen({ x: test.x - cx, y: -(test.y - cy) });
  const sign = (v) => (v >= 0 ? `+${Math.round(v)}` : `${Math.round(v)}`);
  const lines = [
    ['big', `( ${test.x} , ${test.y} )`],
    ['sub', `裝置像素 (${Math.round(test.x * dpr)}, ${Math.round(test.y * dpr)})　dpr ${dpr}`],
    ['sub', `裝置座標 (${sign(dev.x)}, ${sign(dev.y)})　原點中心・+y 朝上`],
    ['dim', `畫布 ${Math.round(w)}×${Math.round(h)}　視窗 ${innerWidth}×${innerHeight}` +
      `　螢幕 ${screen.width}×${screen.height}　方向 ${screen.orientation?.angle ?? 0}°`],
  ];
  const padY = 10;
  const ph = padY * 2 + 34 + 16 * 2 + 14;
  const py = test.y < h / 2 ? h - ph - 10 : 10;
  ctx.save();
  ctx.fillStyle = 'rgba(11,13,18,.88)';
  ctx.strokeStyle = '#2b3040';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(8, py, w - 16, ph, 10);
  ctx.fill();
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  let ty = py + padY;
  for (const [kind, txt] of lines) {
    if (kind === 'big') {
      ctx.fillStyle = '#ffc93c';
      ctx.font = '600 28px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(txt, w / 2, ty);
      ty += 34;
    } else if (kind === 'sub') {
      ctx.fillStyle = '#949db0';
      ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(txt, w / 2, ty);
      ty += 16;
    } else {
      ctx.fillStyle = '#46506b';
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(txt, w / 2, ty);
      ty += 14;
    }
  }
  ctx.restore();

  // 四個角的座標，標出原始座標系的範圍
  ctx.save();
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = '#5d6577';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('(0,0)', 4, h - 14);
  ctx.textAlign = 'right';
  ctx.fillText(`(${Math.round(w)},${Math.round(h)})`, w - 4, h - 14);
  ctx.restore();
}

/** 鳥瞰視角的起始角度：手機畫在 3 點鐘方向，圓心在它左邊。 */
const BIRD_BASE = 0;

/**
 * 鳥瞰視角：房間的參考系，手機繞著圓心跑。
 *
 * 和常見做法的三個差別：
 *  1. 轉角用陀螺儀的 |ω| 積分驅動，不用 deviceorientation 的方位角 ——
 *     方位角在 Android 是磁力計絕對值（轉盤的金屬軸承、馬達磁鐵會干擾），
 *     在 iOS 是相對值且會持續漂移。
 *  2. canvas 的 y 軸向下，所以螢幕上的逆時針對應 canvas 角度「遞減」。
 *     直接把角度加上去會讓畫面轉向和實際相反。
 *  3. 箭頭長度是真的量出來的 a_c / a_t，不是從假設的圓幾何畫出來的。
 *     方向由校正鎖定的 ĉ 決定，手機圖示也照 ĉ 轉到正確的安裝角度。
 */
function drawBirdView() {
  const { ctx, w, h } = fitCanvas(els.view);
  const size = Math.min(w, h);
  const cx = w / 2;
  const cy = h / 2;
  const R = size * 0.32;
  const maxArrow = size * 0.22;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#10131b';
  ctx.fillRect(0, 0, w, h);

  // 轉盤
  ctx.strokeStyle = '#2f3648';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TWO_PI);
  ctx.stroke();

  // 手機在圓上的位置。spin > 0 是螢幕上的逆時針，canvas 角度要遞減。
  const a = BIRD_BASE - state.spin * state.psi;
  const px = cx + Math.cos(a) * R;
  const py = cy + Math.sin(a) * R;

  // 走過的軌跡（在手機後方）
  ctx.strokeStyle = 'rgba(90,169,255,.28)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, R, a + state.spin * 1.5, a, state.spin > 0);
  ctx.stroke();

  // 半徑線
  ctx.save();
  ctx.setLineDash([4, 5]);
  ctx.strokeStyle = 'rgba(140,152,180,.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(px, py);
  ctx.stroke();
  ctx.restore();

  // 圓心
  ctx.fillStyle = '#e7ecf3';
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, TWO_PI);
  ctx.fill();
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = '#949db0';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('圓心', cx, cy + 9);

  const { r } = derived();
  if (Number.isFinite(r)) {
    ctx.fillStyle = '#5d6577';
    ctx.textBaseline = 'middle';
    ctx.fillText(`r = ${r.toFixed(3)} m`,
      cx + Math.cos(a) * R * 0.5, cy + Math.sin(a) * R * 0.5 - 12);
  }

  // 手機圖示。轉到讓裝置的 ĉ 對準指向圓心的方向 —— 也就是真實的安裝角度。
  const aIn = Math.atan2(cy - py, cx - px);
  const alphaC = state.cHat ? Math.atan2(-state.cHat.y, state.cHat.x) : 0;
  const iconRot = aIn - alphaC;
  const iw = size * 0.085;
  const ih = size * 0.16;

  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(iconRot);
  ctx.fillStyle = '#1e2436';
  ctx.strokeStyle = '#7d879e';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(-iw / 2, -ih / 2, iw, ih, iw * 0.18);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#0b0d12';
  ctx.fillRect(-iw * 0.36, -ih * 0.38, iw * 0.72, ih * 0.76);
  ctx.fillStyle = '#4a536e';
  ctx.beginPath();
  ctx.roundRect(-iw * 0.14, -ih / 2 + ih * 0.05, iw * 0.28, 2.5, 2);
  ctx.fill();
  ctx.restore();

  if (!state.cHat) {
    ctx.fillStyle = '#5d6577';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('轉動轉盤以取得圓心方向…', cx, h - 14);
    return;
  }

  // 前進方向：位置角以 −spin 的速率變化，所以速度方向是 spin·(sin a, −cos a)
  const tang = { x: state.spin * Math.sin(a), y: -state.spin * Math.cos(a) };

  updateRange();
  const k = maxArrow / state.range;
  const len = (v) => Math.min(Math.abs(v) * k, maxArrow);

  if (!state.level) ctx.globalAlpha = 0.22;

  const tSign = state.atAvg >= 0 ? 1 : -1;
  const tl = len(state.atAvg);
  arrow(ctx, px, py, px + tang.x * tl * tSign, py + tang.y * tl * tSign, '#3ddc84', 5);

  const cSign = state.acAvg >= 0 ? 1 : -1;
  const cl = len(state.acAvg);
  arrow(ctx, px, py,
    px + Math.cos(aIn) * cl * cSign, py + Math.sin(aIn) * cl * cSign, '#ff4d55', 6);
  ctx.globalAlpha = 1;

  // 旋轉方向與狀態
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#5aa9ff';
  ctx.fillText(state.spin > 0 ? '逆時針 ↺' : '順時針 ↻', 12, h - 14);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#5d6577';
  ctx.fillText(`${(state.omega * 60 / TWO_PI).toFixed(1)} rpm`, w - 12, h - 14);
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = state.calibrated ? '#3ddc84' : '#c9a227';
  ctx.fillText(state.calibrated ? '已校正・方向鎖定' : '未校正・方向估計中', 12, 20);
}

function drawView() {
  if (state.viewMode === 'test') { drawTestView(); return; }
  if (state.viewMode === 'bird') { drawBirdView(); return; }
  const { ctx, w, h } = fitCanvas(els.view);
  const size = Math.min(w, h);
  const cx = w / 2;
  const cy = h / 2;
  const R = size * 0.40;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#10131b';
  ctx.fillRect(0, 0, w, h);

  updateRange();
  const k = R / state.range;

  ctx.save();
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, R * frac, 0, TWO_PI);
    ctx.strokeStyle = frac === 1 ? '#2f3648' : '#222838';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (frac === 0.5 || frac === 1) {
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

  // 瞬時的水平合成向量（含重力洩漏），讓人看得到原始訊號在動
  const hS = toScreen(state.h);
  const hMag = Math.hypot(hS.x, hS.y);
  if (hMag > 0.02) {
    const hLen = Math.min(hMag * k, R);
    arrow(ctx, cx, cy, cx + (hS.x / hMag) * hLen, cy - (hS.y / hMag) * hLen,
      'rgba(190,200,220,.4)', 3);
  }

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
  const tS = toScreen(tangentOf(state.cHat, state.spin));

  // 圓周軌跡
  {
    const Ro = R * 0.78;
    const ox = cx + c.x * Ro;
    const oy = cy - c.y * Ro;
    const a0 = Math.atan2(cy - oy, cx - ox);
    ctx.save();
    ctx.setLineDash([5, 6]);
    ctx.strokeStyle = 'rgba(140,152,180,.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(ox, oy, Ro, a0 - 1.15, a0 + 1.15);
    ctx.stroke();
    ctx.setLineDash([]);
    const ahead = a0 + (state.spin > 0 ? -0.75 : 0.75);
    const px = ox + Math.cos(ahead) * Ro;
    const py = oy + Math.sin(ahead) * Ro;
    const tg = state.spin > 0
      ? { x: Math.sin(ahead), y: -Math.cos(ahead) }
      : { x: -Math.sin(ahead), y: Math.cos(ahead) };
    arrow(ctx, px - tg.x * 8, py - tg.y * 8, px + tg.x * 10, py + tg.y * 10,
      'rgba(140,152,180,.75)', 2.5);
    ctx.restore();
  }

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

  labelAt(ctx, cx + c.x * (R + 16), cy - c.y * (R + 16), '圓心', 'rgba(255,77,85,.8)', w, h);

  if (!state.level) ctx.globalAlpha = 0.22;

  const clampLen = (a) => Math.min(Math.abs(a) * k, R);
  const atLen = clampLen(state.atAvg);
  const tSign = state.atAvg >= 0 ? 1 : -1;
  arrow(ctx, cx, cy, cx + tS.x * atLen * tSign, cy - tS.y * atLen * tSign, '#3ddc84', 5);

  const acLen = clampLen(state.acAvg);
  const cSign = state.acAvg >= 0 ? 1 : -1;
  arrow(ctx, cx, cy, cx + c.x * acLen * cSign, cy - c.y * acLen * cSign, '#ff4d55', 6);

  ctx.globalAlpha = 1;
  if (!state.level) {
    ctx.save();
    ctx.fillStyle = 'rgba(255,77,85,.14)';
    ctx.fillRect(0, cy - 26, w, 52);
    ctx.fillStyle = '#ff4d55';
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`手機傾斜 ${state.tiltDeg.toFixed(0)}° — 讀到的是重力`, cx, cy - 8);
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('請放平再量', cx, cy + 11);
    ctx.restore();
  }

  // 旋轉方向指示
  ctx.save();
  const rr = size * 0.075;
  const rx = w - rr - 14;
  const ry = rr + 14;
  ctx.strokeStyle = '#5aa9ff';
  ctx.lineWidth = 2;
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
  ctx.fillText(ccw ? '逆時針' : '順時針', rx, ry);
  ctx.restore();

  ctx.save();
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = state.calibrated ? '#3ddc84' : '#c9a227';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(state.calibrated ? '已校正・方向鎖定' : '未校正・方向估計中', 12, 20);
  ctx.restore();
}

function drawChart() {
  const { ctx, w, h } = fitCanvas(els.chart);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#10131b';
  ctx.fillRect(0, 0, w, h);
  if (chartData.length < 2) return;

  const t1 = chartData[chartData.length - 1].t;
  const t0 = t1 - CHART_SPAN;
  const aMax = Math.max(1, ...chartData.map((d) => Math.max(Math.abs(d.ac), Math.abs(d.at)))) * 1.15;
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

  for (const [key, Y, color, lw] of [
    ['w', Yw, 'rgba(90,169,255,.55)', 1.5],
    ['at', Ya, '#3ddc84', 2],
    ['ac', Ya, '#ff4d55', 2],
  ]) {
    ctx.beginPath();
    chartData.forEach((d, i) => {
      const x = X(d.t);
      const y = Y(d[key]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
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

let compassCtx = null;
let compassImage = null;
let compassOff = null;

function drawCompass() {
  if (!compassCtx) {
    compassCtx = els.compass.getContext('2d');
    compassCtx.imageSmoothingEnabled = false;
    compassImage = compassCtx.createImageData(COMPASS_BASE_SIZE, COMPASS_BASE_SIZE);
    compassOff = document.createElement('canvas');
    compassOff.width = compassOff.height = COMPASS_BASE_SIZE;
  }
  let dx = 0;
  let dy = -1;
  if (state.cHat) {
    const c = toScreen(state.cHat);
    dx = c.x;
    dy = -c.y;
  }
  compassImage.data.set(renderCompass(dx, dy));
  compassOff.getContext('2d').putImageData(compassImage, 0, 0);
  compassCtx.clearRect(0, 0, els.compass.width, els.compass.height);
  compassCtx.drawImage(compassOff, 0, 0, els.compass.width, els.compass.height);
}

// ---------------------------------------------------------------- 主迴圈

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '–');

function updateReadouts() {
  const { w, r, v } = derived();
  els.rdAc.textContent = fmt(state.acAvg);
  els.rdAt.textContent = fmt(state.atAvg);
  els.rdRpm.textContent = state.hasGyro ? fmt((w * 60) / TWO_PI, 1) : '–';
  els.rdR.textContent = fmt(r, 3);
  els.rdV.textContent = fmt(v);
  els.rdAh.textContent = fmt(state.hMag);

  els.sbRate.textContent = `${state.hz.toFixed(0)} Hz`;
  els.sbGyro.innerHTML = state.hasGyro
    ? '陀螺儀 <span class="good">✓</span>'
    : '陀螺儀 <span class="bad">✗</span>';
  const tiltBad = state.tiltDeg >= 10;
  els.sbTilt.innerHTML =
    `手機 <span class="${tiltBad ? 'bad' : 'good'}">${state.tiltDeg.toFixed(1)}°</span>`;
  els.sbLeak.innerHTML = state.calibrated
    ? `轉盤 <span class="${state.tableTiltDeg > 3 ? 'bad' : 'good'}">` +
      `${state.tableTiltDeg.toFixed(1)}°</span> (±${state.leakAmp.toFixed(2)})`
    : '轉盤 <span class="dim">未校正</span>';

  els.sensorInfo.textContent =
    `${BUILD} · ${state.sampleCount} 筆 · ${state.hz.toFixed(0)} Hz · ` +
    `慣例 ${state.signConv > 0 ? '規範(+z)' : 'iOS(−z)'} · ` +
    `螢幕 ${screen.orientation?.angle ?? 0}° · ` +
    `平均窗 ${state.hasGyro ? '1 圈' : `${LIVE_SECONDS_NO_GYRO}s`}`;
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

function resetEstimators() {
  state.gzLP = 0;
  state.fzLP = 0;
  state.convReady = false;
  state.omega = 0;
  state.psi = 0;
  state.cHat = null;
  state.calibrated = false;
  state.ac = state.at = 0;
  state.leakAmp = 0;
  state.tableTiltDeg = 0;
  resetRevolution();
  stopCalibration();
}

function setRunning(on, mode) {
  state.running = on;
  state.mode = on ? mode : null;
  els.btnCalib.disabled = !on;
  els.btnClear.disabled = !on;
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
  demo.w = demo.t = demo.psi = 0;
  setRunning(true, 'demo');
});

els.btnCalib.addEventListener('click', () => {
  if (calib.active) {
    stopCalibration();
    setStatus('已取消校正');
  } else {
    startCalibration();
  }
});

els.btnClear.addEventListener('click', () => {
  state.calibrated = false;
  state.cHat = null;
  state.leakAmp = 0;
  state.tableTiltDeg = 0;
  resetRevolution();
  stopCalibration();
  setStatus('已清除校正，回到自動估計');
});

function setViewMode(mode) {
  state.viewMode = mode;
  els.tabScreen.classList.toggle('on', mode === 'screen');
  els.tabBird.classList.toggle('on', mode === 'bird');
  els.tabTest.classList.toggle('on', mode === 'test');

  // 座標測試是獨立畫面，量測相關的區塊全部收起來
  const testing = mode === 'test';
  for (const el of [els.readouts, els.controlsMain, els.controlsOpts,
    els.chartPanel, els.sensorBar, els.legendMain]) {
    el.classList.toggle('hidden', testing);
  }
  els.controlsTest.classList.toggle('hidden', !testing);
  if (!testing && test.fs) toggleTestFullscreen();
  // 灰色的瞬時向量只有螢幕視角才畫
  els.lgRaw.style.display = mode === 'screen' ? '' : 'none';

  if (testing) {
    testSetPos(0, 0);
    setStatus('座標測試：點畫面任一處或用十字鍵移動燈，按中間回到 (0,0)', 'warn');
  }
  try { localStorage.setItem('viewMode', mode); } catch { /* 無痕模式會丟錯 */ }
}

els.tabScreen.addEventListener('click', () => setViewMode('screen'));
els.tabBird.addEventListener('click', () => setViewMode('bird'));
els.tabTest.addEventListener('click', () => setViewMode('test'));

// 十字鍵畫在 canvas 上（這樣燈才能疊在它上面），所以用點擊座標做命中判定
els.view.addEventListener('pointerdown', (e) => {
  if (state.viewMode !== 'test' || !test.hits) return;
  const r = els.view.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  const inside = (box) => box && x >= box.x && x <= box.x + box.w
    && y >= box.y && y <= box.y + box.h;
  e.preventDefault();

  if (inside(test.hits.exit)) { toggleTestFullscreen(); return; }
  for (const dir of ['up', 'down', 'left', 'right']) {
    if (inside(test.hits[dir])) { testHold(dir); return; }
  }
  if (inside(test.hits.center)) { testSetPos(0, 0); return; }
  testSetPos(x, y);                    // 點畫面任何一處，燈就跳過去
});

for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
  els.view.addEventListener(ev, testStopHold);
}

window.addEventListener('keydown', (e) => {
  if (state.viewMode !== 'test') return;
  const step = e.shiftKey ? 10 : 1;
  const moves = {
    ArrowUp: [0, -step], ArrowDown: [0, step],
    ArrowLeft: [-step, 0], ArrowRight: [step, 0],
  };
  const m = moves[e.key];
  if (m) { testSetPos(test.x + m[0], test.y + m[1]); e.preventDefault(); }
  else if (e.key === '0') testSetPos(0, 0);
  else if (e.key === 'f') toggleTestFullscreen();
});

els.btnFull.addEventListener('click', toggleTestFullscreen);
els.btnOrigin.addEventListener('click', () => testSetPos(0, 0));

els.selSpin.addEventListener('change', (e) => {
  state.spinMode = e.target.value;
  if (state.spinMode !== 'auto') state.spin = state.spinMode === 'ccw' ? 1 : -1;
});

els.selRange.addEventListener('change', (e) => { state.rangeMode = e.target.value; });

els.btnCsv.addEventListener('click', () => {
  const header = 't_s,ax,ay,az,ah_x,ah_y,a_c,a_t,a_c_avg,a_t_avg,omega_rad_s\n';
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

let savedView = 'screen';
try { savedView = localStorage.getItem('viewMode') || 'screen'; } catch { /* 略 */ }
setViewMode(['bird', 'test'].includes(savedView) ? savedView : 'screen');

els.sensorInfo.textContent = `${BUILD} · 尚未取得感測器資料`;
setStatus('尚未開始 — 按下「開始測量」');
requestAnimationFrame(loop);
