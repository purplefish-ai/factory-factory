import type { ToolCallUpdate } from '@agentclientprotocol/sdk';
import { dedupeLocations } from './acp-adapter-utils';

type CommandDisplayContext = {
  command: string;
  firstCommand: string;
  nonFlagArgs: string[];
  pathArg: string | null;
  cwd: string;
  locations: Array<{ path: string }>;
  isShellMeta: boolean;
};

type CommandChainSplitState = {
  parts: string[];
  current: string;
  quote: '"' | "'" | null;
  escaped: boolean;
};

const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'more']);
const LIST_OR_FIND_COMMANDS = new Set(['ls', 'tree', 'find', 'fd']);
const GREP_LIKE_COMMANDS = new Set(['rg', 'ripgrep', 'grep', 'ag']);
const SHELL_META_COMMANDS = new Set(['cd', 'export', 'set', 'unset', 'alias', 'unalias', 'source']);

function dedupeStrings<T extends string>(values: Iterable<T>): T[] {
  return Array.from(new Set(values));
}

function trimOptionalQuotes(token: string): { text: string; quote: '"' | "'" | null } {
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    return { text: token.slice(1, -1), quote: '"' };
  }
  if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) {
    return { text: token.slice(1, -1), quote: "'" };
  }
  return { text: token, quote: null };
}

