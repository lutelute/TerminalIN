# TiN Integration Protocol

TerminalIN (TiN) が外部ツール (AtelierX など) と連携するための **公開プロトコル仕様**。

- **Protocol version**: `1.0`
- **Status**: Draft → Stable 予定 (TiN v1.2.0 リリースで Stable 化)
- **Scope**: macOS のみ
- **Maintainer**: lutelute

---

## 0. このドキュメントの位置付け

本ドキュメントは **TiN と任意のクライアント (AtelierX プラグイン等) の契約** を定義する唯一の真実源です。

- TiN 本体の実装は本仕様に従う
- クライアント実装 (例: `atelierx-plugin`) は本仕様を前提に書く
- 仕様変更は本ファイルの更新 → バージョン番号/capability 更新 → 各実装追従、の順で行う

**TiN も AtelierX も本仕様の "外側" の固有名詞を自分のコードに含めてはならない。**
連携の知識はすべてクライアント (プラグイン) 側に閉じる。

---

## 1. 3 ペルソナ設計原則

本プロトコルは以下 3 タイプのユーザー全員を等しく幸せにすることを目的とする:

| ペルソナ | 欲しいもの | インストールするもの |
|---|---|---|
| **A: TiN 単独派** | ターミナルワークスペース管理 | TiN.app |
| **B: AtelierX 単独派** | ウィンドウカンバン管理 | AtelierX.app |
| **C: 統合派** | 両アプリの連携体験 | TiN.app + AtelierX.app + `tin-bridge` プラグイン |

### A/B 独立性の絶対条件

以下はいかなる仕様拡張でも破ってはならない:

1. **TiN は AtelierX の存在を知らない**
   - TiN のコード・UI・設定画面・ドキュメント (README 除く) に "AtelierX" の文字列を書かない
   - `snapped.json` / `info.json` / `tin://` URL スキームは **TiN 単体として意味のある機能** として設計する (例: Raycast/Alfred/Shortcuts から使える汎用 API)
2. **AtelierX は TiN の存在を知らない**
   - AtelierX 本体コードに "TiN" / "TerminalIN" の文字列を書かない
   - プラグイン API (`setCardDecorator` 等) は汎用として設計し、他プラグインからも再利用可能にする
3. **配布物の分離**
   - TiN.app の DMG に `atelierx-plugin/` ディレクトリを含めない (`package.json` `build.files` で除外)
   - AtelierX.app にプラグインをプリインストールしない
4. **graceful degradation**
   - 相手アプリが未起動/未インストールでも、各アプリは単体で完全に動作する
   - ファイル不在・URL scheme 失敗・プロトコル不一致はすべて "相手がいない" として扱い、機能を静かに無効化する (エラーダイアログを出さない)

### C (統合派) の体験保証

以下が守られている限り、統合派は "一本化された体験" を得られる:

- TiN で Snap したウィンドウが AtelierX で自動的に "管理中" 扱いされる
- AtelierX の Grid 配置から TiN 管理中ウィンドウが除外される
- AtelierX のカードから TiN の操作 (Snap / Focus / 新規ターミナル) をトリガーできる
- TiN の未起動・未インストール時もプラグインは静かに無効化される

---

## 2. ファイル配置

TiN は以下の 2 ファイルを `userData` ディレクトリに書き出す。

```
~/Library/Application Support/TiN/
├── info.json       # TiN の自己情報 (起動時に書き出し、終了時に削除)
└── snapped.json    # 現在 Snap 中のウィンドウ一覧 (状態変化時に更新)
```

### 書き込み要件

- **atomic write**: 一時ファイル (`*.tmp`) に書いてから `rename()` で差し替える
- **権限**: 読み取り用途のみ想定のため `0644`
- **文字コード**: UTF-8, LF 改行
- **`info.json` のライフサイクル**: TiN 起動時に作成、**正常終了時に削除**。クラッシュ時は残留する可能性があるため、クライアントは `info.json` の存在だけでは起動中判定せず、`updatedAt` の鮮度も併用するべき

---

## 3. `info.json` スキーマ

TiN の自己紹介。クライアントは起動時に読んで capability を判定する。

### フォーマット

