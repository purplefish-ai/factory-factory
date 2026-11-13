import { describeRuleFixtures } from '../testing/rule-fixtures';

describeRuleFixtures('no-await-import', {
  rejected: ['async function load() { return await import("./module"); }'],
  accepted: [
    'import { example } from "./module";',
    'async function load() { return import("./module"); }',
  ],
});
