import type { NextFunction, Request, Response } from 'express';

/**
 * Milestone 5, Stage 1a, amendment A1/B6. Two independent decisions per
 * request, by path:
 *
 *  1. `Cache-Control: no-store` + `X-Content-Type-Options: nosniff` on
 *     every response EXCEPT widget assets (`/widget.js` and anything under
 *     `/widget/`) - those get their own, deliberately long-lived,
 *     immutable caching headers from the static-serving layer itself
 *     (widget-static.ts), which this middleware must never override or
 *     fight with. Applies to admin pages, admin static assets (JS/CSS/etc,
 *     since the admin bundle is never meant to be cached across deploys -
 *     same "always fresh, no caching" discipline A1 already decided), and
 *     every JSON `/v1/*` API response.
 *  2. `Content-Security-Policy` + `Referrer-Policy` ONLY on an admin HTML
 *     document response (the SPA shell / fallback), never on a JSON API
 *     response and never on an admin static asset (a CSP header on a .js
 *     or .css file's own response has no browser effect anyway - CSP is
 *     enforced by the document that LOADS a resource, not by that
 *     resource's own response headers - so setting it there would be
 *     inert, not merely redundant). Since this middleware runs before
 *     static serving decides whether a given `/admin/*` path resolves to a
 *     real file or the SPA fallback, "is this the HTML shell" is decided
 *     by a simple heuristic: no recognizable file extension on the last
 *     path segment. This is accurate for this app's own static layout
 *     (every real asset Vite emits has an extension; every client-routed
 *     page path - e.g. `/admin/approvals/123` - does not).
 */
const WIDGET_SHORT_ALIAS_PATH = '/widget.js';
const WIDGET_VERSIONED_PREFIX = '/widget/';
const ADMIN_PREFIX = '/admin';
const STATIC_ASSET_EXTENSION_PATTERN = /\.[a-z0-9]+$/i;

export function buildAdminCsp(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

function isWidgetAssetPath(path: string): boolean {
  return path === WIDGET_SHORT_ALIAS_PATH || path.startsWith(WIDGET_VERSIONED_PREFIX);
}

function isAdminPath(path: string): boolean {
  return path === ADMIN_PREFIX || path.startsWith(`${ADMIN_PREFIX}/`);
}

function looksLikeStaticAsset(path: string): boolean {
  return STATIC_ASSET_EXTENSION_PATTERN.test(path);
}

export function securityHeadersMiddleware(req: Request, res: Response, next: NextFunction): void {
  const path = req.path;

  if (isWidgetAssetPath(path)) {
    next();
    return;
  }

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (isAdminPath(path) && !looksLikeStaticAsset(path)) {
    res.setHeader('Content-Security-Policy', buildAdminCsp());
    res.setHeader('Referrer-Policy', 'no-referrer');
  }

  next();
}
