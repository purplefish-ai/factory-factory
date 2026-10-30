import { z } from 'zod';
import { CodexAccountKind } from './core/enums';
import { providerPlanUsageSchema } from './provider-usage';
export const NATIVE_DEFAULT_CODEX_ACCOUNT_ID = 'codex-native-default';
export const codexAccountSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.nativeEnum(CodexAccountKind),
  enabled: z.boolean(),
  authenticated: z.boolean(),
  email: z.string().nullable(),
  planType: z.string().nullable(),
  usage: providerPlanUsageSchema,
});
export const codexLoginStateSchema = z.object({
  accountId: z.string(),
  status: z.enum(['pending', 'completed', 'failed', 'cancelled']),
  authorizationUrl: z.string().url().optional(),
  message: z.string().optional(),
});
export type CodexAccountSummary = z.infer<typeof codexAccountSummarySchema>;
export type CodexLoginState = z.infer<typeof codexLoginStateSchema>;
