import { z } from 'zod';
import type { ToolEvent } from './types';

const githubPrUrl = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const shellWord = /(?:\\[\s\S]|'[^']*'|"(?:\\[\s\S]|[^"\\])*"|[^\s;&|<>()'"`\\])+/y;
const shellOperator = /(?:<<<|<<-|<<|>&|&&|\|\||[;&|()<>])/y;
const outputSchema = z.object({ aggregatedOutput: z.string() });

function literalWord(raw: string): string {
  return raw.replace(
    /'([^']*)'|"((?:\\[\s\S]|[^"\\])*)"|\\([\s\S])/g,
    (_, single: string | undefined, double: string | undefined, escaped: string) =>
      single ?? double?.replace(/\\(["\\$`\n])/g, '$1') ?? escaped
  );
}

function isRestCreate(args: string[]): boolean {
  let method: string | undefined;
  let postData = false;
  let endpoint: string | undefined;
  const tokens = args.values();
  for (const arg of tokens) {
    if (arg === '-X' || arg === '--method') {
      method = tokens.next().value;
    } else if (arg.startsWith('--method=')) {
      method = arg.slice(9);
    } else if (arg.startsWith('-X')) {
      method = arg.slice(2);
    } else if (['-F', '-f', '--raw-field', '--field', '--input'].includes(arg)) {
      postData = true;
      tokens.next();
    } else if (['-H', '--header', '-q', '--jq', '--hostname', '-t', '--template'].includes(arg)) {
      tokens.next();
    } else if (!arg.startsWith('-')) {
      endpoint ??= arg;
    }
  }
  return isPullsCollection(endpoint) && usesPost(method, postData);
}

function usesPost(method: string | undefined, postData: boolean): boolean {
  return method === undefined ? postData : method.toUpperCase() === 'POST';
}

function isPullsCollection(endpoint: string | undefined): boolean {
  return /^\/?repos\/[\w.{}-]+\/[\w.{}-]+\/pulls$/.test(endpoint ?? '');
}

type CreateOperation = 'cli' | 'rest';

function createsInCommand(words: string[], depth: number): CreateOperation[] {
  const args = [...words];
  while (/^[A-Za-z_]\w*=/.test(args[0] ?? '')) {
    args.shift();
  }
  const executable = args.shift()?.split('/').pop();
  if (
    depth === 0 &&
    /^(?:ba|z|da)?sh$/.test(executable ?? '') &&
    /^-[a-z]*c$/.test(args[0] ?? '')
  ) {
    return createOperations(args[1] ?? '', depth + 1);
  }
  if (executable !== 'gh') {
    return [];
  }
  if (args[0] === '-R' || args[0] === '--repo') {
    args.splice(0, 2);
  }
  if (args[0] === 'pr' && args[1] === 'create') {
    return ['cli'];
  }
  return args[0] === 'api' && isRestCreate(args.slice(1)) ? ['rest'] : [];
}

// Read literal shell command positions. Quoted arguments, comments and heredoc
// bodies can all contain transcripts of other commands and must stay opaque.
function createOperations(command: string, depth = 0): CreateOperation[] {
  const commands = readCommandWords(command);
  return commands.flatMap((words) => createsInCommand(words, depth));
}

function skipHeredocs(script: string, start: number, delimiters: string[]): number {
  let cursor = start;
  for (const delimiter of delimiters.splice(0)) {
    while (cursor < script.length) {
      const newline = script.indexOf('\n', cursor);
      const end = newline < 0 ? script.length : newline;
      const line = script.slice(cursor, end);
      cursor = end + 1;
      if (line.replace(/^\t+/, '') === delimiter) {
        break;
      }
    }
  }
  return cursor;
}

function nextToken(script: string, cursor: number): string | undefined {
  // Comments and whitespace are recognized only at token boundaries.
  const trivia = /#[^\n]*|[^\S\n]+/y;
  for (const pattern of [trivia, shellOperator, shellWord]) {
    pattern.lastIndex = cursor;
    const token = pattern.exec(script)?.[0];
    if (token) {
      return token;
    }
  }
  return undefined;
}

function readCommandWords(script: string): string[][] {
  const commands: string[][] = [];
  const delimiters: string[] = [];
  let words: string[] = [];
  let expectingDelimiter = false;
  for (let cursor = 0; cursor < script.length;) {
    if (script[cursor] === '\n') {
      commands.push(words);
      words = [];
      cursor = skipHeredocs(script, cursor + 1, delimiters);
      continue;
    }
    const token = nextToken(script, cursor);
    if (!token) {
      return [];
    }
    cursor += token.length;
    if (/^(?:#|\s)/.test(token)) {
      continue;
    }
    if (expectingDelimiter) {
      delimiters.push(literalWord(token));
      expectingDelimiter = false;
    } else if (token === '<<' || token === '<<-') {
      expectingDelimiter = true;
    } else if ([';', '&&', '||', '|', '&'].includes(token)) {
      commands.push(words);
      words = [];
    } else {
      words.push(literalWord(token));
    }
  }
  commands.push(words);
  return commands;
}

export function shellCreatedPrUrls(event: ToolEvent): string[] {
  if ('server' in event.input || 'tool' in event.input) {
    return [];
  }
  const candidates = [event.input.command, event.input.cmd, event.toolName];
  if (event.toolName === 'commandExecution' || event.input.type === 'commandExecution') {
    candidates.push(event.input.title);
  }
  const operations = candidates
    .filter((command): command is string => typeof command === 'string' && command.includes('gh'))
    .map((command) => createOperations(command))
    .find((creates) => creates.length > 0);
  if (!operations) {
    return [];
  }
  const raw = event.input.rawOutput;
  const nested = outputSchema.safeParse(raw);
  const outputs = [
    event.output?.content,
    event.input.aggregatedOutput,
    nested.data?.aggregatedOutput,
    raw,
  ];
  for (const output of outputs) {
    if (typeof output !== 'string') {
      continue;
    }
    const urls = urlsFromOutput(output, operations.includes('rest'));
    if (urls.length) {
      return urls.length <= operations.length ? urls : [];
    }
  }
  return [];
}

const restOutputSchema = z.object({
  html_url: z.string().regex(githubPrUrl),
  number: z.number().int().positive(),
});
function urlsFromOutput(output: string, rest: boolean): string[] {
  if (rest && output.trimStart().startsWith('{')) {
    try {
      const result = restOutputSchema.safeParse(JSON.parse(output));
      if (result.success && result.data.html_url.endsWith(`/${result.data.number}`)) {
        return [result.data.html_url];
      }
    } catch {
      // Shell output may include logs before the URL.
    }
  }
  return [
    ...new Set(
      output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => githubPrUrl.test(line))
    ),
  ];
}
