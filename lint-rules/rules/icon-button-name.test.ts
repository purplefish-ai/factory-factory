import { describeRuleFixtures } from '../testing/rule-fixtures';

describeRuleFixtures('icon-button-name', {
  rejected: [
    'const x = <Button size="icon" aria-label={""}><XIcon /></Button>;',
    'const x = <Button size="icon" aria-label={``}><XIcon /></Button>;',
    'const x = <button><span><XIcon /></span></button>;',
    'const x = <button><Icons.Close /></button>;',
    'const x = <button><Toolkit.CloseIcon /></button>;',
    'const x = <Button size="icon"><XIcon /><span aria-hidden>Close</span></Button>;',
    'const x = <Button asChild size="icon"><a aria-label=""><XIcon /></a></Button>;',
    'const x = <Button size="icon"><PlusIcon /></Button>;',
    'const x = <button><XIcon /></button>;',
    'const x = <Button size="icon" />;',
    'const x = <Button size="icon"><span /></Button>;',
    'const x = <Button size="icon"><span aria-hidden="true">Close</span></Button>;',
    'const x = <Button size="icon" aria-label=""><PlusIcon /></Button>;',
    'const x = <IconButton label=""><XIcon /></IconButton>;',
    'const x = <IconButton label={``}><XIcon /></IconButton>;',
  ],
  accepted: [
    'const x = <Button size="icon"><><XIcon /><span className="sr-only">Close</span></></Button>;',
    'const x = <button><span><XIcon /></span>Close</button>;',
    'const x = <Button asChild size="icon"><a aria-label="Close"><XIcon /></a></Button>;',
    'const x = <Button size="icon" aria-label="Add workspace"><PlusIcon /></Button>;',
    'const x = <button title="Close"><XIcon /></button>;',
    'const x = <Button size="icon"><PlusIcon /><span className="sr-only">Add workspace</span></Button>;',
    'const x = <Button><PlusIcon />Add workspace</Button>;',
    'const x = <Button aria-labelledby={labelId}><PlusIcon /></Button>;',
    'const x = <IconButton label={label}><XIcon /></IconButton>;',
  ],
});
