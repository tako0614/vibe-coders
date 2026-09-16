# Vibe Coders

リポジトリを拠点に動く常駐エージェント。Hono + Bun + React、SQLite + Drizzle、[Atom Memory](https://github.com/tako0614/atom-memory)を使用しています。

## 起動

Bun 1.3.14以上を先にインストールしてください。

```sh
npm install -g vibe-coders@0.2.1
vibe-coders setup
cd /path/to/workspace
vibe-coders init
vibe-coders
```

`http://127.0.0.1:3100` を開き、親AIの接続方法を選びます。**Codexサブスク**は端末の保存済み認証を自動利用します。OpenRouter・OpenAI互換APIはURLとAPIキーを設定します。どちらもモデルpickerで一覧から検索・選択でき、モデル名を直接入力することもできます。親モデルが未設定でも、設定画面とターミナルは利用できます。

## 機能

- チャット、画像・テキスト・PDF添付、非同期の人間入力、認証再確認
- チャットの下書き・添付画像をブラウザへ保存、長い会話の自動要約（元の履歴は保持）
- ファイルの編集・差分・内容照合つき復元、shell・PTY、同じ端末の手動操作、再起動時の状態復帰
- デッキ・複数端末のグリッド・最大化・モバイル切り替え、Codex / Claudeを含む任意CLIの共通shell実行
- 継続的な標準入力、EOF、bounded wait、PTYの現在画面、操作権を照合した人間とAIの引き継ぎ
- stdio / HTTP MCP、導入依頼・動的追加・更新・再接続、複数選択・初期値付きフォーム、URL認証、OAuth（事前登録クライアントにも対応）
- **Codexのサブスク枠で親エージェントを実行**。ChatGPTログイン、モデル一覧、画像・ツール呼び出し、認証待ちからの再開
- Linuxのデスクトップを自動接続。画面のないホストには専用の仮想画面、Chrome・端末の起動、AI操作中のプレビュー
- WebSocketによる即時の端末入出力、コピー・貼り付け・文字サイズ・全画面
- 単発・周期・イベント条件の予定、Atomの保存と自動取得
- SearXNG / Brave Search、履歴と画像の保存期間設定

`atom.toml` と `AGENT.md` が作業Homeの構成です。設定・資格情報・DBは既定でリポジトリ外へ保存します。`vibe-coders doctor` で利用可能な機能を確認できます。

旧 `@tako0614/vibe-coder` から改名しています。保存先は従来の `~/.config/vibe-coder` と `~/.local/share/vibe-coder`、環境変数は `VIBE_CODER_*` を引き継ぎます。同じHomeで起動すると既存の設定・会話・記憶を使用できます。

モデル変更はチャット内で完結します。設定画面は認証と接続先の管理に使用します。API接続はモデルを未選択のままキーを保存でき、チャットでモデルを選ぶと待機中の依頼を開始します。

## 実行環境

初期リリースの実機検証対象はLinuxです。WindowsのPTYはnode-pty / ConPTYの経路を用意していますが、Windows・macOSでの実機検証は別途必要です。

PDFにはPopplerの `pdftotext`、X11直接操作には `xdotool` とImageMagickが必要です。PDFは先頭20ページまでのテキスト層を扱い、スキャン画像のOCRは含みません。

Linuxでは起動時にアクセス可能なX11画面を確認し、なければ認証付きXvfbとVNCをこのホストに起動します。Debian / Ubuntuでは不足パッケージをrootまたはパスワード不要のsudoで自動導入します。権限が足りない場合は実行するコマンドを画面に表示します。Chrome / Chromiumはホストにインストールされたものを専用プロファイルで開きます。通常のWayland画面・macOS・Windowsの直接自動接続は未対応で、手動VNCを使用します。

手動VNC方式は、RFB 3.3 / 3.7 / 3.8のraw encodingとNone / 標準VNC password authenticationに対応します。対象OS側でVNCサーバーを有効にします。別ホストへ接続する場合は、SSH転送等でバックエンドのloopbackへ接続してください。OS固有の画面共有認証をすべて実装するものではありません。

「npmパッケージから導入」はAI未接続でも使えます。バージョンを固定して導入し、MCPへ接続してツール一覧を取得します。認証情報が必要なら専用入力を出し、保存後に接続を再開します。

MCP接続の「追加したい機能」やチャットから「Chromeを導入してMCPで接続して」と依頼できます。親がOS・既存環境を確認し、通常のChromeと必要なMCPを導入・登録・接続します。親モデルと対象ホストへの操作経路が必要です。Chromeのリモートデバッグ許可など、本人操作が必要な箇所は入力カードへ回します。

Codexサブスクは既存の `CODEX_HOME/auth.json`（既定 `~/.codex/auth.json`）をそのまま使います。有効な認証があれば再ログインなしで利用できます。設定で「Codexを使う」を選び、チャット入力欄のモデルpickerでモデルを検索・選択するかIDを直接入力します。認証がない場合だけWebUIのコード・ブラウザ認証を使います。keyringのみの認証読取は未対応です。CLIで設定する場合は `vibe-coders provider configure --kind codex --model MODEL_ID` です。親はアプリ内のResponses接続で推論し、Vibe CodersがMCP・ファイル・予定・記憶を実行します。APIキーは不要です。

認証が必要な間は親の推論を待機し、ログイン完了で元の依頼を再開します。Codexが認証情報を保存・更新し、アプリが認証情報を会話・モデル入力・Atomへ渡すことはありません。サブスクの利用枠不足をAPI課金へ自動で切り替えません。Codexのサブスク向け接続仕様の変更によって更新が必要になる場合があります。

全停止は管理下の実行を止めます。任意shellは起動したOSユーザーの権限で動きます。WebUIは単一所有者向けの管理画面です。外部公開する場合はHTTPSと正確な `VIBE_CODER_ORIGIN` を設定してください。

Atom Memoryは0.7.0を使用し、SQLiteドライバのimportをBun向けに置き換えてbundleしています。依存ライブラリのライセンス文は `THIRD_PARTY_LICENSES.txt` に同梱しています。

0.2.0から子実行専用のnativeツール・APIを廃止しました。Codex / Claudeも通常のshellコマンドとして起動します。Codexサブスクの親モデル接続とログインは利用できます。ブラウザ再接続は動作中の端末へ戻りますが、サーバー再起動ではプロセスを再実行せず中断扱いにします。
