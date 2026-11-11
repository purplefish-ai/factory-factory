/**
 * The composer of the selected chat session: its draft and attachments, loaded
 * from and saved to sessionStorage per session.
 *
 * A session change loads the next session's composer while rendering, so no
 * commit shows the previous session's draft or attachments. Each selection is a
 * new visit: callbacks bound to an earlier visit, including an earlier visit to
 * the same session, are ignored.
 *
 * Chat settings persistence stays in use-chat-state, next to the settings
 * reducer actions.
 */

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useLatestRef } from '@/client/hooks/use-stable-callback';
import type { MessageAttachment } from '@/lib/chat-protocol';
import {
  clearDraft,
  clearInputAttachments as clearPersistedInputAttachments,
  loadDraft,
  loadInputAttachments,
  persistDraft,
  persistInputAttachments,
} from './chat-persistence';

/** Identifies one selection of a session; a new object on every selection. */
export interface ChatSessionVisit {
  dbSessionId: string | null;
}

interface ComposerState {
  visit: ChatSessionVisit;
  draft: string;
  attachments: MessageAttachment[];
  /** Advances whenever the attachments empty, so a drop zone can restart. */
  generation: number;
}

function loadComposer(dbSessionId: string | null, generation: number): ComposerState {
  return {
    visit: { dbSessionId },
    draft: loadDraft(dbSessionId),
    attachments: loadInputAttachments(dbSessionId),
    generation,
  };
}

function showAttachmentPersistenceError(operation: 'save' | 'clear') {
  if (operation === 'save') {
    toast.error("Couldn't autosave attachments.", {
      description:
        'They are still in this composer, but may be lost if you reload or switch sessions.',
    });
    return;
  }

  toast.error("Couldn't clear saved attachments.", {
    description: 'Previously saved attachments may reappear after a reload or session switch.',
  });
}

export interface UseChatPersistenceReturn {
  visit: ChatSessionVisit;
  inputDraft: string;
  /** Set the draft and save it (debounced). */
  setInputDraft: (draft: string) => void;
  inputAttachments: MessageAttachment[];
  /** The latest attachments, including ones set earlier in the same event. */
  inputAttachmentsRef: RefObject<MessageAttachment[]>;
  inputDraftGeneration: number;
  /** Set and save the attachments; ignored once another session is selected. */
  setInputAttachments: (attachments: React.SetStateAction<MessageAttachment[]>) => void;
  /** Clear the draft and attachments from the composer and storage. */
  clearInput: () => void;
}

export function useChatPersistence(dbSessionId: string | null): UseChatPersistenceReturn {
  const [stored, setComposer] = useState(() => loadComposer(dbSessionId, 0));
  let composer = stored;
  if (stored.visit.dbSessionId !== dbSessionId) {
    composer = loadComposer(dbSessionId, stored.generation);
    setComposer(composer);
  }
  const { visit } = composer;
  const visitRef = useLatestRef(visit);
  const dbSessionIdRef = useLatestRef(dbSessionId);
  const inputAttachmentsRef = useLatestRef(composer.attachments);
  const persistDraftDebounced = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingDraftRef = useRef<{ sessionId: string | null; draft: string } | undefined>(
    undefined
  );

  const setInputDraft = useCallback((draft: string) => {
    setComposer((current) => ({ ...current, draft }));
    const sessionId = dbSessionIdRef.current;

    // Debounce sessionStorage write to avoid blocking main thread on every keystroke
    if (persistDraftDebounced.current) {
      clearTimeout(persistDraftDebounced.current);
    }
    pendingDraftRef.current = { sessionId, draft };
    persistDraftDebounced.current = setTimeout(() => {
      persistDraft(sessionId, draft);
      pendingDraftRef.current = undefined;
      persistDraftDebounced.current = undefined;
    }, 300);
  }, []);

  // Bound to the visit it was rendered for, so a slow paste/drop/upload cannot
  // land in a later session.
  const setInputAttachments = useCallback(
    (update: React.SetStateAction<MessageAttachment[]>) => {
      if (visitRef.current !== visit) {
        return;
      }
      const attachments =
        typeof update === 'function' ? update(inputAttachmentsRef.current) : update;
      inputAttachmentsRef.current = attachments;
      setComposer((current) => ({
        ...current,
        attachments,
        generation: attachments.length === 0 ? current.generation + 1 : current.generation,
      }));
      const persistenceResult = persistInputAttachments(visit.dbSessionId, attachments);
      if (!persistenceResult.ok) {
        showAttachmentPersistenceError(persistenceResult.operation);
      }
    },
    [visit]
  );

  const clearInput = useCallback(() => {
    inputAttachmentsRef.current = [];
    setComposer((current) => ({
      ...current,
      draft: '',
      attachments: [],
      generation: current.generation + 1,
    }));
    if (persistDraftDebounced.current) {
      clearTimeout(persistDraftDebounced.current);
      persistDraftDebounced.current = undefined;
    }
    pendingDraftRef.current = undefined;
    clearDraft(dbSessionIdRef.current);
    const persistenceResult = clearPersistedInputAttachments(dbSessionIdRef.current);
    if (!persistenceResult.ok) {
      showAttachmentPersistenceError(persistenceResult.operation);
    }
  }, []);

  // Flush the outgoing draft when the session changes or the composer unmounts,
  // including switches made before the debounce completes.
  useEffect(() => {
    return () => {
      if (persistDraftDebounced.current) {
        clearTimeout(persistDraftDebounced.current);
        persistDraftDebounced.current = undefined;
      }
      const pending = pendingDraftRef.current;
      if (pending && pending.sessionId === dbSessionId) {
        persistDraft(dbSessionId, pending.draft);
        pendingDraftRef.current = undefined;
      }
    };
  }, [dbSessionId]);

  return {
    visit,
    inputDraft: composer.draft,
    setInputDraft,
    inputAttachments: composer.attachments,
    inputAttachmentsRef,
    inputDraftGeneration: composer.generation,
    setInputAttachments,
    clearInput,
  };
}
