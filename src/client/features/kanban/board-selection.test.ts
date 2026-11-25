import { describe, expect, it } from 'vitest';
import {
  type BoardSelection,
  columnSelectionState,
  EMPTY_BOARD_SELECTION,
  selectedBoardIds,
  toggleBoardSelection,
  toggleColumnSelection,
} from './board-selection';

const waiting = ['w1', 'w2', 'w3', 'w4'];

function selected(selection: BoardSelection) {
  return [...selection.selectedIds].sort();
}

describe('board selection', () => {
  it('toggles one card and makes it the anchor', () => {
    const once = toggleBoardSelection(EMPTY_BOARD_SELECTION, waiting, 'w2', false);
    expect(selected(once)).toEqual(['w2']);
    expect(once.anchorId).toBe('w2');
    const twice = toggleBoardSelection(once, waiting, 'w2', false);
    expect(selected(twice)).toEqual([]);
    expect(EMPTY_BOARD_SELECTION.selectedIds.size).toBe(0);
  });

  it('applies the clicked card’s new state to the range in either direction', () => {
    const anchored = toggleBoardSelection(EMPTY_BOARD_SELECTION, waiting, 'w4', false);
    const range = toggleBoardSelection(anchored, waiting, 'w2', true);
    expect(selected(range)).toEqual(['w2', 'w3', 'w4']);
    const cleared = toggleBoardSelection(range, waiting, 'w3', true);
    // w3 was selected, so the range w2..w3 is cleared.
    expect(selected(cleared)).toEqual(['w4']);
  });

  it('toggles only the card when the anchor is not in its column', () => {
    const anchored = toggleBoardSelection(EMPTY_BOARD_SELECTION, ['d1'], 'd1', false);
    const range = toggleBoardSelection(anchored, waiting, 'w3', true);
    expect(selected(range)).toEqual(['d1', 'w3']);
  });

  it('selects a whole column, reports partial state and clears a full column', () => {
    const one = toggleBoardSelection(EMPTY_BOARD_SELECTION, waiting, 'w1', false);
    expect(columnSelectionState(one, waiting)).toBe('some');
    expect(columnSelectionState(one, ['d1'])).toBe('none');
    const all = toggleColumnSelection(one, waiting);
    expect(columnSelectionState(all, waiting)).toBe('all');
    expect(all.anchorId).toBe('w1');
    expect(selected(toggleColumnSelection(all, waiting))).toEqual([]);
  });

  it('lists selected cards in board order, skipping cards not on the board', () => {
    const selection: BoardSelection = {
      selectedIds: new Set(['w3', 'gone', 'w1']),
      anchorId: null,
    };
    expect(selectedBoardIds(selection, waiting)).toEqual(['w1', 'w3']);
  });
});
