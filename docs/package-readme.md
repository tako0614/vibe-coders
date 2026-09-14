# Vibe Coders

リポジトリを拠点に動く常駐エージェント。Hono + Bun + React、SQLite + Drizzle、[Atom Memory](https://github.com/tako0614/atom-memory)を使用しています。

## 起動

Bun 1.3.14以上を先にインストールしてください。

```sh
npm install -g vibe-coders@0.1.6
vibe-coders setup
cd /path/to/workspace
vibe-coders init
vibe-coders
```

`http://127.0.0.1:3100` を開き、親AIの接続方法を選びます。**Codexサブスク**はChatGPTログイン後にモデルを選んで保存するだけで使えます。OpenAI互換APIの場合はURL・モデル・APIキーを設定します。親モデルが未設定でも、設定画面とターミナルは利用できます。

## 機能

- チャット、画像・テキスト・PDF添付、非同期の人間入力、認証再確認
- ファイル操作、shell・PTY、同じ端末の手動操作、再起動時の状態復帰
- Codex App Server / Claude Code連携とセッション再開
- stdio / HTTP MCP、導入依頼・動的追加・更新・再接続、型付きフォーム、URL認証、OAuth
- **Codexのサブスク枠で親エージェントを実行**。ChatGPTログイン、モデル一覧、画像・ツール呼び出し、認証待ちからの再開
- Linux X11 / VNCによる共有デスクトップ
- 単発・周期・イベント条件の予定、Atomの保存と自動取得
- SearXNG / Brave Search、履歴と画像の保存期間設定

`atom.toml` と `AGENT.md` が作業Homeの構成です。設定・資格情報・DBは既定でリポジトリ外へ保存します。`vibe-coders doctor` で利用可能な機能を確認できます。

旧 `@tako0614/vibe-coder` から改名しています。保存先は従来の `~/.config/vibe-coder` と `~/.local/share/vibe-coder`、環境変数は `VIBE_CODER_*` を引き継ぎます。同じHomeで起動すると既存の設定・会話・記憶を使用できます。

## 実行環境

初期リリースの実機検証対象はLinuxです。WindowsのPTYはnode-pty / ConPTYの経路を用意していますが、Windows・macOSでの実機検証は別途必要です。

PDFにはPopplerの `pdftotext`、X11直接操作には `xdotool` とImageMagickが必要です。PDFは先頭20ページまでのテキスト層を扱い、スキャン画像のOCRは含みません。

VNC方式は、RFB 3.3 / 3.7 / 3.8のraw encodingとNone / 標準VNC password authenticationに対応します。対象OS側でVNCサーバーを有効にします。別ホストへ接続する場合は、SSH転送等でバックエンドのloopbackへ接続してください。OS固有の画面共有認証をすべて実装するものではありません。

MCP接続の「追加したい機能」やチャットから「Chromeを導入してMCPで接続して」と依頼できます。親がOS・既存環境を確認し、通常のChromeと必要なMCPを導入・登録・接続します。親モデルと対象ホストへの操作経路が必要です。Chromeのリモートデバッグ許可など、本人操作が必要な箇所は入力カードへ回します。

CodexサブスクはCodex CLIのファイル認証を使います。WebUIの親モデル設定か `vibe-coders codex login` からChatGPTログインし、モデルを選んで「ログインして接続」を押してください。ログイン済みなら「このモデルでチャットを始める」で接続できます。CLIで設定する場合は `vibe-coders provider configure --kind codex --model MODEL_ID` です。親はアプリ内のResponses接続で推論し、Vibe CodersがMCP・ファイル・予定・記憶を実行します。APIキーは不要です。

認証が必要な間は親の推論を待機し、ログイン完了で元の依頼を再開します。Codexが認証情報を保存・更新し、アプリが認証情報を会話・モデル入力・Atomへ渡すことはありません。サブスクの利用枠不足をAPI課金へ自動で切り替えません。Codexのサブスク向け接続仕様の変更によって更新が必要になる場合があります。

全停止は管理下の実行を止めます。任意shellは起動したOSユーザーの権限で動きます。WebUIは単一所有者向けの管理画面です。外部公開する場合はHTTPSと正確な `VIBE_CODER_ORIGIN` を設定してください。

Atom Memoryは0.7.0を使用し、SQLiteドライバのimportをBun向けに置き換えてbundleしています。依存ライブラリのライセンス文は `THIRD_PARTY_LICENSES.txt` に同梱しています。
