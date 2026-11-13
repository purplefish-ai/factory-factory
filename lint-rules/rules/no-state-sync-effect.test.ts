import { describeRuleFixtures } from '../testing/rule-fixtures';

describeRuleFixtures('no-state-sync-effect', {
  rejected: [
    'function Panel({ id }) { const [tab, setTab] = useState("info"); useEffect(() => { setTab("info"); }, [id]); return null; }',
    'useEffect(() => { if (!open) { return; } setIndex(0); setCount((count) => count + 1); }, [open]);',
    'React.useLayoutEffect(() => setSelected(items[0]), [items]);',
  ],
  accepted: [
    'useEffect(() => { setWidth(container.current.offsetWidth); }, [items]);',
    'useEffect(() => { setReady(true); }, []);',
    'useEffect(() => { const timer = setTimeout(() => setValue(next), 300); return () => clearTimeout(timer); }, [next]);',
    'useEffect(() => { toast.error(error); setOpen(false); }, [error]);',
    'useEffect(() => { setValue(readStoredValue(key)); }, [key]);',
    'useEffect(() => { if (!enabled) { return; } }, [enabled]);',
    'useEffect(() => { setTimeout(flush, delay); }, [delay]);',
  ],
});
