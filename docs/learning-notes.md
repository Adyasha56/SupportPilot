# Learning notes

## Milestone 2 — Database decision: MongoDB Atlas (M0) with Atlas Vector Search, via Mongoose

**Decision**: MongoDB Atlas, free M0 cluster, using Atlas Vector Search for policy chunk retrieval, accessed through Mongoose.

**Why, over Postgres + pgvector**:
- **One system for both data and vectors.** `PolicyChunk` documents and their embeddings live in the same collection, queried with one `$vectorSearch` aggregation stage rather than a separate vector extension bolted onto a relational table. For a document-shaped domain (tenants, documents, chunks, conversations, agent steps — all naturally nested/variable-shape records), this fits better than forcing a relational schema.
- **Tenant isolation is structurally simple.** `tenantId` is just another field on every document, pre-filtered inside the same `$vectorSearch` call via the index's `filter`-type fields (see the Milestone 2 plan for the exact mechanism) — no separate row-level-security configuration needed, as Postgres would require for the same guarantee.
- **Free tier genuinely supports it.** Verified directly against current MongoDB docs (not memory): Atlas free (M0) clusters support up to 3 Search/Vector Search indexes combined, with 512 MB storage. That's enough for this project's one tenant-filtered vector index plus headroom.

**Trade-offs accepted, against Postgres + pgvector**:
- **512 MB storage cap** is smaller than Neon's free tier — chunk text must stay lean (store extracted text only, not raw uploaded files, per RULES.md section 7).
- **3-index ceiling** means the vector index design must be deliberate from the start — one shared index with a `tenantId` filter field, not one index per tenant (already the documented design in `PROJECT.md` section 3).
- **No SQL joins or relational integrity** — trade-offs are handled at the application layer (Mongoose schemas + repository interfaces) rather than database constraints. Acceptable here since the data model (per `PROJECT.md` section 5) has few true relational constraints — mostly parent-child references (chunk → document → tenant), which Mongoose's `ref`/`populate` or manual `tenantId` scoping covers adequately.
- **Index creation is asynchronous** (not instant on write) — the app must poll `listSearchIndexes()` for `queryable: true` before relying on a newly created index, which Postgres's synchronous `CREATE INDEX` wouldn't require. Handled once in a small startup/bootstrap routine, not a recurring concern.

**Interview Q&A**: *"Why MongoDB over Postgres for a RAG system, when pgvector is also free and well-known?"* — Because the actual data (multi-tenant documents, chunks, conversation traces, agent steps) is naturally document-shaped, not relational, and Atlas Vector Search keeps the embeddings in the same collection as the data they describe instead of a bolted-on extension. The real constraint that shaped the design was the free tier's 3-index cap, which is why the project uses one shared vector index with a `tenantId` filter field rather than per-tenant indexes — same discipline pgvector would need under a hosted free tier's own index-count limits.

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

## Milestone 1 — node:http with a custom `lookup`, not fetch, for the tool runner

**What**: the tool runner sends every outbound connector request via `node:http`/`node:https`'s `request()`, never the built-in `fetch`, with `agent: false` (a fresh, non-pooled connection per call) and a custom `lookup` option.

**Why**: this closes a real DNS-rebinding gap that a fetch-only pre-check can't. `fetch` resolves DNS internally, with no hook to re-validate the address at the moment it actually connects — so a hostname could pass an earlier SSRF check and then resolve to a private IP by the time `fetch` itself connects, moments later. `http.request`'s `lookup` option runs at that exact connect moment, so validation and connection happen atomically. `agent: false` additionally guarantees a prior validated connection is never silently reused for a different, unvalidated target.

**What I found by testing it, not assuming it**: Node only invokes the custom `lookup` function when the target is a *hostname* — for a literal IP target, Node skips DNS resolution (and `lookup`) entirely, which is correct and safe (there's no resolution step to rebind in the first place). My first test for "lookup runs on every request" used a literal IP as the stub server's URL and silently proved nothing — `resolveDns` was called zero times, not because the feature was broken, but because the test never actually exercised the lookup path. Fixed by pointing the test at a hostname instead. Also confirmed directly: Node calls `lookup` with `{ all: true }` by default, which is why the lookup function has to handle both the single-address and array callback shapes, not just one.

## Milestone 1 — ToolRunnerSettings must boot with an empty host allowlist

**What went wrong**: `ToolRunnerSettingsSchema` originally required `hostAllowlist` to have at least one entry (`.min(1)`). Starting the built app with `NODE_ENV=production` and no tool-runner env vars set at all crashed at Nest's bootstrap, because `CONNECTOR_HOST_ALLOWLIST` defaults to an empty list and the schema rejected it.

**The fix**: removed the `.min(1)` constraint. An empty allowlist is a valid, safe configuration — it just means no connector is currently permitted to make outbound requests, which is the correct conservative default for an unconfigured deployment, not an error condition.

**Why this matters beyond the one bug**: it's a concrete instance of "fail fast on genuinely invalid config, but don't treat the safest possible default as invalid" — a container that won't start because nothing has been configured yet is worse than one that starts and simply permits nothing until an operator sets the allowlist.

## Milestone 1 — a stray idPattern on escalate_to_human

**What went wrong**: the `escalate_to_human` connector fixture originally set `"idPattern": "^ESC-\\d{4,}$"`. That pattern describes the *output* escalation id format (`ESC-####`) — but `escalate_to_human`'s only input argument is `summary` (free text), which has no id-shaped field at all. The pattern was silently meaningless: nothing in the tool runner would ever apply it to anything, since `escalate_to_human` has zero entries in the id-argument list it checks against.

**The fix**: removed it. Caught while wiring `request.body` mappings for the POST tools and re-reading each fixture carefully, not by a failing test — nothing failed, because the pattern simply never got exercised. A good reminder that "doesn't throw" isn't the same as "correct."

## Milestone 1 — a package using zod needs zod as its own dependency

**What went wrong**: `apps/api/src/agent/tool-runner/tool-runner.settings.ts` imports `zod` directly, but `apps/api/package.json` never declared it — only `packages/shared` did. pnpm's strict per-package isolation doesn't let one workspace package borrow another's dependency transitively, so the test suite failed with `Cannot find package 'zod'` the moment this file was added.

**The fix**: added `zod@4.6.7` as a direct `apps/api` dependency. **Why not route it through `packages/shared` instead**: `ToolRunnerSettingsSchema` is purely an `apps/api`-internal concern (env parsing for this app's own tool runner) — `mock-store` has no use for it, so putting it in the shared package would be the wrong home just to avoid a second `zod` entry in a lockfile.

## Milestone 1 — a size-limit test that didn't test the size limit

**What went wrong**: the first version of the "oversized response" test set `Content-Length: 5` and then wrote 2000 bytes, expecting the tool runner's own streaming byte-counter to catch it. It didn't — Node's own HTTP parser rejects a response that delivers more bytes than its declared `Content-Length` as a protocol violation, surfacing as a generic network error *before* our byte-counting logic ever got a chance to run. The test still "passed" in the sense that *some* failure occurred, but not the one it claimed to be testing.

**The fix**: rewrote the test to send a response with *no* `Content-Length` at all (chunked encoding), which Node cannot pre-validate the size of — that's the actual scenario our own streaming counter exists to defend against, and it's the one real "lying" servers can get away with (declaring too little is caught by Node itself; declaring nothing at all is not).
