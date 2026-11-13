import { describeRuleFixtures } from '../testing/rule-fixtures';

describeRuleFixtures('no-render-ref-write', {
  rejected: [
    'function Panel() { const ref = useRef(0); ref.current = 1; return null; }',
    'function useLatest(value) { const latest = useRef(value); latest.current = value; return latest; }',
    'const Row = memo(function Row() { const renders = useRef(0); renders.current++; return null; });',
    'const usePrevious = (value) => { const previous = useRef(value); if (previous.current !== value) { previous.current = value; } };',
    'function Panel() { const last = useRef(null); last.current ||= value; return null; }',
    'function Panel() { const last = useRef(null); if (last.current === null) { init(); } else { last.current = value; } return null; }',
    'function useRows(rows) { const seen = useRef(0); return useMemo(() => { seen.current = rows.length; return rows; }, [rows]); }',
  ],
  accepted: [
    'function Panel() { const cache = useRef(null); if (cache.current === null) { cache.current = new Map(); } return null; }',
    'function Panel() { const cache = useRef(null); cache.current ??= new Map(); return null; }',
    'function Panel() { const count = useRef(0); useEffect(() => { count.current = 1; }); const onClick = () => { count.current += 1; }; return null; }',
    'function resetScope(scope) { scope.current = null; }',
    'function useRows(rows) { const seen = useRef(0); const onClick = useCallback(() => { seen.current = rows.length; }, [rows]); return onClick; }',
  ],
});
