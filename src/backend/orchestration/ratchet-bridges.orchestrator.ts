/**
 * Ratchet Bridge Wiring
 *
 * Configures ratchet domain services with their cross-domain dependencies.
 * Called once at application startup (before ratchetService.start()).
 *
 * This file imports from domain barrels and wires typed bridge implementations
 * into each ratchet service's configure() method.
 */

import { githubCLIService } from '@/backend/domains/github';
import {
  ciFixerService,
  ciMonitorService,
  fixerSessionService,
  type RatchetGitHubBridge,
  type RatchetSessionBridge,
  ratchetService,
} from '@/backend/domains/ratchet';
import { sessionDomainService, sessionService } from '@/backend/domains/session';

export function configureRatchetBridges(): void {
  const sessionBridge: RatchetSessionBridge = {
    isSessionRunning: (id) => sessionService.isSessionRunning(id),
    isSessionWorking: (id) => sessionService.isSessionWorking(id),
    stopClaudeSession: (id) => sessionService.stopClaudeSession(id),
    startClaudeSession: (id, opts) => sessionService.startClaudeSession(id, opts),
    getClient: (id) => sessionService.getClient(id) ?? null,
    injectCommittedUserMessage: (id, msg) =>
      sessionDomainService.injectCommittedUserMessage(id, msg),
  };

  const githubBridge: RatchetGitHubBridge = {
    extractPRInfo: (url) => githubCLIService.extractPRInfo(url),
    getPRFullDetails: (repo, pr) => githubCLIService.getPRFullDetails(repo, pr),
    getReviewComments: (repo, pr) => githubCLIService.getReviewComments(repo, pr),
    computeCIStatus: (checks) =>
      githubCLIService.computeCIStatus(
        checks?.map((c) => ({
          status: c.status,
          conclusion: c.conclusion ?? undefined,
          state: undefined,
        })) ?? null
      ),
    getAuthenticatedUsername: () => githubCLIService.getAuthenticatedUsername(),
    fetchAndComputePRState: (prUrl) => githubCLIService.fetchAndComputePRState(prUrl),
  };

  // Wire all ratchet services with their cross-domain bridges
  ratchetService.configure({ session: sessionBridge, github: githubBridge });
  fixerSessionService.configure({ session: sessionBridge });
  ciFixerService.configure({ session: sessionBridge });
  ciMonitorService.configure({ session: sessionBridge, github: githubBridge });
}
