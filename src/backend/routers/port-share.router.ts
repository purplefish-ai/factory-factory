import { type Request, type Response, Router } from 'express';
import type { AppContext } from '@/backend/app-context';
import { toError } from '@/backend/lib/error-utils';
import type { TailscaleConfig } from '@/backend/services/config.service';
import {
  PortShareError,
  type PortShareFailure,
  parseSharePort,
} from '@/backend/services/port-share';

const PROXY_URL = /^\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/;
/** Navigations Factory Factory itself started, or the user typed or bookmarked. */
const AUTO_SHARE_FETCH_SITES = new Set(['same-origin', 'none']);

const FAILURE_STATUS: Record<PortShareFailure, number> = {
  DISABLED: 404,
  PRIVILEGED: 403,
  FACTORY_FACTORY: 403,
  SERVICE: 403,
  NOT_LISTENING: 502,
  PORT_IN_USE: 409,
  SERVE_FAILED: 502,
};

interface ProxyTarget {
  port: number;
  /** Path and query below `/proxy/<port>`, always starting with `/`. */
  pathAndQuery: string;
}

function parseProxyTarget(url: string): ProxyTarget | null {
  const match = PROXY_URL.exec(url);
  const port = match?.[1] ? parseSharePort(match[1]) : null;
  if (!(match && port)) {
    return null;
  }
  return { port, pathAndQuery: `${match[2] || '/'}${match[3] ?? ''}` };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function sendPage(
  res: Response,
  status: number,
  options: { title: string; body: string; formActionOrigin?: string }
): void {
  const formAction = options.formActionOrigin ? ` ${options.formActionOrigin}` : '';
  res
    .status(status)
    .set('Cache-Control', 'no-store')
    .set(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formAction}; frame-ancestors 'none'`
    )
    .type('html')
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(options.title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.5;color:#222}@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}}button{font:inherit;padding:.5rem 1rem;border-radius:.375rem;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer}code{word-break:break-all}</style></head><body><h1>${escapeHtml(options.title)}</h1>${options.body}</body></html>`
    );
}

function sendConfirmation(res: Response, target: ProxyTarget, shareOrigin: string): void {
  sendPage(res, 200, {
    title: `Share port ${target.port}?`,
    formActionOrigin: shareOrigin,
    body: `<p>This opens <code>${escapeHtml(`${shareOrigin}${target.pathAndQuery}`)}</code>, sharing port ${target.port} from the host with your tailnet until Factory Factory stops.</p><form method="post"><button type="submit">Share port ${target.port}</button></form>`,
  });
}

/** Joins strings rather than resolving a URL, so the path can never change the origin. */
export function buildShareLocation(shareOrigin: string, pathAndQuery: string): string | null {
  if (!pathAndQuery.startsWith('/') || /[\r\n\\]/.test(pathAndQuery)) {
    return null;
  }
  const location = `${shareOrigin}${pathAndQuery}`;
  try {
    return new URL(location).origin === shareOrigin ? location : null;
  } catch {
    return null;
  }
}

export function canAutoShare(req: Request): boolean {
  const site = req.get('sec-fetch-site');
  return (
    req.method === 'GET' &&
    site !== undefined &&
    AUTO_SHARE_FETCH_SITES.has(site) &&
    req.get('sec-fetch-mode') === 'navigate' &&
    req.get('sec-fetch-dest') === 'document' &&
    req.get('sec-purpose') === undefined &&
    req.get('purpose') === undefined
  );
}

/**
 * `/proxy/<port>/<path>` shares a loopback port through Tailscale Serve and
 * redirects to it. Shared apps run on their own port, so they never share
 * Factory Factory's origin. Sharing is a side effect, so cross-site and
 * speculative requests get a confirmation page whose same-origin POST shares.
 */
export function createPortShareRouter(appContext: AppContext): Router {
  const router = Router();
  const { configService, createLogger, portShareService } = appContext.services;
  const logger = createLogger('port-share-route');

  const share = async (req: Request, res: Response, target: ProxyTarget, status: number) => {
    const shareOrigin = portShareService.getShareOrigin(target.port);
    const location = shareOrigin && buildShareLocation(shareOrigin, target.pathAndQuery);
    if (!location) {
      sendPage(res, 400, { title: 'Invalid link', body: '<p>This share link is not valid.</p>' });
      return;
    }
    try {
      await portShareService.ensure(target.port);
      res.set('Cache-Control', 'no-store').redirect(status, location);
    } catch (error) {
      if (error instanceof PortShareError) {
        sendPage(res, FAILURE_STATUS[error.reason], {
          title: `Port ${target.port} is not shared`,
          body: `<p>${escapeHtml(error.message)}</p>`,
        });
        return;
      }
      logger.error('Failed to share port', toError(error), { port: target.port, path: req.path });
      sendPage(res, 500, {
        title: `Port ${target.port} is not shared`,
        body: '<p>Factory Factory could not share this port. Check the server log.</p>',
      });
    }
  };

  const dispatch = async (
    req: Request,
    res: Response,
    target: ProxyTarget,
    tailscale: TailscaleConfig
  ) => {
    if (req.method === 'POST') {
      if (req.get('origin') === tailscale.origin) {
        await share(req, res, target, 303);
        return;
      }
      sendPage(res, 403, {
        title: 'Request blocked',
        body: '<p>Confirm sharing from the Factory Factory page.</p>',
      });
      return;
    }
    if (canAutoShare(req)) {
      await share(req, res, target, 302);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.set('Allow', 'GET, HEAD, POST').sendStatus(405);
      return;
    }
    sendConfirmation(res, target, portShareService.getShareOrigin(target.port) ?? '');
  };

  router.use(async (req, res) => {
    const target = parseProxyTarget(req.url);
    if (!target) {
      sendPage(res, 400, { title: 'Invalid link', body: '<p>This share link is not valid.</p>' });
      return;
    }
    const tailscale = configService.getTailscaleConfig();
    if (!(tailscale && portShareService.isAvailable())) {
      sendPage(res, 404, {
        title: 'Port sharing is off',
        body: '<p>Loopback ports can be shared only when Factory Factory runs through <code>ff tailscale</code>.</p>',
      });
      return;
    }
    await dispatch(req, res, target, tailscale);
  });

  return router;
}
