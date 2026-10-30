import { z } from 'zod';
import { CodexAccountKind } from './core/enums';

/** Profile metadata only. Native credential files are never part of an export. */
export const codexAccountMetadataSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  label: z.string().trim().min(1).max(100),
  kind: z.nativeEnum(CodexAccountKind),
  enabled: z.boolean(),
  identityKey: z
    .string()
    .regex(/^(?:[a-f0-9]{64}|native-email:[a-f0-9]{64}(?::imported:[A-Za-z0-9_-]+)?)$/)
    .nullable(),
});
export type CodexAccountMetadata = z.infer<typeof codexAccountMetadataSchema>;
