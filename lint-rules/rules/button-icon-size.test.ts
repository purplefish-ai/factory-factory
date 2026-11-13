import { describeRuleFixtures } from '../testing/rule-fixtures';

describeRuleFixtures('button-icon-size', {
  rejected: [
    'const x = <Button size="sm"><PlayIcon className="h-3 w-3" />Run</Button>;',
    'const x = <Button>{busy ? <XIcon className="mr-1 md:w-4" /> : null}Go</Button>;',
    'const x = <IconButton label="Close"><span><XIcon className="h-5 w-5" /></span></IconButton>;',
    'const x = <Button size="sm"><DownloadIcon className="mr-2" />Export</Button>;',
    'const x = <Button size="sm"><DownloadIcon className="m-1" />Export</Button>;',
    'const x = <Button>Next<CaretRightIcon className="md:ml-1.5" /></Button>;',
    'const x = <Button>{open ? <CaretDownIcon className="me-1" /> : null}Hide</Button>;',
    'const x = <Button asChild><Link to="/"><HouseIcon className="mr-[3px]" />Home</Link></Button>;',
  ],
  accepted: [
    'const x = <Button size="sm"><PlayIcon />Run</Button>;',
    'const x = <Button size="sm"><PlayIcon className="size-3 shrink-0" />Run</Button>;',
    'const x = <div className="h-6 w-6"><XIcon className="h-3 w-3" /></div>;',
    // Optical offsets, pushing an icon to the end and spacing inside a wrapper pass.
    'const x = <Button size="sm"><PlayIcon className="-ml-0.5" />Run</Button>;',
    'const x = <Button size="sm"><PlayIcon className="my-0.5" />Run</Button>;',
    'const x = <Button className="w-full">Menu<CaretDownIcon className="ml-auto" /></Button>;',
    'const x = <Button><span className="flex"><XIcon className="mr-1" />Close</span></Button>;',
    'const x = <div><XIcon className="mr-2" />Close</div>;',
  ],
});
