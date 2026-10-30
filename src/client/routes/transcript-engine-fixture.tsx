import { elementScroll, measureElement, useVirtualizer } from '@tanstack/react-virtual';
import { useRef, useState } from 'react';
import { isNativeCompensation } from '@/client/features/chat/transcript-scroll-events';

/** Development-only proof of the installed engine, without application policy. */
export function TranscriptEngineFixture() {
  const nextKey = useRef(999);
  const viewport = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState(() =>
    Array.from({ length: 40 }, (_, key) => ({ key, height: 80 }))
  );
  const [nativeFollow, setNativeFollow] = useState(false);
  const engine = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => 80,
    getItemKey: (index) => rows[index]?.key ?? index,
    anchorTo: nativeFollow ? 'end' : 'start',
    followOnAppend: nativeFollow,
    overscan: 5,
    scrollToFn: (offset, options, instance) => {
      const node = viewport.current;
      if (node && options.behavior === undefined && options.adjustments === undefined) {
        node.dataset.deferredWrites = String(Number(node.dataset.deferredWrites ?? 0) + 1);
        node.dataset.deferredAllowed = String(isNativeCompensation(options));
      }
      elementScroll(offset, options, instance);
    },
    measureElement: (node, entry, instance) => {
      const height = measureElement(node, entry, instance);
      node.setAttribute('data-engine-measured-height', String(height));
      return height;
    },
  });
  engine.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    item.end <= (instance.scrollOffset ?? 0) + 1;

  return (
    <section>
      <div className="flex flex-wrap gap-2 p-2">
        <button
          type="button"
          onClick={() => {
            engine.cancelScroll();
            const visible = engine.getVirtualItemForOffset(viewport.current?.scrollTop ?? 0);
            setRows((items) =>
              items.map((item, index) =>
                index === (visible?.index ?? 1) - 1 ? { ...item, height: item.height + 200 } : item
              )
            );
          }}
        >
          Grow preceding engine row
        </button>
        <button
          type="button"
          onClick={() => {
            const key = nextKey.current++;
            setRows((items) => [{ key, height: 1200 }, ...items]);
          }}
        >
          Prepend giant engine row
        </button>
        <button type="button" onClick={() => engine.scrollToEnd({ behavior: 'instant' })}>
          End command
        </button>
        <button type="button" onClick={() => engine.cancelScroll()}>
          Cancel command
        </button>
        <button type="button" onClick={() => setNativeFollow((value) => !value)}>
          Toggle native follow
        </button>
        <button
          type="button"
          onClick={() => {
            const key = nextKey.current++;
            setRows((items) => [...items, { key, height: 120 }]);
          }}
        >
          Append engine row
        </button>
        <button
          type="button"
          onClick={() =>
            setRows((items) =>
              items.map((item, index) =>
                index === items.length - 1 ? { ...item, height: item.height + 200 } : item
              )
            )
          }
        >
          Grow engine row
        </button>
      </div>
      <div
        ref={viewport}
        data-testid="engine-viewport"
        style={{ height: 320, overflow: 'auto', overflowAnchor: 'none' }}
      >
        <div style={{ height: engine.getTotalSize(), position: 'relative' }}>
          {engine.getVirtualItems().map((row) => (
            <div
              key={row.key}
              ref={engine.measureElement}
              data-index={row.index}
              data-row-key={row.key}
              style={{
                position: 'absolute',
                width: '100%',
                height: rows[row.index]?.height,
                transform: `translateY(${row.start}px)`,
              }}
            >
              Engine row {row.key}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
