import { z } from 'zod';

export const FactoryConfigSchema = z.object({
  scripts: z.object({
    setup: z.string().optional(),
    run: z.string().optional(),
    postRun: z.string().optional(),
    cleanup: z.string().optional(),
  }),
});

export type FactoryConfig = z.infer<typeof FactoryConfigSchema>;