```json
{
  "protocol": "1.0",
  "app": "TiN",
  "version": "1.2.0",
  "startedAt": 1712000000000,
  "updatedAt": 1712000000000,
  "capabilities": [
    "snap",
    "raise",
    "workspace",
    "grid-terminal",
    "window-list"
  ],
  "endpoints": {
    "snappedFile": "snapped.json",
    "urlScheme": "tin"
  }
}
```

### フィールド定義

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `protocol` | string | ✅ | プロトコルバージョン (semver minor まで)。互換性チェックに使用 |
| `app` | string | ✅ | 常に `"TiN"` (将来 fork されても `"TiN"` 派生を名乗らせない) |
| `version` | string | ✅ | TiN アプリ本体のバージョン (semver) |
| `startedAt` | number | ✅ | TiN プロセス起動時刻 (Unix ms) |
| `updatedAt` | number | ✅ | このファイルの最終更新時刻 (Unix ms)。鮮度判定に使用 |
| `capabilities` | string[] | ✅ | サポートする機能の配列 (後述) |
| `endpoints` | object | ✅ | 関連リソースへのパス (将来拡張用) |

### Capabilities 一覧

| capability | 意味 | 対応コマンド |
|---|---|---|
| `snap` | 外部ウィンドウを Grid にスナップできる | `tin://snap` |
| `raise` | 指定ウィンドウを前面化できる | `tin://raise` |
| `workspace` | ワークスペース (複数 Grid) 管理がある | `tin://workspace/*` |
| `grid-terminal` | Grid 内に埋め込みターミナルを生成できる | `tin://terminal/new` |
| `window-list` | `snapped.json` にウィンドウ一覧を書き出す | (ファイル読み取り) |

**クライアントは `capabilities` の有無で機能分岐すること。** `version` 文字列で分岐してはならない (TiN 側が後方互換を壊した場合に対応しにくくなるため)。

---

## 4. `snapped.json` スキーマ

TiN が現在管理中のウィンドウ一覧。Snap / Release / Workspace 切替のたびに atomic write される。

### フォーマット

```json
{
  "protocol": "1.0",
  "updatedAt": 1712000000000,
  "activeWorkspaceId": "ws-1",
  "snappedWindows": [
    {
      "app": "Terminal",
      "pid": 12345,
      "windowNumber": 678,
      "title": "shigenoburyuto — -zsh — 80×24",
      "windowIndex": 0,
      "slot": 0,
      "workspaceId": "ws-1",
      "snappedAt": 1712000000000
    },
    {
      "app": "iTerm2",
      "pid": 23456,
      "windowNumber": 789,
      "title": "1. vim main.js",
      "windowIndex": 0,
      "slot": 1,
      "workspaceId": "ws-1",
      "snappedAt": 1712000000500
    }
  ]
}
```

### フィールド定義

#### ルート

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `protocol` | string | ✅ | プロトコルバージョン |
| `updatedAt` | number | ✅ | このファイルの最終更新時刻 (Unix ms) |
| `activeWorkspaceId` | string \| null | ✅ | 現在アクティブなワークスペース ID。ワークスペース概念が無い場合は `null` |
| `snappedWindows` | SnappedWindow[] | ✅ | Snap 中のウィンドウ配列。0 件のこともある |

#### `SnappedWindow`

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `app` | string | ✅ | アプリ名 (例: `"Terminal"`, `"iTerm2"`, `"WezTerm"`) |
| `pid` | number | ✅ | プロセス ID |
| `windowNumber` | number | ✅ | CGWindowID。アプリ再起動で変わる |
| `title` | string | ✅ | ウィンドウタイトル (空文字可) |
| `windowIndex` | number | ✅ | 同一アプリ内でのウィンドウインデックス (0 起点) |
| `slot` | number | ✅ | Grid 内のスロット番号 (0 起点) |
| `workspaceId` | string \| null | ✅ | 所属ワークスペース。ワークスペース概念が無い場合は `null` |
| `snappedAt` | number | ✅ | Snap された時刻 (Unix ms) |

### マッチング戦略 (重要)

クライアントが "どのカード/ウィンドウが TiN 管理中か" を判定する際、単一のキーでは不十分。以下の優先順位で多段マッチングすること:

1. **第 1 候補**: `app` + `windowNumber`
   - 最も厳密だが、アプリ再起動で破綻する
2. **第 2 候補**: `app` + `pid` + `windowIndex`
   - アプリが起動中なら安定
