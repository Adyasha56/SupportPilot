import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

/** 1 year, in milliseconds - serve-static's own `maxAge` option, combined with `immutable: true`, produces exactly `Cache-Control: public, max-age=31536000, immutable` (amendment B4). */
export const WIDGET_VERSIONED_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
/** 5 minutes, in seconds - the short-lived `/widget.js` alias (amendment B4): auto-updating, explicitly documented as carrying NO SRI guarantee (its content can change at this URL; only the versioned path's content is stable enough to hash). */
export const WIDGET_ALIAS_MAX_AGE_SECONDS = 300;
export const WIDGET_ALIAS_PATH = '/widget.js';

/**
 * Milestone 5, Stage 1a, amendment B4. Two pieces, registered in this exact
 * order in main.ts:
 *
 *  1. `useStaticAssets(dir, { prefix: '/widget/<version>', ... })` - the
 *     SAME serve-static mechanism (and the same traversal protection) the
 *     admin static root uses (admin-static.ts), mounted under a prefix
 *     built from the configured, settings-driven `widgetVersion` - a plain
 *     string EQUALITY match baked into the mount prefix at boot time,
 *     never built from a request's own path segment, so there is no
 *     traversal surface in the version itself. `immutable: true` +
 *     `maxAge` together produce the long-lived, immutable Cache-Control
 *     this path promises - a real SRI hash on this exact URL stays valid
 *     for as long as this app instance serves this version. Safe to call
 *     with a directory that doesn't exist yet, same reasoning as the admin
 *     static root (express.static never stats at mount time).
 *  2. `widgetAliasHandler(dir)`, mounted at the fixed `/widget.js` path -
 *     NOT a directory mount (there is no variable path segment at all, so
 *     no traversal surface to test here, unlike the versioned mount
 *     above): serves the exact same underlying `widget.js` file, but with
 *     a short, ordinary Cache-Control instead of the immutable one, for an
 *     integrator who wants auto-updates on new deploys without re-pinning
 *     an SRI hash each time. Explicitly checks the file exists first,
 *     returning this project's own 404 shape rather than crashing or
 *     falling through to the admin SPA fallback (a completely separate
 *     path prefix, never reached from here).
 */
export function registerWidgetStaticAssets(app: NestExpressApplication, widgetStaticDir: string, widgetVersion: string): void {
  const versionedPrefix = `/widget/${widgetVersion}`;
  app.useStaticAssets(widgetStaticDir, {
    prefix: versionedPrefix,
    dotfiles: 'deny',
    index: false,
    maxAge: WIDGET_VERSIONED_MAX_AGE_MS,
    immutable: true,
  });
  app.use(WIDGET_ALIAS_PATH, widgetAliasHandler(widgetStaticDir));
}

export function widgetAliasHandler(widgetStaticDir: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const filePath = resolve(join(widgetStaticDir, 'widget.js'));
    if (!existsSync(filePath)) {
      res.status(404).json({ statusCode: 404, code: 'NOT_FOUND', message: 'Not found.' });
      return;
    }
    res.setHeader('Cache-Control', `public, max-age=${WIDGET_ALIAS_MAX_AGE_SECONDS}`);
    res.sendFile(filePath);
  };
}
