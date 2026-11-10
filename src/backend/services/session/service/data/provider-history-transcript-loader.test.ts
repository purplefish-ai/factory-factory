import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configService } from '@/backend/services/config.service';
import * as reader from '@/backend/services/session/service/data/session-history-jsonl-reader';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { providerHistoryTranscriptCache } from './provider-history-transcript-cache';
import {
  createProviderHistoryHydrator,
  type ProviderHistorySession,
} from './session-provider-history-hydrator';

type Provider = 'CLAUDE' | 'CODEX';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  providerHistoryTranscriptCache.clear();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function historyLine(provider: Provider, text: string, index: number): string {
  const timestamp = `2026-11-09T00:00:${String(index).padStart(2, '0')}Z`;
  return JSON.stringify(
    provider === 'CLAUDE'
      ? {
          type: 'user',
          uuid: `uuid-${text}`,
          sessionId: 'provider',
          timestamp,
          message: { role: 'user', content: text },
        }
      : { type: 'event_msg', timestamp, payload: { type: 'user_message', message: text } }
  );
}

/** Real provider files in a temporary root, read by the real loaders. */
function fixture(provider: Provider, texts: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'ff-history-cache-'));
  directories.push(directory);
  const sessionsDir = join(directory, 'sessions');
  let filePath: string;
  const lines = texts.map((text, index) => historyLine(provider, text, index + 1));
  if (provider === 'CLAUDE') {
    vi.spyOn(configService, 'getClaudeConfigDir').mockReturnValue(directory);
    const project = join(directory, 'projects', '-work');
    mkdirSync(project, { recursive: true });
    filePath = join(project, 'provider.jsonl');
  } else {
    const dateDirectory = join(sessionsDir, '2026', '11', '09');
    mkdirSync(dateDirectory, { recursive: true });
    filePath = join(dateDirectory, 'rollout-provider.jsonl');
    lines.unshift(
      JSON.stringify({ type: 'session_meta', payload: { id: 'provider', cwd: '/work' } })
    );
  }
  writeFileSync(filePath, `${lines.join('\n')}\n`);
  const session: ProviderHistorySession = {
    provider,
    providerSessionId: 'provider',
    providerMetadata: {},
    workspace: { worktreePath: '/work' },
    codexAccountContext: { accountId: 'fixture', homeDir: directory, sessionsDir, env: {} },
  };
  const original = reader.readNonEmptyJsonlLines;
  const onLine = vi.fn<(line: string) => void>();
  const read = vi.spyOn(reader, 'readNonEmptyJsonlLines').mockImplementation((input) =>
    original({
      ...input,
      onLine: (line, lineNumber) => {
        onLine(line);
        return input.onLine(line, lineNumber);
      },
    })
  );
  const append = (text: string, index: number) =>
    appendFileSync(filePath, `${historyLine(provider, text, index)}\n`);
  return { filePath, session, read, onLine, append };
}

const texts = (domain: SessionDomainService) =>
  domain
    .getTranscriptSnapshot('session')
    .map((message) => message.text ?? message.message?.text ?? message.message?.type);
const prOutcome = { type: 'pr_update', text: 'Review feedback', prDeliveryState: 'failed' };

