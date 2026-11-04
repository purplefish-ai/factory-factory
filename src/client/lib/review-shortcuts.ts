const REVIEW_SHORTCUT_BLOCKING_CONTEXT =
  'input, textarea, select, dialog, [contenteditable]:not([contenteditable="false"]), ' +
  '[role="combobox"], [role="listbox"], [role="option"], [role="menu"], [role="menubar"], ' +
  '[role^="menuitem"], [role="dialog"], [role="alertdialog"], [role="textbox"], [role="searchbox"]';

/**
 * True when a page-level Reviews shortcut should yield: the event was already
 * handled, carries a Ctrl/Alt/Meta modifier (browser and OS shortcuts such as
 * ⌘D), or targets a text field, menu, dialog or unrelated control. Shift is
 * left to the caller so deliberate chords such as Shift+A can be told apart
 * from plain keys.
 */
export function shouldIgnoreReviewShortcut(event: KeyboardEvent): boolean {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  ) {
    return true;
  }
  const target = event.target instanceof Element ? event.target : document.activeElement;
  if (target?.closest(REVIEW_SHORTCUT_BLOCKING_CONTEXT)) {
    return true;
  }
  const control = target?.closest('button, a[href]');
  return !!control && !control.matches('[data-review-list] > button');
}

/**
 * Normalizes a keydown into a Reviews shortcut name: plain keys stay as-is
 * (`j`), Shift chords become `Shift+A`, and ignored events return null.
 */
export function getReviewShortcut(event: KeyboardEvent): string | null {
  if (shouldIgnoreReviewShortcut(event)) {
    return null;
  }
  return event.shiftKey ? `Shift+${event.key.toUpperCase()}` : event.key;
}
