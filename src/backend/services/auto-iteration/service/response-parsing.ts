import type { CritiqueResult, MetricEvaluation } from './auto-iteration.types';

export function parseMetricEvaluation(response: string): MetricEvaluation {
  try {
    const json = extractJson(response);
    return {
      metricSummary: String(json.metricSummary ?? 'Unknown'),
      improved: Boolean(json.improved),
      targetReached: Boolean(json.targetReached),
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
      approved: Boolean(json.approved),
      notes: String(json.notes ?? ''),
    };
  } catch {
    return {
      approved: false,
      notes: `Could not parse critique response: ${response.slice(0, 200)}`,
    };
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: JSON scanning is clearer as one state machine.
function extractJson(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  if (start === -1) {
    throw new Error('No JSON found');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }
  throw new Error('No JSON found');
}
