import { readStorageItem, removeStorageItem, writeStorageItem } from '@/client/lib/browser-storage';

const SETUP_WARNING_DISMISSED_PREFIX = 'ff_setup_warning_dismissed:';

function getSetupWarningDismissedKey(workspaceId: string): string {
  return `${SETUP_WARNING_DISMISSED_PREFIX}${workspaceId}`;
}

export function isSetupWarningDismissed(
  workspaceId: string,
  initErrorMessage: string | null
): boolean {
  return initErrorMessage
    ? readStorageItem(getSetupWarningDismissedKey(workspaceId)) === initErrorMessage
    : false;
}

/** Best effort: dismissal is not remembered when storage refuses it. */
export function rememberSetupWarningDismissed(
  workspaceId: string,
  initErrorMessage: string | null
) {
  if (initErrorMessage) {
    writeStorageItem(getSetupWarningDismissedKey(workspaceId), initErrorMessage);
  }
}

export function forgetSetupWarningDismissed(workspaceId: string) {
  removeStorageItem(getSetupWarningDismissedKey(workspaceId));
}
