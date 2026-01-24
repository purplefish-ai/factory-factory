import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { v4 as uuidv4 } from 'uuid';
import { requireClaudeSetup } from './claude-auth.js';

const execAsync = promisify(exec);

/**
 * Escape a string for safe use in shell commands
 * Uses single quotes and escapes any embedded single quotes
 */
function shellEscape(str: string): string {
  // Replace single quotes with '\'' (end quote, escaped quote, start quote)
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/**
 * Validate tmux session name to prevent injection
 * Session names should only contain alphanumeric chars, underscores, and dashes
 */
function validateSessionName(name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid tmux session name: ${name}`);
  }
  return name;
}

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
 * Check if tmux session exists
 */
async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  try {
    // Session name should already be validated, but check again for safety
    const validatedName = validateSessionName(sessionName);
    await execAsync(`tmux has-session -t ${validatedName} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
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
  const tmuxSessionName = validateSessionName(getTmuxSessionName(agentId));

  // Write system prompt to temporary file
  const systemPromptPath = path.join(os.tmpdir(), `factoryfactory-prompt-${agentId}.txt`);
  fs.writeFileSync(systemPromptPath, systemPrompt, 'utf-8');

  // Get agent profile
  const profile = AGENT_PROFILES.WORKER;

  // Build Claude CLI command
  const claudeCommand = buildClaudeCommand(sessionId, systemPromptPath, workingDir, profile);

  // Create tmux session
  const exists = await tmuxSessionExists(tmuxSessionName);
  if (exists) {
    // Kill existing session
    await execAsync(`tmux kill-session -t ${tmuxSessionName}`);
  }

  // Create new tmux session running Claude
  // Use -d flag to create detached session
  // Use shell escaping for workingDir to prevent command injection
  await execAsync(`tmux new-session -d -s ${tmuxSessionName} -c ${shellEscape(workingDir)}`);

  // Remove ANTHROPIC_API_KEY from environment (force OAuth)
  await execAsync(`tmux set-environment -t ${tmuxSessionName} -r ANTHROPIC_API_KEY`);

  // Send Claude command to tmux session
  // Use shell escaping for the command to prevent injection
  await execAsync(`tmux send-keys -t ${tmuxSessionName} ${shellEscape(claudeCommand)} Enter`);

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

  const tmuxSessionName = validateSessionName(getTmuxSessionName(agentId));
  const profile = AGENT_PROFILES.WORKER;

  // Check if tmux session exists
  const exists = await tmuxSessionExists(tmuxSessionName);
  if (!exists) {
    throw new Error(`Tmux session ${tmuxSessionName} does not exist. Cannot resume.`);
  }

  // Build resume command
  const resumeCommand = buildResumeCommand(sessionId, profile);

  // Send resume command to tmux
  await execAsync(`tmux send-keys -t ${tmuxSessionName} ${shellEscape(resumeCommand)} Enter`);

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
 * Uses atomic set-buffer + paste-buffer + send-keys Enter pattern
 * This prevents race conditions and handles all text correctly
 */
export async function sendMessage(agentId: string, message: string): Promise<void> {
  const tmuxSessionName = validateSessionName(getTmuxSessionName(agentId));

  // Check session exists
  const exists = await tmuxSessionExists(tmuxSessionName);
  if (!exists) {
    throw new Error(`Tmux session ${tmuxSessionName} does not exist`);
  }

  // Use atomic command chaining pattern from multiclaude:
  // set-buffer (load text) -> paste-buffer (insert to pane) -> send-keys Enter (submit)
  // The text is passed as $1 to sh -c to avoid shell escaping issues
  const cmdStr = `tmux set-buffer -- "$1" && tmux paste-buffer -t ${tmuxSessionName} && tmux send-keys -t ${tmuxSessionName} Enter`;

  await execAsync(`sh -c '${cmdStr}' sh "${message.replace(/"/g, '\\"').replace(/'/g, "'\\''")}"`);
}

/**
 * Capture output from tmux session
 * Returns last N lines of visible content
 */
export async function captureOutput(agentId: string, lines: number = 100): Promise<string> {
  const tmuxSessionName = validateSessionName(getTmuxSessionName(agentId));

  const exists = await tmuxSessionExists(tmuxSessionName);
  if (!exists) {
    throw new Error(`Tmux session ${tmuxSessionName} does not exist`);
  }

  // Capture pane content
  const { stdout } = await execAsync(`tmux capture-pane -t ${tmuxSessionName} -p -S -${lines}`);

  return stdout;
}

/**
 * Check if Claude process is running in tmux session
 */
export async function getSessionStatus(agentId: string): Promise<{
  exists: boolean;
  running: boolean;
}> {
  const tmuxSessionName = validateSessionName(getTmuxSessionName(agentId));

  const exists = await tmuxSessionExists(tmuxSessionName);
  if (!exists) {
    return { exists: false, running: false };
  }

  // Check if any process is running (not just shell prompt)
  // This is a heuristic - we check if there's activity
  try {
    const { stdout } = await execAsync(
      `tmux list-panes -t ${tmuxSessionName} -F "#{pane_current_command}"`
    );

    const command = stdout.trim();
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
  const tmuxSessionName = validateSessionName(getTmuxSessionName(agentId));

  const exists = await tmuxSessionExists(tmuxSessionName);
  if (!exists) {
    return; // Already stopped
  }

  // Send Ctrl+C to interrupt Claude
  await execAsync(`tmux send-keys -t ${tmuxSessionName} C-c`);

  // Wait a moment
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

/**
 * Kill tmux session and cleanup
 * Use this for force cleanup
 */
export async function killSession(agentId: string): Promise<void> {
  const tmuxSessionName = validateSessionName(getTmuxSessionName(agentId));

  const exists = await tmuxSessionExists(tmuxSessionName);
  if (!exists) {
    return;
  }

  // Kill tmux session
  await execAsync(`tmux kill-session -t ${tmuxSessionName}`);

  // Cleanup system prompt file if it exists
  const systemPromptPath = path.join(os.tmpdir(), `factoryfactory-prompt-${agentId}.txt`);
  if (fs.existsSync(systemPromptPath)) {
    fs.unlinkSync(systemPromptPath);
  }
}

/**
 * List all worker tmux sessions
 */
export async function listWorkerSessions(): Promise<string[]> {
  try {
    const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}"');
    const sessions = stdout.trim().split('\n');
    return sessions.filter((name) => name.startsWith('worker-'));
  } catch {
    return []; // No sessions
  }
}
