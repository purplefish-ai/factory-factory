import { describeRuleFixtures } from '../testing/rule-fixtures';

describeRuleFixtures('no-next-directives', {
  rejected: ['"use client"; export const example = 1;', '"use server"; export const example = 1;'],
  accepted: ['const description = "use client";', 'function example() { return "use server"; }'],
});
