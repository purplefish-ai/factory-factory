/**
 * The board's multi-select state. Ranges and "select all" act on one column's
 * cards in the order the board shows them, so they never reach cards the
 * filter hides or another column.
 */
export interface BoardSelection {
  readonly selectedIds: ReadonlySet<string>;
  /** The last card toggled; a range runs from here. */
  readonly anchorId: string | null;
}

export const EMPTY_BOARD_SELECTION: BoardSelection = { selectedIds: new Set(), anchorId: null };

/**
 * Toggles one card. With `range`, every card between the anchor and this one
 * in `columnIds` takes the state this card is toggled to; without an anchor in
 * the same column it toggles just this card.
 */
export function toggleBoardSelection(
  selection: BoardSelection,
  columnIds: readonly string[],
  id: string,
  range: boolean
): BoardSelection {
  const selectedIds = new Set(selection.selectedIds);
  const select = !selectedIds.has(id);
  const anchorIndex = selection.anchorId === null ? -1 : columnIds.indexOf(selection.anchorId);
  const index = columnIds.indexOf(id);
  const ids =
    range && anchorIndex !== -1 && index !== -1
      ? columnIds.slice(Math.min(anchorIndex, index), Math.max(anchorIndex, index) + 1)
      : [id];
  for (const each of ids) {
    if (select) {
      selectedIds.add(each);
    } else {
      selectedIds.delete(each);
    }
  }
  return { selectedIds, anchorId: id };
}

export type ColumnSelectionState = 'none' | 'some' | 'all';

export function columnSelectionState(
  selection: BoardSelection,
  columnIds: readonly string[]
): ColumnSelectionState {
  const count = columnIds.filter((id) => selection.selectedIds.has(id)).length;
  if (count === 0) {
    return 'none';
  }
  return count === columnIds.length ? 'all' : 'some';
}

/** Selects every card in the column, or clears the column when all are already selected. */
export function toggleColumnSelection(
  selection: BoardSelection,
  columnIds: readonly string[]
): BoardSelection {
  const selectedIds = new Set(selection.selectedIds);
  const clear = columnSelectionState(selection, columnIds) === 'all';
  for (const id of columnIds) {
    if (clear) {
      selectedIds.delete(id);
    } else {
      selectedIds.add(id);
    }
  }
  return { selectedIds, anchorId: selection.anchorId };
}

/** The selected cards among `orderedIds`, in that order. */
export function selectedBoardIds(selection: BoardSelection, orderedIds: readonly string[]) {
  return orderedIds.filter((id) => selection.selectedIds.has(id));
}
