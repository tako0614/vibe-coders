import { z } from 'zod';
import { providerSchema } from './contracts';

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
export type ModelChoice = { id: string; name: string; isDefault?: boolean };
export const providerUrl = (url: string) => new URL(url).href.replace(/\/+$/, '');
