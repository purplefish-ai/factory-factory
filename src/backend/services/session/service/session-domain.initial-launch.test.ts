import { expect, it } from 'vitest';
import { SessionDomainService } from './session-domain.service';

it('keeps initial launch starting through READY, configuration, and dispatch preparation', () => {
  const domain = new SessionDomainService();
  const release = domain.beginInitialLaunch('s1');
  expect(domain.getRuntimeSnapshot('s1').phase).toBe('starting');
  domain.setRuntimeSnapshot('s1', {
    phase: 'idle',
    processState: 'alive',
    activity: 'IDLE',
    updatedAt: 'now',
  });
  expect(domain.getRuntimeSnapshot('s1').phase).toBe('starting');
  domain.markRunning('s1');
  expect(domain.getRuntimeSnapshot('s1').phase).toBe('running');
  domain.markIdle('s1', 'alive');
  release();
  expect(domain.getRuntimeSnapshot('s1').phase).toBe('idle');
});

it('releases launches with no prompt and publishes the resulting idle transition', () => {
  const domain = new SessionDomainService();
  const phases: string[] = [];
  domain.on('runtime_changed', () => phases.push(domain.getRuntimeSnapshot('s1').phase));
  const release = domain.beginInitialLaunch('s1');
  domain.markIdle('s1', 'alive');
  release();
  release();
  expect(phases).toEqual(['starting', 'starting', 'idle']);
});

it.each(['error', 'stopping'] as const)(
  'does not hide %s or let an old launch release a new one',
  (phase) => {
    const domain = new SessionDomainService();
    const release = domain.beginInitialLaunch('s1');
    domain.setRuntimeSnapshot('s1', {
      phase,
      processState: 'alive',
      activity: 'IDLE',
      updatedAt: 'now',
    });
    expect(domain.getRuntimeSnapshot('s1').phase).toBe(phase);
    domain.markIdle('s1', 'stopped');
    const releaseNew = domain.beginInitialLaunch('s1');
    release();
    expect(domain.getRuntimeSnapshot('s1').phase).toBe('starting');
    releaseNew();
    expect(domain.getRuntimeSnapshot('s1').phase).toBe('idle');
  }
);

it('does not restore a projected starting phase after overlapping launch reservations', () => {
  const domain = new SessionDomainService();
  const first = domain.beginInitialLaunch('s1');
  const second = domain.beginInitialLaunch('s1');
  first();
  second();
  expect(domain.getRuntimeSnapshot('s1').phase).toBe('idle');
});

it('does not publish a stale launch after its session store is replaced', () => {
  const domain = new SessionDomainService();
  const release = domain.beginInitialLaunch('s1');
  domain.clearSession('s1');
  domain.markRunning('s1');
  const phases: string[] = [];
  domain.on('runtime_changed', () => phases.push('changed'));
  release();
  expect(phases).toEqual([]);
  expect(domain.getRuntimeSnapshot('s1').phase).toBe('running');
});

it.each(['running', 'error', 'stopping'] as const)(
  'does not replace an existing %s runtime with launch intent',
  (phase) => {
    const domain = new SessionDomainService();
    domain.setRuntimeSnapshot('s1', {
      phase,
      processState: 'alive',
      activity: phase === 'running' ? 'WORKING' : 'IDLE',
      updatedAt: 'now',
    });
    const release = domain.beginInitialLaunch('s1');
    expect(domain.getRuntimeSnapshot('s1').phase).toBe(phase);
    release();
    expect(domain.getRuntimeSnapshot('s1').phase).toBe(phase);
  }
);
