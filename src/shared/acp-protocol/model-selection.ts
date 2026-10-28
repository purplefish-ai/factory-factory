interface ModelSelectionChoice {
  value: string;
  label: string;
}

/** Resolve Claude aliases only when the advertised identity and context are unambiguous. */
export function resolveClaudeModelAlias(
  requested: string,
  choices: readonly ModelSelectionChoice[]
): ModelSelectionChoice | undefined {
  const alias = /^(sonnet|opus|haiku|fable)(\[1m\])?$/.exec(requested);
  if (alias) {
    const matches = choices.filter(
      (choice) =>
        choice.value.startsWith(`claude-${alias[1]}-`) &&
        choice.value.endsWith('[1m]') === requested.endsWith('[1m]')
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  const canonical = /^claude-(sonnet|opus|haiku|fable)-(\d+(?:-\d+)*)(\[1m\])?$/.exec(requested);
  if (!canonical) {
    return undefined;
  }
  const [, family, version, context = ''] = canonical;
  return choices.find(
    (choice) =>
      choice.value === `${family}${context}` &&
      choice.label.toLowerCase().replace(/\s+\([^)]*\)$/, '') ===
        `${family} ${version?.replaceAll('-', '.')}`
  );
}
