import { escapeShellArg, execShell, tmuxCommand, validateSessionName } from '../lib/shell.js';

interface TmuxSession {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
}

/**
 * Centralized tmux client for all tmux operations.
 * All tmux commands should go through this client to ensure consistency.
 */
class TmuxClient {
  private socketPath?: string;

  constructor() {
    this.socketPath = process.env.TMUX_SOCKET_PATH;
  }

  /**
   * Check if a tmux session exists
   */
  async sessionExists(sessionName: string): Promise<boolean> {
    const validatedName = validateSessionName(sessionName);

    try {
      await tmuxCommand(['has-session', '-t', validatedName], this.socketPath);
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

    // Build args array for spawn (safe)
    const args = ['new-session', '-d', '-s', validatedName];
    if (workingDir) {
      args.push('-c', workingDir);
    }

    try {
      await tmuxCommand(args, this.socketPath);
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

    try {
      await tmuxCommand(['kill-session', '-t', validatedName], this.socketPath);
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

    try {
      await tmuxCommand(['rename-session', '-t', validatedOld, validatedNew], this.socketPath);
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
    const format = '#{session_name}:#{session_windows}:#{session_created}:#{session_attached}';

    try {
      const { stdout } = await tmuxCommand(['list-sessions', '-F', format], this.socketPath);
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

    // Check session exists
    const exists = await this.sessionExists(validatedName);
    if (!exists) {
      throw new Error(`Tmux session ${validatedName} does not exist`);
    }

    // Build tmux socket args
    const socketArgs = this.socketPath ? `-S ${escapeShellArg(this.socketPath)}` : '';

    // Use atomic command chaining pattern:
    // set-buffer (load text) -> paste-buffer (insert to pane) -> send-keys Enter (submit)
    // Pass the message via environment variable to avoid shell escaping issues
    const cmdStr = `tmux ${socketArgs} set-buffer -- "$TMUX_MESSAGE" && tmux ${socketArgs} paste-buffer -t ${validatedName} && tmux ${socketArgs} send-keys -t ${validatedName} Enter`;

    try {
      await execShell(`sh -c '${cmdStr}'`, { env: { ...process.env, TMUX_MESSAGE: message } });
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

    try {
      await tmuxCommand(['send-keys', '-t', validatedName, keys], this.socketPath);
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

    // Check session exists
    const exists = await this.sessionExists(validatedName);
    if (!exists) {
      throw new Error(`Tmux session ${validatedName} does not exist`);
    }

    try {
      const { stdout } = await tmuxCommand(
        ['capture-pane', '-t', validatedName, '-p', '-S', `-${lines}`],
        this.socketPath
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

    try {
      if (value === undefined) {
        // Unset the variable with -r flag
        await tmuxCommand(['set-environment', '-t', validatedName, '-r', varName], this.socketPath);
      } else {
        await tmuxCommand(
          ['set-environment', '-t', validatedName, varName, value],
          this.socketPath
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

    try {
      const { stdout } = await tmuxCommand(
        ['list-panes', '-t', validatedName, '-F', '#{pane_current_command}'],
        this.socketPath
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
