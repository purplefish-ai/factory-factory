// Shares loopback ports through `ff tailscale`.
export { parseSharePort } from '@/shared/port-share-policy';
export {
  PortShareError,
  type PortShareFailure,
  PortShareService,
  portShareService,
} from './service/port-share.service';
