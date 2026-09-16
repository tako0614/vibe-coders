# 実装状況

2026-09-16。Vibe CodersはHono / Bun / React / SQLite / Drizzleで実装しています。

## Atomはどれを使っているか

あなたの [`tako0614/atom-memory`](https://github.com/tako0614/atom-memory) のnpm公開版 **0.7.0** を使用しています。`src/server/memory.ts` はその `MemoryHost` と `SqliteStorage` を組み込むホストです。独自の代替ライブラリではありません。`patches/atom-memory@0.7.0.patch` はSQLiteドライバのimportを `node:sqlite` から `bun:sqlite` へ置き換える差分と、長い検索入力でSQLiteの式の深さ制限に達しないようにする検索SQLの修正です。

手元のライブラリとnpmでは0.9.0の公開も確認しました。このアプリの依存は0.7.0に固定しており、0.9の宣言的writeやInputTokenへ移行した状態とは扱いません。採用版の契約に従って、毎回の取得と成功したモデル応答後の利用ackを行います。

## 実装済み

| 機能           | 実装内容                                                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| チャット       | 会話・画像・テキスト・PDF添付、ストリーム、追加入力、親の一時停止と再開、全停止、長い会話の自動要約と元の履歴保持、下書きのブラウザ保存、回答コピー、自動拡張入力欄、会話検索と選択復帰、スマホのメニュー                                                                                            |
| 人間入力       | 非同期カード、明示wait、期限・取消・重複送信・接続版の照合、専用秘密入力                                                                                                   |
| 認証の確認     | モデル接続の認証確認。認証拒否なら同じカードの版を更新して再入力。一時障害なら保存したキーを保持して再確認。VNCも実認証を確認                                              |
| MCP            | stdio / Streamable HTTP、動的discovery、ツール一覧変更、文字・単一/複数選択・整数・数値・真偽値フォーム、初期値・表示名・入力制約、URL elicitation                                                            |
| MCP OAuth      | SDKのdiscovery・client登録、事前登録クライアントID/シークレット・スコープ、PKCE・トークン保存・更新。期限と接続版に結び付く一回限りのstate、コールバック後の接続再開                                                      |
| ファイル・実行 | WebUIの差分・編集・復元、範囲読取・glob・内容照合つき編集、shell、継続PTY、Unicode/TUI現在画面、手動操作への引き継ぎ                                                                                |
| CLI実行 | 共通shellのPTY / pipe、継続入力・EOF・待機・停止、デッキ・グリッド・最大化・モバイル切り替え。Codex / Claudeも通常のCLIとして起動 |
| MCP導入        | AI不要のnpm導入・バージョン固定・discovery、認証入力後の再接続。手動の追加・編集・認証、チャットからの導入依頼、環境・実行ファイルの確認、親からの追加・更新・再接続・切断・削除。接続は独立runで行い、実ツールを次の推論へ反映。Chromeは通常アプリとMCPを導入する利用例   |
| Codex親モデル  | サブスク認証によるResponses接続。親ループ・MCP・予定・Atomは本アプリが所有。ツールIDとストリーム終端の照合、暗号化コンテキスト継続、画像入力、401時の一度の更新、一時障害の再試行、利用枠超過で停止 |
| モデル選択・認証 | チャット入力欄のpickerでCodex・OpenRouter・OpenAI互換APIのモデルを検索・選択・直接入力。接続設定はモデル未選択でも保存可能。Codexの保存済みauth.jsonを自動利用。必要な場合のコード／ブラウザ認証、親の認証待ちからの再開、取消・全停止・再起動時の処理 |
| GUI            | Linux X11直接操作とVNC経由。画面取得・クリック・キー・Unicode文字・スクロール・ドラッグ。同じVNCをWebUIでも利用                                                            |
| 別OSの画面     | VNCサーバーを公開できるWayland / macOS / Windowsと、WSLから別ホストの画面への接続経路。リモート通信はloopbackへのSSH転送等を使用                                           |
| Windows端末    | shellはcmd、PTYはnode-pty / ConPTY。Linux/macOSはBun PTY                                                                                                                   |
| 予定           | 単発・周期・即時実行、実行終了・入力解決・メッセージ受信を条件とする予定。イベントIDのカーソルで重複発火を防止                                                             |
| Web・PDF       | SearXNG / Brave Searchの検索API、出典URLと取得日時、URL本文取得。PopplerでPDFの先頭20ページまでのテキスト層を抽出                                                          |
| 保存期間       | 画像30日・終了済み実行30日・会話90日が既定。変更・無期限化可能。進行中の作業、未回答の依頼、有効な予定、未処理イベントがある会話を保護                                     |
| 保存・復帰     | SQLite migration、受信箱、実行状態、資格情報の独立保存、消失プロセスをinterruptedにする復帰。不明な副作用を自動再送しない                                                  |
| 排他           | 設定・資格情報をプロセス間で排他更新。完成したPID記録を原子的に公開し、終了済みのwriterのロックを回収                                                                      |
| 配布           | 元のnode_modulesを要しないBun用バックエンド＋ビルド済みWebUI、npm用配布ディレクトリ、Dockerfile / Compose、各OSのCI定義                                                    |

外部プロセスやネットワークの副作用にexactly-onceを保証しません。資格情報と暗号鍵は同じOSユーザーがアクセス可能です。任意shellから秘密を隔離するサンドボックスとしては扱いません。管理下の手動操作区間はAIの観測を停止しますが、他のOSプロセスによる観測を制御するものではありません。

0.2.2のチャット横のシェル・共有画面、手動MCP設定、AI設定ツールは [検証記録](debugging-0.2.2.md)。0.2.1のチャット内モデル選択・UI改善・Codex一覧取得の修正は [検証記録](debugging-0.2.1.md)。0.2.0のshell共通化とデッキは [仕様](shell-workspace.md)・[検証記録](debugging-0.2.0.md)。0.1.8の会話要約・ファイル編集/復元・下書き保存・子への追加指示・MCP導入改善は [検証記録](debugging-0.1.8.md)。0.1.7の端末・自動デスクトップ改善は [検証記録](debugging-0.1.7.md)。0.1.6での不具合修正と実画面の検証範囲は [動作修正と画面整理](debugging-0.1.6.md) に記録しています。0.1.8検証時の実アカウントは推論時に429（利用枠不足）を返したため、以下の実Codexでの完了実績は先行版で確認したものです。

0.3.0の複数デスクトップ・effortとAtomの実Codex検証は [検証記録](debugging-0.3.0.md)。この検証では利用枠エラーはなく、保存後の再起動・別会話での記憶再利用が通りました。その検証時点の常用HomeのAtomは0件でした。0.3.3では会話の区切りで記憶を自動整理し、過去の会話の手動取り込み、出典・関連・変更履歴・モデルへ渡した会話を確認できます。[0.3.3の検証記録](debugging-0.3.3.md)。

## この環境で確認したこと

- 端末のWebSocket入出力、切断後の差分再取得、操作権の失効、手動区間のAI画面からの除去。実Chromeの入力から表示まで12回の測定で中央値9.8ms・最大17.2ms（同じホストのLAN URL）。
- 手動設定なしのXvfb・認証付きVNC起動、既存のX11画面への接続、AIの観測IDを消費しないプレビュー、Chrome起動、終了・異常終了後のプロセス回収。

- 型検査、Bunの84テスト、Reactビルド、Honoによる認証付き画面配信（0.2.1）。
- CLI設定・init・起動・終了・二重起動拒否。配布用bundleを別ディレクトリへ移して、元のnode_modulesなしで起動・migration・認証・画面配信。npm tarballからのインストール、実行コマンド、Home初期化。
- `vibe-coders@0.1.8` をnpmへ公開。公開tarballの内容一致と、公開registryからのインストール・実行コマンド・Home初期化を確認。
- HTTPのLANアドレスで本番WebUIを開き、`crypto.randomUUID` が利用できない環境で入力回答が送れないことを0.1.4で再現。0.1.5ではチャット・入力回答・MCP導入依頼がサーバーへ届くことを実Chromeで確認。
- 改名時の移行試験では、旧 `@tako0614/vibe-coder@0.1.1` で保存したログイン設定・会話・Atomの記憶を `vibe-coders@0.1.2` から読み書きできることを確認。
- 決めた手順を返すモデルfixtureで、MCP導入依頼 → 環境確認 → shellによるローカルMCP実行ファイルの導入 → 登録 → discovery → 次の推論での実ツール呼び出しを同じ会話で確認。CLI未導入、設定版変更、初期化中のデスクトップ引き継ぎも回帰試験。
- Codex認証のJSON-RPC fixtureで、コード／ブラウザ方式、認証URLの制約、秘密の履歴非混入、API認証・CSRF、成功時の元の作業の一回の開始、失敗・取消・全停止・失われた認証カードの復旧を確認。
- WebUIでMCP導入フォーム、Codexの認証カード・コードの消去・待機中の子の完了、390px幅を確認。新規の実アカウント認証操作は行わずfixtureで検証。既存のログイン済みCodexでは、追加した認証確認を通って実ファイル作成・読戻しまで再検証。
- **実際のCodexサブスクで親を実行**。端末のモデル一覧が返した既定モデルを使い、親からファイル作成・読戻し・Atomへの保存・非秘密の人間入力を実行。`native_start` を使用していません。
- **実Codexサブスクの親からMCPを動的登録**。環境確認 → `mcp_add` → discovery → 実Chromeの `list_pages` → 実行結果の確認まで同じ会話で完走。29ツールを取得。Chromeは検証専用で、インストール済みの環境を使用しました。
- Codex親モデルの回帰試験で、終端のoutput配列が空の実ストリーム形式、暗号化コンテキスト・画像・tool call IDの継続、ログインから元の親の依頼の再開、取消後の再要求防止、全停止、途中切断時の非実行、API課金への非フォールバックを確認。
- 実MCPサーバーとのツール呼出し、数値・真偽値・URL入力。HTTP OAuth fixtureによるdiscovery・登録・PKCE照合・callback再利用拒否・接続再開。
- 実際のXvfb＋パスワード付きx11vncで、640×480の画面取得、クリック、英字と日本語のキーイベント、ドラッグ、手動への引き継ぎ、古い観測による入力拒否。
- 実際のChrome＋chrome-devtools-mcpで29ツール取得、タブ一覧、手動操作時の切断と再接続。検証専用のChromeを使用し、普段のプロファイルを変更していません。
- ログイン・会話・PTY入力・予定保存・記憶保存・ファイル読取・接続設定・秘密入力・390px幅のブラウザ操作。
- WebUIのnoVNCからパスワード付きの実デスクトップへ接続し、800×600の表示と手動操作からAIへの返却を確認。
- 過去のnative実装では実際のCodexによるファイル作成・読戻しを確認。0.2.0ではこの専用経路を削除しており、共通shell経由での実AIの完走実績として扱いません。
- 0.2.0の常用LAN版で親の接続先をCodexへ設定し、端末の既存認証と `gpt-6-astra` による実テキスト応答を確認。実Chromeでも返答と接続済み表示を確認。0.2.1ではモデル一覧をCodexのカタログコマンドから取得するよう修正し、同じホストから6モデルを確認。
- 0.2.0のshellはプロセスの出力・終了コードを返します。作業完了、セッション再開、追加指示の意味はCLIと操作者が扱い、専用native状態へ変換しません。
- PDF fixtureの実Poppler読取、検索HTTP fixture、期限削除、認証拒否・一時障害・再検証の回帰試験。

## 外部条件が足りず完了していない検証・公開

1. **OpenAI互換APIの実接続と未導入Chromeの総合検証**：Codexサブスクによる親の実推論・ツール・MCPは確認済みです。別のOpenAI互換APIの実キーでの推論と、Chrome自体が未導入の環境から実LLMが導入まで完走する試験は未実施です。Codexの新規アカウント認証操作はfixtureで検証し、実機では既存のChatGPTログインを使用しています。
2. **Claude Codeの実推論**：端末のOAuthセッションが期限切れで、更新に失敗しました。実CLIからの認証失敗を受け取り、成功扱いしないことは確認。`claude auth login` 後に再試験が必要です。
3. **macOS / Windows / Waylandの実機検証**：接続とPTYのコード、CI定義はありますが、当該OSの実機はこの環境にありません。Linux上のVNC試験を各OSのIME・権限・DPI確認へ読み替えません。
4. **Docker実行**：Dockerfileを用意してビルドを試みましたが、このホストの入れ子のコンテナ環境でAppArmor profile適用に失敗しました。通常のDockerホストでのビルド・起動確認が必要です。ホストのセキュリティ設定は変更していません。
5. **外部サーバーへの配備**：Webサービスの配備先・ドメインは未指定です。npm配布名は `vibe-coders`。公開版は [配布・運用](distribution.md) に記録します。

MCP標準の文字列選択配列まで対応します。標準外の入れ子オブジェクト・オブジェクト配列やサービス固有の独自認証、スキャンPDFのOCR、全CLIの内部状態の共通化までは包括対応としません。対応していない外部能力はエラーまたはdeclineとして返します。壊れた旧形式の空lockや、ロック回収中の強制終了で残ったrecoveryディレクトリは運用側の確認が必要です。

## 再実行

```sh
bun run check
bun test test/shell-workspace.test.ts # 実PTY・pipe・デッキ・入力と終了
bun scripts/check-provider.ts --codex # Codexサブスクで親を検証（実モデル）
bun scripts/check-provider.ts      # 設定済みのOpenAI互換APIを検証
```

ブラウザ検証は `test/fixtures/preview.ts` とViteを起動してから実行します。

```sh
VIBE_CODER_CDP=http://127.0.0.1:9223 bun scripts/browser-check.ts
VIBE_CODER_CDP=http://127.0.0.1:9223 bun scripts/check-browser-mcp.ts
VIBE_CODER_CDP=http://127.0.0.1:9223 bun scripts/check-codex-mcp.ts # 実Codexの親が登録・呼出し
```

Codex認証UIのfixture検証はpreviewとbrowser-checkの両方に `VIBE_CODER_TEST_AUTH=1` と同じ一時ファイルの `VIBE_CODER_TEST_AUTH_STATE` を指定します。

実VNCのUI検証はpreviewとbrowser-checkの両方に `VIBE_CODER_TEST_DESKTOP=1` を指定します。

外部モデルへ送らないUI fixtureの認証は `owner / test-only-password-123`。実運用の設定には使用しません。一時Homeはpreview終了時に削除し、スクリーンショットは `/tmp/vibe-coder-browser/` へ保存します。

## 採用APIの一次資料

- [Atom Memory](https://github.com/tako0614/atom-memory)
- [Hono on Bun](https://hono.dev/docs/getting-started/bun)、[Drizzle / Bun SQLite](https://orm.drizzle.team/docs/get-started/bun-sqlite-new)
- [Bun PTY](https://bun.com/docs/runtime/child-process)、[node-pty](https://github.com/microsoft/node-pty)
- [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/client)、[MCP elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)
- [Codex App Server](https://developers.openai.com/codex/app-server)、[Claude Code programmatic usage](https://code.claude.com/docs/en/headless)
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [RFB protocol](https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst)、[noVNC](https://novnc.com/noVNC/docs/API.html)
- [SearXNG Search API](https://docs.searxng.org/dev/search_api.html)、[Brave Search](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started)

## 設定の操作経路

MCP画面はAI不要の手動フォームです。ローカルコマンド / HTTPを選んで追加・編集し、認証情報は専用入力から保存します。npm導入も手動操作できます。旧 `/api/mcp/setup` は削除し、AIへの依頼には通常の会話送信APIを使います。

親AIには `connections_list`、`mcp_add/update/reconnect/disconnect/remove` と `settings_update` を公開しています。`settings_update` は設定のrevisionを指定してモデル接続・検索・保存期間・デスクトップを変更し、WebUIと同じ更新処理を通ります。モデル変更は次の推論から反映し、他の会話が実行中なら拒否します。接続先が変わった場合、前のAPIキーを流用しません。資格情報とWebログイン・公開アドレスはこのツールの変更対象外です。デスクトップ設定を変えても人間からAIへ操作権を移しません。
