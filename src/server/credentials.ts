import { Config, Vault } from './config';

export async function verifyProvider(config: Config, vault: Vault, revision: number) {
  const p = config.read().provider;
  if (!p || p.revision !== revision)
    return { status: 'stale', message: '接続設定が変更されています。' };
  if (p.kind === 'codex')
    return { status: 'unverified', message: 'CodexログインからChatGPTの認証を確認してください。' };
  const key = vault.get('provider:main', revision);
  if (p.keyRequired && !key) return { status: 'invalid', message: 'APIキーを入力してください。' };
  try {
    const response = await fetch(`${p.baseUrl.replace(/\/$/, '')}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403)
      return {
        status: 'invalid',
        message: '認証が拒否されました。キーとアクセス権を確認して再入力してください。',
      };
    if (response.status === 429 || response.status >= 500)
      return {
        status: 'temporary_error',
        message: '一時的な制限またはサーバー障害です。キーを変更せず再確認できます。',
      };
    if (!response.ok)
      return {
        status: 'unverified',
        message: '接続先の認証確認APIを利用できません。モデル実行で確認してください。',
      };
    return {
      status: 'verified',
      message: '接続先の認証を確認しました。モデルの実行権限と推論品質は別途確認します。',
    };
  } catch {
    return {
      status: 'temporary_error',
      message: '通信できませんでした。キーは保持しています。再確認できます。',
    };
  }
}
