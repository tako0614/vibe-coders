# 配布・運用

2026-09-16。**0.2.0を常用LAN版へ反映しました。npm公開は認証待ち（401）で、公開済み版は0.1.8です。** 0.2.0ではデッキ・複数端末と共通shellを追加し、専用native子実行を廃止しました。検索・直接入力できるモデルpickerと既存Codex認証の再利用にも対応しています。[仕様と移行](shell-workspace.md)・[反映結果と残っている制限](debugging-0.2.0.md)を参照してください。以下のnpmインストール例は公開済み版です。

```sh
npm install -g vibe-coders@0.1.8
```

ソースは公開GitHubリポジトリ [tako0614/vibe-coders](https://github.com/tako0614/vibe-coders) で管理します。

旧 `@tako0614/vibe-coder@0.1.1` からの改名です。同じHomeで起動すると、従来の設定・会話・Atomの記憶を使えます。保存先の `vibe-coder` ディレクトリと `VIBE_CODER_*` 環境変数は引き続き使用します。

公開registryから0.1.8を取得し、配布ファイルのSHA-512一致、npmからのインストール、`vibe-coders` コマンドとHome初期化を確認しました。65テスト、Reactビルド、配布bundleの別ディレクトリ起動も通過しています。旧0.1.1で保存したログイン設定・会話・Atomの記憶を0.1.2から読み書きする移行試験は、改名時に確認済みです。

## npm用配布物

```sh
bun run package
bun run check:package
cd dist/package
npm pack
```

配布名・実行コマンド名ともに `vibe-coders` です。Bun 1.3.14以上を先にインストールしてください。配布物はBun用JavaScriptなので、各OS向けの実行ファイルを別々にダウンロードする必要はありません。WindowsのPTYはoptional dependencyのnode-ptyを使います。

ローカルtarballの導入後は以下の手順です。

```sh
npm install -g /path/to/vibe-coders-0.2.0.tgz
vibe-coders setup
cd /path/to/workspace
vibe-coders init
vibe-coders
```

ライブラリのライセンス文は `THIRD_PARTY_LICENSES.txt` に同梱します。Atom Memoryの実装はそのライブラリをbundleして配布します。元のリポジトリのnode_modulesを読み込む構成ではありません。

## LANからのアクセス

同じLANの別端末から開く場合、待ち受けとブラウザから使うURLを両方指定します。次のIPは起動するPCのLANアドレスに置き換えてください。

```sh
VIBE_CODER_LISTEN=0.0.0.0 VIBE_CODER_ORIGIN=http://192.168.1.10:3100 vibe-coders
```

常用する場合は端末設定の `web.hostname` に `0.0.0.0`、`web.origin` に実際のURLを保存します。MCP OAuthのcallbackにもそのURLが使われます。ログインには `vibe-coders setup` で設定したユーザー名とパスワードを使います。`web.origin` は一つのURLを許可する設定なので、別端末もそのURLから開いてください。

0.1.8ではHTTPのLAN接続でもチャット・入力回答・MCP導入依頼に必要な操作IDを生成できます。

## コンテナ

```sh
docker compose build
docker compose run --rm vibe-coders setup
docker compose run --rm vibe-coders init
docker compose up -d
```

`workspace/` を作業Homeに、named volumeを設定とDBの保存先にします。ブラウザは `http://127.0.0.1:3100`。`VIBE_CODER_LISTEN` はlistenアドレスだけを変えます。HTTPSのリバースプロキシ配下では `VIBE_CODER_ORIGIN=https://your-host.example` も指定し、公開Originと一致させてください。MCP OAuthのcallback URLにも外部Originを使う場合は、端末設定の `web.origin` を同じ値にします。

自動デスクトップはコンテナ内に起動します。ホストの既存画面を使う場合、コンテナから見たlocalhostとホストOSのlocalhostは別です。SSH転送等で対象VNCをバックエンドと同じネットワーク名前空間のloopbackへ接続してください。ログイン済みのCodexやChromeを使う用途では、通常のホスト上で起動する構成が扱いやすくなります。

この環境ではDockerのAppArmor profileを適用できずビルドが止まりました。通常のDockerホストでの実行はまだ確認していません。

自動接続のVNCはloopbackだけで待ち受け、X11とVNCの認証情報はHomeごとの状態領域に保存します。別のHomeとはポート・画面・Chromeプロファイルを共有しません。終了時は自身が起動したプロセスだけを停止し、異常終了後の再起動もPIDと起動時刻を照合して回収します。

## OS側の準備

- Linux自動接続：アクセス可能なX11のDISPLAYを使用し、なければ専用のXvfbを起動。Debian / Ubuntuではrootまたはパスワード不要のsudoで、必要な `xvfb xauth x11-utils x11vnc openbox xterm` を導入します。権限不足・その他のディストリビューションでは、画面に出るインストール案内を使用してください。既存の手動VNC設定は優先されます。
- Linux X11の手動直接操作：`xdotool`、ImageMagickの`import`、同じDISPLAYを共有するVNCサーバー。
- VNC経由：RFB 3.3 / 3.7 / 3.8、raw encoding、Noneまたは標準VNC password authenticationに対応するサーバー。接続先のOS側で画面共有と必要な許可を有効にします。macOS固有認証やVeNCrypt専用構成は、そのままでは接続できません。
- Windows：Bunとnode-pty / ConPTY。PowerShellや任意CLIもコマンドを指定してPTYから起動できます。
- PDF：Popplerの`pdftotext`。スキャン画像には別途OCRまたは画像を扱うモデル・ツールが必要です。
- Chrome：通常のChromeと、採用するMCPサーバーの実行環境（Chrome DevTools MCPならNode.js / npx）。MCPの導入依頼を親に渡すか、汎用MCP設定で登録します。普段のChromeを使う場合は、公式手順に沿ってリモートデバッグを有効にし、接続を許可します。
- Codex：既存の `CODEX_HOME/auth.json`（既定は `~/.codex/auth.json`）をそのまま使用します。有効な保存済み認証があれば再ログインは不要です。モデル一覧・認証更新には端末のCodex CLIを使用します。keyringのみの認証読取は未対応で、利用可能とは表示せず理由を案内します。
- Claude：Claude Code CLIとそのログイン。親のモデル設定やAPIキーは自動で共有しません。

各OSのCI定義は `.github/workflows/check.yml` にあります。定義の存在を実機試験の成功としては扱いません。

## MCPとCodex認証

「設定・接続 → MCP → npmパッケージから導入」でパッケージ名を指定すると、正確なバージョンへ固定して導入し、登録・接続・ツール取得を行います。親AIの接続は不要です。パッケージは設定ディレクトリ内の `mcp-packages/` に保存し、導入結果・失敗した工程を実行ログに残します。登録後の認証待ち・接続失敗は、専用入力と「接続」から再開できます。HTTPサービスは「手動で設定」でURLを指定すると登録後に接続します。

OAuthの動的登録に対応しない接続先は、事前登録したクライアントID・必要なスコープを設定できます。シークレットが必要なら「クライアント認証」で保存します。シークレットを設定JSONやチャットに記入しません。

Chrome専用の登録コマンドはありません。「設定・接続 → MCP接続」の導入依頼は親への通常の依頼として保存されます。親は環境を確認し、必要なソフトとMCPを導入して、登録・接続・取得したツールの呼び出しまで進めます。手動設定は `vibe-coders mcp add --json` またはWebUIから行えます。稼働中はWebUIで接続・切断でき、親からは追加・更新・再接続・削除が可能です。

Codex認証のURL・コードはWeb認証が必要な専用APIからのみ表示し、会話・実行ログ・Atomには渡しません。成功通知とアカウント状態を確認して待機中の実行を再開します。全停止・入力カードの取消・期限切れでは認証試行を取り消し、再起動時には失われた試行のカードを閉じます。認証中のデスクトップは本人操作に切り替え、返却は画面が安全になってから本人が行います。

コード方式は別PCからも使えます。ブラウザ方式のcallbackはCodexが起動したホストのloopbackへ戻るため、WebUIを別PCから開いている場合はコード方式を使用してください。親の接続方法をCodexサブスクに設定すれば、OpenAI互換APIのキーは不要です。

## 親をCodexサブスクで動かす

「AI接続 → Codex」を選ぶと端末の認証を自動確認します。モデルpickerで選ぶか、モデル名を直接入力して「このモデルでチャットを始める」を押します。保存済み認証がなければコード・ブラウザ認証を案内します。モデル一覧は端末のCodex App Serverから取得します。

親のループとツール実行はVibe Codersが持ち、アプリ内の接続処理がCodexのサブスク向けResponsesエンドポイントを呼びます。接続先は固定し、設定で指定した任意のURLへCodexのトークンを送りません。既存認証はサーバー内でのみ読み、Vibe Codersの設定へコピーしません。更新・新規ログインはCodex自身に任せ、認証保存先の設定を上書きしません。

OpenRouter・OpenAI互換APIも同じ検索・直接入力可能なpickerを使用します。モデル名を知らなくてもURLとAPIキーから一覧を取得できます。OpenRouterはキーなしでも公開一覧を取得でき、接続時にはAPIキーを保存します。同じURLでモデルだけを変更すると保存済みキーを引き継ぎ、別URLへそのキーを送信しません。

レスポンスのストリーム終端とツール呼び出しIDを照合し、暗号化された推論コンテキストを同じモデルの次の呼び出しへ渡します。途中で切れた応答のツールは実行しません。401はトークン更新後に一度だけ再試行し、429は利用枠エラーとして表示します。別アカウントやAPI課金への自動切替はしません。

Tiboが紹介した[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)のCodex接続実装と、[公式の認証資料](https://developers.openai.com/codex/auth)を照合しています。このアプリは独立したプロキシサービスを起動せず、必要な接続処理をBunバックエンドで行います。Codexのサブスク向けエンドポイントは通常のOpenAI APIとは異なるため、提供側の変更への追従が必要です。
