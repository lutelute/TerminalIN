#!/usr/bin/env node
/**
 * TiN デモ GIF キャプチャスクリプト
 *
 * 使い方:
 *   node scripts/capture-demo.mjs
 *
 * 出力: assets/demo.gif
 *
 * 必要なもの:
 *   - TiN が起動中（npx electron . --dev または /Applications/TiN.app）
 *   - ffmpeg（brew install ffmpeg）
 *   - playwright-core（npm install --save-dev playwright-core）
 *
 * デモシーケンス:
 *   1. TiN ヘッダー全体を見せる
 *   2. ☰ でドロワーを開く
 *   3. Apps タブに切り替え → アプリ一覧を見せる
 *   4. Snap ボタン → スロットピッカー → スロット選択
 *   5. タブバーに追加されたタブを見せる
 *   6. グリッドサイズポップアップ → カスタム入力 → ライブプレビュー
 *   7. ⊞ / ⊡ でモード切り替え
 *   8. ドロワーを閉じて完了
 */

import { chromium } from 'playwright-core';
import { execSync, exec } from 'child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FRAMES_DIR = join(ROOT, '.demo-frames');
const OUT_GIF = join(ROOT, 'assets', 'demo.gif');

const CDP_URL = 'http://localhost:9222';
const FPS = 8;          // GIF フレームレート
const SCALE = 1;        // 1 = 実サイズ、0.5 = 半分

// ── ユーティリティ ──────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let frameIndex = 0;
async function captureFrame(page) {
  const buf = await page.screenshot({ type: 'png' });
  const path = join(FRAMES_DIR, `frame_${String(frameIndex++).padStart(5, '0')}.png`);
  writeFileSync(path, buf);
}

async function captureFor(page, ms, intervalMs = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await captureFrame(page);
    await sleep(intervalMs);
  }
}

// ── デモ実行 ──────────────────────────────────────────────

async function runDemo(page) {

  // --- 0. 初期状態を見せる（1.5秒）---
  console.log('📸 初期状態...');
  await captureFor(page, 1500);

  // --- 1. ドロワーを開く ---
  console.log('📸 ドロワーを開く...');
  await page.evaluate(() => document.getElementById('drawer-toggle-btn').click());
  await captureFor(page, 1000);

  // --- 2. Terminal タブを見せる ---
  console.log('📸 Terminal タブ...');
  await page.evaluate(() => document.querySelector('.avail-tab.term')?.click());
  await captureFor(page, 1000);

  // --- 3. Apps タブに切り替え ---
  console.log('📸 Apps タブ...');
  await page.evaluate(() => document.querySelector('.avail-tab.apps')?.click());
  await captureFor(page, 1200);

  // --- 4. Snap ボタンをクリック → スロットピッカー ---
  console.log('📸 Snap ボタン → スロットピッカー...');
  await page.evaluate(() => {
    const rows = document.querySelectorAll('[data-avail-list="1"] .row-action');
    if (rows[0]) rows[0].click();
  });
  await captureFor(page, 1200);

  // スロットピッカーが出ていれば最初のスロットを選択
  const pickerClosed = await page.evaluate(async () => {
    const picker = document.querySelector('.slot-picker');
    if (!picker) return true;
    // 最初の空きスロット（青いセル）をクリック
    const freeCell = [...picker.querySelectorAll('div[style*="pointer"]')].find(
      d => d.style.cursor === 'pointer'
    );
    if (freeCell) freeCell.click();
    return false;
  });
  await captureFor(page, 1000);

  // --- 5. タブバーに追加されたことを確認 ---
  console.log('📸 タブバー更新...');
  await captureFor(page, 800);

  // ドロワーを閉じる
  await page.evaluate(() => document.getElementById('drawer-toggle-btn').click());
  await captureFor(page, 600);

  // --- 6. グリッドサイズポップアップ → カスタム入力 → ライブプレビュー ---
  console.log('📸 グリッドサイズポップアップ...');
  await page.evaluate(() => document.querySelector('.grid-size-cycle')?.click());
  await captureFor(page, 800);

  // カスタム入力 1×3 を入力してプレビュー更新
  await page.evaluate(() => {
    const popup = document.getElementById('grid-size-popup');
    if (!popup) return;
    const inputs = popup.querySelectorAll('input[type="number"]');
    inputs[0].value = '1'; inputs[0].dispatchEvent(new Event('input'));
    inputs[1].value = '3'; inputs[1].dispatchEvent(new Event('input'));
  });
  await captureFor(page, 800);

  // 2×2 を入力
  await page.evaluate(() => {
    const popup = document.getElementById('grid-size-popup');
    if (!popup) return;
    const inputs = popup.querySelectorAll('input[type="number"]');
    inputs[0].value = '2'; inputs[0].dispatchEvent(new Event('input'));
    inputs[1].value = '2'; inputs[1].dispatchEvent(new Event('input'));
  });
  await captureFor(page, 800);

  // プリセット 2×2 をクリックして確定
  await page.evaluate(() => {
    const items = document.querySelectorAll('.grid-size-item');
    const item22 = [...items].find(i => i.querySelector('span')?.textContent === '2×2');
    if (item22) item22.click();
  });
  await captureFor(page, 600);

  // --- 7. タブモード切り替え ---
  console.log('📸 タブモード切り替え...');
  await page.evaluate(() => document.getElementById('view-mode-btn')?.click());
  await captureFor(page, 800);

  // グリッドモードに戻す
  await page.evaluate(() => document.getElementById('view-mode-btn')?.click());
  await captureFor(page, 600);

  // --- 8. スナップしたアプリを unsnap して元に戻す ---
  // (デモを clean に終わらせるため)
  await page.evaluate(() => {
    const closeBtns = document.querySelectorAll('.tab-close[data-wn]');
    // デモ中に追加した最後のタブを閉じる
    if (closeBtns.length > 0) {
      const last = closeBtns[closeBtns.length - 1];
      // 既存の snapped (デモ前から) は閉じない — 元々の wn との差分は難しいので skip
    }
  });

  // --- 9. 最終状態 ---
  console.log('📸 最終状態...');
  await captureFor(page, 1000);

  console.log(`✅ ${frameIndex} フレーム取得完了`);
}

