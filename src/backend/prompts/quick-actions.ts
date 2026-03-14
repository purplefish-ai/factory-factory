/**
 * Quick action loader.
 *
 * Default quick actions are defined by markdown files in prompts/quick-actions/.
 * Repositories can override/add actions through factory-factory.json quickActions config.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { FactoryConfigService } from '@/backend/services/factory-config.service';
import { createLogger } from '@/backend/services/logger.service';
import type {
  FactoryConfig,
  QuickActionMode,
  QuickActionSurface,
} from '@/shared/schemas/factory-config.schema';
import { createMarkdownLoader, parseFrontmatter } from './markdown-loader';

const logger = createLogger('quick-actions');

// =============================================================================
// Types
// =============================================================================

export interface QuickAction {
  /** Action ID (filename without .md extension) */
  id: string;
  /** Display name from frontmatter */
  name: string;
  /** Description from frontmatter */
  description: string;
  /** Where the action appears in UI */
  surface: QuickActionSurface;
  /** How the action executes */
  mode: QuickActionMode;
  /** Whether this action is rendered as one-click first-class button */
  pinned: boolean;
  /** Lucide icon name (optional) */
  icon?: string;
  /** Prompt content sent to the model */
  content: string;
}

interface ParsedQuickActionMarkdown {
  id: string;
  name: string;
  description: string;
  icon?: string;
  content: string;
  surface?: QuickActionSurface;
  mode?: QuickActionMode;
  pinned?: boolean;
}

type QuickActionConfigEntry = NonNullable<
  NonNullable<FactoryConfig['quickActions']>['actions']
>[number];

// =============================================================================
// Constants
// =============================================================================

// Path to quick-actions directory (relative to this file's location)
// From src/backend/prompts/ → src/backend → src → project root
const QUICK_ACTIONS_DIR = resolve(import.meta.dirname, '../../..', 'prompts/quick-actions');
const SURFACES: readonly QuickActionSurface[] = ['sessionBar', 'chatBar'];

const DEFAULT_CHAT_ACTIONS: readonly QuickAction[] = [
  {
    id: 'create-pr',
    name: 'Create Pull Request',
    description: 'Create a pull request for the current branch',
    surface: 'chatBar',
    mode: 'sendPrompt',
    pinned: false,
    icon: 'git-pull-request',
    content:
      'Create a pull request for the current branch using the GitHub CLI (gh). Include a clear title and description summarizing the changes.',
  },
  {
    id: 'address-pr-comments',
    name: 'Address PR Comments',
    description: 'Fetch and address pull request comments',
    surface: 'chatBar',
    mode: 'sendPrompt',
    pinned: false,
    icon: 'message-square-text',
    content:
      'Fetch the comments on the current pull request using the GitHub CLI (gh) and address any feedback or requested changes.',
  },
  {
    id: 'simplify-code',
    name: 'Simplify Code',
    description: 'Simplify recent changes',
    surface: 'chatBar',
    mode: 'sendPrompt',
    pinned: false,
    icon: 'sparkles',
    content:
      'Use the code-simplifier agent to review and simplify the recent changes. Focus on improving clarity, consistency, and maintainability while preserving all functionality.',
  },
] as const;

// =============================================================================
// Frontmatter Parser
// =============================================================================

const QuickActionFrontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  type: z.string().optional(),
  mode: z.string().optional(),
  surface: z.string().optional(),
  pinned: z.boolean().optional(),
});

// =============================================================================
// Quick Action Loading
// =============================================================================

function parseOptionalMode(value: string | undefined): QuickActionMode | undefined {
  if (value === 'newSession' || value === 'sendPrompt') {
    return value;
  }
  return undefined;
}

function parseOptionalSurface(value: string | undefined): QuickActionSurface | undefined {
  if (value === 'sessionBar' || value === 'chatBar') {
    return value;
  }
  return undefined;
}

function resolveLegacyTypeMode(type: string | undefined): QuickActionMode | undefined {
  if (type === 'agent') {
    return 'newSession';
  }
  if (type === 'script') {
    return 'sendPrompt';
  }
  return undefined;
}

/**
 * Parse a single quick action file.
 */
