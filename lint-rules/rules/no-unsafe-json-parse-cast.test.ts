import { describeRuleFixtures } from '../testing/rule-fixtures';

describeRuleFixtures('no-unsafe-json-parse-cast', {
  rejected: [
    'const value = JSON.parse(input) as Response;',
    'const value = JSON.parse(input) as unknown as Response;',
  ],
  accepted: ['const parsed = JSON.parse(input); const value = schema.parse(parsed);'],
});
