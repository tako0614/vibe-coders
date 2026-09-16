# Vibe Coders

リポジトリを拠点に動く、チャット中心の常駐エージェント。Hono + Bun + React、状態保存はSQLite + Drizzleです。

親のモデル呼び出し、shell・PTY、MCP、人への入力依頼、予定を一つのバックエンドで管理します。入力カードはIDを返して完了し、回答待ちの間も親は別の作業を進められます。UIを閉じてもバックエンドは実行を持ち続けます。

## 起動

Bun 1.3.14以上が必要です。初期の検証対象はLinuxです。

npm公開済み版は `npm install -g vibe-coders@0.1.8`、このソースの0.2.0は配布tarballから導入できます（npm公開は認証待ち）。起動手順は [配布・運用](docs/distribution.md) を参照してください。以下はソースからの起動手順です。

```sh
git clone https://github.com/tako0614/vibe-coders.git
cd vibe-coders
bun install --frozen-lockfile
bun run setup       # WebUIのユーザー名・パスワードを伏字で設定
bun run init        # 現在の場所に atom.toml / AGENT.md を作成（既存は保持）
bun run dev
```

開発画面は **http://127.0.0.1:5173**。親AIは「設定・接続」で **Codexサブスク（ChatGPTログイン）** またはOpenAI互換APIを選べます。Codexを選ぶ場合はモデルを選んで「ログインして接続」を押します。ログイン済みなら「このモデルでチャットを始める」で接続できます。OpenAI互換APIの場合はURL・モデルID・APIキーを設定します。モデル未設定でも、設定・入力カード・ターミナルは利用できます。

通常起動ではビルド済みReactをHonoから配信します。

```sh
bun run build
bun run start                 # http://127.0.0.1:3100
bun run start --home /path/to/agent-repo
```

`AGENT.md` は親の指示、`atom.toml` は持ち運べる設定です。別のHomeで使う場合は `bun src/cli.ts init --home /path/to/agent-repo` を実行します。

## 使える操作

- Webチャット、画像・テキスト添付、ツール結果、追加入力、親の一時停止・再開、全停止
- 非同期の入力カード、専用の秘密入力、取消、明示待機、イベントによる復帰
- ファイル一覧・範囲読取・glob・内容照合つき編集、URL取得、shell、持続PTY、TUIの現在画面
- 任意CLIの起動、実行ログ、終了コード、同じ端末の手動操作と返却。WebSocketで即時入出力、コピー・貼り付け・文字サイズ・全画面
- Linuxの画面を自動接続。画面のないホストには専用デスクトップを用意し、Chrome・端末の起動、AI操作中のプレビュー、手動操作を共有
- stdio / Streamable HTTP MCPの登録・更新・削除・接続・動的ツール取得、型付きフォーム、URL認証、OAuth
- MCPで使いたい機能を親へ依頼し、実行環境の確認・不足ソフトの導入・接続・動作確認を進める
- 単発・周期・イベント条件による予定、作成・編集・削除・即時実行、`atom.toml` の共有ルーチン
- Atom Memoryの保存・検索・参照・修正、推論ごとの自動取得と成功後の利用ack
- デッキごとの複数端末、グリッド・最大化・モバイル切り替え、Codex / Claudeを含む任意CLIの共通shell実行
- **親エージェントをCodexのサブスク枠で実行**。ChatGPTログイン、モデル一覧、ツール呼び出し、画像入力、暗号化された推論コンテキストの継続、利用枠エラーの表示
- SearXNG / Brave Search、PDFのテキスト読取、画像・履歴の保存期間設定
- Linux X11またはVNCによる画面取得・クリック・キー・入力・スクロール・ドラッグ、同じVNCのWeb操作

GUIのX11直接操作には `xdotool` とImageMagickが必要です。VNC方式なら別OSの画面にも接続できます。VNC接続先はバックエンドのloopbackで、別ホストはSSH転送等を使います。「手動操作」にすると管理下のAIアクセスを止め、「安全な画面でAIに返す」で返却します。ブラウザMCPが同じ画面を扱う場合は `targetId: "desktop"` を設定してください。対応するVNC認証とOS別の準備は [配布・運用](docs/distribution.md) を参照してください。

「設定・接続 → MCP接続」の「追加したい機能」やチャットから、たとえば「Chromeを導入してMCPで接続し、ページを操作できるようにして」と依頼できます。Chrome専用機能は持たず、親が通常のアプリとMCPを導入・登録します。既存のChromeや接続を優先し、必要な本人操作は入力カードへ回します。実行先ホストへの操作経路と、親モデルの接続設定が必要です。

