import { Config, Vault } from './config';
import { modelDiscoverySchema, providerUrl, type ModelChoice } from '../shared/models';

export function savedProviderCredential(config: Config, vault: Vault, baseUrl: string) {
  const current = config.read().provider;
  return current &&
    current.kind !== 'codex' &&
    providerUrl(current.baseUrl) === providerUrl(baseUrl)
    ? vault.get('provider:main', current.revision)
    : undefined;
}

export async function providerModels(config: Config, vault: Vault, input: unknown) {
  const { baseUrl, credential, useSavedCredential } = modelDiscoverySchema.parse(input);
  const key =
    credential ||
    (useSavedCredential ? savedProviderCredential(config, vault, baseUrl) : undefined);
  let response: Response;
  try {
    response = await fetch(`${providerUrl(baseUrl)}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error(
      'モデル一覧に接続できません。URLを確認するか、モデル名を直接入力してください。',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      response.status === 401 || response.status === 403
        ? 'モデル一覧の取得には有効なAPIキーが必要です。'
        : 'モデル一覧を取得できません。モデル名を直接入力することもできます。',
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('モデル一覧が空です。');
  let body = '',
    bytes = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4 * 1024 * 1024) throw new Error();
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    const data = JSON.parse(body).data;
    if (!Array.isArray(data)) throw new Error();
    const models = new Map<string, ModelChoice>();
    for (const item of data) {
      if (typeof item?.id !== 'string' || !item.id.trim() || item.id.length > 200) continue;
      const name = typeof item.name === 'string' ? item.name.slice(0, 300) : item.id;
      if (/[\r\n\x00-\x1f]/.test(item.id) || (key && (item.id.includes(key) || name.includes(key))))
        continue;
      models.set(item.id, { id: item.id, name });
      if (models.size >= 2000) break;
    }
    return [...models.values()].sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    throw new Error('モデル一覧の形式を読み取れません。モデル名を直接入力してください。');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
