import { describeRuleFixtures } from '../testing/rule-fixtures';

describeRuleFixtures('no-zod-any', {
  rejected: ['const schema = z.any();', 'const schema = zod.any();'],
  accepted: ['const schema = z.unknown();'],
});
