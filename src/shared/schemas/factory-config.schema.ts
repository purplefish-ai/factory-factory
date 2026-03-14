import { z } from 'zod';

export const QuickActionSurfaceSchema = z.enum(['sessionBar', 'chatBar']);
export type QuickActionSurface = z.infer<typeof QuickActionSurfaceSchema>;

export const QuickActionModeSchema = z.enum(['newSession', 'sendPrompt']);
export type QuickActionMode = z.infer<typeof QuickActionModeSchema>;

function isSurfaceModeCompatible(surface: QuickActionSurface, mode: QuickActionMode): boolean {
  return (
    (surface === 'sessionBar' && mode === 'newSession') ||
    (surface === 'chatBar' && mode === 'sendPrompt')
  );
}

export const FactoryQuickActionEntrySchema = z
  .object({
    id: z.string().optional(),
    path: z.string().optional(),
    surface: QuickActionSurfaceSchema.optional(),
    mode: QuickActionModeSchema.optional(),
    pinned: z.boolean().optional(),
    enabled: z.boolean().optional(),
    icon: z.string().optional(),
  })
  .refine((value) => Boolean(value.id || value.path), {
    message: 'Each quick action must specify id or path',
  })
  .refine(
    (value) => !(value.surface && value.mode) || isSurfaceModeCompatible(value.surface, value.mode),
    {
      message: 'Quick action mode must match surface (sessionBar/newSession or chatBar/sendPrompt)',
    }
  );

export const FactoryQuickActionsSchema = z.object({
  includeDefaults: z
    .union([
      z.boolean(),
      z.object({
        sessionBar: z.boolean().optional(),
        chatBar: z.boolean().optional(),
      }),
    ])
    .optional(),
  actions: z.array(FactoryQuickActionEntrySchema).optional(),
});

export const FactoryScriptsSchema = z.object({
  setup: z.string().optional(),
  run: z.string().optional(),
  postRun: z.string().optional(),
  cleanup: z.string().optional(),
});

export const FactoryConfigInputSchema = z.object({
  scripts: FactoryScriptsSchema.optional(),
  quickActions: FactoryQuickActionsSchema.optional(),
});

export const FactoryConfigSchema = FactoryConfigInputSchema.extend({
  scripts: FactoryScriptsSchema.default({}),
});

export type FactoryConfig = z.infer<typeof FactoryConfigSchema>;
export type FactoryConfigInput = z.infer<typeof FactoryConfigInputSchema>;
