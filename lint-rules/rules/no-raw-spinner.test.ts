import { describeRuleFixtures } from '../testing/rule-fixtures';

describeRuleFixtures('no-raw-spinner', {
  rejected: [
    'const x = <CircleNotchIcon className="h-4 w-4 animate-spin" />;',
    'const x = <Icon className={cn("size-3", spin && "animate-spin")} />;',
    'const className = "motion-safe:animate-spin";',
    'const x = <SpinnerGapIcon aria-hidden />;',
    'const className = `p-2 animate-spin`;',
  ],
  accepted: [
    'const x = <Spinner className="size-3" aria-hidden />;',
    'const className = "animate-spin-slow animate-pulse";',
    'const name = "no-animate-spin";',
  ],
});
