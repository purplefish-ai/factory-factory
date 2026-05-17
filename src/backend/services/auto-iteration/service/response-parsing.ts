import type { CritiqueResult, MetricEvaluation } from './auto-iteration.types';

export function parseMetricEvaluation(response: string): MetricEvaluation {
  try {
    const json = extractJson(response);
    return {
      metricSummary: String(json.metricSummary ?? 'Unknown'),
      improved: parseExplicitBoolean(json.improved),
      targetReached: parseExplicitBoolean(json.targetReached),
    };
  } catch {
    return {
      metricSummary: response.slice(0, 200),
      improved: false,
      targetReached: false,
    };
  }
}

export function parseCritiqueResult(response: string): CritiqueResult {
  try {
    const json = extractJson(response);
    return {
      approved: parseExplicitBoolean(json.approved),
      notes: String(json.notes ?? ''),
    };
  } catch {
    return {
      approved: false,
      notes: `Could not parse critique response: ${response.slice(0, 200)}`,
    };
  }
}

function parseExplicitBoolean(value: unknown): boolean {
  return value === true;
}

interface JsonScanState {
  depth: number;
  inString: boolean;
  escaped: boolean;
}

function extractJson(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  if (start === -1) {
    throw new Error('No JSON found');
  }

  const end = findJsonEnd(text, start);
  return JSON.parse(text.slice(start, end + 1));
}

function findJsonEnd(text: string, start: number): number {
  let state: JsonScanState = { depth: 0, inString: false, escaped: false };
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (char === undefined) {
      continue;
    }

    state = nextJsonScanState(state, char);
    if (!state.inString && state.depth === 0 && char === '}') {
      return index;
    }
  }

  throw new Error('No JSON found');
}

function nextJsonScanState(state: JsonScanState, char: string): JsonScanState {
  if (state.escaped) {
    return { ...state, escaped: false };
  }

  if (state.inString) {
    return nextJsonStringState(state, char);
  }

  if (char === '"') {
    return { ...state, inString: true };
  }

  if (char === '{') {
    return { ...state, depth: state.depth + 1 };
  }

  if (char === '}') {
    return { ...state, depth: state.depth - 1 };
  }

  return state;
}

function nextJsonStringState(state: JsonScanState, char: string): JsonScanState {
  if (char === '\\') {
    return { ...state, escaped: true };
  }

  if (char === '"') {
    return { ...state, inString: false };
  }

  return state;
}
