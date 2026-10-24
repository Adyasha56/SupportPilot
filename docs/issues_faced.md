# Issues faced — Milestone 0

A log of real problems hit while setting up the repo/tooling, and the fix applied for each.

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
