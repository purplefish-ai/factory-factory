import { useEffect, useRef, useState } from 'react';
import type { SavedAgentSpecification } from '@/shared/agent-management';
import {
  parseSavedReplacement,
  savedDraftFrom,
  savedSpecificationFromDraft,
} from './event-agent-draft';
import type { EventAgent, EventDraftValidation, EventProjectSources } from './types';

export interface EventAgentEditorProps {
  agent: EventAgent;
  initialReplacement?: boolean;
  onSave: (specification: SavedAgentSpecification, revision: number) => Promise<void>;
  onValidate: (specification: SavedAgentSpecification) => Promise<EventDraftValidation>;
  onSources: (input: { connectionId?: string; cursor?: string }) => Promise<EventProjectSources>;
  onCancel: () => void;
  onReload?: () => Promise<EventAgent>;
}
function sourcePageResult(
  previous: EventProjectSources | undefined,
  result: EventProjectSources,
  append: boolean
): EventProjectSources {
  if (!append) {
    return result;
  }
  const channels = new Map(
    [...(previous?.slack.channels ?? []), ...(result.slack.channels ?? [])].map((channel) => [
      channel.id,
      channel,
    ])
  );
  return { ...result, slack: { ...result.slack, channels: [...channels.values()] } };
}
export function useEventAgentEditor(props: EventAgentEditorProps) {
  const [baseline, setBaseline] = useState(props.agent);
  const [draft, setDraft] = useState(() =>
    props.agent.specification ? savedDraftFrom(props.agent.specification) : null
  );
  const [replacementMode, setReplacementMode] = useState(props.initialReplacement ?? false);
  const [replacement, setReplacement] = useState('');
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<EventDraftValidation>();
  const [sources, setSources] = useState<EventProjectSources>();
  const [sourceError, setSourceError] = useState(false);
  const [busy, setBusy] = useState<'save' | 'validate' | 'sources' | 'reload' | null>(null);
  const submitting = useRef(false);
  const version = useRef(0);
  const sourceRequest = useRef(0);
  const busyRequest = useRef(0);
  const previewRequest = useRef(0);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const changed = () => {
    version.current += 1;
    if (!submitting.current) {
      busyRequest.current += 1;
      setBusy(null);
    }
    setPreview(undefined);
    setSources(undefined);
    setSourceError(false);
    setError(undefined);
  };
  const updateDraft = (next: NonNullable<typeof draft>) => {
    changed();
    setDraft(next);
  };
  const updateReplacement = (next: string) => {
    changed();
    setReplacement(next);
  };
  const specification = () =>
    replacementMode
      ? parseSavedReplacement(replacement)
      : draft
        ? savedSpecificationFromDraft(draft)
        : null;
  const isCurrent = (captured: number) => active.current && version.current === captured;
  const showFailure = (failure: unknown, captured: number) => {
    if (isCurrent(captured)) {
      setError(
        failure instanceof Error ? failure.message : 'Could not complete this request. Try again.'
      );
    }
  };
  const begin = (operation: NonNullable<typeof busy>) => {
    const target = { version: version.current, request: ++busyRequest.current };
    setBusy(operation);
    setError(undefined);
    return target;
  };
  const finish = (target: { version: number; request: number }) => {
    if (isCurrent(target.version) && busyRequest.current === target.request) {
      setBusy(null);
    }
  };
  const readSpecification = () => {
    try {
      const current = specification();
      if (!current) {
        throw new Error('A complete replacement is required.');
      }
      return current;
    } catch {
      setError(
        'Check the complete configuration: name, instructions, execution settings and event JSON must be valid. Supply the whole intended specification for replacement.'
      );
      return null;
    }
  };
  const save = async (current: SavedAgentSpecification) => {
    submitting.current = true;
    previewRequest.current += 1;
    const target = begin('save');
    try {
      await props.onSave(current, baseline.managementRevision);
    } catch (failure) {
      showFailure(failure, target.version);
    } finally {
      submitting.current = false;
      finish(target);
    }
  };
  const validate = async (current: SavedAgentSpecification) => {
    const request = ++previewRequest.current;
    const target = begin('validate');
    try {
      const result = await props.onValidate(current);
      if (isCurrent(target.version) && previewRequest.current === request) {
        setPreview(result);
      }
    } catch (failure) {
      if (previewRequest.current === request) {
        showFailure(failure, target.version);
      }
    } finally {
      finish(target);
    }
  };
  const discover = async (input: { connectionId?: string; cursor?: string }) => {
    const request = ++sourceRequest.current;
    setSourceError(false);
    const target = begin('sources');
    try {
      const result = await props.onSources(input);
      if (isCurrent(target.version) && sourceRequest.current === request) {
        setSources((previous) => sourcePageResult(previous, result, !!input.cursor));
      }
    } catch (failure) {
      if (sourceRequest.current === request && isCurrent(target.version)) {
        setSourceError(true);
        showFailure(failure, target.version);
      }
    } finally {
      finish(target);
    }
  };
  const attempt = (
    operation: 'save' | 'validate' | 'sources',
    input: { connectionId?: string; cursor?: string } = {}
  ) => {
    if (submitting.current) {
      return;
    }
    if (operation === 'sources') {
      return discover(input);
    }
    const current = readSpecification();
    if (current) {
      return operation === 'save' ? save(current) : validate(current);
    }
    return undefined;
  };
  const applyLatest = (latest: EventAgent) => {
    changed();
    setBaseline(latest);
    setDraft(latest.specification ? savedDraftFrom(latest.specification) : null);
    setReplacementMode(false);
    setReplacement('');
  };
  const reload = async () => {
    if (!props.onReload || submitting.current) {
      return;
    }
    const target = begin('reload');
    try {
      const latest = await props.onReload();
      if (isCurrent(target.version) && busyRequest.current === target.request) {
        applyLatest(latest);
      }
    } catch (failure) {
      if (busyRequest.current === target.request) {
        showFailure(failure, target.version);
      }
    } finally {
      finish(target);
    }
  };
  return {
    baseline,
    draft,
    updateDraft,
    replacementMode,
    replacement,
    updateReplacement,
    startReplacement: () => {
      changed();
      setReplacementMode(true);
      setReplacement('');
    },
    sourceSelectionChanged: changed,
    error,
    preview,
    sources,
    sourceError,
    busy,
    attempt,
    stale: baseline.managementRevision !== props.agent.managementRevision,
    reload,
  };
}