親モデルにCodexサブスクを選ぶと、Vibe Codersの会話ループ・MCP・Atom・予定をそのままCodexの契約枠で動かします。Codex CLIでChatGPTログインし、アプリ内のResponses接続から推論します。APIキーは不要です。未認証なら親の推論を認証待ちにし、完了イベントで元の依頼を再開します。入力カード・子プロセス・バックエンドは動き続けます。

ログインは親モデルの設定欄で行います。コード方式は別PCからも、ブラウザ方式は同じPCから利用できます。認証情報はCodexのファイルストアに保存し、更新はCodexが行います。トークン・コードを会話やAtomへ渡しません。利用枠不足でAPI課金へ自動切替しません。

APIキーは保存後に接続先の認証APIで確認します。拒否された場合は同じカードが再入力へ戻り、一時的な障害ならキーを保持して再確認できます。認証APIの成功と、個々のモデルを実行できることは別の確認です。

## 保存先

| 範囲                            | 既定の保存先                                                        |
| ------------------------------- | ------------------------------------------------------------------- |
| 持ち運ぶ構成                    | Homeの `atom.toml` と `AGENT.md`                                    |
| 端末の接続設定・Web認証ハッシュ | `~/.config/vibe-coder/config.json`                                  |
| 暗号化した資格情報とローカル鍵  | `~/.config/vibe-coder/vault.enc` / `vault.key`                      |
| 会話・入力・実行・予定          | `~/.local/share/vibe-coder/<Homeのハッシュ>/state.sqlite`           |
| Atom Memoryとホスト認可         | 同じディレクトリの `memory.sqlite` / `memory.sqlite.authority.json` |

XDGの設定を使用します。検証用には `VIBE_CODER_CONFIG_DIR` と `VIBE_CODER_DATA_DIR` で変更できます。原文のキーを会話DB・Atom・リポジトリへ保存しません。資格情報と暗号鍵は同じOSユーザーの権限下にあり、任意shellからの強い隔離を提供する設計ではありません。

Vibe Codersへの改名後も、保存先と `VIBE_CODER_*` 環境変数は共通です。同じHomeから起動すると、旧 `@tako0614/vibe-coder` の設定・会話・記憶を引き継ぎます。

既定listenはloopback。外部公開するときはHTTPSを終端し、端末設定の `web.origin` を外部の正確なOriginに設定します。管理用の認証情報は生成アプリのプレビューへ渡さず、別Originで配信してください。

同じLANの別端末から開く手順は [LANからのアクセス](docs/distribution.md#lanからのアクセス) にあります。

## CLI

```sh
bun src/cli.ts --help
bun src/cli.ts doctor
bun src/cli.ts config
bun src/cli.ts provider configure
bun src/cli.ts codex login
bun src/cli.ts provider configure --kind codex --model MODEL_ID
```

非対話入力は `setup --username NAME --password-stdin`、`provider configure --base-url URL --model ID`、`mcp add --json`、`computer connect --json`、`secret --target ID --stdin` を用意しています。秘密はstdinから渡し、コマンド引数には入れません。実行中の接続はWebUIの「接続」で再読込できます。

## 検証と実装状況

```sh
bun run check          # TypeScript、Bunテスト、画面配信、配布bundleの別ディレクトリ起動
bun run package        # npm用の配布物を dist/package へ作成
bun run db:generate    # Drizzleスキーマ変更時にmigrationを生成
```

DBのmigrationはバックエンド起動時に適用します。依存は `bun.lock` に固定しています。Atom Memoryはnpm公開済みの0.7.0を使い、SQLiteドライバのimportだけをBun向けに変更したパッチを管理しています。

0.2.0ではshellの入口を共通化し、DeckIDE型のデッキ・複数端末・最大化・手動引き継ぎを追加しました。専用native子実行を廃止し、PTYと継続的な標準入出力を同じ実行管理で扱います。Codex・OpenRouter・OpenAI互換APIは検索・直接入力ができるモデルpickerに対応し、Codexの保存済みauth.jsonを再ログインなしで利用します。[仕様と移行](docs/shell-workspace.md)・[検証記録](docs/debugging-0.2.0.md) を参照してください。0.1.8の会話要約・ファイル編集/復元・下書き・MCP導入は継続します。

0.1.7の端末・デスクトップ改善は [端末の遅延と自動デスクトップ](docs/debugging-0.1.7.md)。0.1.6の修正と検証範囲は [動作修正と画面整理](docs/debugging-0.1.6.md)。設計全体は [plan.md](plan.md)、実装範囲・実機検証・外部条件待ちは [実装状況](docs/implementation.md)、配布方法は [配布・運用](docs/distribution.md) に記録しています。Codexサブスクによる親のファイル操作・記憶・人間入力と、親がMCPを登録して実Chromeを読むところまで確認しています。OpenAI互換APIの実接続、Claudeの再ログイン、各OSの実機検証などは残っています。
