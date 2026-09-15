# 0.1.8: 会話の継続とMCP導入

2026-09-15。会話が長くなると入力が肥大化する問題、ファイルを確認してもUIから修正・復元できない問題、再読込で下書きが消える問題、子への実行中の指示、MCPの導入・入力・認証を改善しました。

## 変更したこと

- **会話の自動要約**：入力が大きくなると古い部分をモデルで整理し、最近のやり取りと最新のユーザー指示を保持します。元の会話・画像・ツール結果は削除せず、`conversation_history` で範囲取得できます。tool callと結果の対応が完了した境界で分割し、要約失敗時は保存境界を進めません。上限エラーは一度だけ圧縮して再試行します。要約にも設定中のモデルの利用枠を使います。
- **ファイルの編集・差分・復元**：「ファイル → 変更を確認」で、初回起動時に保存した作業フォルダの状態と比較できます。編集・復元は内容のハッシュを照合し、表示後の変更があれば止めます。AI、手動編集、外部CLIの変更を含みます。復元はファイル単位です。
- **下書き**：会話ごとの文章と添付画像をブラウザのIndexedDBへ保存します。再読込・再ログイン後も戻り、送信成功後に削除します。保存できない場合は画面に表示します。別ブラウザへの同期や全入力フォームの自動保存ではありません。
- **子への追加指示**：Codexは `turn/steer`、Claudeは `stream-json` のinterrupt後に同じセッションへ追加します。UIと親の `native_input` から利用できます。実行ID・ターンID・操作IDで古い送信と重複を拒否し、到達不明時は自動再送しません。
- **MCP導入**：AI未接続でもnpmパッケージ名から導入できます。タグを正確な版へ解決し、専用ディレクトリへ保存、接続、ツール取得まで行います。導入工程・失敗理由は実行ログから確認できます。既存接続は上書きしません。
- **MCPフォーム・認証**：表示名付き選択、複数選択、初期値、数値・文字数・選択数の制約に対応。非秘密の人間入力カードには安全に評価できる正規表現も利用できます。OAuthは動的登録に加え事前登録クライアントも利用可能です。資格情報の保存後に接続を再開します。
- **保存期間**：会話や実行の期限削除時に、対応する要約と追加指示の記録も削除します。

## 確認したこと

- `bun run check`：65テスト、型検査、Reactビルド、認証付き配信、別ディレクトリから配布bundleを起動。
- LANのHTTPで、MCPの複数選択と既定値、再読込後の下書き復元、送信して画面を切り替えた後の保存データ削除、ファイル編集・差分・復元を確認。
- 実ChromeのWebUI：ファイル編集→差分→復元、文章・画像の下書き→再読込→再ログイン→復元、npm導入、端末操作、Codex認証fixture、実VNC、390px幅。
- `scripts/check-mcp-install.ts`：公開npmの `chrome-devtools-mcp@1.9.0` を新しい導入経路でインストールし、29ツールを取得。検証専用Chromeの `list_pages` が完了。
- CLI fixture：Codexの実行中steer、Claudeのinterruptと追加指示、同じ操作IDの再送抑制、古いターンへの送信拒否、全停止。
- stdio MCPとHTTP OAuth fixture：表示名・複数選択の値と制約、既定値、資格情報を接続版へ結び付ける処理、従来のdiscovery・PKCE・callback再利用拒否。

公開npmの0.1.8について、tarballのSHA-512一致、公開registryからの再インストール、CLI起動とHome初期化を確認しました。稼働中のローカル版も0.1.8へ更新し、設定revision 6、既存の2会話、Codexのサブスク認証、共有デスクトップを引き継いで起動しています。LANの実画面で新しいファイル差分画面を確認しました。更新前の設定・会話DB・Atom DBは別ファイルへバックアップし、SQLiteの整合性を確認しています。

## 実AIの再検証結果

親Codexとnative Codexは、どちらも実アカウントの利用枠上限を返しました。新しいClaude通信方式は初期化できましたが、実推論は `OAuth session expired and could not be refreshed` で終了しました。別のOpenAI互換APIの実接続先・モデル・キーは提供されていません。**0.1.8の実AIによる一連の作業完了は未確認です。** 過去版の完走記録やfixtureを、この版の実推論成功としては扱いません。

再確認するコマンド：

```sh
bun scripts/check-provider.ts --codex
bun scripts/check-native.ts codex
claude auth login
bun scripts/check-native.ts claude
# OpenAI互換APIを設定した後
bun scripts/check-provider.ts
```

ファイル復元の保存対象は、1ファイル2MiB以下・合計32MiB・5,000ファイルまでのUTF-8テキストです。Git管理下では無視設定を使い、バイナリ・シンボリックリンク・依存物・ビルド出力を除外します。保存対象外は画面に表示します。過去の全編集を時系列で戻す機能ではありません。

MCPの標準外の入れ子フォーム、OAuth以外のサービス固有ログイン、スキャンPDFのOCR、別OSの実機試験は今回の対応範囲に含めません。

## 一次資料

- [Codex App Server: turn/steer](https://developers.openai.com/codex/app-server/)
- [Claude streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)、[公式SDKの制御プロトコル](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)
- [MCP elicitation仕様](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