function parseQuickActionFile(
  filePath: string,
  content: string,
  id: string
): ParsedQuickActionMarkdown | null {
  const { frontmatter, body } = parseFrontmatter(content, {
    name: (v) => v,
    description: (v) => v,
    icon: (v) => v,
    type: (v) => v,
    mode: (v) => v,
    surface: (v) => v,
    pinned: (v) => v === 'true',
  });
  const parsedFrontmatter = QuickActionFrontmatterSchema.safeParse(frontmatter);
  const normalizedFrontmatter = parsedFrontmatter.success ? parsedFrontmatter.data : {};
  const mode =
    parseOptionalMode(normalizedFrontmatter.mode) ??
    resolveLegacyTypeMode(normalizedFrontmatter.type) ??
    undefined;
  const surface = parseOptionalSurface(normalizedFrontmatter.surface);
  const trimmedBody = body.trim();

  if (trimmedBody.length === 0) {
    logger.warn('Quick action markdown body is empty', { filePath, id });
    return null;
  }

  return {
    id,
    name: normalizedFrontmatter.name ?? id,
    description: normalizedFrontmatter.description ?? '',
    icon: normalizedFrontmatter.icon,
    content: trimmedBody,
    surface,
    mode,
    pinned: normalizedFrontmatter.pinned,
  };
}

const quickActionLoader = createMarkdownLoader<ParsedQuickActionMarkdown>({
  directory: QUICK_ACTIONS_DIR,
  logger,
  parseFile: parseQuickActionFile,
});

function includeDefaultsForSurface(
  config: FactoryConfig['quickActions'] | undefined,
  surface: QuickActionSurface
): boolean {
  const includeDefaults = config?.includeDefaults;
  if (typeof includeDefaults === 'boolean') {
    return includeDefaults;
  }
  if (includeDefaults && typeof includeDefaults === 'object') {
    return includeDefaults[surface] ?? true;
  }
  return true;
}

function getDefaultQuickActions(surface: QuickActionSurface): QuickAction[] {
  const sessionDefaults = quickActionLoader
    .load()
    .map<QuickAction>((action) => ({
      id: action.id,
      name: action.name,
      description: action.description,
      icon: action.icon,
      content: action.content,
      surface: action.surface ?? 'sessionBar',
      mode: action.mode ?? 'newSession',
      pinned: action.pinned ?? false,
    }))
    .filter((action) => action.surface === surface);

  if (surface === 'chatBar') {
    return [...DEFAULT_CHAT_ACTIONS, ...sessionDefaults];
  }

  return sessionDefaults;
}

function isPathWithinRepo(repoPath: string, actionPath: string): boolean {
  const absolute = resolve(repoPath, actionPath);
  const normalizedRoot = resolve(repoPath);
  const rel = relative(normalizedRoot, absolute);
  return rel === '' || !(rel.startsWith('..') || isAbsolute(rel));
}

async function loadRepoAction(params: {
  repoPath: string;
  actionPath: string;
  idOverride?: string;
}): Promise<ParsedQuickActionMarkdown | null> {
  if (!isPathWithinRepo(params.repoPath, params.actionPath)) {
    logger.warn('Ignoring quick action path outside repository', {
      repoPath: params.repoPath,
      actionPath: params.actionPath,
    });
    return null;
  }

  const fullPath = resolve(params.repoPath, params.actionPath);
  try {
    const content = await readFile(fullPath, 'utf-8');
    const fallbackId =
      params.actionPath.split('/').pop()?.replace(/\.md$/i, '') ?? params.actionPath;
    const parsed = parseQuickActionFile(fullPath, content, params.idOverride ?? fallbackId);
    if (!parsed) {
      return null;
    }
    return {
      ...parsed,
      id: params.idOverride ?? parsed.id,
    };
  } catch (error) {
    logger.warn('Failed to load repo quick action markdown', {
      repoPath: params.repoPath,
      actionPath: params.actionPath,
      error: String(error),
    });
    return null;
  }
}

function defaultModeForSurface(surface: QuickActionSurface): QuickActionMode {
  return surface === 'chatBar' ? 'sendPrompt' : 'newSession';
}

function defaultSurfaceForMode(mode: QuickActionMode): QuickActionSurface {
  return mode === 'sendPrompt' ? 'chatBar' : 'sessionBar';
}

