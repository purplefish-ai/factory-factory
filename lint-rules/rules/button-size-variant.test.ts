import { describeRuleFixtures } from '../testing/rule-fixtures';

describeRuleFixtures('button-size-variant', {
  rejected: [
    'const x = <Button size="icon" className="h-6 w-6" aria-label="Close"><XIcon /></Button>;',
    'const x = <Button size="sm" className={cn("md:h-8", x)}>Run</Button>;',
    'const x = <IconButton label="Close" className="size-7"><XIcon /></IconButton>;',
  ],
  accepted: [
    'const x = <Button className="w-full sm:w-auto">Go</Button>;',
    'const x = <Button className="w-1/2">Go</Button>;',
    'const x = <Button variant="link" className="h-auto p-0">More</Button>;',
    'const x = <Button className="min-w-0 max-w-[14rem] sm:w-[160px]">Go</Button>;',
  ],
});
