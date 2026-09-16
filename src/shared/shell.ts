import { z } from 'zod';
import { desktopIdSchema } from './contracts';

export const WORKSPACE_RUN_LIMIT = 2000;

export const shellSchema = z
  .object({
    command: z.string().min(1).max(32000).optional(),
    mode: z.enum(['pipe', 'pty']).default('pipe'),
    cwd: z.string().max(4000).optional(),
    title: z.string().trim().min(1).max(120).optional(),
    deckId: z.string().max(100).optional(),
    desktopId: desktopIdSchema.optional(),
  })
  .strict()
  .refine((s) => s.mode === 'pty' || !!s.command, 'A pipe run needs a command.');

export const workspaceSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    decks: z
      .array(
        z
          .object({ id: z.string().min(1).max(100), name: z.string().trim().min(1).max(80) })
          .strict(),
      )
      .min(1)
      .max(30),
    placements: z.record(z.string(), z.string()),
    hidden: z.array(z.string()).max(WORKSPACE_RUN_LIMIT),
  })
  .strict()
  .superRefine((s, ctx) => {
    const ids = new Set(s.decks.map((d) => d.id));
    if (ids.size !== s.decks.length || Object.values(s.placements).some((id) => !ids.has(id)))
      ctx.addIssue({ code: 'custom', message: 'Invalid deck assignment.' });
    if (
      Object.keys(s.placements).length > WORKSPACE_RUN_LIMIT ||
      new Set(s.hidden).size !== s.hidden.length
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid workspace size.' });
  });
export type ShellSpec = z.infer<typeof shellSchema>;
export type ShellWorkspace = z.infer<typeof workspaceSchema>;
export const emptyWorkspace = (): ShellWorkspace => ({
  revision: 0,
  decks: [{ id: 'main', name: 'メイン' }],
  placements: {},
  hidden: [],
});
