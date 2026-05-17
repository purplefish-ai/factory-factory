export function normalizeUnknownError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSessionUpdateMessage(message: unknown): unknown {
  if (
    !isRecord(message) ||
    message.method !== 'session/update' ||
    !isRecord(message.params) ||
    !isRecord(message.params.update) ||
    !Array.isArray(message.params.update.locations)
  ) {
    return message;
  }

  const update = message.params.update;
  const locations = update.locations as unknown[];
  const needsNormalization = locations.some(
    (loc) =>
      isRecord(loc) && loc.line !== undefined && loc.line !== null && typeof loc.line !== 'number'
  );
  if (!needsNormalization) {
    return message;
  }

  return {
    ...message,
    params: {
      ...message.params,
      update: {
        ...update,
        locations: locations.map((loc) => {
          if (!isRecord(loc) || typeof loc.line === 'number' || loc.line == null) {
            return loc;
          }
          return {
            ...loc,
            line:
              Array.isArray(loc.line) && loc.line.length > 0 ? (loc.line[0] as number) : undefined,
          };
        }),
      },
    },
  };
}

export function createNormalizedAcpReadableStream<T>(
  readable: ReadableStream<T>
): ReadableStream<T> {
  if (typeof readable.getReader !== 'function') {
    return readable;
  }

  let reader: ReadableStreamDefaultReader<T> | null = null;
  return new ReadableStream<T>({
    start() {
      reader = readable.getReader();
    },
    async pull(controller) {
      if (!reader) {
        reader = readable.getReader();
      }
      const currentReader = reader;

      try {
        const { done, value } = await currentReader.read();
        if (done) {
          controller.close();
          currentReader.releaseLock();
          reader = null;
          return;
        }
        controller.enqueue(normalizeSessionUpdateMessage(value) as T);
      } catch (error) {
        currentReader.releaseLock();
        controller.error(error);
        reader = null;
      }
    },
    async cancel(reason) {
      try {
        await reader?.cancel(reason);
      } finally {
        reader?.releaseLock();
        reader = null;
      }
    },
  });
}
