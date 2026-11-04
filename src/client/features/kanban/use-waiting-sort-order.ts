import { useEffect, useState } from 'react';
import type { WaitingSortOrder } from './board-view';

const STORAGE_KEY = 'kanban-waiting-sort-order';

function readSortOrder(): WaitingSortOrder {
  try {
    if (localStorage.getItem(STORAGE_KEY) === 'created') {
      return 'created';
    }
  } catch {
    // Browser storage can be unavailable; keep sorting usable in memory.
  }
  return 'latest-message';
}

/** One browser preference shared across project boards. */
export function useWaitingSortOrder(): [WaitingSortOrder, (order: WaitingSortOrder) => void] {
  const [order, setOrder] = useState(readSortOrder);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (
        (event.key === STORAGE_KEY || event.key === null) &&
        (event.storageArea === null || event.storageArea === localStorage)
      ) {
        setOrder(readSortOrder());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return [
    order,
    (nextOrder) => {
      setOrder(nextOrder);
      try {
        localStorage.setItem(STORAGE_KEY, nextOrder);
      } catch {
        // A failed preference write must not interrupt the board.
      }
    },
  ];
}
