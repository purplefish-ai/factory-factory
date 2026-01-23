import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface TmuxSession {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
}

export class TmuxClient {
  private socketPath?: string;

  constructor() {
    this.socketPath = process.env.TMUX_SOCKET_PATH;
  }

  private getSocketArg(): string {
    return this.socketPath ? `-S "${this.socketPath}"` : '';
  }

  async createSession(sessionName: string): Promise<string> {
    const socketArg = this.getSocketArg();
    const command = `tmux ${socketArg} new-session -d -s "${sessionName}"`;

    try {
      await execAsync(command);
      return sessionName;
    } catch (error) {
      throw new Error(
        `Failed to create tmux session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async killSession(sessionName: string): Promise<void> {
    const socketArg = this.getSocketArg();
    const command = `tmux ${socketArg} kill-session -t "${sessionName}"`;

    try {
      await execAsync(command);
    } catch (error) {
      throw new Error(
        `Failed to kill tmux session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async sessionExists(sessionName: string): Promise<boolean> {
    const socketArg = this.getSocketArg();
    const command = `tmux ${socketArg} has-session -t "${sessionName}"`;

    try {
      await execAsync(command);
      return true;
    } catch {
      return false;
    }
  }

  async listSessions(): Promise<TmuxSession[]> {
    const socketArg = this.getSocketArg();
    const command = `tmux ${socketArg} list-sessions -F "#{session_name}:#{session_windows}:#{session_created}:#{session_attached}"`;

    try {
      const { stdout } = await execAsync(command);
      const sessions: TmuxSession[] = [];

      for (const line of stdout.trim().split('\n')) {
        if (!line) continue;

        const [name, windows, created, attached] = line.split(':');
        sessions.push({
          name,
          windows: parseInt(windows, 10),
          created,
          attached: attached === '1',
        });
      }

      return sessions;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('no server running') ||
        error instanceof Error && error.message.includes('failed to connect')
      ) {
        return [];
      }
      throw new Error(
        `Failed to list tmux sessions: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async sendKeys(sessionName: string, keys: string, enter = true): Promise<void> {
    const socketArg = this.getSocketArg();
    const keysToSend = enter ? `${keys}` : keys;
    const enterArg = enter ? 'Enter' : '';
    const command = `tmux ${socketArg} send-keys -t "${sessionName}" "${keysToSend}" ${enterArg}`;

    try {
      await execAsync(command);
    } catch (error) {
      throw new Error(
        `Failed to send keys to tmux session: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async capturePane(sessionName: string, lines = 100): Promise<string> {
    const socketArg = this.getSocketArg();
    const command = `tmux ${socketArg} capture-pane -t "${sessionName}" -p -S -${lines}`;

    try {
      const { stdout } = await execAsync(command);
      return stdout;
    } catch (error) {
      throw new Error(
        `Failed to capture tmux pane: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

export const tmuxClient = new TmuxClient();
