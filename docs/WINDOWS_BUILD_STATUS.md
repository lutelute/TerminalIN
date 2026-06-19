# TiN Windows ビルド・動作確認の現状と引き継ぎ

(2026-06-19 更新。Parallels on Apple Silicon の Windows 11 ARM64 で実機確認した結果)

---

## TL;DR

- **TiN は Windows(arm64)で起動する**。Workspace ウィンドウ・2×2 グリッド UI まで表示を確認済み。
- **最大の発見: native addon は arm64 でビルドしないとロードできない。** 今回 x64 でビルドしたため
  `ax_helper.node is not a valid Win32 application` となり、**内蔵ターミナル(node-pty)も
  外部ウィンドウ操作(ax_helper)も動かなかった**（＝「ターミナルが認識されない」の正体）。
- **次の一手: native を arm64 でビルド → 配置 → 起動。** CI(`.github/workflows/win-native.yml`)は
  x64/arm64 両方をビルドする matrix に更新済み。`win-native-arm64` artifact を使う。

---

## 達成したこと

1. Parallels の Windows 11(ARM64)へ `prlctl` でアクセス。node v24 / npm / git は導入済み。
2. **VS Build Tools は導入できなかった** → CI ビルドに切り替え。
3. GitHub Actions(`windows-2022`)で `win-helper.cc`(→ `ax_helper.node`)と node-pty を
   Electron ABI でビルドし artifact 化（x64 で成功）。
4. artifact を共有フォルダ経由で VM の `C:\tin` に配置。
5. scheduled task でユーザーセッション起動 → **TiN の GUI 起動を確認**。

---

## 核心課題：アーキテクチャ不一致（最優先）

- VM は **ARM64**（`PROCESSOR_ARCHITECTURE=ARM64`）、Electron も **arm64**（`process.arch=arm64`）。
- 今回ビルドした native は **x64**。Electron(arm64)からロード時に
  `Error: ... ax_helper.node is not a valid Win32 application`。
- 結果、`main.js` の `if (axHelper)` が false → 外部ウィンドウ操作は osascript fallback
  （Windows に osascript は無いので no-op）。**node-pty(x64)も同様にロード不可で内蔵端末が出ない。**
- → **arm64 でビルドすれば解消する見込み。** CI を arm64 対応済み。

起動ログ（`C:\tin\tin.log`）の該当行:
```
[tin] ax_helper not available, falling back to osascript:
      \\?\C:\tin\build\Release\ax_helper.node is not a valid Win32 application.
```
**この行が消えれば native ロード成功。**

---

## 次のアクション（順番）

1. CI `win-native.yml` を実行（push 済みなら自動。`gh workflow run win-native.yml` でも可）。
   - `win-native-x64` と `win-native-arm64` の2 artifact が出る。
2. **`win-native-arm64`** を DL し、VM の以下へ配置:
   - `build/Release/ax_helper.node` → `C:\tin\build\Release\ax_helper.node`
   - `node_modules/node-pty/build/Release/**` → `C:\tin\node_modules\node-pty\build\Release\`
3. TiN を再起動し、`tin.log` に上記エラーが出ないこと、内蔵ターミナル（+ ボタン）が出ることを確認。
4. 外部ウィンドウ操作の検証: メモ帳/PowerShell 等を開き、ドロワーから snap → グリッド配置を確認。
   - `win-helper.cc` の `listWindows`/`moveWindows`(EnumWindows/SetWindowPos)が機能するか。
5. **ターミナル分類**: `main.js` のターミナルアプリ名リストは macOS 前提
   (Terminal/iTerm2/Warp…)。Windows Terminal(`WindowsTerminal.exe`)/`powershell`/`cmd` を
   認識するよう分類ロジックの追加が必要（WINDOWS_PORT.md L50-61 / §2 参照）。

---

## 環境・操作手順（再現用）

### VM
- Parallels VM 名: `Windows 11`、アーキ ARM64、ログインユーザー `shigenoburyuto`（console, session 1）。
- 共有フォルダ: Mac Home が `C:\Mac\Home`。コードは `C:\tin`(共有から robocopy 済み)。

### prlctl の制約（重要）
- `prlctl exec` は **SYSTEM(session 0)** で動く。**GUI アプリは表示されず、VS インストーラも動かない。**
- 回避: **scheduled task でユーザーセッション実行**。
  ```
  prlctl exec "Windows 11" schtasks /create /tn <T> /tr "<cmd>" /sc once /st 00:00 /ru shigenoburyuto /it /rl HIGHEST /f
  prlctl exec "Windows 11" schtasks /run /tn <T>
  ```
  これで `whoami` が `c253\shigenoburyuto` になり、GUI 起動・管理者操作が可能。
- スクショ: `prlctl capture "Windows 11" --file /tmp/x.png`。

### VS Build Tools が入らない件
- `vs_buildtools.exe` が **証明書エラー 0x80096004**（`Certificate is invalid: vs_installer.opc`）で失敗。
  VM のルート証明書/TLS（大学LANのインターセプト疑い）が原因。**ネットが遅い時間帯は特に不安定。**
- → ローカルビルドは諦め、**CI ビルド（VS完備）→ 成果物配置**が確実。
  （npm registry への TLS は通るので、electron 等 JS 依存は VM の `npm install` で入る。native のみ CI。）

### TiN 起動
```
prlctl exec "Windows 11" schtasks /create /tn TinStart /tr "cmd /c cd /d C:\tin && npx electron . > C:\tin\tin.log 2>&1" /sc once /st 00:00 /ru shigenoburyuto /it /rl HIGHEST /f
prlctl exec "Windows 11" schtasks /run /tn TinStart
```
- platform 差分は `lib/platform.js`（PowerShell/ConPTY、titleBarOverlay 等）。

---

## 参照
- `docs/WINDOWS_PORT.md` — 移植計画全体（macOS 依存マップ、置換表、フェーズ計画）
- `native/win-helper.cc` — Win32 addon（EnumWindows/SetWindowPos、MVP 関数群）
- `.github/workflows/win-native.yml` — x64/arm64 native ビルド CI
