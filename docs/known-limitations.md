# Known limitations and accepted risks

An honest list of things this project deliberately does NOT solve, and why
each is an acceptable trade-off at this project's current scale (a
portfolio flagship running on free tiers, not a multi-instance production
deployment - PROJECT.md's own non-goals). Several of these are also
mentioned in-line in `PROJECT.md`/`docs/learning-notes.md`; this file is the
one place that collects all of them together.

## Single-instance assumptions

Every in-memory guard in this project - the per-IP/per-key/per-tenant/per-
customerRef rate limiters (`apps/api/src/auth/rate-limiter.ts`), the
per-apiKeyId limiter on the admin decision route
(`apps/api/src/approvals/approval-decision-rate-limiter.provider.ts`), the
in-flight-run limiter and conversation lock
(`apps/api/src/chat/in-flight-run-limiter.ts`, `conversation-lock.ts`), the
widget polling endpoint's own per-conversation rate limiter (Milestone 5,
`apps/api/src/chat/poll-rate-limiter.provider.ts`), the per-ADMIN-PRINCIPAL
rate limiter inside `AdminAuthGuard` itself (Stage 1c item 5 - applies to
every approvals/conversations/settings/connectors/policies admin request),
the daily generate-budget guards (`apps/api/src/agent/loop/daily-generate-
budget.ts`), the circuit breaker inside `GeminiLlmProvider`, and the
ingestion per-tenant busy-lock - holds its state in a single Node process's
memory. Running more than one instance of the API (a second container, a
horizontally-scaled deployment) would give each instance its OWN,
independent copy of every one of these: a rate limit configured for "20
requests/minute per tenant" would actually allow up to `20 x N` across N
instances, two instances could each think they're the only one processing a
given conversation, and the daily budget would be enforced per-instance, not
globally. This is a known, accepted limitation at this project's scale
(PROJECT.md's own non-goal: "a hosted, many-customer production
deployment"). Fixing it for real would mean moving every one of these to a
shared store (Redis, or MongoDB itself) - a real piece of future work, not
a small patch.

## The per-API-key chat limit is a TENANT-WIDE throttle, not a per-visitor one

`ChatSettings.rateLimitApiKeyMaxRequests` (default 60/min, enforced by
`ApiKeyGuard`'s per-key `RateLimiter`) is keyed by the `ApiKey` document's
own id - and a tenant's public widget key is exactly ONE document, shared
by every visitor of that tenant's widget. This was the direct cause of a
real bug found and fixed in Part 0 of the Milestone 5, Stage 1a follow-up
(see the next section): before the fix, the widget's polling endpoint ALSO
spent this same shared budget, so a handful of concurrent visitors polling
at a few requests/minute each could sum past 60/min and get everyone -
every visitor's chat send included - a `429`, even though no single visitor
was individually anywhere near a reasonable rate. The polling-vs-chat
sharing is now fixed (next section) - but the underlying design point
remains, and is worth stating plainly: **this limit was never really
"per API key" in the sense its name suggests - it's per TENANT**, since
one tenant's widget traffic is, in practice, one shared key's traffic.
A tenant with many simultaneous customers sending chat messages (not just
polling) can still collectively hit this one shared bucket today.

**Proposed fix, not yet built**: make this limit a genuine per-tenant
*setting* (`Tenant.settings`, alongside `refundCap`/`approvalThreshold`),
sized by each tenant's own expected traffic, rather than one fixed global
default (`CHAT_RATE_LIMIT_API_KEY_MAX_REQUESTS`) applied identically
regardless of a tenant's actual visitor volume. This would also let a
tenant genuinely expecting high concurrent chat volume raise their own
limit without changing the default for every other tenant.

## Part 0 (Milestone 5 Stage 1a follow-up), item P1 - the polling endpoint used to share chat's own guard-level buckets

Confirmed directly from the code: `ConversationMessagesController`
originally carried `@UseGuards(ApiKeyGuard)` - the SAME `ApiKeyGuard`
provider `ChatController` uses, both registered once in `ChatModule`'s
`providers` array. NestJS providers are singletons by default, so sharing
the provider meant sharing the exact same `RateLimiter` instances: the
widget's polling traffic was silently spending the identical per-IP
(20/min) and per-API-key (60/min, see the section above) budget as
chat-SENDING traffic. Five concurrent visitors polling at the original 3s/
10s cadence (13 requests/60s each) summed to 65/minute on the ONE shared
per-key bucket - over the 60/min default, 429-ing every visitor's chat AND
polling requests, not just the "excess" ones; visitors sharing a NAT'd IP
hit the per-IP bucket the identical way.

**Fixed**: `ConversationMessagesController` now carries its own
`PollApiKeyGuard` (`apps/api/src/chat/poll-api-key-guard.ts`) - the same
authentication logic (inherited from `ApiKeyGuard`, not copied), but with
its own, entirely independent per-IP/per-key `RateLimiter` instances
(`CHAT_POLL_GUARD_IP_RATE_LIMIT_*`/`CHAT_POLL_GUARD_API_KEY_RATE_LIMIT_*`).
A new per-TENANT poll bucket (`CHAT_POLL_TENANT_RATE_LIMIT_*`) was also
added, on top of the pre-existing per-conversation one, since many
visitors of one tenant's widget can still sum past a per-conversation
bucket's own, narrower limit. Every one of these four buckets is sized
against `ASSUMED_CONCURRENT_VISITORS` (20, a stated assumption -
`apps/api/src/chat/poll-rate-limit-headroom.ts`), not a single visitor -
see `poll-rate-limit-headroom.spec.ts` for the worst-case math each
default is checked against. The documented polling cadence was also
revised (cheaper: 5s start, back off to 15s after 30s) and the endpoint now
supports a conditional `ETag`/`If-None-Match` response, so an unchanged
poll skips the message-page query entirely - both reduce real load
further, on top of the bucket fix itself.

## Config read at import time in several modules

`app.module.ts`, `auth.module.ts`, `chat.module.ts`, `ingestion.module.ts`,
and `retrieval.module.ts` each decide whether to import `DatabaseModule`
via a plain module-level `const`, computed from `process.env.MONGODB_URI`
the FIRST time that file is imported in the process - never re-read after
that. This is fine for how the app actually runs (one process, booted once,
`MONGODB_URI` never changes mid-process) - it only became a real problem
inside the Stage 6 integration-test harness, which needed to flip
`MONGODB_URI` between "set" and "unset" within ONE already-warm test
process (fixed there with `vi.resetModules()` + a fresh dynamic `import()` -
see `chat-unconfigured.integration-spec.ts`'s own doc comment for the full
story). The underlying design - a handful of near-identical
`xDatabaseImportsFor(env)` pure functions, each hand-copied into its own
module - is what a proper **dynamic module** refactor would replace: a
single `DatabaseModule.forRootIfConfigured()`-style factory that every
other module calls identically, instead of five independent copies of the
same "env.MONGODB_URI ? [DatabaseModule] : []" decision. Not done yet
because every module already has its own test proving its OWN copy of this
decision is wired correctly (`*.module.spec.ts`, each with a "the real
decorator's imports match what xDatabaseImportsFor(process.env) computes"
regression guard) - refactoring five already-tested, independently-correct
copies into one shared mechanism is real work with its own risk, not a
quick fix, and nothing in the app's own runtime behavior is actually wrong
today.

## Connector configs live in files, not the database

Per-tenant tool definitions (`get_order`, `track_shipment`, `issue_refund`,
`escalate_to_human`) are JSON files on disk
(`apps/api/src/connectors/fixtures/<tenantId>/<tool>.json`), loaded by
`FileConnectorConfigRepository` - not rows in MongoDB, and there is no
`POST /v1/connectors` endpoint that actually persists anything yet (the API
table in `PROJECT.md` section 6 lists it as a planned endpoint). This means
onboarding a new tenant's connectors today requires a deploy (new files in
the image, or a mounted directory - see the demo profile's own
`CONNECTOR_CONFIG_DIR` bind mount for exactly that pattern) rather than an
admin-console action. Accepted for now because Milestone 1 explicitly
scoped connector configs as "data, not code" at the FILE level only -
moving them into the database (and building the admin console's connector
editor on top) is explicitly Milestone 5 work, not done yet. Stage 1c item 4
added the READ-only half of the admin surface this gap always expected to
eventually need (`GET /v1/connectors`, tool name and description only,
`ConnectorsAdminController`) - this does not change anything above: still
no write path, still files on disk, still a deploy to add a tenant's
connectors. A tenant with no fixtures directory of its own gets an empty
list, never an error.

## The Origin check is advisory, not a security boundary

`checkOriginSpeedBump()` (`apps/api/src/auth/api-key.guard.ts`) compares a
public-scope request's `Origin` header against the tenant's configured
`allowedOrigins` and logs a mismatch - it never blocks the request. This is
deliberate, not an oversight: a widget's origin can always be spoofed,
proxied, or stripped entirely by a non-browser client, so an `Origin` check
can only ever be an operator signal ("traffic from somewhere unexpected"),
never an actual access control. The real security boundary for the public
key is what it's scoped to do (only `POST /v1/chat`, for one tenant, rate
limited) - not where the request claims to come from.

