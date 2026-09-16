/**
 * Minecraft 風格羅盤的像素畫產生器。
 *
 * 純運算、不碰 DOM，所以同一份程式碼可以：
 *   1. 在瀏覽器裡即時繪製（指針指向圓心方向）
 *   2. 在 Node 裡產生 PWA 需要的 icon PNG
 *
 * 基準解析度固定 16x16（和 Minecraft 物品貼圖一樣），再用最近鄰放大，
 * 保留硬邊的像素感。
 */

const RIM = [0x14, 0x15, 0x1c];
const RING = [0x9a, 0xa1, 0xab];
const FACE_IN = [0x26, 0x28, 0x42];
const FACE_OUT = [0x1b, 0x1d, 0x32];
const NEEDLE_RED = [0xd9, 0x3a, 0x3f];
const NEEDLE_WHITE = [0xe8, 0xee, 0xf2];

const BASE = 16;

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 畫出 16x16 的羅盤。
 *
 * @param {number} dirX 指針（紅色端）方向的 x 分量，螢幕座標：x 向右
 * @param {number} dirY 指針（紅色端）方向的 y 分量，螢幕座標：y 向下
 * @returns {Uint8ClampedArray} 長度 16*16*4 的 RGBA
 */
export function renderCompass(dirX = 0, dirY = -1) {
  const len = Math.hypot(dirX, dirY);
  const ux = len > 1e-6 ? dirX / len : 0;
  const uy = len > 1e-6 ? dirY / len : -1;

  const out = new Uint8ClampedArray(BASE * BASE * 4);
  const c = BASE / 2;

  for (let y = 0; y < BASE; y++) {
    for (let x = 0; x < BASE; x++) {
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      const r = Math.hypot(dx, dy);
      const i = (y * BASE + x) * 4;

      let rgb = null;
      let alpha = 0;

      if (r <= 7.4) {
        alpha = 255;
        // 左上偏亮、右下偏暗，做出金屬倒角
        const shade = clamp01((-dx - dy) / 9 + 0.5);
        if (r > 6.2) {
          rgb = RIM;
        } else if (r > 4.9) {
          rgb = shade > 0.5
            ? mix(RING, [0xf2, 0xf5, 0xf8], (shade - 0.5) * 0.9)
            : mix(RING, [0x4a, 0x50, 0x59], (0.5 - shade) * 1.1);
        } else {
          rgb = mix(FACE_IN, FACE_OUT, clamp01(r / 4.9));
        }
      }

      if (alpha) {
        // 指針：以中心為原點的細長菱形，紅端朝 dir、白端朝反向
        const along = dx * ux + dy * uy;
        const perp = -dx * uy + dy * ux;
        const L = 4.5;
        const halfWidth = 1.55 * (1 - Math.abs(along) / L);
        if (Math.abs(along) <= L && halfWidth > 0 && Math.abs(perp) <= halfWidth) {
          rgb = along >= 0 ? NEEDLE_RED : NEEDLE_WHITE;
        }
      }

      if (alpha) {
        out[i] = rgb[0];
        out[i + 1] = rgb[1];
        out[i + 2] = rgb[2];
        out[i + 3] = 255;
      }
    }
  }
  return out;
}

/** 最近鄰放大，保持像素邊緣銳利。 */
export function scaleNearest(rgba, srcSize, factor) {
  const dstSize = srcSize * factor;
  const out = new Uint8ClampedArray(dstSize * dstSize * 4);
  for (let y = 0; y < dstSize; y++) {
    const sy = (y / factor) | 0;
    for (let x = 0; x < dstSize; x++) {
      const sx = (x / factor) | 0;
      const si = (sy * srcSize + sx) * 4;
      const di = (y * dstSize + x) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
    }
  }
  return out;
}

/** 把圖蓋到不透明底色上，給 maskable / apple-touch icon 用。 */
export function onBackground(rgba, size, bg = [0x0e, 0x10, 0x16]) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    const a = rgba[o + 3] / 255;
    out[o] = Math.round(bg[0] * (1 - a) + rgba[o] * a);
    out[o + 1] = Math.round(bg[1] * (1 - a) + rgba[o + 1] * a);
    out[o + 2] = Math.round(bg[2] * (1 - a) + rgba[o + 2] * a);
    out[o + 3] = 255;
  }
  return out;
}

/** 把小圖置中貼到大的正方形畫布上（兩者都是 RGBA）。 */
export function padTo(rgba, srcSize, dstSize) {
  const out = new Uint8ClampedArray(dstSize * dstSize * 4);
  const off = Math.floor((dstSize - srcSize) / 2);
  for (let y = 0; y < srcSize; y++) {
    for (let x = 0; x < srcSize; x++) {
      const si = (y * srcSize + x) * 4;
      const di = ((y + off) * dstSize + (x + off)) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
    }
  }
  return out;
}

export const COMPASS_BASE_SIZE = BASE;
