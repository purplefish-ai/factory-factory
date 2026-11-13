import { describeRuleFixtures } from '../testing/rule-fixtures';

describeRuleFixtures('no-raw-tab-role', {
  rejected: [
    'const x = <div role="tab" onClick={select}>Chat</div>;',
    'const x = <div role="tablist">{tabs}</div>;',
    "const x = <button role={'tab'} />;",
    'const x = <div role={`tablist`} />;',
    'const x = <div role={grouped ? "tablist" : "group"} />;',
    'const x = createElement("div", { role: "tab" });',
    'const x = <div role={("tab")} />;',
    'const x = <div role={"tablist" as const} />;',
    'const x = <div role={"tab"!} />;',
    'const x = createElement("div", { [`role`]: "tab" });',
  ],
  accepted: [
    'const x = <TabList aria-label="Chats"><TabButton label="Chat" isActive onSelect={select} /></TabList>;',
    'const x = <div role="tabpanel" aria-labelledby={tabId} />;',
    'const x = <div role={role} />;',
    'const selector = \'[role="tab"]:not([aria-disabled="true"])\';',
  ],
});
