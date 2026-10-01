import { useLayoutEffect, useRef, useState } from 'react';

/** Own an inline edit and its entire save, including cache reconciliation. */
export function useInlineWorkspaceRename({
  workspaceId,
  projectId,
  name,
  onRename,
}: {
  workspaceId: string;
  projectId: string;
  name: string;
  onRename?: (workspaceId: string, name: string) => Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(name);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const ownerRef = useRef<{
    workspaceId: string;
    projectId: string;
    editing: boolean;
    saving: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    ownerRef.current = { workspaceId, projectId, editing: false, saving: false };
    setIsEditing(false);
    setIsSaving(false);
    return () => {
      ownerRef.current = null;
    };
  }, [workspaceId, projectId]);

  useLayoutEffect(() => {
    if (isEditing) {
      inputRef.current?.select();
    }
  }, [isEditing]);

  const handleStartEdit = () => {
    const owner = ownerRef.current;
    if (!owner || owner.editing || owner.saving || !onRename) {
      return;
    }
    owner.editing = true;
    setEditValue(name);
    setIsEditing(true);
  };

  const handleCancelRename = () => {
    if (ownerRef.current) {
      ownerRef.current.editing = false;
    }
    setIsEditing(false);
    setEditValue(name);
  };

  const handleSaveRename = async () => {
    const owner = ownerRef.current;
    // A ref blocks re-entry even before React commits the pending state.
    if (!owner?.editing || owner.saving) {
      return;
    }
    const trimmed = editValue.trim();
    if (!trimmed || trimmed === name || !onRename) {
      handleCancelRename();
      return;
    }
    owner.saving = true;
    setIsSaving(true);
    try {
      await onRename(workspaceId, trimmed);
    } catch {
      // The mutation surfaces the error; close and allow a fresh edit to retry.
      if (ownerRef.current === owner) {
        setEditValue(name);
      }
    } finally {
      // Navigation, including A/B/A, gives the new editor a different owner.
      if (ownerRef.current === owner) {
        owner.editing = false;
        owner.saving = false;
        setIsEditing(false);
        setIsSaving(false);
      }
    }
  };

  return {
    isEditing,
    editValue,
    setEditValue,
    isSaving,
    inputRef,
    handleStartEdit,
    handleSaveRename,
    handleCancelRename,
  };
}
