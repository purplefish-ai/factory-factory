import type { Server } from 'node:http';
import type { Socket } from 'node:net';

export const PROXY_LOCAL_HOST = '127.0.0.1';

export interface ListeningLocalProxy {
  port: number;
  close: () => Promise<void>;
}

/**
 * Listens on an ephemeral loopback port for cloudflared to target. `close`
 * destroys open connections (including proxied WebSockets) and gives up
 * waiting after one second so shutdown is never held open by a client.
 */
export function listenLocalProxy(server: Server): Promise<ListeningLocalProxy> {
  const activeSockets = new Set<Socket>();
  server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.once('close', () => {
      activeSockets.delete(socket);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, PROXY_LOCAL_HOST, () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not determine proxy port'));
        return;
      }

      resolve({
        port: address.port,
        close: async () => {
          await new Promise<void>((closeResolve) => {
            const timeout = setTimeout(() => {
              closeResolve();
            }, 1000);
            timeout.unref?.();

            server.close(() => {
              clearTimeout(timeout);
              closeResolve();
            });

            for (const socket of activeSockets) {
              socket.destroy();
            }
          });
        },
      });
    });
  });
}