## Customer token replay within its own lifetime

A customer identity token (Ed25519-signed, `apps/api/src/agent/identity/
customer-token.ts`) is valid for anyone who possesses it until it expires
(`CUSTOMER_TOKEN_MAX_LIFETIME_MS`, 15 minutes by default) or is explicitly
retired at the key level - there is no single-use/nonce mechanism, and no
way to revoke one already-issued token early short of retiring the entire
kid (which invalidates every token issued under it, not just one). A token
that leaks (logged somewhere it shouldn't be, intercepted) is usable for
its full remaining lifetime. Accepted because the lifetime is short by
design and the token only ever authorizes read-only lookups plus a
*proposed* action (never an executed one) for one specific, already-known
customerRef - the blast radius of a leaked token is bounded by design, not
by replay protection.

## Free-tier content terms mean fictional data only

Both Gemini's free tier and MongoDB Atlas's free (M0) tier have terms that
make them unsuitable for real personal or customer data (Gemini's free
tier lets Google use submitted content to improve its products, with human
reviewers able to read it - see `.env.example`'s own note next to
`GEMINI_API_KEY`). This project is built, demoed, and tested exclusively
against fictional data (the mock store's seeded orders, sample policy
documents) - never a real company's real customer data. This is a
permanent property of running on free tiers, not something a future fix
removes; a production deployment of this architecture would need paid
tiers for both before handling anything real.

## Gemini free-tier availability and unexplained stalls

The free tier's rate limits and availability are not something this
project controls or can fully predict - `ThrottledClient`/the circuit
breaker (`apps/api/src/llm/`) handle the KNOWN failure modes (429 rate
limits, timeouts, transient errors) with backoff and a trip-open breaker,
but a few manual test runs during development saw occasional stalls with
no clear error surfaced by the SDK itself before timing out - never
root-caused to a specific, reproducible condition, and not something a
code fix was identified for. `degraded: "LLM_UNAVAILABLE"` is this
project's answer either way: whatever the underlying cause, the customer
still gets a clean 200 response and a human-handoff message, never a hung
request or a 500.

## TTL deletes old messages even inside a still-active conversation

`Message`'s TTL index is on `createdAt` (not tied to the conversation's own
activity) while `Conversation`'s TTL is on `updatedAt` - so an individual
message older than `CHAT_RETENTION_DAYS` (30 days by default) is deleted
even while its conversation is still alive and well inside the retention
window itself. Confirmed harmless for the agent's own behavior: `run-
agent.ts`'s history window only ever loads the most recent
`CHAT_HISTORY_WINDOW_SIZE` messages (10 by default) - far inside any
realistic 30-day gap - so the agent never notices. The real exposure is a
hypothetical full-transcript admin view (Milestone 5's "open a
conversation" reasoning panel) for a conversation active longer than the
retention period, which would show a gap where the oldest messages used to
be. No such view exists yet, so nothing is actually broken today - this is
a note for whoever builds it (see `docs/learning-notes.md`'s own entry on
this for the full reasoning).

## The refund-verifier can only ever approve a DELIVERED order

Rule 3 (`ORDER_STATUS_INELIGIBLE`, `apps/api/src/approvals/refund-verifier.ts`)
requires `order.status === 'delivered'` - an order that is `in_transit`,
`delayed`, `cancelled`, or already `refunded` can never pass the verifier,
regardless of how late or clearly problematic it is. This was an explicit,
already-approved rule in the Milestone 4 design table, not something
Stage 5 introduced - but wiring the verifier into live chat for the first
time (Stage 5) surfaced its real consequence directly: a customer whose
order simply hasn't arrived yet (still `in_transit`/`delayed`, the
PROJECT.md section 2 example scenario "my order has not arrived") can
never get an automatic refund PROPOSAL approved - the only outcome
available to that case today is `escalate` with `ORDER_STATUS_INELIGIBLE`,
handing it to a human. This may be exactly the right call (you genuinely
cannot refund money for an order that might still arrive), or it may be
worth a setting letting a tenant opt into refunding a sufficiently-late-
but-undelivered order automatically too - not decided here. Same
discipline as the retrieval-score-threshold decision in Milestone 3:
flagged as a real, surfaced product question with a concrete example
(`chat.integration-spec.ts`'s "not-yet-delivered order: denied" test), not
resolved on the strength of one person's intuition about what "should"
happen.

## TTL retention vs. a long-unresolved retryable-failed Approval

`Approval`'s TTL index (`APPROVAL_RETENTION_DAYS`, default 90) fires on
`createdAt` regardless of status. A `failed` row that is `retryable: true`
(an ambiguous upstream outcome - timeout, network error, 5xx) has no expiry
of its own (only `pending` rows are ever written to `expired` by
`approveFromPending`'s own expiry check) - so one left unresolved long
enough is silently deleted by the TTL, taking its idempotency key with it.
At that point a retry is no longer possible at all; the admin would simply
see the row vanish from `GET /v1/approvals`, with nothing left to act on.
`approvalExpiryDays`'s short default (7) only governs the `pending`-side
expiry path, nowhere near the 90-day TTL window - it is specifically the
retryable-`failed` path operators need to not leave unattended for months.
No scheduled reconciliation sweep or alert exists for this; an admin
noticing and retrying (safe, idempotent, via the real decision route) is
the only recovery path today, and that path itself eventually stops being
available once the TTL is reached. Accepted as a documented gap, not a bug
to fix now - a real fix would need either a longer/separate retention rule
for non-terminal rows, or active alerting, both future scope.

## The admin SPA fallback absorbs a denied/traversal static request into the ordinary shell response

`express.static`'s default `fallthrough: true` (never overridden by
`registerAdminStaticAssets`, `apps/api/src/common/admin-static.ts`) means a
dotfile denial (`dotfiles: 'deny'`) or a `..`-style traversal attempt under
`/admin/*` never reaches the client as its own distinct error - the
underlying `send` stream's error event is swallowed by `serve-static`
(confirmed directly against this project's installed `serve-static@2.2.1`/
`send@1.2.1`: `forwardError` only becomes true once a real file was already
found, so a 403/404 from `send` takes the `next()` branch, not `next(err)`)
and falls through to `adminSpaFallback`, which - exactly as designed for a
legitimate client-routed deep link - serves the SPA's own `index.html` with
a plain `200`. The actual security property (the dotfile's or the
traversal target's own content is never returned) still holds, verified
empirically by `apps/api/test/static-serving.e2e-spec.ts`; what does NOT
hold is a caller being able to distinguish "this path was denied" from "this
is just an unmapped client route" by status code alone - both look like an
ordinary 200 SPA-shell response. Accepted as the correct trade-off for an
SPA fallback (disabling `fallthrough` would also break the legitimate
deep-link case the fallback exists for), not a content-exposure risk - but
worth knowing if a future admin-console security review goes looking for a
403/404 here and doesn't find one. The widget's own static root
(`widget-static.ts`) has no such fallback registered after it, so the
identical attempts there DO surface as a plain, distinguishable 404.

## A real parameter mistake, found and fixed: scrypt was NOT at an OWASP-listed configuration

Milestone 5, Part 0, item Q1 caught a genuine bug in Stage 1b's original
`password-hash.ts`: it used N=2^14, r=8, **p=1** and documented this as
"OWASP's current minimum." Checked directly against the LIVE OWASP
Password Storage Cheat Sheet (2026-11-21), that claim was wrong - the real
table is N=2^17/r=8/p=1 (listed first), down to N=2^13/r=8/p=10, and N=2^14
is paired with **p=5**, never p=1. p=1 at N=2^14 is not one of the five
rows at all; a direct benchmark on this project's own machine measured it
at ~32ms versus ~145-307ms for every real OWASP row - roughly 5x less
total work than even the smallest-memory sanctioned configuration. Fixed
to the real OWASP row (N=2^14, r=8, p=5, ~154ms measured, 16 MiB/
verification) with `maxmem` now set explicitly rather than left at
node:crypto's own 32 MiB default, and a rehash-on-successful-login path so
any credential already written under the original, weaker parameters is
transparently upgraded the next time its owner logs in or re-enters their
password for a step-up, with no forced password reset. Recorded here
specifically so this specific class of mistake (citing a security
standard from memory instead of checking it) is visible and not repeated
silently elsewhere in this project.

## Admin console: one credential per tenant, no self-service password reset

Milestone 5, Stage 1b deliberately ships the single-admin-per-tenant model
PROJECT.md section 6 already decided (no roles, no multi-admin, no SSO -
explicit non-goals). Two concrete consequences worth stating plainly:

- **No password reset flow of any kind** (no "forgot password" email, no
  reset link - there's no email-sending capability in this project at all).
  The only way to change a tenant's admin password is `pnpm run
  set-admin-credential`, run by whoever has direct database access - the
  same person/role who already runs `create-api-key`/`set-tenant-settings`
  today. This is the explicit, accepted recovery path, not a gap to fix
  later at this project's scale.
- **A locked-out admin's recovery path is the tenant's own `admin`-scoped
  API key** (`create-api-key.ts --scope=admin`), which authenticates via
  `AdminAuthGuard`'s header path and is never subject to the password
  lockout at all (lockout only ever applies to the password-login path) -
  see `docs/manual-testing.md`'s own lockout-and-recovery walkthrough.

Unlike every in-memory guard this project already documents above
("Single-instance assumptions"), `AdminSession` rows live in MongoDB, not
process memory - a session genuinely survives a restart/redeploy and is
correctly shared across instances if this were ever horizontally scaled
(PROJECT.md's own non-goal, but worth noting the session store itself
isn't what would need fixing first). The per-IP login limiter and the
scrypt `HashConcurrencyLimiter`, however, ARE single-instance in-memory
state, for the same accepted reason every other limiter in this project is.

## An unexpected infra fault during admin decision execution returns a bare 500

`ApprovalService.executeApproval`'s own `markExecuted`/`markFailed` calls
are not wrapped in a try/catch - a genuinely unexpected failure there (a
Mongo write timeout, for example, after the real refund already succeeded
upstream) propagates uncaught through `ApprovalsController.decide()` and
surfaces as Nest's own default `500` body, never this project's
`{statusCode, code, message}` contract. This is deliberate, not an
oversight: the one real safety property - the approval is left in whatever
state the exception found it (never falsely marked `executed`, never
silently retried from scratch) - already holds without a catch block here,
and a later admin retry (once the lease expires) is what actually
reconciles it, exactly as proven by
`approvals-markexecuted-reconciliation.integration-spec.ts`. Giving this
one failure mode its own clean HTTP shape would be straightforward but was
not judged worth the extra code for a path that, by construction, never
loses money or state - only the HTTP response's own politeness.

## Production deployment checklist

A short checklist for anyone actually setting `NODE_ENV=production` for this
API (Render free web service, Docker Compose outside the `demo` profile,
or any other host) - not a substitute for reading `.env.example` in full,
just the items that fail silently or fail closed in a way worth calling out
up front.

- **`ADMIN_ALLOWED_ORIGINS` must be set.** Left empty, the admin-auth
  Origin check (`admin-auth.settings.ts`) fails closed by design - every
  cookie-session-authenticated non-GET admin request (login excluded) is
  refused with a generic error, not a security hole, but a confusing one to
  debug after the fact. Part 0, item Q3: the API now logs ONE boot-time
  warning when `NODE_ENV=production` and this is empty - a count
  (`allowedOriginsCount: 0`) and a boolean (`nodeEnvIsProduction: true`)
  only, never an origin string, since the log itself must not become a
  place secrets or internal hostnames leak. See
  `apps/api/src/admin-auth/admin-origins-boot-check.ts` and its own spec.
  Watch for `admin_allowed_origins_empty_in_production` in the boot log.
- **`TRUST_PROXY_HOPS`** should match the real number of reverse-proxy hops
  in front of the API (1 on Render's free web service, 0 behind no proxy at
  all) - `main.ts`'s own comment explains why 0 is the only safe default
  without knowing the topology, and why getting this wrong silently breaks
  every per-IP limiter (it would key on the proxy's own IP instead of the
  real client's).
- **`ADMIN_DEV_COOKIE_ENABLED` must be unset (or `false`).** The non-Secure
  dev cookie path requires it set to the literal string `true` AND
  `NODE_ENV!=='production'` - both, never either alone - so leaving it set
  in a production environment variable is harmless by construction, but
  don't rely on that; unset it anyway.
- **`CONNECTOR_CONFIG_DIR`/private-network SSRF exceptions** are the `demo`
  Compose profile's job, never production's - see "Docker demo and the
  SSRF guard" in `PROJECT.md` section 3. A production container always has
  `allowPrivateNetworks: false` and `requireHttps: true`, unconditionally.
- **Free tiers**: re-verify Gemini/Atlas M0/Render's current limits before
  relying on them (RULES.md §7) - they change without notice.
