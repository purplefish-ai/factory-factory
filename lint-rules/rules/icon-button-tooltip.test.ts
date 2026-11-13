import { describeRuleFixtures } from '../testing/rule-fixtures';

describeRuleFixtures('icon-button-tooltip', {
  rejected: [
    'const x = <Tooltip><TooltipTrigger asChild><Button size="icon" aria-label="Close"><XIcon /></Button></TooltipTrigger><TooltipContent>Close</TooltipContent></Tooltip>;',
    'const x = <TooltipTrigger asChild><DropdownMenuTrigger asChild><Button size="icon-xs" aria-label="More"><DotsIcon /></Button></DropdownMenuTrigger></TooltipTrigger>;',
    'const x = <Button size="icon-sm" title="Close"><XIcon /></Button>;',
    'const x = <TooltipTrigger asChild><Button size="icon" title="Close"><XIcon /></Button></TooltipTrigger>;',
  ],
  accepted: [
    'const x = <IconButton label="Close" size="icon-xs"><XIcon /></IconButton>;',
    'const x = <Tooltip><TooltipTrigger asChild><Button size="sm">Archive</Button></TooltipTrigger></Tooltip>;',
    'const x = <Button size="sm" title="Archive every workspace">Archive</Button>;',
  ],
});
