import { describeRuleFixtures } from '../testing/rule-fixtures';

describeRuleFixtures('use-pending-prop', {
  rejected: [
    'const x = <Button disabled={saving}>{saving && <Spinner aria-hidden />}Save</Button>;',
    'const x = <Button size="icon" aria-label="Run">{busy ? <Spinner /> : <PlayIcon />}</Button>;',
    'const x = <DropdownMenuItem>{busy ? <Spinner /> : <SyncIcon />}Sync</DropdownMenuItem>;',
    'const x = <Button><><Spinner />Loading</></Button>;',
  ],
  accepted: [
    'const x = <Button pending={saving} pendingLabel="Saving…">Save</Button>;',
    'const x = <div>{busy && <Spinner aria-hidden />}<Button>Save</Button></div>;',
    'const x = <DropdownMenuItem pending={busy}><SyncIcon />Sync</DropdownMenuItem>;',
  ],
});