function normalizeModeForSurface(params: {
  repoPath: string;
  id: string;
  surface: QuickActionSurface;
  mode: QuickActionMode;
}): QuickActionMode {
  const normalizedMode = defaultModeForSurface(params.surface);
  if (params.mode !== normalizedMode) {
    logger.warn('Quick action mode does not match surface; using surface default mode', {
      repoPath: params.repoPath,
      id: params.id,
      surface: params.surface,
      configuredMode: params.mode,
      normalizedMode,
    });
  }
  return normalizedMode;
}

function normalizeIdFromEntry(entry: { id?: string; path?: string }): string | null {
  if (entry.id) {
    return entry.id;
  }
  if (!entry.path) {
    return null;
  }
  const fileName = entry.path.split('/').pop() ?? entry.path;
  return fileName.replace(/\.md$/i, '');
}

function makeActionKey(surface: QuickActionSurface, id: string): string {
  return `${surface}:${id}`;
}

function deleteActionsById(
  actionMap: Map<string, QuickAction>,
  id: string,
  surface?: QuickActionSurface
): void {
  if (surface) {
    actionMap.delete(makeActionKey(surface, id));
    return;
  }
  for (const [key, action] of actionMap.entries()) {
    if (action.id === id) {
      actionMap.delete(key);
    }
  }
}

function findActionById(
  actionMap: Map<string, QuickAction>,
  id: string,
  surface?: QuickActionSurface
): QuickAction | undefined {
  if (surface) {
    return actionMap.get(makeActionKey(surface, id));
  }
  for (const action of actionMap.values()) {
    if (action.id === id) {
      return action;
    }
  }
  return undefined;
}

function sortResolvedActions(
  actions: QuickAction[],
  configuredOrder: Map<string, number>
): QuickAction[] {
  const withIndex = actions.map((action, index) => ({ action, index }));
  withIndex.sort((a, b) => {
    if (a.action.pinned !== b.action.pinned) {
      return a.action.pinned ? -1 : 1;
    }
    const aOrder = configuredOrder.get(a.action.id);
    const bOrder = configuredOrder.get(b.action.id);
    if (aOrder !== undefined && bOrder !== undefined && aOrder !== bOrder) {
      return aOrder - bOrder;
    }
    if (aOrder !== undefined && bOrder === undefined) {
      return -1;
    }
    if (aOrder === undefined && bOrder !== undefined) {
      return 1;
    }
    return a.index - b.index;
  });
  return withIndex.map((item) => item.action);
}

function seedDefaultActions(params: {
  config: FactoryConfig['quickActions'] | undefined;
  surface?: QuickActionSurface;
  actionMap: Map<string, QuickAction>;
}): void {
  const targetSurfaces = params.surface ? [params.surface] : [...SURFACES];
  for (const surface of targetSurfaces) {
    if (!includeDefaultsForSurface(params.config, surface)) {
      continue;
    }
    for (const defaultAction of getDefaultQuickActions(surface)) {
      if (defaultAction.content.trim().length === 0) {
        continue;
      }
      params.actionMap.set(makeActionKey(surface, defaultAction.id), defaultAction);
    }
  }
}

