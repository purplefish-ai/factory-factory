import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export async function readNonEmptyJsonlLines(params: {
  filePath: string;
  onLine: (line: string, lineNumber: number) => void | Promise<void>;
  onError: (error: unknown) => void;
}): Promise<void> {
  const stream = createReadStream(params.filePath, { encoding: 'utf-8' });
  const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  try {
    let lineNumber = 0;
    for await (const line of reader) {
      lineNumber += 1;
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      await params.onLine(trimmed, lineNumber);
    }
  } catch (error) {
    params.onError(error);
  } finally {
    reader.close();
    stream.destroy();
  }
}
