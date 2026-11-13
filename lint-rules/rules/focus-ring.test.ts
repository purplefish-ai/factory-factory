import { describeRuleFixtures } from '../testing/rule-fixtures';

describeRuleFixtures('focus-ring', {
  rejected: [
    'const c = "rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";',
    'const x = <a className="hover:underline focus-visible:outline-ring" />;',
  ],
  accepted: [
    'const c = "focus-ring focus-visible:ring-inset";',
    'const c = "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";',
  ],
});
