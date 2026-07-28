import { describe, expect, it } from 'vitest';
import { collectForeignKeyIndexViolations } from '@/../scripts/check-fk-indexes';

function schemaWithCompoundRelation(coverage: string): string {
  return `
model Parent {
  a        String
  b        String
  children Child[]

  @@id([a, b])
}

model Child {
  id      String @id
  parentA String
  parentB String
  parent  Parent @relation(fields: [parentA, parentB], references: [a, b])

  ${coverage}
}
`;
}

describe('check-fk-indexes script', () => {
  it('parses commas inside index field arguments', () => {
    const schema = schemaWithCompoundRelation(
      '@@index([parentA(length: 10, sort: Desc), parentB])'
    );

    expect(collectForeignKeyIndexViolations(schema)).toEqual([]);
  });

  it.each([
    '@@id(name: "parentKey", [parentA, parentB])',
    '@@unique(name: "parentKey", [parentA, parentB])',
  ])('recognizes a named compound constraint as coverage: %s', (coverage) => {
    const schema = schemaWithCompoundRelation(coverage);

    expect(collectForeignKeyIndexViolations(schema)).toEqual([]);
  });

  it('accepts composite foreign-key columns in either leading index order', () => {
    const schema = schemaWithCompoundRelation('@@index([parentB, parentA])');

    expect(collectForeignKeyIndexViolations(schema)).toEqual([]);
  });

  it('reports a relation without a covering index', () => {
    const schema = schemaWithCompoundRelation('');

    expect(collectForeignKeyIndexViolations(schema)).toEqual([
      'Model "Child" relation on [parentA, parentB] has no covering index. Add @@index([parentA, parentB]) (or exempt it with a reason in scripts/check-fk-indexes.ts).',
    ]);
  });
});
