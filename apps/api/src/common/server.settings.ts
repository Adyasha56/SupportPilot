import { join } from 'node:path';
import { z } from 'zod';

/**
 * Milestone 5, Stage 1a - static-serving configuration for the admin SPA
 * and the embeddable widget bundle, both served from this SAME API process
 * (amendment A1 - no separate static host, so the admin console can be
 * same-origin). Directories are configurable, never hardcoded, because the
 * real Docker image (A10, built in a later stage) copies the two frontend
 * builds to wherever its own Dockerfile puts them - these defaults only
 * exist for local dev convenience and point at the SIBLING app packages'
 * own `dist/` output, which Stage 1a deliberately does not create (no
 * frontend code yet - see the "empty placeholder convention" note below).
 * Neither directory needs to exist for the app to boot or to serve a clean
 * 404/fallback - see admin-static.ts and widget-static.ts.
 */
const WIDGET_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export const ServerSettingsSchema = z.object({
  adminStaticDir: z.string().min(1),
  widgetStaticDir: z.string().min(1),
  /**
   * The exact path segment this app serves `/widget/<version>/widget.js`
   * under (B4) - a plain equality-checked settings value, never built from
   * request input, so there is no path-traversal surface in the version
   * segment itself. Stage 2 (the real widget build) is expected to set
   * this to the widget package's real semver; until then it defaults to a
   * clearly-placeholder value so an operator who forgets to set it sees an
   * obviously-wrong URL rather than a silently-empty one.
   */
  widgetVersion: z.string().regex(WIDGET_VERSION_PATTERN, 'must be a safe URL-path-segment (letters, digits, dot, dash, underscore)'),
  /** Access-Control-Max-Age (seconds) for the open /v1/chat* CORS preflight (amendment A5). */
  corsPreflightMaxAgeSeconds: z.number().int().positive(),
});
export type ServerSettings = z.infer<typeof ServerSettingsSchema>;

/** apps/api/dist/common -> apps/ , then the sibling frontend package's own dist/ - see this file's own doc comment for why these are dev-only defaults. */
function defaultFrontendDistDir(packageName: string): string {
  return join(__dirname, '..', '..', '..', packageName, 'dist');
}

export function loadServerSettingsFromEnv(env: NodeJS.ProcessEnv): ServerSettings {
  const candidate = {
    adminStaticDir: env.ADMIN_STATIC_DIR || defaultFrontendDistDir('web-admin'),
    widgetStaticDir: env.WIDGET_STATIC_DIR || defaultFrontendDistDir('web-widget'),
    widgetVersion: env.WIDGET_VERSION || 'unbuilt',
    corsPreflightMaxAgeSeconds: Number(env.CORS_PREFLIGHT_MAX_AGE_SECONDS ?? 600),
  };

  const result = ServerSettingsSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`Invalid ServerSettings: ${result.error.message}`);
  }
  return result.data;
}
