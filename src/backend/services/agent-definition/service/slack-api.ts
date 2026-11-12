import { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';

export const slackFailureSchema = z.object({ ok: z.literal(false), error: z.string() });

/**
 * Calls a Slack Web API method with a bearer token. Transport, HTTP and body
 * failures become fixed messages; neither the token nor Slack's text is echoed.
 * Callers validate the returned body.
 */
export async function callSlackApi(
  request: typeof fetch,
  method: string,
  token: string,
  options: { query?: Record<string, string>; post?: boolean } = {}
): Promise<unknown> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }
  let response: Response;
  try {
    response = await request(url.toString(), {
      ...(options.post ? { method: 'POST' } : {}),
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
  } catch {
    throw unreachable();
  }
  if (!response.ok) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      response.status === 429
        ? 'Slack is rate limiting requests. Wait a moment and try again.'
        : 'Slack could not validate this connection. Try again.'
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
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Slack returned an unreadable response. Try again.'
    );
  }
}

function unreachable() {
  return new ApplicationError(
    'PRECONDITION_FAILED',
    'Could not reach Slack. Check your connection and try again.'
  );
}
