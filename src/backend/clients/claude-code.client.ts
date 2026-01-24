import { v4 as uuidv4 } from 'uuid';
import { promptFileManager } from '../agents/prompts/file-manager.js';
import { requireClaudeSetup } from './claude-auth.js';
import { tmuxClient } from './tmux.client.js';

export interface AgentExecutionProfile {
  model?: string;
  permissions: 'skip' | 'prompt';
  sessionId?: string;
}

export interface WorkerSessionContext {
  agentId: string;
  sessionId: string;
  tmuxSessionName: string;
  systemPromptPath: string;
  workingDir: string;
}

// Agent execution profiles
export const AGENT_PROFILES: Record<string, AgentExecutionProfile> = {
  WORKER: {
    model: process.env.WORKER_MODEL || 'claude-sonnet-4-5-20250929',
    permissions: 'skip', // Use --dangerously-skip-permissions
  },
  SUPERVISOR: {
    model: process.env.SUPERVISOR_MODEL || 'claude-sonnet-4-5-20250929',
    permissions: 'skip',
  },
};

/**
 * Generate unique session ID for Claude Code
 */
export function generateSessionId(): string {
  return uuidv4();
}

/**
 * Create tmux session name for agent
 */
function getTmuxSessionName(agentId: string): string {
  return `worker-${agentId}`;
}

/**
 * Create new worker session with Claude Code CLI
 */
export async function createWorkerSession(
  agentId: string,
  systemPrompt: string,
  workingDir: string
): Promise<WorkerSessionContext> {
  // Verify Claude Code setup
  await requireClaudeSetup();

  // Generate session ID
  const sessionId = generateSessionId();
  const tmuxSessionName = getTmuxSessionName(agentId);

  // Write system prompt to temporary file
  const systemPromptPath = promptFileManager.writePromptFile(agentId, systemPrompt);

  // Get agent profile
  const profile = AGENT_PROFILES.WORKER;

  // Build Claude CLI command
  const claudeCommand = buildClaudeCommand(sessionId, systemPromptPath, workingDir, profile);

  // Create tmux session (kill existing if needed)
  const exists = await tmuxClient.sessionExists(tmuxSessionName);
  if (exists) {
    await tmuxClient.killSession(tmuxSessionName);
  }

  // Create new tmux session
  await tmuxClient.createSession(tmuxSessionName, workingDir);

  // Remove ANTHROPIC_API_KEY from environment (force OAuth)
  await tmuxClient.setEnvironment(tmuxSessionName, 'ANTHROPIC_API_KEY');

  // Send Claude command to tmux session
  await tmuxClient.sendMessage(tmuxSessionName, claudeCommand);

  // Wait a moment for Claude to initialize
  await new Promise((resolve) => setTimeout(resolve, 2000));

  return {
    agentId,
    sessionId,
    tmuxSessionName,
    systemPromptPath,
    workingDir,
  };
}

/**
 * Build Claude Code CLI command with all flags
 */
function buildClaudeCommand(
  sessionId: string,
  systemPromptPath: string,
  _workingDir: string, // Reserved for future use
  profile: AgentExecutionProfile
): string {
  const parts = ['claude'];

  // Session ID for persistence
  parts.push(`--session-id ${sessionId}`);

  // System prompt injection
  parts.push(`--append-system-prompt-file ${systemPromptPath}`);

  // Skip permissions for automation
  if (profile.permissions === 'skip') {
    parts.push('--dangerously-skip-permissions');
  }

  // Model override if specified
  if (profile.model) {
    parts.push(`--model ${profile.model}`);
  }

  return parts.join(' ');
}

/**
 * Resume existing Claude session
 */
export async function resumeSession(
  agentId: string,
  sessionId: string,
  workingDir: string
): Promise<WorkerSessionContext> {
  await requireClaudeSetup();

  const tmuxSessionName = getTmuxSessionName(agentId);
  const profile = AGENT_PROFILES.WORKER;

  // Check if tmux session exists
  const exists = await tmuxClient.sessionExists(tmuxSessionName);
  if (!exists) {
    throw new Error(`Tmux session ${tmuxSessionName} does not exist. Cannot resume.`);
  }

  // Build resume command
  const resumeCommand = buildResumeCommand(sessionId, profile);

  // Send resume command to tmux
  await tmuxClient.sendMessage(tmuxSessionName, resumeCommand);

  return {
    agentId,
    sessionId,
    tmuxSessionName,
    systemPromptPath: '', // Not needed for resume
    workingDir,
  };
}

/**
 * Build Claude resume command
 */
function buildResumeCommand(sessionId: string, profile: AgentExecutionProfile): string {
  const parts = ['claude'];

  // Resume with session ID
  parts.push(`--resume ${sessionId}`);

  // Skip permissions
  if (profile.permissions === 'skip') {
    parts.push('--dangerously-skip-permissions');
  }

  // Model override if specified
  if (profile.model) {
    parts.push(`--model ${profile.model}`);
  }

  return parts.join(' ');
}

/**
 * Send message to Claude via tmux
 */
export async function sendMessage(agentId: string, message: string): Promise<void> {
  const tmuxSessionName = getTmuxSessionName(agentId);
  await tmuxClient.sendMessage(tmuxSessionName, message);
}

/**
 * Capture output from tmux session
 * Returns last N lines of visible content
 */
export function captureOutput(agentId: string, lines: number = 100): Promise<string> {
  const tmuxSessionName = getTmuxSessionName(agentId);
  return tmuxClient.capturePane(tmuxSessionName, lines);
}

/**
 * Check if Claude process is running in tmux session
 */
export async function getSessionStatus(agentId: string): Promise<{
  exists: boolean;
  running: boolean;
}> {
  const tmuxSessionName = getTmuxSessionName(agentId);

  const exists = await tmuxClient.sessionExists(tmuxSessionName);
  if (!exists) {
    return { exists: false, running: false };
  }

  // Check if any process is running (not just shell prompt)
  try {
    const command = await tmuxClient.getPaneCommand(tmuxSessionName);
    const running = command !== 'bash' && command !== 'zsh' && command !== 'sh';
    return { exists: true, running };
  } catch {
    return { exists: false, running: false };
  }
}

/**
 * Stop Claude process gracefully
 * Sends Ctrl+C to the tmux session
 */
export async function stopSession(agentId: string): Promise<void> {
  const tmuxSessionName = getTmuxSessionName(agentId);

  const exists = await tmuxClient.sessionExists(tmuxSessionName);
  if (!exists) {
    return; // Already stopped
  }

  // Send Ctrl+C to interrupt Claude
  await tmuxClient.sendInterrupt(tmuxSessionName);

  // Wait a moment
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

/**
 * Kill tmux session and cleanup
 * Use this for force cleanup
 */
export async function killSession(agentId: string): Promise<void> {
  const tmuxSessionName = getTmuxSessionName(agentId);

  const exists = await tmuxClient.sessionExists(tmuxSessionName);
  if (!exists) {
    return;
  }

  // Kill tmux session
  await tmuxClient.killSession(tmuxSessionName);

  // Cleanup system prompt file
  promptFileManager.deletePromptFile(agentId);
}

/**
 * List all worker tmux sessions
 */
export function listWorkerSessions(): Promise<string[]> {
  return tmuxClient.listSessionsByPrefix('worker-');
}
