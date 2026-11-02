// Only these CLIs treat the first positional argument as a subcommand. For
// interpreters and utilities it is usually a filename, pattern, or source code.
const SUBCOMMAND_OPTIONS = new Map<string, string[]>([
  ['git', ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']],
  ['gh', ['-R', '--repo', '--hostname']],
  ['pnpm', ['-C', '--dir', '--filter', '-F']],
  ['npm', ['--prefix', '--workspace', '-w']],
  ['bun', ['--cwd']],
  ['cargo', ['--manifest-path', '--color', '--config', '-Z']],
  ['docker', ['--context', '-c', '--host', '-H', '--config', '--log-level', '-l']],
  ['kubectl', ['--context', '--namespace', '-n', '--kubeconfig', '--server']],
  ['uv', ['--directory', '--project']],
  ['pip', []],
  ['pip3', []],
  ['go', []],
  ['ff', []],
]);
const SHELLS = new Set(['bash', 'dash', 'ksh', 'mksh', 'sh', 'zsh', 'fish']);
const BOOLEAN_OPTIONS = new Set([
  '--no-pager',
  '--paginate',
  '--bare',
  '--no-replace-objects',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-optional-locks',
  '--no-lazy-fetch',
  '--recursive',
  '-r',
  '--workspace-root',
  '--silent',
  '--offline',
  '--debug',
  '--verbose',
  '--quiet',
  '-q',
]);

function shellWords(command: string): string[] {
  // Preserve quoted paths as a single word, and stop before shell operators.
  // This is a display heuristic only; it never executes or rewrites the input.
  const words = command.match(/(?:[^\s"';&|<>\\]|\\.|"[^"]*"|'[^']*')+|[;&|<>\n]/g) ?? [];
  const end = words.findIndex((word) => /^[;&|<>\n]$/.test(word));
  return (end < 0 ? words : words.slice(0, end)).map((word) =>
    word.replace(
      /"([^"]*)"|'([^']*)'|\\(.)/g,
      (_, double, single, escaped) => double ?? single ?? escaped
    )
  );
}

function withSubcommand(executable: string, words: string[]): string {
  const valueOptions = SUBCOMMAND_OPTIONS.get(executable);
  if (!valueOptions) {
    return executable;
  }
  for (let index = 1; index < words.length; index++) {
    const word = words[index] ?? '';
    if (valueOptions.includes(word)) {
      index++;
    } else if (word.startsWith('-') && !word.includes('=') && !BOOLEAN_OPTIONS.has(word)) {
      // Unknown options may consume the next word. Prefer just the executable
      // over accidentally displaying an option value as the subcommand.
      return executable;
    } else if (!word.startsWith('-')) {
      return /^[a-z][a-z0-9-]*$/i.test(word) ? `${executable} ${word}` : executable;
    }
  }
  return executable;
}

export function compactCommandLabel(command: string | string[]): string {
  const words = typeof command === 'string' ? shellWords(command) : command;
  const first = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  const args = words.slice(first < 0 ? words.length : first);
  const executable =
    args[0]
      ?.split(/[/\\]/)
      .pop()
      ?.replace(/\.exe$/i, '') || 'command';
  if (SHELLS.has(executable)) {
    const flag = args.findIndex((word) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word));
    const script = args[flag + 1];
    if (flag > 0 && script) {
      return compactCommandLabel(script);
    }
  }
  return withSubcommand(executable, args);
}
