/**
 * 產生 PWA 需要的 icon。
 *
 *   node tools/gen-icons.mjs
 *
 * 圖案由 src/mc-compass.js 即時算出來（和頁面上顯示的羅盤同一份程式碼），
 * 這裡只負責把 RGBA 編碼成 PNG，所以不需要任何外部套件。
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMPASS_BASE_SIZE,
  onBackground,
  padTo,
  renderCompass,
  scaleNearest,
} from '../src/mc-compass.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DIR = join(ROOT, 'icons');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** icon 上的指針朝右上，看起來比正上方有精神一點。 */
const needle = renderCompass(0.45, -0.89);

function write(name, size, rgba) {
  const file = join(ICON_DIR, name);
  writeFileSync(file, encodePNG(size, rgba));
  console.log(`  ${name}  ${size}x${size}`);
}

mkdirSync(ICON_DIR, { recursive: true });
console.log('產生 icon：');

// 透明底：一般的 PWA icon 與 favicon
for (const [name, factor] of [
  ['icon-192.png', 12],
  ['icon-512.png', 32],
  ['favicon-32.png', 2],
]) {
  const size = COMPASS_BASE_SIZE * factor;
  write(name, size, scaleNearest(needle, COMPASS_BASE_SIZE, factor));
}

// maskable：羅盤只佔 75%，留出 Android 裁切用的安全區
{
  const inner = scaleNearest(needle, COMPASS_BASE_SIZE, 24); // 384
  write('maskable-512.png', 512, onBackground(padTo(inner, 384, 512), 512));
}

// Apple 不處理透明背景，另外給一張有底色的
{
  const size = COMPASS_BASE_SIZE * 12;
  write(
    'apple-touch-icon.png',
    size,
    onBackground(scaleNearest(needle, COMPASS_BASE_SIZE, 12), size),
  );
}
