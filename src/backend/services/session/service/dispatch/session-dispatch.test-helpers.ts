import { acpRuntimeManager } from '@/backend/services/session/service/acp';
import { sessionBackgroundDeliveryService } from '@/backend/services/session/service/lifecycle/session-background-delivery.service';
import {
  sessionConfigService,
  sessionService,
} from '@/backend/services/session/service/lifecycle/session-core-services';
import { SessionDispatchService } from './session-dispatch.service';

/** Supplies the same infrastructure ports as production; individual suites retain their mocks. */
export function createTestSessionDispatcher(): SessionDispatchService {
  return new SessionDispatchService({
    runtimeManager: acpRuntimeManager,
    configService: sessionConfigService,
    promptService: sessionService,
    backgroundDelivery: sessionBackgroundDeliveryService,
  });
}
