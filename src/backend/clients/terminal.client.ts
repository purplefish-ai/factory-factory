import { spawn } from 'node:child_process';

/**
 * Terminal client for interacting with tmux sessions
 * This is a simplified version for Phase 1
 * Full tmux-web integration will be done in a later phase
 */

/**
 * Check if a tmux session exists
 */
export function tmuxSessionExists(sessionName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('tmux', ['has-session', '-t', sessionName]);

    proc.on('exit', (code) => {
      resolve(code === 0);
    });
  });
}

/**
 * Attach to a tmux session and return session info
 */
export async function attachToTmuxSession(sessionName: string): Promise<{
  sessionName: string;
  exists: boolean;
  error?: string;
}> {
  const exists = await tmuxSessionExists(sessionName);

  if (!exists) {
    return {
      sessionName,
      exists: false,
      error: `Tmux session '${sessionName}' does not exist`,
    };
  }

  return {
    sessionName,
    exists: true,
  };
}

/**
 * Read session output from tmux session buffer
 */
export function readSessionOutput(sessionName: string, lines = 100): Promise<string> {
  return new Promise((resolve, reject) => {
    // Verify session exists
    const hasSession = spawn('tmux', ['has-session', '-t', sessionName]);

    hasSession.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Tmux session '${sessionName}' does not exist`));
        return;
      }

      // Capture pane output
      const capturePane = spawn('tmux', [
        'capture-pane',
        '-t',
        sessionName,
        '-p',
        '-S',
        `-${lines}`,
      ]);

      let output = '';
      capturePane.stdout.on('data', (data) => {
        output += data.toString();
      });

      capturePane.on('exit', (exitCode) => {
        if (exitCode === 0) {
          resolve(output);
        } else {
          reject(new Error(`Failed to capture pane output (exit code: ${exitCode})`));
        }
      });

      capturePane.on('error', (error) => {
        reject(error);
      });
    });

    hasSession.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * List all tmux sessions
 */
export function listTmuxSessions(): Promise<
  Array<{ name: string; created: string; attached: boolean }>
> {
  return new Promise((resolve, reject) => {
    const proc = spawn('tmux', [
      'list-sessions',
      '-F',
      '#{session_name}|#{session_created}|#{session_attached}',
    ]);

    let output = '';
    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.on('exit', (code) => {
      if (code === 0) {
        const sessions = output
          .trim()
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => {
            const [name, created, attached] = line.split('|');
            return {
              name,
              created,
              attached: attached === '1',
            };
          });
        resolve(sessions);
      } else {
        // No sessions is not an error, just return empty array
        resolve([]);
      }
    });

    proc.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Send keys to a tmux session
 */
export function sendKeysToSession(sessionName: string, keys: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('tmux', ['send-keys', '-t', sessionName, keys]);

    proc.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Failed to send keys to session (exit code: ${code})`));
      }
    });

    proc.on('error', (error) => {
      reject(error);
    });
  });
}
