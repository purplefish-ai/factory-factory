import { describeRuleFixtures } from '../testing/rule-fixtures';

describeRuleFixtures('use-status-callout', {
  rejected: [
    'const x = <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3" />;',
    'const className = "bg-warning/10 border-b border-warning/20";',
    'const className = `border border-success-accent/50 bg-success-accent/15`;',
    'const className = "dark:bg-info/10 dark:border-info/30 px-2";',
    'const meta = { className: "text-info border-info bg-info/10" };',
  ],
  accepted: [
    // Hover, focus and data-state tints, a tint without a status border, a
    // status border without a tint and mixed tokens are not callouts.
    'const className = "border-warning/40 text-warning hover:bg-warning/10";',
    'const className = "border-destructive/30 focus:bg-destructive/10 data-[state=open]:bg-destructive/10";',
    'const className = "border-b bg-destructive/10 px-4 py-2";',
    'const className = "border-running-accent/70 dark:border-running/40";',
    'const className = "border-transparent bg-success-accent/15 text-success dark:bg-success/10";',
    'const className = "bg-primary/10 border-primary/15";',
  ],
});
