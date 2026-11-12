import { expect, it, vi } from 'vitest';
import { slackRouter } from './slack.trpc';

const services = {
  slackConnectionService: {
    list: vi.fn(),
    connect: vi.fn(),
    test: vi.fn(),
    disconnect: vi.fn(),
    setAppToken: vi.fn(),
    clearAppToken: vi.fn(),
  },
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
    () => caller.setAppToken({ connectionId: 'slack-1', appToken: 'xapp-secret' }),
    () => caller.clearAppToken({ connectionId: 'slack-1' }),
  ]) {
    await expect(operation()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  }
  expect(services.slackConnectionService.setAppToken).not.toHaveBeenCalled();
});

it('rejects unexpected credential fields at the trusted API boundary', async () => {
  const caller = slackRouter.createCaller({ appContext: { services } } as never);
  await expect(
    caller.connect({ botToken: 'xoxb-secret', signingSecret: 'unused' } as never)
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  await expect(
    caller.setAppToken({
      connectionId: 'slack-1',
      appToken: 'xapp-secret',
      botToken: 'xoxb-secret',
    } as never)
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  await expect(
    caller.setAppToken({ connectionId: 'slack-1', appToken: 'xoxb-secret' })
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(services.slackConnectionService.setAppToken).not.toHaveBeenCalled();
});

it('routes app-token mutations to the connection service', async () => {
  const summary = {
    id: 'slack-1',
    name: 'Company',
    workspaceId: 'T-company',
    isEnabled: true,
    hasCredentials: true,
    hasAppToken: true,
    appId: 'A-app',
  };
  services.slackConnectionService.setAppToken.mockResolvedValue(summary);
  services.slackConnectionService.clearAppToken.mockResolvedValue({
    ...summary,
    hasAppToken: false,
    appId: null,
  });
  const caller = slackRouter.createCaller({ appContext: { services } } as never);
  expect(await caller.setAppToken({ connectionId: 'slack-1', appToken: 'xapp-1-secret' })).toEqual(
    summary
  );
  expect(services.slackConnectionService.setAppToken).toHaveBeenCalledWith({
    connectionId: 'slack-1',
    appToken: 'xapp-1-secret',
  });
  expect(await caller.clearAppToken({ connectionId: 'slack-1' })).toMatchObject({
    hasAppToken: false,
  });
  expect(services.slackConnectionService.clearAppToken).toHaveBeenCalledWith('slack-1');
});
