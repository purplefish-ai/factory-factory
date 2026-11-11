import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

const choiceSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
});
const inputSchema = z.object({
  provider: z.enum(['CLAUDE', 'CODEX']),
  model: z.string().optional(),
  codexAccountId: z.string().optional(),
});
const entrySchema = z
  .object({
    input: inputSchema,
    capturedAt: z.number().finite().nonnegative(),
    value: z.object({
      provider: z.enum(['CLAUDE', 'CODEX']),
      model: z.string(),
      reasoning: z.object({
        options: z.array(choiceSchema).max(128),
        selected: z.string().optional(),
        defaultValue: z.string().optional(),
      }),
      planMode: z.object({ supported: z.boolean(), selected: z.boolean() }),
      accessMode: z
        .object({ options: z.array(choiceSchema).max(128), selected: z.string().optional() })
        .optional(),
    }),
  })
  .refine((entry) => entry.input.provider === entry.value.provider);
const snapshotSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema).max(32) });
export type StoredLaunchOptions = z.infer<typeof entrySchema>;
export interface LaunchOptionsPersistence {
  load(): Promise<StoredLaunchOptions[]>;
  save(entries: StoredLaunchOptions[]): Promise<void>;
}

/** Capability metadata only: no account credentials, prompts, or runtime environments. */
export class LaunchOptionsStore implements LaunchOptionsPersistence {
  private writing: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}

  async load(): Promise<StoredLaunchOptions[]> {
    try {
      const file = await open(this.path, 'r');
      try {
        // Bounded reads also cover files replaced or enlarged by another process.
        const buffer = Buffer.alloc(1024 * 1024 + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead === buffer.length) {
          return [];
        }
        return snapshotSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')))
          .entries;
      } finally {
        await file.close();
      }
    } catch {
      // Missing, corrupt, or incompatible snapshots simply start cold.
      return [];
    }
  }

  async save(entries: StoredLaunchOptions[]): Promise<void> {
    // One unsupported provider response must not prevent other models from
    // surviving restart. Never truncate a model's advertised choices.
    const supported = entries.flatMap((entry) => {
      const parsed = entrySchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
    const data = JSON.stringify(snapshotSchema.parse({ version: 1, entries: supported }));
    const write = this.writing
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, data, { mode: 0o600 });
          await rename(temporary, this.path);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    this.writing = write;
    await write;
  }
}
