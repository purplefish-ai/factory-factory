import { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';

export const slackFailureSchema = z.object({ ok: z.literal(false), error: z.string() });

/** Longest Retry-After honored; a larger value is treated as this. */
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

/**
 * A sanitized Slack transport failure. `transient` marks failures worth retrying
 * (unreachable, rate limited, server errors, unreadable bodies); `retryAfterMs`
 * carries Slack's Retry-After for rate limits.
 */
export class SlackApiError extends ApplicationError {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly rateLimited = false,
    readonly retryAfterMs?: number
  ) {
    super('PRECONDITION_FAILED', message);
  }
}

/**
 * Calls a Slack Web API method with a bearer token. Transport, HTTP and body
 * failures become fixed messages; neither the token nor Slack's text is echoed.
 * Callers validate the returned body. A caller signal aborts the request as well
 * as the ten-second limit.
 */
export async function callSlackApi(
  request: typeof fetch,
  method: string,
  token: string,
  options: { query?: Record<string, string>; post?: boolean; signal?: AbortSignal } = {}
): Promise<unknown> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const timeout = AbortSignal.timeout(10_000);
  let response: Response;
  try {
    response = await request(url.toString(), {
      ...(options.post ? { method: 'POST' } : {}),
      headers: { Authorization: `Bearer ${token}` },
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      redirect: 'error',
    });
  } catch {
    throw unreachable();
  }
  if (!response.ok) {
    throw response.status === 429
      ? new SlackApiError(
          'Slack is rate limiting requests. Wait a moment and try again.',
          true,
          true,
          retryAfterMs(response.headers.get('Retry-After'))
        )
      : new SlackApiError(
          'Slack could not validate this connection. Try again.',
          response.status >= 500
        );
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw unreachable();
  }
  try {
    const body: unknown = JSON.parse(text);
    return body;
  } catch {
    throw new SlackApiError('Slack returned an unreadable response. Try again.', true);
  }
}

function unreachable() {
  return new SlackApiError('Could not reach Slack. Check your connection and try again.', true);
}

/** Slack sends whole seconds; an HTTP date is accepted too. */
function retryAfterMs(header: string | null) {
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(Math.ceil(ms), MAX_RETRY_AFTER_MS) : undefined;
}