async function applyConfiguredEntry(params: {
  repoPath: string;
  index: number;
  entry: QuickActionConfigEntry;
  actionMap: Map<string, QuickAction>;
  configuredOrder: Map<string, number>;
}): Promise<void> {
  const { repoPath, index, entry, actionMap, configuredOrder } = params;
  const id = normalizeIdFromEntry(entry);
  if (!id) {
    logger.warn('Skipping quick action entry without id/path', { repoPath });
    return;
  }
  configuredOrder.set(id, index);

  const existing = findActionById(actionMap, id, entry.surface);
  const loadedFromRepo = entry.path
    ? await loadRepoAction({
        repoPath,
        actionPath: entry.path,
        idOverride: id,
      })
    : null;
  const modeCandidate = entry.mode ?? loadedFromRepo?.mode ?? existing?.mode;
  const resolvedSurface: QuickActionSurface =
    entry.surface ??
    loadedFromRepo?.surface ??
    existing?.surface ??
    (modeCandidate ? defaultSurfaceForMode(modeCandidate) : 'sessionBar');

  if (entry.enabled === false) {
    deleteActionsById(actionMap, id, entry.surface);
    return;
  }

  if (!(existing || loadedFromRepo)) {
    logger.warn('Skipping quick action override because id was not found and no path provided', {
      repoPath,
      id,
    });
    return;
  }

  const resolvedMode: QuickActionMode =
    entry.mode ?? loadedFromRepo?.mode ?? existing?.mode ?? defaultModeForSurface(resolvedSurface);
  const normalizedMode = normalizeModeForSurface({
    repoPath,
    id,
    surface: resolvedSurface,
    mode: resolvedMode,
  });
  const resolvedAction: QuickAction = {
    id,
    name: loadedFromRepo?.name ?? existing?.name ?? id,
    description: loadedFromRepo?.description ?? existing?.description ?? '',
    icon: entry.icon ?? loadedFromRepo?.icon ?? existing?.icon,
    content: loadedFromRepo?.content ?? existing?.content ?? '',
    surface: resolvedSurface,
    mode: normalizedMode,
    pinned: entry.pinned ?? loadedFromRepo?.pinned ?? existing?.pinned ?? false,
  };

  if (resolvedAction.content.trim().length === 0) {
    logger.warn('Skipping quick action with empty content', {
      repoPath,
      id: resolvedAction.id,
    });
    return;
  }

  deleteActionsById(actionMap, id, entry.surface);
  actionMap.set(makeActionKey(resolvedSurface, id), resolvedAction);
}

async function resolveQuickActions(params: {
  repoPath: string;
  factoryConfig: FactoryConfig | null;
  surface?: QuickActionSurface;
}): Promise<QuickAction[]> {
  const config = params.factoryConfig?.quickActions;
  const actionMap = new Map<string, QuickAction>();
  const configuredOrder = new Map<string, number>();
  seedDefaultActions({
    config,
    surface: params.surface,
    actionMap,
  });

  for (const [index, entry] of (config?.actions ?? []).entries()) {
    await applyConfiguredEntry({
      repoPath: params.repoPath,
      index,
      entry,
      actionMap,
      configuredOrder,
    });
  }

  const resolvedActions = Array.from(actionMap.values()).filter((action) =>
    params.surface ? action.surface === params.surface : true
  );
  return sortResolvedActions(resolvedActions, configuredOrder);
}

// =============================================================================
// Public API
// =============================================================================

/**
 * List built-in quick actions. Kept for compatibility and tests.
 */
export function listQuickActions(): QuickAction[] {
  return getDefaultQuickActions('sessionBar');
}

/**
 * Resolve quick actions for a repository using factory-factory.json.
 */
export async function listQuickActionsForRepo(params: {
  repoPath: string;
  surface?: QuickActionSurface;
}): Promise<QuickAction[]> {
  let config: FactoryConfig | null = null;
  try {
    config = await FactoryConfigService.readConfig(params.repoPath);
  } catch (error) {
    logger.warn('Failed to parse factory-factory.json for quick actions, using defaults', {
      repoPath: params.repoPath,
      error: String(error),
    });
  }
  return await resolveQuickActions({
    repoPath: params.repoPath,
    factoryConfig: config,
    surface: params.surface,
  });
}

/**
 * Resolve a quick action by ID for a repository.
 */
export async function getQuickActionForRepo(params: {
  repoPath: string;
  id: string;
  surface?: QuickActionSurface;
}): Promise<QuickAction | null> {
  const actions = await listQuickActionsForRepo({
    repoPath: params.repoPath,
    surface: params.surface,
  });
  return actions.find((action) => action.id === params.id) ?? null;
}

/**
 * Get a built-in quick action by ID.
 */
export function getQuickAction(id: string): QuickAction | null {
  return listQuickActions().find((action) => action.id === id) ?? null;
}

/**
 * Get built-in quick action prompt content by ID.
 */
export function getQuickActionContent(id: string): string | null {
  return getQuickAction(id)?.content ?? null;
}

/**
 * Clear the quick action cache (useful for testing or hot reloading).
 */
export function clearQuickActionCache(): void {
  quickActionLoader.clearCache();
}
