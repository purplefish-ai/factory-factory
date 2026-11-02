import {
  nullableRecoveryJsonFields,
  recoveryJsonStorageSchema,
} from '@/shared/schemas/recovery-json-storage.schema';
import { Prisma } from '@prisma-gen/client';

function identifier(value: string) {
  // Identifiers come only from the static supported-field catalog, never the import file.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error('Invalid recovery storage identifier');
  }
  return Prisma.raw(`"${value}"`);
}
export async function readRecoveryJsonStorage(tx: Prisma.TransactionClient) {
  const selects = Object.entries(nullableRecoveryJsonFields).flatMap(([model, fields]) =>
    fields.map(
      (field) =>
        Prisma.sql`SELECT ${model} AS model, ${identifier(model === 'AgentSourceState' ? 'connectionId' : 'id')} AS id, ${field} AS field FROM ${identifier(model)} WHERE json_type(${identifier(field)}) = 'null'`
    )
  );
  const jsonNulls = await tx.$queryRaw(Prisma.join(selects, ' UNION ALL '));
  return recoveryJsonStorageSchema.parse({ version: 1, jsonNulls });
}
