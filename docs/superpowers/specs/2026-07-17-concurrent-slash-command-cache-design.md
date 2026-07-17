# Concurrent Slash-Command Cache Design

## Problem

`SlashCommandCacheService.setCachedCommands()` reads the shared `UserSettings.cachedSlashCommands`
JSON document, merges one provider's commands, and unconditionally writes the whole document. Two
provider sessions can read the same version and then overwrite each other, so the later write can
silently discard the other provider's cache update.

## Considered approaches

1. **Compare-and-swap through the settings capsule (chosen).** Add a settings-accessor operation
   that conditionally updates `cachedSlashCommands` when `updatedAt` still matches. The session
   service retries its provider merge up to five times. This follows the existing workspace-order
   pattern while preserving Prisma model ownership.
2. **Update Prisma directly from the session service.** This is shorter, but it bypasses the
   settings capsule's ownership of `UserSettings` and would violate repository dependency rules.
3. **Move slash-command payload merging into the settings accessor.** This centralizes the retry,
   but couples a generic persistence capsule to session-specific payload versions and command
   normalization.

## Design

The settings accessor will expose
`compareAndSetCachedSlashCommands(expectedUpdatedAt, cachedSlashCommands): Promise<boolean>`.
It will call `userSettings.updateMany()` with `userId: 'default'` and the expected `updatedAt`,
returning true only when exactly one row changed.

`setCachedCommands()` will normalize commands once, then perform at most five immediate attempts.
Each attempt reads current settings, parses and migrates the provider map exactly as today, skips a
write when that provider's commands are already equal, builds a new whole-document payload, and
uses the conditional accessor operation. A stale write retries from a fresh read, so it merges any
concurrent provider update. Database errors and exhausted conflicts remain best-effort cache
failures: the existing warning path records them without failing session processing.

This change does not alter payload format, cache-read behavior, command normalization, schemas, or
UI behavior.

## Testing

A focused unit regression will coordinate two concurrent provider updates against an in-memory
settings row. Both calls initially read the same payload; the first conditional write advances the
row version, forcing the second call to re-read and merge. The final payload must contain both new
provider command lists.

Existing tests continue to cover versioned reads, legacy CODEX migration, malformed payloads,
normalized writes, empty-cache behavior, and best-effort error handling. The full repository
verification sequence is `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`.
