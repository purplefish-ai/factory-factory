import { describeRuleFixtures } from '../testing/rule-fixtures';

describeRuleFixtures('tooltip-provider-root', {
  rejected: ['const x = <TooltipProvider><Tooltip /></TooltipProvider>;'],
  accepted: [],
});
