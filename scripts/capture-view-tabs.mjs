#!/usr/bin/env node
/**
 * view mode タブ切替デモ GIF を生成する。
 *   入力: scripts/demo-view-tabs.html (個人情報なしの UI 再現アニメ)
 *   出力: assets/demo-view-tabs.gif
 * 必要: playwright-core + Google Chrome (channel:chrome) + ffmpeg
 * 実行: node scripts/capture-view-tabs.mjs
 */
import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const HTML = 'file://' + join(__dirname, 'demo-view-tabs.html');
const FRAMES_DIR = join(ROOT, '.demo-frames-vt');
const OUT_GIF = join(ROOT, 'assets', 'demo-view-tabs.gif');
const FPS = 12;
const SCALE = 0.46;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fi = 0;
async function frame(el) {
  const b = await el.screenshot({ type: 'png' });
  writeFileSync(join(FRAMES_DIR, `f_${String(fi++).padStart(5, '0')}.png`), b);
}
async function captureFor(el, ms, iv = 1000 / FPS) {
  const end = Date.now() + ms;
  while (Date.now() < end) { await frame(el); await sleep(iv); }
}

function buildGif(dir, out, fps, scale) {
  console.log('🎬 GIF 生成中...');
  const pal = join(dir, 'palette.png');
  execSync(
    `ffmpeg -y -r ${fps} -i "${dir}/f_%05d.png" ` +
    `-vf "fps=${fps},scale=iw*${scale}:-1:flags=lanczos,palettegen=stats_mode=diff" "${pal}"`,
    { stdio: 'inherit' }
  );
  execSync(
    `ffmpeg -y -r ${fps} -i "${dir}/f_%05d.png" -i "${pal}" ` +
    `-lavfi "fps=${fps},scale=iw*${scale}:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" "${out}"`,
    { stdio: 'inherit' }
  );
}

(async () => {
  if (existsSync(FRAMES_DIR)) rmSync(FRAMES_DIR, { recursive: true });
  mkdirSync(FRAMES_DIR, { recursive: true });

  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 2 });
  await page.goto(HTML);
  const app = page.locator('#app');
  await sleep(500);

  // 1. 初期(端末) + caption
  await page.evaluate(() => window.showCap(true));
  await captureFor(app, 1500);
  // 2. Files へ
  await page.evaluate(() => window.hoverTab(1));
  await captureFor(app, 650);
  await page.evaluate(() => window.clickTab(1));
  await captureFor(app, 1500);
  // 3. Editor へ
  await page.evaluate(() => window.hoverTab(2));
  await captureFor(app, 650);
  await page.evaluate(() => window.clickTab(2));
  await captureFor(app, 1500);
  // 4. 端末へ戻る
  await page.evaluate(() => window.hoverTab(0));
  await captureFor(app, 650);
  await page.evaluate(() => window.clickTab(0));
  await captureFor(app, 1400);

  await browser.close();
  console.log(`✅ ${fi} フレーム取得`);

  buildGif(FRAMES_DIR, OUT_GIF, FPS, SCALE);
  rmSync(FRAMES_DIR, { recursive: true });
  const kb = Math.round(execSync(`wc -c < "${OUT_GIF}"`).toString().trim() / 1024);
  console.log(`🎉 完了: ${OUT_GIF} (${kb} KB)`);
})();
