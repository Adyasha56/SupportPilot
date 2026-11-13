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
in-flight-run limiter and conversation lock
(`apps/api/src/chat/in-flight-run-limiter.ts`, `conversation-lock.ts`), the
daily generate-budget guards (`apps/api/src/agent/loop/daily-generate-
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
editor on top) is explicitly Milestone 5 work, not done yet.

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

## A rare, accepted AgentRun duplication on an ambiguous proposal retry

`chat.service.ts` retries the WHOLE `ApprovalProposalPort.createFromProposal`
call once on failure (Stage 5's extension of Milestone 3's own amendment C
mandatory-write policy) before giving the customer a `503
PENDING_APPROVAL_WRITE_FAILED`. This retry is safe for the common case -
either the first attempt's transaction never committed (nothing to lose by
retrying) or it fully committed and the client-side error was itself the
ambiguous part, in which case the retry's own insert correctly collides
with the real Approval row's active-per-order unique index and resolves to
`already_pending` instead of a duplicate refund request. The ONE thing
this does NOT prevent: if the first attempt's transaction genuinely
committed (Approval `pending` + AgentRun `refundDisposition: pending_approval`)
but the client never found out, the retry's `already_pending` branch
writes a SECOND, distinct AgentRun document for the same `runId` (one
record for each resolution). No duplicate Approval, no duplicate refund,
no customer-visible inconsistency - just one extra audit-trail row for an
already-rare, already-ambiguous case. Accepted rather than engineered
around with idempotency bookkeeping on the AgentRun write itself, which
this project's own `AgentRun` schema doesn't currently support (no unique
constraint ties a run id to "at most one refund-disposition write").

## Two real-world failure modes still untested at the integration level

Two scenarios the Milestone 4 Stage 5 plan called for remain unverified
against a real database/real upstream, though each has unit-level coverage
of the same invariant against fakes:

- **An ambiguous upstream failure (timeout/5xx) during auto-execute,
  inside a real live chat request.** `approval.service.spec.ts`'s own
  "AMBIGUOUS failure never claims success" tests prove this against a
  scripted `PrivilegedRefundRunner`; simulating a genuinely slow/failing
  mock-store endpoint through the full HTTP integration harness (same
  pattern `chat-limits.integration-spec.ts` already uses for the LLM
  provider, not yet adapted for the connector side) was not built this
  stage.
- **The Approval+AgentRun dual-write transaction genuinely failing against
  a real Mongo session**, proving "neither document exists" against the
  real cluster rather than the in-memory fakes. `approval.service.spec.ts`'s
  own transactional unit tests (a fake `TransactionRunner` that rejects)
  prove the invariant at the service layer; a second, differently-overridden
  `TestingModule` would be needed to reproduce it against a real
  connection, which this suite's single-shared-app-boot performance
  rationale argues against adding lightly.

Neither is silently assumed to work - both are named here so they're a
visible gap, not a quiet one, until a future pass builds the harness for
them.
