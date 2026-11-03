// Domain: port-share
// Public API for sharing loopback ports through `ff tailscale`.
// Consumers should import from '@/backend/services/port-share' only.

export { parseSharePort } from '@/shared/port-share-policy';
export {
  PortShareError,
  type PortShareFailure,
  PortShareService,
  portShareService,
} from './port-share.service';
