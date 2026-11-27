import { vi } from 'vitest';

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** A browser `WebSocket` stand-in the test drives by hand. */
export class FakeWebSocket {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;
  static created: FakeWebSocket[] = [];

  readonly url: string;
  readyState = CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.created.push(this);
  }

  send(data: string): void {
    if (this.readyState !== OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === CLOSED) {
      return;
    }
    this.readyState = CLOSED;
    this.onclose?.({ type: 'close' });
  }

  open(): void {
    this.readyState = OPEN;
    this.onopen?.({ type: 'open' });
  }

  receive(frame: unknown): void {
    this.onmessage?.({ type: 'message', data: JSON.stringify(frame) });
  }

  /** The server went away: the browser reports a close without our asking. */
  drop(): void {
    this.close();
  }

  /** Pings this socket sent, by id. */
  pings(): number[] {
    return this.sent.flatMap((raw) => {
      const frame: unknown = JSON.parse(raw);
      return typeof frame === 'object' &&
        frame !== null &&
        'ffTransport' in frame &&
        frame.ffTransport === 'ping' &&
        'id' in frame &&
        typeof frame.id === 'number'
        ? [frame.id]
        : [];
    });
  }

  /** Answers the most recent ping, as a live server does. */
  answerPing(): void {
    const id = this.pings().at(-1);
    if (id === undefined) {
      throw new Error('No ping to answer');
    }
    this.receive({ ffTransport: 'pong', id });
  }
}

export function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.created.at(-1);
  if (!socket) {
    throw new Error('No socket created');
  }
  return socket;
}

export function installFakeWebSocket(): void {
  FakeWebSocket.created = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
}

let visibility: DocumentVisibilityState = 'visible';

/** Sets `document.visibilityState` and fires `visibilitychange`, as a browser does. */
export function setDocumentVisibility(state: DocumentVisibilityState): void {
  visibility = state;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}
