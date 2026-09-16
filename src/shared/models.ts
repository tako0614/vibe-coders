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
