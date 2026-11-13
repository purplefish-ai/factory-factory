import { describeRuleFixtures } from '../testing/rule-fixtures';

describeRuleFixtures('no-native-dialogs', {
  rejected: [
    'window.confirm("Continue?");',
    'prompt("Name", "default");',
    'window["alert"]("Warning");',
  ],
  accepted: [
    'const dialog = { confirm(value: string) { return value; } }; dialog.confirm("hello");',
  ],
});
