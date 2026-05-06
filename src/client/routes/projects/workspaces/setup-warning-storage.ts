const SETUP_WARNING_DISMISSED_PREFIX = 'ff_setup_warning_dismissed:';

function getStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getSetupWarningDismissedKey(workspaceId: string): string {
  return `${SETUP_WARNING_DISMISSED_PREFIX}${workspaceId}`;
}

export function isSetupWarningDismissed(
  workspaceId: string,
  initErrorMessage: string | null
): boolean {
  if (!initErrorMessage) {
    return false;
  }

  try {
    return getStorage()?.getItem(getSetupWarningDismissedKey(workspaceId)) === initErrorMessage;
  } catch {
    return false;
  }
}

export function rememberSetupWarningDismissed(
  workspaceId: string,
  initErrorMessage: string | null
) {
  if (!initErrorMessage) {
    return;
  }

  try {
    getStorage()?.setItem(getSetupWarningDismissedKey(workspaceId), initErrorMessage);
  } catch {
    // Non-blocking: ignore localStorage failures.
  }
}

export function forgetSetupWarningDismissed(workspaceId: string) {
  try {
    getStorage()?.removeItem(getSetupWarningDismissedKey(workspaceId));
  } catch {
    // Non-blocking: ignore localStorage failures.
  }
}
