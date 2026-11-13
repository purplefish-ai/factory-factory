import { describeRuleFixtures } from '../testing/rule-fixtures';

describeRuleFixtures('no-unsafe-resolver-cast', {
  rejected: [
    'const callback = resolve as (value: unknown) => void;',
    'const callback = resolve as (value: Array<unknown>) => void;',
  ],
  accepted: ['const callback = resolve as (value: string) => void;'],
});
