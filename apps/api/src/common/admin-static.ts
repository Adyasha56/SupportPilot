import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

export const ADMIN_PREFIX = '/admin';

/**
 * Milestone 5, Stage 1a, amendment A1/B6. Two pieces, registered in this
 * exact order in main.ts:
 *
 *  1. `useStaticAssets(dir, { prefix: '/admin', dotfiles: 'deny' })` - real
 *     built files (JS/CSS/images/etc) are served directly, with Express's
 *     own (well-established) path normalization/traversal protection.
 *     `dotfiles: 'deny'` refuses any dotfile path outright. Safe to call
 *     even when `dir` does not exist yet - `express.static` only stats the
 *     filesystem per REQUEST, never at mount time, so a missing directory
 *     here never prevents the app from booting; every request to it just
 *     falls through (`next()`) to whatever is registered after it, same as
 *     a real miss would.
 *  2. `adminSpaFallback(dir)`, mounted at the SAME '/admin' prefix - only
 *     reached for a GET under /admin that useStaticAssets did NOT already
 *     serve (no matching real file). Serves the SPA's own index.html for
 *     client-side routing deep links (e.g. /admin/approvals/123). Because
 *     this is registered with the Express path-prefix '/admin', it can
 *     structurally never run for a path that doesn't start with '/admin' -
 *     a request to /v1/anything or any other unmatched route is completely
 *     unaffected, regardless of registration order (never "shadows" an API
 *     404). Explicitly checks the build directory exists before attempting
 *     to serve it, returning this project's own {statusCode, code,
 *     message} 404 shape otherwise - never a crash, and never Nest's/
 *     Express's own default error page, for a build that simply hasn't
 *     been produced yet (true for every environment before Stage 3 of this
 *     milestone actually builds apps/web-admin).
 */
export function registerAdminStaticAssets(app: NestExpressApplication, adminStaticDir: string): void {
  app.useStaticAssets(adminStaticDir, { prefix: ADMIN_PREFIX, dotfiles: 'deny' });
  app.use(ADMIN_PREFIX, adminSpaFallback(adminStaticDir));
}

export function adminSpaFallback(adminStaticDir: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET') {
      next();
      return;
    }
    const indexPath = resolve(join(adminStaticDir, 'index.html'));
    if (!existsSync(indexPath)) {
      res.status(404).json({ statusCode: 404, code: 'NOT_FOUND', message: 'Not found.' });
      return;
    }
    res.sendFile(indexPath);
  };
}
