const SHAPE_DRIFT_DETAILS_LIMIT = 700;

export type ShapeDriftWarn = (message: string, context: Record<string, unknown>) => void;

function toShapeDriftDetails(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') {
      return '[unserializable]';
    }
    return text.length > SHAPE_DRIFT_DETAILS_LIMIT
      ? `${text.slice(0, SHAPE_DRIFT_DETAILS_LIMIT)}...`
      : text;
  } catch {
    return '[unserializable]';
  }
}

export class ShapeDriftReporter {
  private readonly counts = new Map<string, number>();
  private readonly warn: ShapeDriftWarn;

  constructor(warn?: ShapeDriftWarn) {
    this.warn =
      warn ??
      ((message, context) => {
        process.stderr.write(
          `[codex-app-server-acp] ${message} ${JSON.stringify(context ?? {})}\n`
        );
      });
  }

  report(event: string, details?: unknown): void {
    const count = (this.counts.get(event) ?? 0) + 1;
    this.counts.set(event, count);

    const includeDetails = details !== undefined && (count <= 5 || count % 50 === 0);

    this.warn('Codex app-server shape drift detected', {
      event,
      count,
      ...(includeDetails ? { details: toShapeDriftDetails(details) } : {}),
    });
  }
}