3. **第 3 候補**: `app` + `title` (完全一致)
   - タイトルが変化しない前提で有効 (Finder, ブラウザ等)
4. **第 4 候補**: `app` + `title` (前方 40 文字一致)
   - ターミナルなど動的タイトルへのフォールバック

### AtelierX `WindowRef` との対応

AtelierX の `WindowRef` (`{ app, id, name, path? }`) との対応は:

| AtelierX フィールド | TiN フィールド | 備考 |
|---|---|---|
| `app` | `app` | 直接対応 |
| `id` | `windowNumber` (文字列化) または `tty` パス (Terminal の場合) | AtelierX 側の ID 生成戦略に依存 |
| `name` | `title` | 直接対応 |
| `path` | — | Finder 用、TiN では使用しない |

**注意**: AtelierX の Terminal ウィンドウ `id` は tty パス (`/dev/ttys001` 等) を使っている場合がある。この場合 `windowNumber` とは一致しないため、プラグイン側で `app + title` フォールバックを必ず実装すること。

---

## 5. `tin://` URL スキーム

TiN への操作コマンドを外部から送るための URL スキーム。macOS の `open-url` イベントで受信。

### 登録

TiN は起動時に `tin` スキームを自身に関連付ける:

```js
app.setAsDefaultProtocolClient('tin');
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleTinUrl(url);
});
```

`package.json` の `build.mac.protocols` で `Info.plist` に `CFBundleURLTypes` を宣言する:

```json
"mac": {
  "protocols": [
    { "name": "TiN URL", "schemes": ["tin"] }
  ]
}
```

### コマンド一覧

コマンドは `tin://<action>?<params>` 形式。

| URL | 必要 capability | 動作 |
|---|---|---|
| `tin://snap?app=X&windowNumber=Y` | `snap` | 指定ウィンドウを現在アクティブな Grid の空きスロットに Snap |
| `tin://snap?app=X&windowNumber=Y&slot=N` | `snap` | 指定スロットに強制 Snap (既存はリリース) |
| `tin://release?app=X&windowNumber=Y` | `snap` | 指定ウィンドウを Snap 解除 |
| `tin://raise?app=X&windowNumber=Y` | `raise` | 指定ウィンドウを前面化 (AXRaise) |
| `tin://workspace/focus` | `workspace` | アクティブワークスペース全ウィンドウを前面化 |
| `tin://workspace/switch?id=X` | `workspace` | ワークスペース切替 |
| `tin://terminal/new?cwd=X` | `grid-terminal` | 新規 Grid 埋め込みターミナル生成 |

### パラメータ規約

- すべて URL エンコードされた UTF-8 文字列
- `title` は完全一致が前提のためタイトル全体を URL エンコードして渡す
- 未知のパラメータは無視する (前方互換のため)
- 必須パラメータ欠如時は黙って無視 (エラーダイアログは出さない)

### 応答

URL スキームは **fire-and-forget** で、応答は返さない。状態を知りたい場合はクライアントは `snapped.json` を再読み込みすること。

---

## 6. バージョニング方針

### Protocol version (`protocol` フィールド)

- 形式: `major.minor` (例: `"1.0"`, `"1.1"`, `"2.0"`)
- **major 変更**: 既存クライアントは動かなくなる破壊的変更。慎重に
- **minor 変更**: 後方互換の追加のみ (新フィールド、新コマンド、新 capability)
- クライアントは自分が対応している major バージョンをチェックし、major が異なれば機能無効化

### Capability-based feature detection

バージョン番号で機能分岐するのは禁止。**必ず `capabilities` 配列で分岐する。**

```js
// ✅ 正しい
if (info.capabilities.includes('workspace')) {
  registerWorkspaceActions();
}

// ❌ 禁止
if (info.version >= '1.2.0') {
  registerWorkspaceActions();
}
```

### TiN 側の後方互換ポリシー

- 既存 capability を削除する場合、**1 minor バージョン以上の deprecation 期間**を設ける
- deprecation 中は `capabilities` に残しつつ、`info.json` に `deprecatedCapabilities: ["old-feature"]` を追加
- クライアントは `deprecatedCapabilities` を検知したらログに警告を出すべき

### クライアント (プラグイン) 側の宣言

プラグインの `manifest.json` で互換プロトコルを明示:

