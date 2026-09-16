import { z } from 'zod';
import { providerSchema, reasoningEffortSchema } from './contracts';

export const providerCredentialSchema = z
  .string()
  .trim()
  .min(1)
  .max(16000)
  .refine((value) => !/[\r\n]/.test(value), 'APIキーに改行は使用できません。');
export const modelDiscoverySchema = z
  .object({
    baseUrl: providerSchema.shape.baseUrl,
    credential: providerCredentialSchema.optional(),
    useSavedCredential: z.boolean().default(true),
  })
  .strict();
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type ModelChoice = {
  id: string;
  name: string;
  isDefault?: boolean;
  reasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
};
export function reasoningChoices(levels: unknown, defaultLevel?: unknown) {
  if (!Array.isArray(levels)) return {};
  const reasoningEfforts = [
    ...new Set(
      levels.flatMap((v) => {
        const parsed = reasoningEffortSchema.safeParse(v);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
  ];
  const parsed = reasoningEffortSchema.safeParse(defaultLevel);
  return {
    reasoningEfforts,
    ...(parsed.success && reasoningEfforts.includes(parsed.data)
      ? { defaultReasoningEffort: parsed.data }
      : {}),
  };
}

export const providerUrl = (url: string) => new URL(url).href.replace(/\/+$/, '');

export type Provider = z.infer<typeof providerSchema>;
export const providerId = (provider: Pick<Provider, 'kind' | 'baseUrl'>) =>
  provider.kind === 'codex' ? 'codex' : `api:${providerUrl(provider.baseUrl)}`;
export const providerPresets: Provider[] = [
  providerSchema.parse({
    kind: 'codex',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    keyRequired: false,
  }),
  providerSchema.parse({ kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1' }),
  providerSchema.parse({ kind: 'openai', baseUrl: 'https://api.openai.com/v1' }),
];
export function providerName(provider: Provider) {
  const id = providerId(provider);
  if (id === 'codex') return 'Codex';
  if (id === 'api:https://openrouter.ai/api/v1') return 'OpenRouter';
  if (id === 'api:https://api.openai.com/v1') return 'OpenAI';
  const url = new URL(provider.baseUrl);
  return url.host + (url.pathname === '/v1' || url.pathname === '/' ? '' : url.pathname);
}
