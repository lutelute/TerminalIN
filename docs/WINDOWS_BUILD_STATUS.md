# TiN Windows ビルド・動作確認の現状と引き継ぎ

(2026-06-19 更新。Parallels on Apple Silicon の Windows 11 ARM64 で実機確認した結果。
2026-06-18 の検証成果と統合済み)

---

## TL;DR

- **TiN は Windows(arm64)で起動する**。Workspace ウィンドウ・2×2 グリッド UI まで表示を確認済み。
- **本当の残課題は1つだけ: `ax_helper.node`(win-helper.cc)を arm64 でビルドして配置すること。**
- **node-pty は arm64 でビルド不要**。`npm install` で win32-arm64 prebuild がそのまま入り
  ABI 問題なし（2026-06-18 検証済）。今回それを x64 版で誤って上書きしたため内蔵端末が出なかった。
  → クリーンに `npm install` し直せば arm64 の `pty.node` が入る。

---

## アーキテクチャ不一致（今回ハマった点）

- VM は **ARM64**（`PROCESSOR_ARCHITECTURE=ARM64` / Electron `process.arch=arm64`）。
- 今回 CI でビルドした native は **x64**。Electron(arm64)からロード時に
  `Error: ... ax_helper.node is not a valid Win32 application`。
- このとき node-pty も x64 を配置していたため両方ロード不可 → 内蔵端末も外部窓操作も動かなかった。
- 起動ログ `C:\tin\tin.log` の判定行（**消えれば native ロード成功**）:
  ```
  [tin] ax_helper not available, falling back to osascript:
        ...ax_helper.node is not a valid Win32 application.
  ```

---

## 次のアクション（最短ルート）

1. **クリーンに依存を入れる**（arm64 prebuild の node-pty が入る）:
   - ビルド/実行は **`C:\Users\shigenoburyuto\Documents\TerminalIN`**（既存 clone）で。
     Mac 共有(`C:\Mac\Home\...`)上で直接ビルドすると Mac の Mach-O .node を PE で上書きして壊す。
   - そこで `npm install`（install-script の node-gyp が VS 無しで失敗するが、その前に
     electron / node-pty(arm64 prebuild) は入る。`--ignore-scripts` でも可）。
2. **`ax_helper.node` を arm64 でビルドして配置**。方法は2択:
   - (A) ローカル: VS Build Tools(**VC.Tools.ARM64 + Win11SDK**)を入れ、
     `npx node-gyp rebuild --runtime=electron --target=<electronVer> --dist-url=https://electronjs.org/headers --arch=arm64`
   - (B) CI: `.github/workflows/win-native.yml` は **x64/arm64 matrix** に更新済み。
     `win-native-arm64` artifact の `build/Release/ax_helper.node` を
     `…\TerminalIN\build\Release\` に配置（node-pty は arm64 prebuild を使うので CI 版で上書きしない）。
3. TiN 再起動 → `tin.log` に上記エラーが出ないこと、内蔵端末(+ボタン)が出ることを確認。
4. 外部窓 snap 検証: メモ帳/PowerShell を開き、ドロワーから snap → グリッド配置を確認
   （`win-helper.cc` の listWindows=EnumWindows / moveWindows=SetWindowPos + DWM補正）。
5. **ターミナル分類の追加**: `main.js` のターミナルアプリ名リストは macOS 前提
   (Terminal/iTerm2/Warp…)。`WindowsTerminal.exe`/`powershell`/`cmd`/`pwsh` を認識する分岐が必要。

---

## VM 操作手順（2026-06-18 の知見）

- **ユーザーセッション実行**（GUI 可視・管理者操作可）:
  ```
  prlctl exec "Windows 11" --current-user powershell -NoProfile -Command "..."
  ```
  **`--current-user` は VM 名の後**（前に置くと "VM not found"）。SYSTEM(`prlctl exec` 既定)は
  Session 0 分離で GUI 不可視・VS インストーラも動かない。
- 複雑な PowerShell はクォート崩れ＋CP932化けで壊れる →
  **`powershell -EncodedCommand <UTF-16LE base64>`**（Mac 側 `iconv -t UTF-16LE | base64`）が確実。
  あるいは出力先頭に `[Console]::OutputEncoding=[Text.Encoding]::UTF8`。
- スクショ: `prlctl capture "Windows 11" --file /tmp/x.png`。
- GUI操作: `(New-Object -ComObject wscript.shell).AppActivate('Workspace 1'); .SendKeys('^t')`。

## VS Build Tools が入らない件（今回）

- `vs_buildtools.exe` が **証明書エラー 0x80096004**（`Certificate is invalid: vs_installer.opc`）で失敗。
  ルート証明書/TLS（大学LANのインターセプト疑い）。**ネットが遅い時間帯は特に不安定**。
- 入れる場合は **VC.Tools.ARM64 + Win11SDK** ワークロードを含めること（arm64 ターゲットに必須）。
- 入らない時は **CI ビルド（VS完備）→ 成果物配置**で回避（npm registry への TLS は通る）。

## CI: `.github/workflows/win-native.yml`
- `windows-2022`（`windows-latest` は VS18 プレビューで node-gyp が認識不可）。
- `arch: [x64, arm64]` の matrix。arm64 は `msvc-dev-cmd arch: amd64_arm64` でクロス。
- **x64 / arm64 とも CI 成功済み**（run 27818256496）。最新成功 run の **`win-native-arm64`** artifact の
  `build/Release/ax_helper.node` を `…\TerminalIN\build\Release\` に置けばよい
  （`gh run download <runId> -n win-native-arm64`）。node-pty は arm64 prebuild を使うので上書き不要。

## 参照
- `docs/WINDOWS_PORT.md` — 移植計画全体（macOS 依存マップ、置換表、フェーズ計画）
- `native/win-helper.cc` — Win32 addon（MVP 7関数: listWindows/moveWindows/raiseWindows ほか）
- メモリ `project_windows_port` — 第2マイルストーン実装の詳細（HWND=windowNumber、DWM補正等）
