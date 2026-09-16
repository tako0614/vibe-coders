# 0.3.0: 複数デスクトップ、effort、Atomの確認

2026-09-16。

## 変更

チャット横の作業画面を常設し、実際のデスクトップをタブで選択する構成に変更。追加画面は独立したXvfb/VNC、Xauthority、Chromeプロファイル、操作権、観測IDを持つ。同時起動時のDISPLAY確保は同一バックエンド内で直列化する。画面Aの手動操作中も、画面BのAI操作・MCP・シェルは継続できる。

各デスクトップから作成するシェルは、その画面のDISPLAY/XAUTHORITYを使う。画面の操作権変更は関連シェルの古い入力epochを失効させ、手動操作中の出力はAIへ返さない。操作中に終了したシェルの一時出力も返却時に除去する。画面ごとの制御は管理下のツールへの制限であり、同じOSユーザーの任意プロセスを隔離するものではない。

MCPは手動フォームで対象画面を選択できる。stdioプロセスへ対象の環境変数を渡し、その画面の操作権が変わると関連する接続だけを切る。別ホストのVNCに接続しても、シェルの実行先はインストール先ホスト。

旧単数デスクトップの設定・VNC資格情報・手動操作権・MCPターゲットは `default` へ移行する。会話DBはrunsにdesktopId列を追加する。既存のシェルはホストの端末として残す。稼働中シェルがある画面は削除・接続先変更を拒否し、最後の画面も削除できない。

チャット内のeffort選択はCodexの実カタログとOpenRouterのモデル情報から作る。保存値はCodex Responsesの `reasoning.effort`、OpenRouterの `reasoning.effort`、通常のChat Completionsの `reasoning_effort` に渡す。自動設定は省略、モデル変更時はクリア、既存APIキーは同じ接続先で維持。対応情報のないモデルでは選択肢を推測しない。

仕様参照: [OpenAI Reasoning](https://developers.openai.com/api/docs/guides/reasoning)、[OpenRouterのモデル別effort](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#discovering-per-model-reasoning-options)。Codex側はインストール済みCLIの `codex debug models` を使用。

## Atomの実態

使用しているライブラリは `atom-memory@0.7.0`。AIのmemory_write → SQLite保存 → サーバー終了・再起動 → 別会話のモデル入力へ取得、という回帰テストを追加した。

さらに `VIBE_CODER_TEST_REAL_CODEX=1 bun scripts/check-memory.ts` で実サブスクの `gpt-6-astra` / low を使用。AIがmemory_writeを実行し、再起動後の新規会話で、元の会話を渡さずにランダムな公開コード名を正しく回答した。記憶・会話・設定は使い捨てHomeに隔離し、常用Homeには書き込んでいない。これは明示的な保存依頼からの再利用検証で、会話から自律的に何を記憶すべきかの品質評価ではない。

調査時の常用Homeは `am_slots=0` / `am_revisions=0`、会話内のmemory_write実行も0件だった。ライブラリの保存・取得経路は動くが、記憶が蓄積していたわけではない。全会話を自動で記憶へ変換する処理は追加していない。

## 検証

- `bun run check`: 型検査、90テスト、React/backendビルド、配布bundleの別ディレクトリ起動・migration・認証・画面配信が成功。
- 独立した2画面の起動、シェルのDISPLAY/Xauthority、MCPプロセスの接続先と片側失効、別画面の観測ID拒否、チケットの別画面利用拒否、操作権変更後の出力非公開と古い入力拒否、単体削除後の他画面継続。
- 旧設定からの資格情報・手動操作権・MCP・会話履歴の移行。
- Codex/APIのeffort送信本文、モデル一覧の対応情報、保存済みキーの維持、自動設定時の省略。

- 実ChromeのLANブラウザ検証: 2画面の追加・切り替え・片側handoff・対象画面に紐づく端末・削除・再読み込み後の選択復帰、effort変更と再読み込み後の保存、既存の認証・MCPフォーム・入力・ファイル編集・ドラフト・モバイル表示が成功。画面幅390pxで横方向のはみ出しなし。

## 常用環境への反映

0.3.0のtarballをインストールし、`http://192.168.0.122:3100` のサービスを更新した。更新直前の10会話・91メッセージ、記憶DBの全行、モデル/認証/検索/保存設定をバックアップと照合して保持を確認。最初のデスクトップは `default` / `:90`、操作権は更新前と同じagent。Codexの保存済み認証はnative-fileとして利用でき、`gpt-6-astra` のlow/medium/high/xhigh/max/ultraをカタログから取得した。

設定・会話DB・記憶DB・暗号化vault・暗号鍵・Atom認可ファイルの6ファイルを更新前にバックアップした。npm公開済み版は0.1.8のままで、この反映は0.3.0のローカルtarballによる。
