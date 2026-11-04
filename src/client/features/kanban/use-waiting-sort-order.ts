import { useState } from 'react';
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
