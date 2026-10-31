import { expect, it, vi } from 'vitest';
import { slackRouter } from './slack.trpc';

const services = {
  slackConnectionService: { list: vi.fn(), connect: vi.fn(), test: vi.fn(), disconnect: vi.fn() },
  configService: { getCorsConfig: () => ({ allowedOrigins: ['http://localhost:3000'] }) },
};

it('blocks remote clients from reading or managing Slack credentials', async () => {
  const caller = slackRouter.createCaller({
    appContext: { services },
    requestTrust: { isLocal: false, remoteAddress: '203.0.113.1' },
  } as never);
  for (const operation of [
    () => caller.list(),
    () => caller.connect({ botToken: 'xoxb-secret' }),
    () => caller.test({ id: 'slack-1' }),
    () => caller.disconnect({ id: 'slack-1' }),
  ]) {
    await expect(operation()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  }
});

it('rejects unexpected credential fields at the trusted API boundary', async () => {
  const caller = slackRouter.createCaller({ appContext: { services } } as never);
  await expect(
    caller.connect({ botToken: 'xoxb-secret', signingSecret: 'unused' } as never)
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});
