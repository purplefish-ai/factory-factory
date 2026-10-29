import type { AccountObservation } from './types';
export interface AccountCandidate {
  id: string;
  pressure: number;
}
export function accountPressure(
  observation: AccountObservation,
  requestedModel?: string
): number | null {
  const catalog = observation.modelCatalog ?? [];
  const chosen =
    requestedModel && requestedModel !== 'default'
      ? catalog.find((model) => model.id === requestedModel || model.model === requestedModel)
      : catalog.find((model) => model.isDefault);
  if (
    requestedModel &&
    requestedModel !== 'default' &&
    observation.models.length &&
    !observation.models.includes(requestedModel)
  ) {
    return null;
  }
  const effective = chosen?.model ?? (requestedModel === 'default' ? undefined : requestedModel);
  const windows = observation.usage.windows.filter((window) => {
    const bucket = window.id.split(':')[0];
    const nativeScope = observation.usageModelScopes?.[window.id];
    if (nativeScope) {
      return nativeScope === effective || bucket === requestedModel;
    }
    if (nativeScope === null || bucket === 'codex') {
      return true;
    }
    return effective !== undefined && bucket === effective;
  });
  return windows.length ? Math.max(...windows.map((window) => window.usedPercent)) : 101;
}
export function chooseAccount(
  candidates: AccountCandidate[],
  reservation: (id: string) => number,
  recency: (id: string) => number
): string {
  const sorted = [...candidates].sort(
    (a, b) =>
      Math.floor(a.pressure / 10) - Math.floor(b.pressure / 10) ||
      reservation(a.id) - reservation(b.id) ||
      recency(a.id) - recency(b.id)
  );
  const id = sorted[0]?.id;
  if (!id) {
    throw new Error('No usable Codex account has remaining capacity');
  }
  return id;
}
