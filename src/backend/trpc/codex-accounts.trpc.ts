import { z } from 'zod';
import { codexAccountSummarySchema, codexLoginStateSchema } from '@/shared/codex-accounts';
import { providerPlanUsageSchema } from '@/shared/provider-usage';
import { router, trustedLocalProcedure } from './trpc';

const accountInput = z.object({ id: z.string().trim().min(1) });
const label = z.string().trim().min(1).max(100);

/** Native credentials and filesystem paths never cross this trusted-local API. */
export const codexAccountsRouter = router({
  list: trustedLocalProcedure
    .output(z.array(codexAccountSummarySchema))
    .query(({ ctx }) => ctx.appContext.services.codexAccountService.getAccounts()),
  create: trustedLocalProcedure
    .input(z.object({ label }))
    .output(codexAccountSummarySchema)
    .mutation(({ ctx, input }) =>
      ctx.appContext.services.codexAccountService.createAccount(input.label)
    ),
  update: trustedLocalProcedure
    .input(
      accountInput
        .extend({ label: label.optional(), enabled: z.boolean().optional() })
        .refine(
          (input) => input.label !== undefined || input.enabled !== undefined,
          'Choose an account setting to update'
        )
    )
    .output(codexAccountSummarySchema)
    .mutation(({ ctx, input: { id, ...updates } }) =>
      ctx.appContext.services.codexAccountService.updateAccount(id, updates)
    ),
  startLogin: trustedLocalProcedure
    .input(accountInput)
    .output(codexLoginStateSchema)
    .mutation(({ ctx, input }) => ctx.appContext.services.codexAccountService.startLogin(input.id)),
  loginStatus: trustedLocalProcedure
    .input(accountInput)
    .output(codexLoginStateSchema)
    .query(({ ctx, input }) =>
      ctx.appContext.services.codexAccountService.getLoginStatus(input.id)
    ),
  cancelLogin: trustedLocalProcedure
    .input(accountInput)
    .mutation(({ ctx, input }) =>
      ctx.appContext.services.codexAccountService.cancelLogin(input.id)
    ),
  getUsage: trustedLocalProcedure
    .input(accountInput)
    .output(providerPlanUsageSchema)
    .query(({ ctx, input }) => ctx.appContext.services.codexAccountService.getUsage(input.id)),
});