function unescapeCommandToken(token: string, quote: '"' | "'" | null): string {
  if (quote === "'") {
    return token.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }
  return token.replace(/\\(["'\\\s|&;])/g, '$1');
}

function sanitizeCommandToken(token: string): string {
  const trimmed = token.trim();
  const { text, quote } = trimOptionalQuotes(trimmed);
  return unescapeCommandToken(text, quote).trim();
}

export function tokenizeCommand(command: string): string[] {
  return (command.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/g) ?? [])
    .map((token) => sanitizeCommandToken(token))
    .filter((token) => token.length > 0);
}

function commandName(token: string): string {
  const unix = token.split('/').at(-1) ?? token;
  return (unix.split('\\').at(-1) ?? unix).toLowerCase();
}

function isChainSeparatorChar(char: string): boolean {
  return char === ';' || char === '\n' || char === '|' || char === '&';
}

function readChainSeparatorLength(command: string, index: number): number {
  const char = command[index];
  if (!(char && isChainSeparatorChar(char))) {
    return 0;
  }
  const next = command[index + 1];
  if ((char === '|' || char === '&') && next === char) {
    return 2;
  }
  return 1;
}

function isLikelyPathToken(token: string): boolean {
  if (!token || token.startsWith('-')) {
    return false;
  }
  if (
    token.startsWith('./') ||
    token.startsWith('../') ||
    token.startsWith('/') ||
    token.startsWith('~')
  ) {
    return true;
  }
  return (
    token.includes('/') ||
    token.includes('\\') ||
    token.endsWith('.') ||
    /\.[a-z0-9]+$/i.test(token)
  );
}

function normalizeLocationPath(pathToken: string, cwd: string): string {
  if (pathToken.startsWith('/')) {
    return pathToken;
  }
  if (pathToken.startsWith('~')) {
    return pathToken;
  }
  const base = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd;
  return `${base}/${pathToken}`;
}

function pushCommandChainPart(state: CommandChainSplitState): void {
  const trimmed = state.current.trim();
  if (trimmed.length > 0) {
    state.parts.push(trimmed);
  }
  state.current = '';
}

function consumeEscapedCommandChar(state: CommandChainSplitState, char: string): boolean {
  if (!state.escaped) {
    return false;
  }
  state.current += char;
  state.escaped = false;
  return true;
}

function consumeEscapeInitiator(state: CommandChainSplitState, char: string): boolean {
  if (!(char === '\\' && state.quote !== "'")) {
    return false;
  }
  state.current += char;
  state.escaped = true;
  return true;
}

function hasOddTrailingBackslashes(value: string): boolean {
  let count = 0;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (value[index] !== '\\') {
      break;
    }
    count += 1;
  }
  return count % 2 === 1;
}

function consumeQuotedCommandChar(state: CommandChainSplitState, char: string): boolean {
  if (!state.quote) {
    return false;
  }
  const escapedSingleQuote =
    state.quote === "'" && char === "'" && hasOddTrailingBackslashes(state.current);
  state.current += char;
  if (char === state.quote && !escapedSingleQuote) {
    state.quote = null;
  }
  return true;
}

function consumeQuoteStart(state: CommandChainSplitState, char: string): boolean {
  if (!(char === '"' || char === "'")) {
    return false;
  }
  state.quote = char;
  state.current += char;
  return true;
}

function consumeCommandChainSeparator(
  state: CommandChainSplitState,
  command: string,
  index: number
): number {
  const separatorLength = readChainSeparatorLength(command, index);
  if (separatorLength <= 0) {
    return 0;
  }
  pushCommandChainPart(state);
  return separatorLength;
}

export function splitCommandChain(command: string): string[] {
  const state: CommandChainSplitState = {
    parts: [],
    current: '',
    quote: null,
    escaped: false,
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (!char) {
      continue;
    }

    if (consumeEscapedCommandChar(state, char)) {
      continue;
    }

    if (consumeEscapeInitiator(state, char)) {
      continue;
    }

    if (consumeQuotedCommandChar(state, char)) {
      continue;
    }

    if (consumeQuoteStart(state, char)) {
      continue;
    }

    const consumedSeparatorLength = consumeCommandChainSeparator(state, command, index);
    if (consumedSeparatorLength > 0) {
      index += consumedSeparatorLength - 1;
      continue;
    }

    state.current += char;
  }

  pushCommandChainPart(state);
  return state.parts;
}

function buildCommandDisplayContexts(
  rawCommand: string | null,
  cwd: string
): CommandDisplayContext[] {
  const command = rawCommand?.trim();
  if (!command) {
    return [];
  }

  const contexts: CommandDisplayContext[] = [];
  const segments = splitCommandChain(command);
  for (const segment of segments) {
    const tokens = tokenizeCommand(segment);
    if (tokens.length === 0) {
      continue;
    }

    const [firstToken] = tokens;
    if (!firstToken) {
      continue;
    }
    const firstCommand = commandName(firstToken);
    const nonFlagArgs = tokens.slice(1).filter((token) => !token.startsWith('-'));
    const pathArg = nonFlagArgs.find(isLikelyPathToken) ?? null;
    const commandPath = pathArg ? normalizeLocationPath(pathArg, cwd) : null;
    const locations = commandPath ? [{ path: commandPath }] : [];
    contexts.push({
      command: segment,
      firstCommand,
      nonFlagArgs,
      pathArg,
      cwd,
      locations,
      isShellMeta: SHELL_META_COMMANDS.has(firstCommand),
    });
  }

  return contexts;
}

function chooseActionableCommandContexts(
  contexts: CommandDisplayContext[]
): CommandDisplayContext[] {
  const actionable = contexts.filter((context) => !context.isShellMeta);
  return actionable.length > 0 ? actionable : contexts;
}

function selectCombinedCommandKind(
  displays: Array<{ kind: NonNullable<ToolCallUpdate['kind']> }>
): NonNullable<ToolCallUpdate['kind']> {
  const firstNonExecute = displays.find((display) => display.kind !== 'execute');
  return firstNonExecute?.kind ?? 'execute';
}

function resolveCommandDisplayFromContext(context: CommandDisplayContext): {
  title: string;
  kind: NonNullable<ToolCallUpdate['kind']>;
  locations: Array<{ path: string }>;
} {
  if (READ_COMMANDS.has(context.firstCommand)) {
    const label = context.pathArg ?? context.command;
    return { title: `Read ${label}`, kind: 'read', locations: context.locations };
  }

  if (LIST_OR_FIND_COMMANDS.has(context.firstCommand)) {
    const target = context.pathArg
      ? normalizeLocationPath(context.pathArg, context.cwd)
      : context.cwd;
    const title =
      context.firstCommand === 'find' || context.firstCommand === 'fd'
        ? `Search ${target}`
        : `List ${target}`;
    return { title, kind: 'search', locations: context.locations };
  }

  if (GREP_LIKE_COMMANDS.has(context.firstCommand)) {
    const query = context.nonFlagArgs.find((token) => !isLikelyPathToken(token));
    const target = context.pathArg ? ` in ${context.pathArg}` : '';
    const title = query ? `Search ${query}${target}` : `Search ${context.command}`;
    return { title, kind: 'search', locations: context.locations };
  }

  return { title: context.command, kind: 'execute', locations: context.locations };
}

export function resolveCommandDisplay(params: { command: string | null; cwd: string }): {
  title: string;
  kind: NonNullable<ToolCallUpdate['kind']>;
  locations: Array<{ path: string }>;
} {
  const contexts = chooseActionableCommandContexts(
    buildCommandDisplayContexts(params.command, params.cwd)
  );
  if (contexts.length === 0) {
    return { title: 'commandExecution', kind: 'execute', locations: [] };
  }

  const [singleContext] = contexts;
  if (singleContext && contexts.length === 1) {
    return resolveCommandDisplayFromContext(singleContext);
  }

  const displays = contexts.map((context) => resolveCommandDisplayFromContext(context));
  const title = dedupeStrings(displays.map((display) => display.title)).join(', ');
  const kind = selectCombinedCommandKind(displays);
  const locations = dedupeLocations(displays.flatMap((display) => display.locations)).map(
    (location) => ({
      path: location.path,
    })
  );
  return { title, kind, locations };
}

function normalizeCwdForScope(cwd: string): string {
  if (cwd.length > 1 && cwd.endsWith('/')) {
    return cwd.slice(0, -1);
  }
  return cwd;
}

function normalizeScopeToken(token: string): string {
  return token.replace(/\s+/g, ' ').trim();
}

export function buildCommandApprovalScopeKey(params: {
  command: string | null;
  cwd: string;
}): string | null {
  const contexts = buildCommandDisplayContexts(params.command, params.cwd);
  if (contexts.length === 0) {
    return null;
  }

  let scopeCwd = normalizeCwdForScope(params.cwd);
  const segments: string[] = [];
  for (const context of contexts) {
    if (context.firstCommand === 'cd') {
      const rawTarget = context.nonFlagArgs[0];
      const target = rawTarget ? normalizeScopeToken(rawTarget) : '';
      if (target.length > 0) {
        scopeCwd = normalizeCwdForScope(normalizeLocationPath(target, scopeCwd));
        segments.push(`cd ${target} -> ${scopeCwd}`);
      } else {
        segments.push('cd');
      }
      continue;
    }

    const args = context.nonFlagArgs.map(normalizeScopeToken).filter((arg) => arg.length > 0);
    const normalized = normalizeScopeToken([context.firstCommand, ...args].join(' '));
    if (normalized.length === 0) {
      continue;
    }
    segments.push(`[cwd=${scopeCwd}] ${normalized}`);
  }

  const normalizedSegments = segments
    .map(normalizeScopeToken)
    .filter((segment) => segment.length > 0);
  if (normalizedSegments.length === 0) {
    return null;
  }

  return `cwd=${normalizeCwdForScope(params.cwd)}|${normalizedSegments.join(' && ')}`;
}
