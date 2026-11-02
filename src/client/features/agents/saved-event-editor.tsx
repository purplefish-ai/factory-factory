import { useEffect, useRef } from 'react';
import { invalidateSavedAgentQueries } from '@/client/lib/agent-query-cache';
import { trpc } from '@/client/lib/trpc';
import { EventAgentEditor } from './event-agent-editor';
import type { EventAgent } from './types';

/** Every operation closes over its original owner; invalidation survives unmount. */
export function SavedEventEditor({
  agent,
  onCancel,
  onSaved,
}: {
  agent: EventAgent;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const utils = trpc.useUtils();
  const update = trpc.agent.updateSaved.useMutation();
  const validation = trpc.agent.validateDraft.useMutation();
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const owner = { projectId: agent.projectId, agentId: agent.id };
  return (
    <EventAgentEditor
      agent={agent}
      onCancel={onCancel}
      onSave={async (specification, revision) => {
        try {
          await update.mutateAsync({
            ...owner,
            expectedManagementRevision: revision,
            specification,
          });
        } catch (error) {
          await utils.agent.get.invalidate(owner);
          throw error;
        }
        await invalidateSavedAgentQueries(utils, owner.projectId, owner.agentId);
        if (active.current) {
          onSaved();
        }
      }}
      onValidate={(specification) =>
        validation.mutateAsync({ projectId: owner.projectId, specification })
      }
      onSources={(input) =>
        utils.client.agent.projectSources.query({ projectId: owner.projectId, ...input })
      }
      onReload={() => utils.agent.get.fetch(owner)}
    />
  );
}
