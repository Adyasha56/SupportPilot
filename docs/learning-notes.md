# Learning notes

## Milestone 0 — TypeScript pinned to 6.0.3, not 7.x

**What**: the root and `apps/api` `package.json` pin `typescript` to `6.0.3` instead of the registry's `latest` tag (`7.0.2`).

**Why**: TypeScript 7 is Microsoft's native Go-ported compiler. Its `7.0` release supports `experimentalDecorators` and `emitDecoratorMetadata` (the design-time metadata NestJS's dependency injection reads at boot), but it ships no compiler API yet — that returns in `7.1`. `@nestjs/cli`'s `nest build` command depends on that API, so it cannot build a Nest app under TypeScript 7.0 today.

**Trade-off rejected**: staying on `7.0.2` and building with plain `tsc` instead of `nest build`, bypassing the Nest CLI. Rejected because it would mean hand-rolling what `nest build` already does (asset copying, webpack/SWC build modes) for no real benefit this early, and it diverges from the standard NestJS workflow interviewers would recognize.

**Revisit when**: TypeScript 7.1 (or later) restores the compiler API and `@nestjs/cli` confirms support for it. Check the registry and `@nestjs/cli`'s release notes before upgrading.

**Interview Q&A**: *"Why is this project on an older TypeScript line when a newer major is out?"* — Because the newer major (TypeScript 7, the Go-native compiler) dropped its compiler API in its first release, which the NestJS CLI's build command depends on. Pinning to the last compiler-API-complete release (6.0.3) keeps the standard Nest build pipeline working; the dependency is tracked for an upgrade once 7.1 restores that API.

## Milestone 0 — tsconfig used deprecated moduleResolution and baseUrl

**What went wrong**: `tsconfig.base.json` set `"module": "commonjs"` with `"moduleResolution": "node"` (which TypeScript resolves to the `node10` strategy), and `apps/api/tsconfig.json` set `"baseUrl": "./"`. TypeScript 6.0.3 treats both as hard errors (`TS5107`, `TS5101`) because they're slated for removal in TypeScript 7.0, so `nest build` failed before any of our code even compiled.

**The fix**: changed `module` and `moduleResolution` to `"nodenext"` together (they must match — `commonjs` paired with a `node16`/`nodenext` resolution strategy is invalid) and removed `baseUrl` entirely, since nothing in the codebase uses path aliases. `apps/api/package.json` has no `"type": "module"`, so under `nodenext` the compiler still emits CommonJS output and relative imports still don't need `.js` extensions — only packages that opt into ESM via `"type": "module"` get the extension requirement.

**Why not just silence it**: TypeScript offers `"ignoreDeprecations": "6.0"` to suppress these specific errors, but that only delays the same break to TypeScript 7.0 rather than fixing it — the deprecated options still wouldn't work there. Fixing the actual settings now means the config is already 7.0-ready whenever the compiler-API gap (see the TypeScript 6.0.3 pin entry above) is resolved.

## Milestone 0 — nest build emitted dist/src/main.js instead of dist/main.js

**What went wrong**: `apps/api/tsconfig.json`'s `include` listed both `src/**/*.ts` and `test/**/*.ts` with no `rootDir` set. TypeScript infers `rootDir` as the nearest common ancestor of every included file when it isn't given explicitly — here, that's `apps/api/` itself, since `src/` and `test/` are siblings. So the compiler mirrored that structure under `outDir`, producing `dist/src/main.js` and `dist/test/*.spec.js` instead of a flat `dist/main.js`. The `start` script (`node dist/main.js`) and the Dockerfile `CMD` assumed the flat layout and failed with `MODULE_NOT_FOUND`.

**The fix**: a separate `apps/api/tsconfig.build.json` that extends the main `tsconfig.json`, sets `rootDir: "./src"`, and narrows `include` to `src/**/*.ts` only (excluding `test/`, `**/*.spec.ts`, `dist`, `node_modules`). `nest-cli.json` points `compilerOptions.tsConfigPath` at this build config. The original `tsconfig.json` is untouched and still covers `src/` + `test/` together, so the editor, ESLint, and Vitest keep type-checking both.

**Why a separate build tsconfig, not one tsconfig doing both jobs**: type-checking and editor tooling want the widest `include` (so tests get type errors too), but compilation output wants the narrowest `include` (only what ships to `dist/`, with `rootDir` pinned so the output path is predictable). One tsconfig can't satisfy both without compromising one side — this split is the standard Nest CLI pattern (`nest new` scaffolds projects this way by default) for exactly this reason.
