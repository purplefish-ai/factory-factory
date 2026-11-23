import { type Request, type Response, Router } from 'express';
import type { AppContext } from '@/backend/app-context';
import { isBrowserRequestAllowed } from '@/backend/lib/request-trust';
import { CHAT_IMAGE_ID_PATTERN } from '@/shared/chat-image-ref';

/** A content id names one image forever, so the browser may keep it for good. */
const IMMUTABLE = 'private, max-age=31536000, immutable';

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function refuse(res: Response, status: 403 | 404): void {
  res.status(status).set('Cache-Control', 'no-store').end();
}

/**
 * Serves the chat images the WebSocket transport sent as references
 * (`@/shared/chat-image-ref`), from the in-memory `ChatImageStore`.
 *
 * Threat model: the same as `publicProcedure`, which already lets any caller
 * past the browser boundary read every transcript with its images. A browser
 * `<img>` sends no `Origin`, so cross-site requests are refused by
 * `Sec-Fetch-Site` and by `Cross-Origin-Resource-Policy`; ids are SHA-256
 * content hashes that cannot be guessed without the image; and only PNG, JPEG,
 * GIF and WebP, typed from their bytes, are ever stored, served `nosniff` and
 * sandboxed.
 */
export function createChatImageRouter(appContext: AppContext): Router {
  const router = Router();

  router.get('/:id', (req, res) => {
    const { configService, chatImageStore } = appContext.services;
    const corsConfig = configService.getCorsConfig();
    const allowed =
      isBrowserRequestAllowed(
        { origin: header(req, 'origin'), host: req.headers.host, localPort: req.socket.localPort },
        corsConfig,
        () => configService.getBackendHost()
      ) &&
      (corsConfig.disableCorsChecks === true || header(req, 'sec-fetch-site') !== 'cross-site');
    if (!allowed) {
      refuse(res, 403);
      return;
    }

    const id = req.params.id;
    const image = CHAT_IMAGE_ID_PATTERN.test(id) ? chatImageStore.get(id) : undefined;
    if (!image) {
      refuse(res, 404);
      return;
    }

    res.set({
      'Content-Type': image.mediaType,
      'Cache-Control': IMMUTABLE,
      ETag: `"${id}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    // `send` answers a matching If-None-Match with 304 and a HEAD without a body.
    res.send(Buffer.from(image.data, 'base64'));
  });

  // Nothing else lives under the route; keep other methods and paths uncached.
  router.all('/{*rest}', (_req, res) => refuse(res, 404));

  return router;
}
