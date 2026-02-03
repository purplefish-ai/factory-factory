import type { Server as HttpServer } from 'node:http';

/**
 * Server instance returned by createServer()
 */
export interface ServerInstance {
  /** Start the server and return the URL */
  start(): Promise<string>;
  /** Stop the server gracefully */
  stop(): Promise<void>;
  /** Get the actual port the server is listening on */
  getPort(): number;
  /** Get the HTTP server instance (for Electron to monitor) */
  getHttpServer(): HttpServer;
}
