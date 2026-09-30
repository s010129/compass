# 驗證腳本

用 Playwright + Chromium 驅動真實瀏覽器，注入合成的 `devicemotion` 事件，
再**掃描 canvas 的像素**確認畫出來的東西和程式回報的一致。

重點原則：**不要只讀內部變數**。讀變數等於用同一份邏輯驗自己；掃像素才能
抓到「算對了但畫反了」這類錯誤——本專案最嚴重的幾個 bug 都是這一類。

## 準備

```sh
cd <任一暫存目錄>
npm init -y && npm i playwright
# 本環境的 Chromium 在 /opt/pw-browsers/chromium，腳本裡已寫死 executablePath
```

每支腳本都連到一個本機 http server，port 寫在檔案裡（8123 / 8125 / 8126 / 8127）。
跑之前先開好：

```sh
npx http-server -p 8126 -c-1 /path/to/compass
```

`test-subpath.mjs` 需要把專案放在 `site/compass/` 底下（測 GitHub Pages 的子路徑）。

## 腳本一覽

| 檔案 | 測什麼 | 關鍵判準 |
|---|---|---|
| `test.mjs` | 注入已知向量，驗 a_c / rpm / r / v | 圓心在 +x、ω=120°/s → a_c=5、20 rpm、r=1.14 |
| `test-demo.mjs` | 示範模式端到端 + 校正 | 圓心方向 62.0°、r=0.250、傾斜 2.0°、逆時針 |
| `test-fix.mjs` | 平放／傾斜守門 | 平放慢轉要有讀值；傾斜 30° 要示警 |
| `test-gyro.mjs` | 陀螺儀正負號無關性 | 反號的陀螺儀結果要**逐項相同** |
| `test-leak.mjs` | 重現重力洩漏的破壞力 | 4° + 15 rpm → 圓心方向擺動 269° |
| `test-calib.mjs` | 校正前後對照 | 校正後擺動 0.0°、a_c 與 r 命中真值 |
| `test-bird.mjs` | 鳥瞰視角轉向不鏡像 | 逆時針 → canvas 角度遞減 |
| `test-coord.mjs` | 座標測試頁 | 點畫面回報值 = 實際繪製位置 |
| `test-origin.mjs` | 原點記號在左上角 | 直角記號的像素集中在左上 |
| `test-raw.mjs` | 原始向量診斷頁 | 洩漏 RMS = g·sinθ |
| `test-linear.mjs` | 螢幕視角 → 向心力模式 | 注入 +x/+y 掃紅箭頭像素；反轉、歸零、死區（小訊號不被鎖 0、方向不被拉到軸上）、靈敏度選單、全螢幕；iOS/Android 預設反轉；橫放提示 |
| `test-canvas-reset.mjs` | canvas.width 是否重設 transform | 指定同值也會重設成單位矩陣 |

## ⚠️ 路徑要改

每支腳本開頭都有一行寫死的截圖輸出路徑：

```js
const OUT = '/tmp/claude-0/.../scratchpad';
```

那是當初開發容器的暫存目錄，**在別的機器上不存在**。跑之前改成你自己的目錄，
或直接把 `p.screenshot({ path: ... })` 那幾行拿掉。

`executablePath: '/opt/pw-browsers/chromium'` 同理——如果你的 Playwright 是
正常安裝的，把這個參數整個刪掉讓它用預設的就好。

## 常見陷阱（都踩過）

- **點在畫布外**：`test-coord.mjs` 曾用 `r.top + 400` 想點畫布內，但畫布只有
  340 高，結果點到下面的按鈕。座標要先確認在 `rect` 範圍內。
- **容差太緊**：燈在 (0,0) 只露出 1/4 圓，可見像素形心是 4r/3π ≈ 3.8，不是 0。
- **注入速率**：用 `for` 迴圈猛灌事件會讓程式算出的 `dt` 失真（α 被放大數十倍）。
  要用 `requestAnimationFrame` 以真實時間注入。
- **抗鋸齒雜點**：掃特定顏色時，邊緣的抗鋸齒像素會混進顏色區間。判定要用
  「壓倒性集中」而不是「其他角必須為 0」。