```json
{
  "id": "tin-bridge",
  "version": "1.2.0",
  "compatibleTinProtocols": ["1.0"],
  "compatibleTinVersions": ">=1.2.0"
}
```

ただし **実行時の分岐は `capabilities` で行う**こと。上記はあくまでドキュメント用途。

---

## 7. Graceful Degradation ルール

連携相手が居ない状況でも、各実装は無害に動作すること。

### TiN 側

- `snapped.json` / `info.json` の書き出しに失敗しても TiN 本体機能は継続する (try/catch + console warning)
- `tin://` URL が来なくても TiN は通常動作する
- 誰も `snapped.json` を読まなくても性能劣化はない

### クライアント側

- `info.json` が存在しない → TiN 未起動/未インストール扱い。UI を静かに無効化
- `info.json` が存在するが `protocol` が非互換 → "対応するプラグインを更新してください" とログ警告、機能は無効化
- `snapped.json` が存在しない or パース失敗 → 空配列として扱う
- `tin://` URL オープンに失敗 → TiN インストールページを開くオプションを提供 (任意)
- `fs.watch` が発火しない macOS バグへの対策: 2 秒ポーリングを fallback として併用

---

## 8. セキュリティ考慮

- **ローカルファイルのみ**: `snapped.json` / `info.json` はローカル `userData` 配下。ネットワーク経由では公開しない
- **URL スキームの検証**: TiN 側は受信した URL のパラメータを厳格にバリデーションし、シェルコマンド等を実行しない
- **パストラバーサル防止**: `cwd` パラメータ等は `path.resolve` + ホワイトリスト化
- **権限最小化**: `snapped.json` は `0644` (read-only for others)

---

## 9. テスト方法

### TiN 単体検証

```bash
# TiN を起動した状態で
cat ~/Library/Application\ Support/TiN/info.json
cat ~/Library/Application\ Support/TiN/snapped.json

# URL スキーム動作確認
open 'tin://workspace/focus'
open 'tin://snap?app=Terminal&windowNumber=1234'
```

### クライアント単体検証

TiN なしで `~/Library/Application Support/TiN/` にテストデータを手動配置:

```bash
mkdir -p ~/Library/Application\ Support/TiN
cat > ~/Library/Application\ Support/TiN/info.json <<EOF
{
  "protocol": "1.0",
  "app": "TiN",
  "version": "1.2.0-test",
  "startedAt": $(date +%s)000,
  "updatedAt": $(date +%s)000,
  "capabilities": ["snap", "raise", "workspace", "window-list"],
  "endpoints": { "snappedFile": "snapped.json", "urlScheme": "tin" }
}
EOF
```

---

## 10. バージョン履歴

| Protocol | 日付 | TiN version | 変更内容 |
|---|---|---|---|
| `1.0` | 2026-04-10 | v1.2.0 | 初版。`snapped.json`, `info.json`, `tin://` URL スキーム策定 |

---

## Appendix A: クライアント実装チェックリスト

新規クライアントを実装する際の最小要件:

- [ ] `info.json` 読み取り → `protocol` major が自分の対応範囲か確認
- [ ] `capabilities` 配列で機能分岐 (バージョン番号分岐は禁止)
- [ ] `snapped.json` の多段マッチング戦略実装 (第 1〜第 4 候補)
- [ ] `fs.watch` + ポーリングの併用
- [ ] TiN 未起動時の graceful degradation
- [ ] `tin://` URL の fire-and-forget 挙動を理解
- [ ] `deprecatedCapabilities` の警告ログ
- [ ] セキュリティ: パラメータバリデーション

## Appendix B: TiN 実装チェックリスト

TiN 本体が本プロトコルに準拠するための最小要件:

- [ ] 起動時に `info.json` を atomic write
- [ ] 正常終了時に `info.json` を削除
- [ ] Snap / Release / Workspace 切替時に `snapped.json` を atomic write
- [ ] `tin://` URL スキーム登録 + `open-url` ハンドラ
- [ ] `package.json` `build.files` で `atelierx-plugin/**` と `docs/**` を除外
- [ ] 書き出し失敗時のエラーハンドリング (TiN 本体は継続)
- [ ] `capabilities` 配列を実際のサポート状況に合わせて出す
- [ ] 後方互換を壊す場合は `deprecatedCapabilities` に 1 minor 以上残す
