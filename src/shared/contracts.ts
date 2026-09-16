import { z } from 'zod';

export const fieldSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
    label: z.string().min(1).max(200),
    type: z.enum(['text', 'choice', 'multiChoice', 'secret', 'number', 'integer', 'boolean']),
    required: z.boolean().default(true),
    description: z.string().max(2000).optional(),
    default: z
      .union([z.string().max(32000), z.number(), z.boolean(), z.array(z.string().max(200)).max(20)])
      .optional(),
    pattern: z.string().max(1000).optional(),
    minItems: z.number().int().nonnegative().max(20).optional(),
    maxItems: z.number().int().nonnegative().max(20).optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().max(32000).optional(),
    format: z.enum(['email', 'uri', 'date', 'date-time']).optional(),
    options: z
      .array(z.object({ label: z.string().max(200), value: z.string().max(200) }))
      .max(20)
      .optional(),
  })
  .strict();
export const humanSpecSchema = z
  .object({
    kind: z.enum(['input', 'secret', 'action']),
    title: z.string().min(1).max(200),
    message: z.string().max(8000).default(''),
    targetId: z.string().max(100).optional(),
    fields: z.array(fieldSchema).max(10).default([]),
    resumeNote: z.string().max(2000).optional(),
    dedupeKey: z.string().min(1).max(200).optional(),
    expiresAt: z.number().int().positive().optional(),
    externalCompletion: z.boolean().optional(),
    url: z
      .url()
      .refine((value) => {
        const u = new URL(value);
        return (
          !u.username &&
          !u.password &&
          (u.protocol === 'https:' ||
            (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
        );
      }, 'Use HTTPS or a loopback URL.')
      .optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (
      s.kind === 'secret' &&
      (!s.targetId || s.fields.length !== 1 || s.fields[0].type !== 'secret')
    )
      fail('Secret requests require a registered target and exactly one secret field.');
    if (s.kind !== 'secret' && s.fields.some((f) => f.type === 'secret'))
      fail('Secret fields require the dedicated secret route.');
    if (s.kind === 'action' && s.fields.length) fail('Action requests cannot collect text.');
    if (new Set(s.fields.map((f) => f.name)).size !== s.fields.length)
      fail('Field names must be unique.');
    if (s.fields.some((f) => ['choice', 'multiChoice'].includes(f.type) && !f.options?.length))
      fail('Choices need options.');
  });
export type HumanSpec = z.infer<typeof humanSpecSchema>;
export type WaitCondition = {
  type: 'user.message' | 'human.resolved' | 'run.completed' | 'schedule.fired';
  requestId?: string;
  runId?: string;
};
export type ToolCall = { id: string; name: string; arguments: string };
export type ImagePart = {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'high' | 'low' };
};
export type MessageBody = {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  images?: ImagePart[];
  // Opaque provider continuation items; excluded from Atom's textual context.
  codex?: { model: string; output: unknown[] };
};
export const scheduleSchema = z
  .object({
    title: z.string().min(1).max(200),
    prompt: z.string().min(1).max(16000),
    action: z.enum(['prompt', 'shell']).default('prompt'),
    nextAt: z.number().int().positive(),
    intervalMs: z.number().int().min(1000).nullable().default(null),
    enabled: z.boolean().default(true),
    timeZone: z.string().default('UTC'),
    trigger: z
      .object({
        event: z.enum(['run.completed', 'human.resolved', 'user.message']),
        runId: z.string().optional(),
        requestId: z.string().optional(),
        repeat: z.boolean().default(false),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((s) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: s.timeZone });
      return true;
    } catch {
      return false;
    }
  }, 'Invalid time zone');
export const providerSchema = z
  .object({
    kind: z.enum(['openai', 'codex']).optional(),
    baseUrl: z.url().refine((url) => {
      const u = new URL(url);
      return (
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        (u.protocol === 'https:' ||
          (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
      );
    }, 'Use HTTPS, or HTTP on loopback, without credentials or query parameters.'),
    model: z.string().trim().max(200).default(''),
    supportsImages: z.boolean().default(true),
    keyRequired: z.boolean().default(true),
  })
  .strict();
export const mcpSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/),
    transport: z.enum(['stdio', 'http']),
    command: z.string().min(1).optional(),
    credentialEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,99}$/)
      .refine(
        (name) =>
          ![
            'HOME',
            'PATH',
            'SHELL',
            'NODE_OPTIONS',
            'BUN_OPTIONS',
            'LD_PRELOAD',
            'LD_LIBRARY_PATH',
          ].includes(name),
        'Reserved process environment name.',
      )
      .optional(),
    args: z.array(z.string()).default([]),
    url: z.url().optional(),
    targetId: z.string().max(100).optional(),
    enabled: z.boolean().default(true),
    oauth: z.boolean().optional(),
    oauthClientId: z.string().trim().min(1).max(1000).optional(),
    oauthClientSecret: z.boolean().optional(),
    oauthScope: z.string().trim().max(2000).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.transport === 'stdio' && !v.command)
      c.addIssue({ code: 'custom', message: 'Command is required.' });
    if (v.transport === 'http') {
      try {
        const u = new URL(v.url!);
        if (u.username || u.password || u.search || !['https:', 'http:'].includes(u.protocol))
          throw new Error();
      } catch {
        c.addIssue({
          code: 'custom',
          message: 'Provide an HTTP URL without credentials or query parameters.',
        });
      }
    }
  });
export const desktopSchema = z
  .object({
    name: z.string().min(1).max(100),
    display: z
      .string()
      .regex(/^:\d+(\.\d+)?$/)
      .default(':0'),
    mode: z.enum(['x11', 'vnc']).optional(),
    vncHost: z.enum(['127.0.0.1', 'localhost']).default('127.0.0.1'),
    vncPort: z.number().int().min(1).max(65535),
  })
  .strict();
export const searchSchema = z
  .object({
    engine: z.enum(['searxng', 'brave']),
    baseUrl: providerSchema.shape.baseUrl,
  })
  .strict();
export const retentionSchema = z
  .object({
    imageDays: z.number().int().min(1).nullable().default(30),
    runDays: z.number().int().min(1).nullable().default(30),
    conversationDays: z.number().int().min(1).nullable().default(90),
  })
  .strict();
