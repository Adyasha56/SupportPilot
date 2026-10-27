# Issues faced

A log of real problems hit during development, and the fix applied for each.

## Milestone 0

## 1. TypeScript 7 breaks `nest build`

**Issue**: Registry "latest" TypeScript (`7.0.2`) is Microsoft's new Go-native compiler. It supports the decorators Nest needs, but its `7.0` release ships no compiler API — `@nestjs/cli`'s `nest build` depends on that API and fails without it (API returns in `7.1`).

**Fix**: Pinned `typescript` to `6.0.3`, the last pre-7 release with a complete compiler API.

## 2. tsconfig used options TypeScript 6 now rejects

**Issue**: `moduleResolution: "node"` (resolves to the deprecated `node10` strategy) and `baseUrl` are hard errors in TypeScript 6.0.3 (`TS5107`, `TS5101`), since both are being removed in 7.0.

**Fix**: Changed `module` and `moduleResolution` to `"nodenext"` together (they must match), and removed `baseUrl` (unused — no path aliases in the code).

## 3. `nest build` output nested under `dist/src/` instead of `dist/`

**Issue**: `apps/api/tsconfig.json` included both `src/**/*.ts` and `test/**/*.ts` with no `rootDir`. TypeScript inferred `rootDir` as the common ancestor of both folders (`apps/api/`), so it mirrored that structure under `dist/`, producing `dist/src/main.js` instead of `dist/main.js`. The `start` script and Dockerfile `CMD` both expected the flat path and failed with `MODULE_NOT_FOUND`.

**Fix**: Added `apps/api/tsconfig.build.json` — extends the main tsconfig, sets `rootDir: "./src"`, and narrows `include` to `src/**/*.ts` only (excludes `test/`). Wired it in via `nest-cli.json`'s `compilerOptions.tsConfigPath`. This is the standard Nest CLI pattern.

## 4. corepack couldn't install pnpm

**Issue**: `corepack enable` failed with `EPERM` (Windows `Program Files` is permission-protected), and corepack's own pnpm fetch failed on a signature-verification error (stale key set in that corepack version).

**Fix**: Bypassed corepack — installed pnpm directly and pinned: `npm install -g pnpm@12.15.0`.

## 5. pnpm blocked `@swc/core`'s native build script

**Issue**: pnpm's supply-chain safety gate blocks native postinstall scripts by default (`ERR_PNPM_IGNORED_BUILDS`). `@swc/core` needs its postinstall to work (it powers Vitest's decorator-metadata transform).

**Fix**: `pnpm approve-builds --all`, which recorded `allowBuilds: '@swc/core': true` in `pnpm-workspace.yaml`.

## 6. Node 22 vs. required Node 24

**Issue**: The project targets Node 24 LTS, but the dev machine had Node 22.12.0. `nest build` failed with `ERR_REQUIRE_CYCLE_MODULE`, a Node module-loader bug in `@nestjs/cli`'s own dependency chain (`@angular-devkit/schematics` → `ora`, an ESM-only package) that only manifests on the older Node version.

**Fix**: Installed and switched to Node 24.22.1. No code change — purely an environment fix.

## 7. Vitest decorator metadata under test

**Issue**: Vitest's default esbuild-based transform doesn't emit the `design:paramtypes` metadata Nest's dependency injection reads at boot, so DI would silently fail in tests.

**Fix**: Added `unplugin-swc` + `@swc/core` to `vitest.config.mts`, routing TS compilation through SWC (which does emit the metadata, reading `tsconfig`'s `emitDecoratorMetadata`/`experimentalDecorators`).

## 8. Vitest CJS config-loader deprecation warning

**Issue**: `vitest.config.ts` used ESM `import`/`export` syntax but was loaded as CommonJS, triggering a forward-looking deprecation warning from Vite's config loader.

**Fix**: Renamed the file to `vitest.config.mts`.

## 9. Docker image built successfully but the API crashed with `MODULE_NOT_FOUND`

**Issue**: The container's own `/app/dist/main.js` was missing, even though the exact same `pnpm deploy` output worked fine when reproduced locally. Root cause: `ci.yml`'s "Build" step runs `pnpm -r run build` directly on the GitHub Actions runner *before* `docker compose build`. That run leaves `apps/api/tsconfig.build.tsbuildinfo` (TypeScript's incremental-build cache) on the runner's checkout — the same directory Docker uses as its build context. `.dockerignore` excluded `dist/` from the image but not `*.tsbuildinfo`, so the stale cache file rode into the container. Once inside, `tsc` trusted it ("source unchanged, nothing to emit") and skipped compiling entirely, even though the container had no actual `dist/` output to match that claim.

**Fix**: Added `**/*.tsbuildinfo` to `.dockerignore`, so the cache file never enters the Docker build context and every image build compiles from scratch.

## Milestone 1

## 1. `net.BlockList` and Node's custom `lookup` are only invoked for hostname targets

**Issue**: a test asserting the DNS-rebinding-safe `lookup` function runs "on every request" initially used a literal IP as the request target and passed with zero actual verification — `resolveDns` was never called, because Node's `http.request` skips invoking the `lookup` option entirely when the target is already an IP literal (no resolution step needed, so nothing to protect).

**Fix**: rewrote the test to target a hostname instead. Also confirmed directly that Node calls `lookup` with `{ all: true }` by default, requiring the lookup function to handle both the single-address and array callback shapes.

## 2. A size-limit test that didn't exercise the size limit

**Issue**: a test for the response-size cap set `Content-Length: 5` then sent 2000 bytes, expecting our own streaming byte-counter to catch it. Node's HTTP parser rejects that as a protocol violation on its own, before our counter ever runs — the test "passed" by hitting the wrong failure path entirely.

**Fix**: rewrote the test to send a response with no `Content-Length` at all (chunked encoding), which is the actual scenario our streaming counter exists to catch, since Node has nothing to pre-validate against in that case.

## 3. Empty `CONNECTOR_HOST_ALLOWLIST` crashed the app at boot

**Issue**: `ToolRunnerSettingsSchema` required at least one allowlist entry. Starting the built app with `NODE_ENV=production` and no tool-runner env vars set at all (the real "freshly deployed, unconfigured" scenario) crashed Nest's bootstrap.

**Fix**: removed the `.min(1)` constraint. An empty allowlist is a valid, safe default — it blocks every connector rather than crashing the container.

## 4. `zod` imported directly in `apps/api` without being its own dependency

**Issue**: `tool-runner.settings.ts` imports `zod`, but only `packages/shared` declared it as a dependency. pnpm's per-package isolation doesn't let `apps/api` borrow it transitively — tests failed with `Cannot find package 'zod'`.

**Fix**: Added `zod@4.6.7` directly to `apps/api/package.json`, since this particular schema (API-internal env settings) isn't something `mock-store` needs — the wrong fix would have been routing it through `shared` just to avoid a second lockfile entry.

## 5. A stray `idPattern` on a tool with no id-shaped input

**Issue**: the `escalate_to_human` connector fixture had `"idPattern": "^ESC-\\d{4,}$"` — the format of the tool's *output* id, applied to nothing, since `escalate_to_human`'s only input is free-text `summary`. No test failed; the pattern was simply never exercised by anything.

**Fix**: removed it. Caught by re-reading each fixture carefully while wiring `request.body` mappings, not by a failing test.
