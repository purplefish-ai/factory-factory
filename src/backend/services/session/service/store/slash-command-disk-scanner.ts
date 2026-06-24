import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import type { CommandInfo } from '@/shared/acp-protocol';

function parseCommandDescription(filePath: string): string {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) {
      return '';
    }
    const descLine = match[1]?.split(/\r?\n/).find((line) => line.startsWith('description:'));
    return descLine ? descLine.slice('description:'.length).trim() : '';
  } catch {
    return '';
  }
}

function isRealPathContainedInRoot(rootReal: string, targetReal: string): boolean {
  const rel = relative(rootReal, targetReal);
  return !(rel.startsWith('..') || isAbsolute(rel));
}

function isContainedInRoot(rootReal: string, filePath: string): boolean {
  try {
    const fileReal = realpathSync(filePath);
    return isRealPathContainedInRoot(rootReal, fileReal);
  } catch {
    return false;
  }
}

export function commandNameKey(name: string): string {
  const normalized = name.trim().replace(/^\/+/, '');
  const colonIndex = normalized.lastIndexOf(':');
  return colonIndex >= 0 ? normalized.slice(colonIndex + 1) : normalized;
}

export function isWorkspaceScopedCommandName(name: string): boolean {
  const normalized = name.trim().replace(/^\/+/, '');
  const colonIndex = normalized.lastIndexOf(':');
  if (colonIndex < 0) {
    return false;
  }
  const scope = normalized.slice(0, colonIndex);
  return scope === 'project' || scope === 'workspace';
}

function scanCommandsFromDir(dir: string, seen: Set<string>, containmentRoot = dir): CommandInfo[] {
  let files: string[];
  let rootReal: string;
  try {
    rootReal = realpathSync(containmentRoot);
    const dirReal = realpathSync(dir);
    if (!isRealPathContainedInRoot(rootReal, dirReal)) {
      return [];
    }
    files = readdirSync(dir).filter((file) => file.endsWith('.md'));
  } catch {
    return [];
  }

  const commands: CommandInfo[] = [];
  for (const file of files) {
    const filePath = join(dir, file);
    if (!isContainedInRoot(rootReal, filePath)) {
      continue;
    }
    const name = basename(file, '.md');
    const key = commandNameKey(name);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    commands.push({ name, description: parseCommandDescription(filePath) });
  }
  return commands;
}

export function scanClaudeGlobalCommandsFromDisk(seen = new Set<string>()): CommandInfo[] {
  return scanCommandsFromDir(join(homedir(), '.claude', 'commands'), seen);
}

export function scanClaudeWorkspaceCommandsFromDisk(
  worktreePath: string | null,
  seen = new Set<string>()
): CommandInfo[] {
  if (!worktreePath) {
    return [];
  }
  return scanCommandsFromDir(join(worktreePath, '.claude', 'commands'), seen, worktreePath);
}

export function scanClaudeWorkspaceCommandNames(worktreePath: string | null): Set<string> {
  return new Set(
    scanClaudeWorkspaceCommandsFromDisk(worktreePath).map((command) => commandNameKey(command.name))
  );
}
