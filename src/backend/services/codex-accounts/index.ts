import { configService } from '@/backend/services/config.service';
import { codexAccountAccessor } from './resources/codex-account.accessor';
import { CodexAccountService } from './service/codex-account.service';
import {
  loginNativeAccount,
  probeNativeAccount,
  probeNativeIdentity,
} from './service/native-account';
export { CodexAccountService } from './service/codex-account.service';
export type { CodexRuntimeContext } from './service/types';
export { getMetadataCredentialsStore } from './service/metadata-credentials-store';
export { NATIVE_DEFAULT_CODEX_ACCOUNT_ID } from '@/shared/codex-accounts';
export const codexAccountService = new CodexAccountService({
  store: codexAccountAccessor,
  config: configService,
  probe: probeNativeAccount,
  probeIdentity: probeNativeIdentity,
  login: loginNativeAccount,
});

export {
  exportCodexAccountMetadata,
  restoreCodexAccountMetadata,
  resolveRestoredCodexAccountId,
} from './service/codex-account-backup';
