import { describeRuleFixtures } from '../testing/rule-fixtures';

describeRuleFixtures('stable-context-value', {
  rejected: [
    'const x = <KanbanContext.Provider value={{ a, b }}>{c}</KanbanContext.Provider>;',
    'const x = <PanelContext value={[state, setState]}>{c}</PanelContext>;',
    'const x = <Ctx.Provider value={() => run()}>{c}</Ctx.Provider>;',
    'const x = <SearchContext value={buildValue(a)}>{c}</SearchContext>;',
    'const x = <Ctx.Provider value={ready ? { a } : null}>{c}</Ctx.Provider>;',
    'const x = <StoreContext value={new Store()}>{c}</StoreContext>;',
    'const x = <Ctx.Provider value={{ a } as Value}>{c}</Ctx.Provider>;',
    'const x = createElement(Ctx.Provider, { value: { a } }, c);',
    'const x = React.createElement(NavContext, { value: [a] }, c);',
    'const x = <SlotContext value={<Icon />}>{c}</SlotContext>;',
    'const x = <Ctx.Provider value={useState(0)}>{c}</Ctx.Provider>;',
  ],
  accepted: [
    'const x = <KanbanContext.Provider value={value}>{c}</KanbanContext.Provider>;',
    'const x = <PanelContext value={state}>{c}</PanelContext>;',
    'const x = <ThemeContext value="dark">{c}</ThemeContext>;',
    'const x = <Ctx.Provider value={useMemo(() => ({ a }), [a])}>{c}</Ctx.Provider>;',
    'const x = <Ctx.Provider value={React.useCallback(run, [])}>{c}</Ctx.Provider>;',
    'const x = <Ctx.Provider value={context ?? DEFAULT_CONTEXT}>{c}</Ctx.Provider>;',
    'const x = <Select value={{ id }} />;',
    'const x = <Tooltip.Root value={[a]} />;',
    'const x = createElement(Ctx.Provider, { value }, c);',
  ],
});
