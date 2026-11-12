import { z } from 'zod';
import {
  slackClearAppTokenInputSchema,
  slackConnectInputSchema,
  slackConnectionSummarySchema,
  slackConnectionTestSchema,
  slackSetAppTokenInputSchema,
} from '@/shared/slack-connection';
import { router, trustedLocalProcedure } from './trpc';

const connectionInput = z.strictObject({ id: z.string().min(1) });
export const slackRouter = router({
  list: trustedLocalProcedure
    .output(z.array(slackConnectionSummarySchema))
    .query(({ ctx }) => ctx.appContext.services.slackConnectionService.list()),
  connect: trustedLocalProcedure
    .input(slackConnectInputSchema)
    .output(slackConnectionSummarySchema)
    .mutation(({ ctx, input }) => ctx.appContext.services.slackConnectionService.connect(input)),
  test: trustedLocalProcedure
    .input(connectionInput)
    .output(slackConnectionTestSchema)
    .mutation(({ ctx, input }) => ctx.appContext.services.slackConnectionService.test(input.id)),
  disconnect: trustedLocalProcedure
    .input(connectionInput)
    .mutation(({ ctx, input }) =>
      ctx.appContext.services.slackConnectionService.disconnect(input.id)
    ),
  setAppToken: trustedLocalProcedure
    .input(slackSetAppTokenInputSchema)
    .output(slackConnectionSummarySchema)
    .mutation(({ ctx, input }) =>
      ctx.appContext.services.slackConnectionService.setAppToken(input)
    ),
  clearAppToken: trustedLocalProcedure
    .input(slackClearAppTokenInputSchema)
    .output(slackConnectionSummarySchema)
    .mutation(({ ctx, input }) =>
      ctx.appContext.services.slackConnectionService.clearAppToken(input.connectionId)
    ),
});
