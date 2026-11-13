import { describeRuleFixtures } from '../testing/rule-fixtures';

describeRuleFixtures('no-arbitrary-font-size', {
  rejected: [
    'const x = <span className="text-[10px] uppercase" />;',
    'const className = "md:text-[11px]";',
    'const className = `p-1 text-[0.8rem]`;',
    'const className = cn("!text-[1.5em]", active && "font-medium");',
  ],
  accepted: [
    'const className = "text-2xs text-xs text-[var(--size)] w-[10px] leading-[11px]";',
    'const className = "text-[#ff0000] text-[color:var(--x)]";',
    'const path = "/docs/text-[10px]-guide";',
  ],
});
