import { z } from 'zod';
import {
  desktopDefinitionSchema,
  providerSchema,
  retentionSchema,
  searchSchema,
} from '../shared/contracts';
import type { Runtime } from './runtime';
import { savedProviderCredential } from './provider-models';

type Services = Pick<Runtime, 'config' | 'store' | 'vault' | 'desktop' | 'codex'>;
export const settingsUpdateSchema = z
  .object({
    revision: z.number().int(),
    change: z.discriminatedUnion('section', [
      z.object({ section: z.literal('provider'), value: providerSchema }).strict(),
      z.object({ section: z.literal('search'), value: searchSchema }).strict(),
      z.object({ section: z.literal('retention'), value: retentionSchema }).strict(),
      z.object({ section: z.literal('desktop'), value: desktopDefinitionSchema }).strict(),
    ]),
  })
  .strict();

export function updateProvider(
  r: Services,
  input: { revision: number; provider: z.infer<typeof providerSchema>; credential?: string },
  conversationId?: string,
) {
  const { revision, provider, credential } = input;
  if (provider.kind === 'codex' && credential)
    throw new Error('Codexは端末の認証情報を使用します。');
  if (/^sk-[\w-]{20,}$/.test(provider.model))
    throw new Error('APIキーはモデル名ではなく、APIキーの専用欄に入力してください。');
  const previous = r.config.read().provider;
  if (
    (previous?.model !== provider.model ||
      previous?.baseUrl !== provider.baseUrl ||
      previous?.kind !== provider.kind ||
      previous?.reasoningEffort !== provider.reasoningEffort) &&
    r.store.listConversations().some((c) => c.state === 'running' && c.id !== conversationId)
  )
    throw new Error('実行が完了してからモデルや接続先を変更してください。');
  const key =
    provider.kind === 'codex' || !provider.keyRequired
      ? undefined
      : credential || savedProviderCredential(r.config, r.vault, provider.baseUrl);
  const config = r.config.update(revision, (v) => {
    v.provider = {
      ...provider,
      ...(provider.kind === 'codex'
        ? {
            baseUrl: 'https://chatgpt.com/backend-api/codex',
            keyRequired: false,
            supportsImages: true,
          }
        : {}),
      revision: (v.provider?.revision || 0) + 1,
    };
  });
  if (key)
    r.config.lock(() => {
      if (r.config.read().revision !== config.revision)
        throw new Error('接続設定が変更されました。再読み込みしてください。');
      r.vault.put('provider:main', config.provider!.revision, crypto.randomUUID(), key);
    });
  r.store.notify();
  if (provider.kind === 'codex') void r.codex.refresh().catch(() => {});
  return { ...r.config.public(), credentialReady: !config.provider!.keyRequired || !!key };
}

export async function updateSettings(r: Services, raw: unknown, conversationId?: string) {
  const parsed = settingsUpdateSchema.parse(raw);
  const input = { revision: parsed.revision, ...parsed.change };
  if (input.section === 'provider')
    return updateProvider(r, { revision: input.revision, provider: input.value }, conversationId);
  if (input.section === 'desktop') {
    await r.desktop.update(input.revision, input.value);
    return r.config.public();
  }
  r.config.update(input.revision, (config) => {
    if (input.section === 'retention') config.retention = input.value;
    else if (input.section === 'search')
      config.search = { ...input.value, revision: (config.search?.revision || 0) + 1 };
  });

  r.store.notify();
  return r.config.public();
}
