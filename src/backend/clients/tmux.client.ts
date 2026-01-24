import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface TmuxSession {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
}

/**
 * Validate tmux session name to prevent injection
 * Session names should only contain alphanumeric chars, underscores, and dashes
 */
function validateSessionName(name: string): string {
  if (!/^[\w-]+$/.test(name)) {
    throw new Error(`Invalid tmux session name: ${name}`);
  }
  return name;
}

/**
 * Escape a string for safe use in shell commands
 * Uses single quotes and escapes any embedded single quotes
 */
function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/**
 * Centralized tmux client for all tmux operations.
 * All tmux commands should go through this client to ensure consistency.
 */
export class TmuxClient {
  private socketPath?: string;

  constructor() {
    this.socketPath = process.env.TMUX_SOCKET_PATH;
  }

  private getSocketArg(): string {
    return this.socketPath ? `-S "${this.socketPath}"` : '';
  }

  /**
   * Check if a tmux session exists
   */
  async sessionExists(sessionName: string): Promise<boolean> {
    const validatedName = validateSessionName(sessionName);
    const socketArg = this.getSocketArg();

    try {
      await execAsync(`tmux ${socketArg} has-session -t ${validatedName} 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a new detached tmux session
   */
  async createSession(sessionName: string, workingDir?: string): Promise<string> {
    const validatedName = validateSessionName(sessionName);
    const socketArg = this.getSocketArg();
    const dirArg = workingDir ? `-c ${shellEscape(workingDir)}` : '';

    try {
      await execAsync(`tmux ${socketArg} new-session -d -s ${validatedName} ${dirArg}`);
      return validatedName;
    } catch (error) {
      throw new Error(
        `Failed to create tmux session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Kill a tmux session
   */
  async killSession(sessionName: string): Promise<void> {
    const validatedName = validateSessionName(sessionName);
    const socketArg = this.getSocketArg();

    try {
      await execAsync(`tmux ${socketArg} kill-session -t ${validatedName}`);
    } catch (error) {
      throw new Error(
        `Failed to kill tmux session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Rename a tmux session
   */
  async renameSession(oldName: string, newName: string): Promise<void> {
    const validatedOld = validateSessionName(oldName);
    const validatedNew = validateSessionName(newName);
    const socketArg = this.getSocketArg();

    try {
      await execAsync(`tmux ${socketArg} rename-session -t ${validatedOld} ${validatedNew}`);
    } catch (error) {
      throw new Error(
        `Failed to rename tmux session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * List all tmux sessions
   */
  async listSessions(): Promise<TmuxSession[]> {
    const socketArg = this.getSocketArg();
    const command = `tmux ${socketArg} list-sessions -F "#{session_name}:#{session_windows}:#{session_created}:#{session_attached}"`;

    try {
      const { stdout } = await execAsync(command);
      const sessions: TmuxSession[] = [];

      for (const line of stdout.trim().split('\n')) {
        if (!line) {
          continue;
        }

        const [name, windows, created, attached] = line.split(':');
        sessions.push({
          name,
          windows: Number.parseInt(windows, 10),
          created,
          attached: attached === '1',
        });
      }

      return sessions;
    } catch (error) {
      if (
        (error instanceof Error && error.message.includes('no server running')) ||
        (error instanceof Error && error.message.includes('failed to connect'))
      ) {
        return [];
      }
      throw new Error(
        `Failed to list tmux sessions: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * List sessions matching a prefix
   */
  async listSessionsByPrefix(prefix: string): Promise<string[]> {
    const sessions = await this.listSessions();
    return sessions.filter((s) => s.name.startsWith(prefix)).map((s) => s.name);
  }

  /**
   * Send a message to a tmux session using atomic buffer pattern.
   * This is the correct way to send text that may contain special characters.
   * Uses set-buffer + paste-buffer + send-keys Enter for reliability.
   */
  async sendMessage(sessionName: string, message: string): Promise<void> {
    const validatedName = validateSessionName(sessionName);
    const socketArg = this.getSocketArg();

    // Check session exists
    const exists = await this.sessionExists(validatedName);
    if (!exists) {
      throw new Error(`Tmux session ${validatedName} does not exist`);
    }

    // Use atomic command chaining pattern:
    // set-buffer (load text) -> paste-buffer (insert to pane) -> send-keys Enter (submit)
    // Pass the message via environment variable to avoid shell escaping issues
    const cmdStr = `tmux ${socketArg} set-buffer -- "$TMUX_MESSAGE" && tmux ${socketArg} paste-buffer -t ${validatedName} && tmux ${socketArg} send-keys -t ${validatedName} Enter`;

    try {
      await execAsync(`sh -c '${cmdStr}'`, { env: { ...process.env, TMUX_MESSAGE: message } });
    } catch (error) {
      throw new Error(
        `Failed to send message to tmux session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Send raw keys to a tmux session.
   * Use this for control sequences like C-c, Enter, etc.
   * For sending text messages, use sendMessage() instead.
   */
  async sendKeys(sessionName: string, keys: string): Promise<void> {
    const validatedName = validateSessionName(sessionName);
    const socketArg = this.getSocketArg();

    try {
      await execAsync(`tmux ${socketArg} send-keys -t ${validatedName} ${keys}`);
    } catch (error) {
      throw new Error(
        `Failed to send keys to tmux session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Send interrupt (Ctrl+C) to a tmux session
   */
  async sendInterrupt(sessionName: string): Promise<void> {
    await this.sendKeys(sessionName, 'C-c');
  }

  /**
   * Capture pane content from a tmux session
   */
  async capturePane(sessionName: string, lines = 100): Promise<string> {
    const validatedName = validateSessionName(sessionName);
    const socketArg = this.getSocketArg();

    // Check session exists
    const exists = await this.sessionExists(validatedName);
    if (!exists) {
      throw new Error(`Tmux session ${validatedName} does not exist`);
    }

    try {
      const { stdout } = await execAsync(
        `tmux ${socketArg} capture-pane -t ${validatedName} -p -S -${lines}`
      );
      return stdout;
    } catch (error) {
      throw new Error(
        `Failed to capture tmux pane: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Set or unset an environment variable in a tmux session
   */
  async setEnvironment(sessionName: string, varName: string, value?: string): Promise<void> {
    const validatedName = validateSessionName(sessionName);
    const socketArg = this.getSocketArg();

    try {
      if (value === undefined) {
        // Unset the variable with -r flag
        await execAsync(`tmux ${socketArg} set-environment -t ${validatedName} -r ${varName}`);
      } else {
        await execAsync(
          `tmux ${socketArg} set-environment -t ${validatedName} ${varName} ${shellEscape(value)}`
        );
      }
    } catch (error) {
      throw new Error(
        `Failed to set environment in tmux session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get the current command running in a tmux session's pane
   */
  async getPaneCommand(sessionName: string): Promise<string> {
    const validatedName = validateSessionName(sessionName);
    const socketArg = this.getSocketArg();

    try {
      const { stdout } = await execAsync(
        `tmux ${socketArg} list-panes -t ${validatedName} -F "#{pane_current_command}"`
      );
      return stdout.trim();
    } catch (error) {
      throw new Error(
        `Failed to get pane command: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

// Singleton instance for convenience
export const tmuxClient = new TmuxClient();
