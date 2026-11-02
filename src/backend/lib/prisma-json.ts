import { Prisma } from '@prisma-gen/client';

/** SQL absence and the JSON literal null carry different evidence semantics. */
export function nullablePrismaJson(value: Prisma.InputJsonValue | null, jsonNull: boolean) {
  return value === null ? (jsonNull ? Prisma.JsonNull : Prisma.DbNull) : value;
}
