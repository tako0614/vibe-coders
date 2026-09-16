import { Config, Vault } from './config';
import {
  reasoningChoices,
  modelDiscoverySchema,
  providerUrl,
  providerId,
  type ModelChoice,
} from '../shared/models';

import { savedProviderCredential } from './provider-connections';

export async function providerModels(config: Config, vault: Vault, input: unknown) {
  const { baseUrl, credential, useSavedCredential } = modelDiscoverySchema.parse(input);
  const current = config.read();
  const id = providerId({ kind: 'openai', baseUrl });
  const saved =
    current.provider && providerId(current.provider) === id
      ? current.provider
      : current.providers.find((provider) => providerId(provider) === id);
  const key =
    credential ||
    (useSavedCredential && saved?.keyRequired !== false
      ? savedProviderCredential(config, vault, baseUrl)
      : undefined);
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
      const efforts =
        item.reasoning?.supported_efforts === null
          ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
          : item.reasoning?.supported_efforts;
      models.set(item.id, {
        id: item.id,
        name,
        ...reasoningChoices(
          Array.isArray(efforts)
            ? efforts.filter((v: unknown) => !(v === 'none' && item.reasoning?.mandatory))
            : undefined,
          item.reasoning?.default_effort,
        ),
      });
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
