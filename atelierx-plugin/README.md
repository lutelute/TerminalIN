# TiN Bridge Plugin for AtelierX

[AtelierX](https://github.com/lutelute/AtelierX) と [TerminalIN (TiN)](https://github.com/lutelute/TerminalIN) を疎結合に連携させるプラグイン。

## できること

- **TiN 管理中カードを Grid 除外**: TiN で Snap したウィンドウに対応する AtelierX カードに 🔒 バッジが付き、`GridArrangeModal` の対象から自動除外される
- **カードから TiN 操作**: 各カードのヘッダー/フッターに TiN コマンドボタン (Raise / Workspace Focus / New Grid Terminal) が追加される
- **graceful degradation**: TiN 未起動/未インストール時はプラグインが静かに無効化される (エラーなし)

## 要件

- **AtelierX** v1.13.1 以上
- **TiN** v1.2.0 以上 (Protocol v1.0 対応)
- macOS (両アプリとも macOS のみ)

## インストール

1. AtelierX を起動
2. `設定 → プラグイン → GitHubからインストール`
3. 以下を入力:
   ```
   lutelute/TerminalIN:atelierx-plugin
   ```
4. インストール後、プラグイン一覧で **有効化**
5. TiN を起動して任意のターミナルウィンドウを Snap
6. AtelierX 側で該当カードに 🔒 バッジが付くことを確認

## アンインストール

AtelierX の `設定 → プラグイン → アンインストール` から削除。
削除時、このプラグインが設定した装飾とアクションは自動的にクリアされる。

## 動作原理

AtelierX 本体には TiN 固有のコードが一切含まれない。代わりに以下の汎用インターフェースを使う:

- **状態読み取り**: `~/Library/Application Support/TiN/snapped.json` を監視
- **能力検出**: `~/Library/Application Support/TiN/info.json` を読む
- **コマンド送信**: `tin://` URL scheme (fire-and-forget)
- **カード装飾**: AtelierX プラグイン API の `setCardDecorator`
- **カードアクション**: AtelierX プラグイン API の `registerCardAction`

契約仕様は [`TerminalIN/docs/PROTOCOL.md`](../docs/PROTOCOL.md) を参照。

## 3ペルソナ原則

本プラグインは、以下 3 タイプのユーザーを全員尊重する:

| ペルソナ | 振る舞い |
|---|---|
| **TiN だけ使う人** | プラグイン未インストール。TiN は単体で完全動作 |
| **AtelierX だけ使う人** | プラグイン未インストール。AtelierX は単体で完全動作 |
| **両方使う人** | プラグインをインストールして統合体験を得る |

## トラブルシューティング

### カードに 🔒 バッジが付かない

- TiN が起動しているか確認: `ls ~/Library/Application\ Support/TiN/` に `info.json` があるか
- TiN で実際にウィンドウを Snap したか確認
- AtelierX のカードに対象ウィンドウがリンクされているか確認
- AtelierX Developer Tools のコンソールで `[Plugin:tin-bridge]` ログを確認

### TiN ボタンを押しても何も起きない

- TiN がインストールされているか: `/Applications/TiN.app` の存在確認
- `open 'tin://workspace/focus'` を手動実行して URL scheme が登録されているか確認
- TiN を一度再起動

### マッチングが外れる

AtelierX と TiN 間のウィンドウ対応は以下の優先順で判定:

1. `app + windowNumber` (数値ID完全一致)
2. `app + title` 完全一致
3. `app + title` 前方 40 文字一致

AtelierX 側のウィンドウ ID がターミナルの tty パスなど非数値の場合、第2/第3候補にフォールバックする。タイトルが動的に変わるターミナルでは前方一致しか効かない場合がある。

## 開発

このプラグインは TiN リポジトリの `atelierx-plugin/` サブディレクトリに同居している。
TiN の Protocol v1.0 と本プラグインは同じタグでリリースされる。

プロトコル変更時:
1. `TerminalIN/docs/PROTOCOL.md` 更新
2. `TerminalIN/main.js` の `TIN_CAPABILITIES` など調整
3. `TerminalIN/atelierx-plugin/main.js` 追従
4. 同じタグでリリース (TiN version = plugin version)

## License

ISC
