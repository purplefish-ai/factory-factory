import { ApplicationError } from '@/backend/lib/application-error';
import {
  DEFAULT_SESSION_MODEL_BY_PROVIDER,
  normalizeSessionModelForProvider,
} from '@/shared/session-model';
import type { SessionProvider } from '@prisma-gen/client';

export {
  DEFAULT_SESSION_MODEL_BY_PROVIDER,
  normalizeSessionModelForProvider,
} from '@/shared/session-model';

export function resolveSessionModelForProvider(
  model: string | null | undefined,
  provider: SessionProvider,
  fallbackModel?: string | null
): string {
  const explicit = normalizeSessionModelForProvider(model, provider);
  if (model?.trim() && !explicit) {
    throw new ApplicationError(
      'INVALID_INPUT',
      `Model "${model}" is not compatible with ${provider}`
    );
  }
  return (
    explicit ??
    normalizeSessionModelForProvider(fallbackModel, provider) ??
    DEFAULT_SESSION_MODEL_BY_PROVIDER[provider]
  );
}