// ── GIF 生成 ──────────────────────────────────────────────

function buildGif(framesDir, outPath, fps, scale) {
  console.log('🎬 GIF 生成中...');

  // パレット生成
  const palettePath = join(framesDir, 'palette.png');
  execSync(
    `ffmpeg -y -r ${fps} -i "${framesDir}/frame_%05d.png" ` +
    `-vf "fps=${fps},scale=iw*${scale}:-1:flags=lanczos,palettegen=stats_mode=diff" ` +
    `"${palettePath}"`,
    { stdio: 'inherit' }
  );

  // GIF 合成
  execSync(
    `ffmpeg -y -r ${fps} -i "${framesDir}/frame_%05d.png" -i "${palettePath}" ` +
    `-lavfi "fps=${fps},scale=iw*${scale}:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" ` +
    `"${outPath}"`,
    { stdio: 'inherit' }
  );

  console.log(`✅ GIF 出力: ${outPath}`);
  const size = Math.round(execSync(`wc -c < "${outPath}"`).toString().trim() / 1024);
  console.log(`   サイズ: ${size} KB`);
}

// ── メイン ────────────────────────────────────────────────

(async () => {
  // フレームディレクトリ準備
  if (existsSync(FRAMES_DIR)) rmSync(FRAMES_DIR, { recursive: true });
  mkdirSync(FRAMES_DIR, { recursive: true });

  // CDP 接続
  console.log(`🔌 CDP 接続中: ${CDP_URL}`);
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (e) {
    console.error('❌ TiN が起動していないか CDP が無効です。');
    console.error('   npx electron . --dev で TiN を起動してください。');
    process.exit(1);
  }

  const contexts = browser.contexts();
  if (!contexts.length) { console.error('❌ CDP コンテキストが見つかりません'); process.exit(1); }

  // workspace.html のページを選択
  let page;
  for (const ctx of contexts) {
    const pages = ctx.pages();
    const p = pages.find(p => p.url().includes('workspace.html'));
    if (p) { page = p; break; }
  }
  if (!page) { console.error('❌ workspace.html のページが見つかりません'); process.exit(1); }

  console.log(`✅ ページ接続: ${page.url()}`);

  try {
    await runDemo(page);
  } finally {
    await browser.close();
  }

  // GIF 生成
  buildGif(FRAMES_DIR, OUT_GIF, FPS, SCALE);

  // フレーム削除
  rmSync(FRAMES_DIR, { recursive: true });
  console.log('🎉 完了！');
})();