describe.each(['CLAUDE', 'CODEX'] as const)('%s provider history transcripts', (provider) => {
  it('reopens a cleared idle session without rereading its unchanged history file', async () => {
    const { session, read } = fixture(provider, ['one', 'two']);
    const domain = new SessionDomainService();
    const hydrate = createProviderHistoryHydrator(domain);
    await hydrate('session', session);
    const first = domain.getTranscriptSnapshot('session');
    expect(texts(domain)).toEqual(['one', 'two']);

    // A rejected PR update survives inactive-viewer cleanup and merges after reopening.
    domain.failMessage(
      'session',
      {
        id: 'pr-event-local-outcome',
        text: 'Review feedback',
        timestamp: '2026-11-09T00:01:00Z',
        source: { type: 'pr_event', request: { workspaceId: 'w', prId: null, bindingRevision: 1 } },
        settings: {
          selectedModel: null,
          reasoningEffort: null,
          thinkingEnabled: false,
          planModeEnabled: false,
        },
      },
      'Provider unavailable'
    );
    domain.clearSession('session', { preserveRejections: true });
    expect(texts(domain)).toEqual(['Review feedback']);

    await hydrate('session', session);
    expect(read).toHaveBeenCalledOnce();
    expect(texts(domain)).toEqual(['one', 'two', 'Review feedback']);
    const reopened = domain.getTranscriptSnapshot('session');
    expect(reopened.slice(0, 2)).toEqual(first);
    expect(reopened[2]?.message).toMatchObject(prOutcome);
    expect(reopened[2]!.order).toBeGreaterThan(reopened[1]!.order);
    expect(domain.getHistoryHydrationSource('session')).toBe('jsonl');
  });

  it('keeps the cached projection intact when a store reassigns an entry in place', async () => {
    const { session, read } = fixture(provider, ['one']);
    const domain = new SessionDomainService();
    const hydrate = createProviderHistoryHydrator(domain);
    await hydrate('session', session);
    // Tool-use enrichment reassigns a stored entry's message in place.
    const [entry] = domain.getTranscriptSnapshot('session');
    Object.assign(entry!, { text: 'changed by the live store' });
    domain.clearSession('session', { preserveRejections: true });

    const reopened = new SessionDomainService();
    await createProviderHistoryHydrator(reopened)('session', session);
    expect(read).toHaveBeenCalledOnce();
    expect(texts(reopened)).toEqual(['one']);
  });

  it('rereads a history file that changed after it was cached', async () => {
    const { filePath, session, read, append } = fixture(provider, ['one']);
    const domain = new SessionDomainService();
    const hydrate = createProviderHistoryHydrator(domain);
    await hydrate('session', session);
    domain.clearSession('session', { preserveRejections: true });

    append('two', 2);
    await hydrate('session', session);
    expect(read).toHaveBeenCalledTimes(2);
    expect(texts(domain)).toEqual(['one', 'two']);

    // Same size, different content: only the modification time tells them apart.
    domain.clearSession('session', { preserveRejections: true });
    const original = readFileSync(filePath, 'utf8');
    writeFileSync(filePath, original.replace('"two"', '"owt"'));
    utimesSync(filePath, new Date(), new Date(Date.now() + 60_000));
    await hydrate('session', session);
    expect(read).toHaveBeenCalledTimes(3);
    expect(texts(domain)).toEqual(['one', 'owt']);
  });

  it('shares one read between concurrent hydrations of the same session', async () => {
    const { session, read } = fixture(provider, ['one', 'two']);
    const loadDomain = new SessionDomainService();
    const startupDomain = new SessionDomainService();
    await Promise.all([
      createProviderHistoryHydrator(loadDomain)('session', session),
      createProviderHistoryHydrator(startupDomain)('session', session),
    ]);
    expect(read).toHaveBeenCalledOnce();
    expect(texts(loadDomain)).toEqual(['one', 'two']);
    expect(texts(startupDomain)).toEqual(['one', 'two']);
  });

  it('finishes a shared read for a current caller after another caller goes stale', async () => {
    const { session, read, onLine } = fixture(provider, ['one', 'two']);
    const staleDomain = new SessionDomainService();
    const currentDomain = new SessionDomainService();
    onLine.mockImplementationOnce(() => {
      staleDomain.resetProviderHistory('session', 'replacement');
    });
    await Promise.all([
      createProviderHistoryHydrator(staleDomain)('session', session),
      createProviderHistoryHydrator(currentDomain)('session', session),
    ]);
    expect(read).toHaveBeenCalledOnce();
    expect(texts(staleDomain)).toEqual([]);
    expect(texts(currentDomain)).toEqual(['one', 'two']);
  });

  it('never caches a read that every caller abandoned', async () => {
    const { session, read, onLine } = fixture(provider, ['one', 'two']);
    const abandoned = new SessionDomainService();
    onLine.mockImplementationOnce(() => {
      abandoned.resetProviderHistory('session', 'replacement');
    });
    await createProviderHistoryHydrator(abandoned)('session', session);
    expect(texts(abandoned)).toEqual([]);
    expect(providerHistoryTranscriptCache.size).toBe(0);

    const fresh = new SessionDomainService();
    await createProviderHistoryHydrator(fresh)('session', session);
    expect(read).toHaveBeenCalledTimes(2);
    expect(texts(fresh)).toEqual(['one', 'two']);
  });
});
