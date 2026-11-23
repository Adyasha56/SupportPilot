import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Milestone 5, Part 0 (Stage 1b follow-up) item Q1 - a real correctness
 * bug found and fixed: the original version of this file used N=2^14,
 * r=8, **p=1** and called it "OWASP's current minimum" - checked directly
 * against the LIVE OWASP Password Storage Cheat Sheet
 * (cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html,
 * checked 2026-11-21), that is wrong on two counts: the cheat sheet's
 * actual table is
 *
 *   N=2^17 (128 MiB), r=8, p=1   <- listed first/default
 *   N=2^16 (64 MiB),  r=8, p=2
 *   N=2^15 (32 MiB),  r=8, p=3
 *   N=2^14 (16 MiB),  r=8, p=5
 *   N=2^13 (8 MiB),   r=8, p=10
 *
 * - every row is presented as comparably secure, trading memory for CPU
 * parallelism (p) as memory shrinks; N=2^14 is paired with p=5, never
 * p=1. p=1 at N=2^14 is not one of the five rows at all - it's strictly
 * weaker than even the smallest-memory row (2^13, p=10), confirmed by
 * direct benchmark on this machine (node:crypto, this project's own
 * runtime, 2026-11-21):
 *
 *   N=2^17,r=8,p=1 (OWASP #1):  306.5ms,  128.0 MiB
 *   N=2^16,r=8,p=2 (OWASP #2):  293.7ms,   64.0 MiB
 *   N=2^15,r=8,p=3 (OWASP #3):  196.6ms,   32.0 MiB
 *   N=2^14,r=8,p=5 (OWASP #4):  153.9ms,   16.0 MiB
 *   N=2^13,r=8,p=10 (OWASP #5): 145.1ms,    8.0 MiB
 *   N=2^14,r=8,p=1 (the bug):    32.4ms,   16.0 MiB  <- ~5x less work than #5
 *
 * DECISION: OWASP row #4 (N=2^14, r=8, p=5) - a REAL OWASP row, not a
 * deviation, chosen specifically for this project's unusually tight free-
 * tier memory budget (Render free, ~512MB total - PROJECT.md section 4).
 * Peak memory for one verification is `128 * N * r` bytes (confirmed
 * empirically: this does NOT scale with p in Node's scrypt - every row
 * above ran successfully with `maxmem` sized from N*r alone, matching
 * OWASP's own memory column, which is why increasing p lets memory drop
 * while keeping comparable total work):
 *
 *   128 * 16384 (N) * 8 (r) = 16,777,216 bytes = 16 MiB.
 *
 * `maxmem` is set EXPLICITLY (never left at node:crypto's own 32 MiB
 * default) to exactly this value plus a small fixed headroom - necessary
 * now that a verification against an OLD, weaker stored hash (a smaller
 * N) must still succeed, and sufficient to make a miscalculated or
 * maliciously-crafted huge N in a stored hash string FAIL LOUDLY (a
 * `maxmem` error) rather than silently allocate unbounded memory - see
 * `maxmemFor` below.
 *
 * CONCURRENCY BUDGET (stated, not guessed): 96 MiB dedicated to concurrent
 * verification hashing - under 20% of the 512MB host, leaving the rest for
 * the Node runtime, Mongoose connections, and everything else this one
 * process already does. At 16 MiB/verification, 96 / 16 = 6 concurrent
 * slots - `ADMIN_HASH_MAX_CONCURRENCY` defaults to 6 (see
 * admin-auth.settings.ts). The QUEUE (separately bounded,
 * `ADMIN_HASH_MAX_QUEUE_LENGTH`) costs no extra scrypt memory at all while
 * waiting - only a queued closure - so it is not part of this budget.
 */
export const SCRYPT_N = 16_384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 5;
export const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;
const HASH_PREFIX = 'scrypt';
/** Fixed headroom added on top of the exact `128*N*r` requirement, for both hashing and verifying. */
const MAXMEM_HEADROOM_BYTES = 1024 * 1024;

export function maxmemFor(n: number, r: number): number {
  return 128 * n * r + MAXMEM_HEADROOM_BYTES;
}

export class PasswordHashError extends Error {}

/** Self-describing: every parameter scrypt needs to verify is IN the string - a later change to SCRYPT_N/R/P never invalidates an existing hash, because verification never consults the current constants. */
export function serializeHash(params: { n: number; r: number; p: number; keylen: number; salt: Buffer; derivedKey: Buffer }): string {
  return [HASH_PREFIX, params.n, params.r, params.p, params.keylen, params.salt.toString('base64'), params.derivedKey.toString('base64')].join('$');
}

interface ParsedHash {
  n: number;
  r: number;
  p: number;
  keylen: number;
  salt: Buffer;
  derivedKey: Buffer;
}

export function parseHash(stored: string): ParsedHash {
  const parts = stored.split('$');
  if (parts.length !== 7 || parts[0] !== HASH_PREFIX) {
    throw new PasswordHashError('Malformed password hash string.');
  }
  const [, nStr, rStr, pStr, keylenStr, saltB64, keyB64] = parts;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  const keylen = Number(keylenStr);
  if (![n, r, p, keylen].every((v) => Number.isInteger(v) && v > 0)) {
    throw new PasswordHashError('Malformed password hash parameters.');
  }
  return { n, r, p, keylen, salt: Buffer.from(saltB64, 'base64'), derivedKey: Buffer.from(keyB64, 'base64') };
}

function scryptAsync(password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // ASYNC scryptSync NEVER used (item 2's explicit requirement) - scryptSync would block
    // the whole event loop for the hash's own duration, stalling every other request this
    // process is handling, including completely unrelated ones, for as long as one hash takes.
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string, params: { n: number; r: number; p: number; keylen: number } = { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, keylen: SCRYPT_KEYLEN }): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derivedKey = await scryptAsync(password, salt, params.keylen, { N: params.n, r: params.r, p: params.p, maxmem: maxmemFor(params.n, params.r) });
  return serializeHash({ ...params, salt, derivedKey });
}

/**
 * `timingSafeEqual` on the two DERIVED KEYS, never a `===`/string compare,
 * and never short-circuiting - same "constant-time compare on top of the
 * authoritative check" belt-and-suspenders pattern `verifyApiKeyHash`
 * already uses (auth/api-key.service.ts). Returns `false` (never throws)
 * for a malformed stored hash, so a corrupted row degrades to "login
 * fails", never a 500.
 */
export async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
  let parsed: ParsedHash;
  try {
    parsed = parseHash(stored);
  } catch {
    return false;
  }
  const candidate = await scryptAsync(password, parsed.salt, parsed.keylen, { N: parsed.n, r: parsed.r, p: parsed.p, maxmem: maxmemFor(parsed.n, parsed.r) });
  if (candidate.length !== parsed.derivedKey.length) {
    return false;
  }
  return timingSafeEqual(candidate, parsed.derivedKey);
}

/**
 * Item Q1 - "rehash on successful login when stored parameters are
 * weaker than current". Strength is compared as total work `N * r * p`
 * (OWASP's own table trades memory for p specifically to keep this
 * product roughly comparable across rows - a smaller N with a
 * proportionally larger p is NOT weaker just because N shrank). A hash
 * already at or above the current target is never rehashed.
 */
export function isWeakerThanCurrentParams(stored: { n: number; r: number; p: number }): boolean {
  const storedWork = stored.n * stored.r * stored.p;
  const currentWork = SCRYPT_N * SCRYPT_R * SCRYPT_P;
  return storedWork < currentWork;
}

/** Parses `stored` and reports whether it is weaker than the current target parameters - `false` (never throws) for a malformed string, the same "fail safe, never crash" rule every other function here follows. */
export function storedHashIsWeak(stored: string): boolean {
  try {
    return isWeakerThanCurrentParams(parseHash(stored));
  } catch {
    return false;
  }
}

/**
 * A FIXED dummy hash, same cost parameters as every real credential,
 * computed once (lazily, on first use) from a fixed password and a FIXED
 * (not random) salt - it must always serialize to the exact same string on
 * every call in this process, so every "unknown email"/"locked account"
 * login attempt verifies against the IDENTICAL hash, indistinguishable
 * from each other and from a real wrong-password attempt's own cost.
 * Never actually matches a real password (callers never reach the
 * `timingSafeEqual` branch with a password anyone could realistically
 * type - this exists purely to spend the SAME scrypt wall-clock time and
 * concurrency-slot as a real verification, not to ever "succeed").
 */
const DUMMY_SALT = Buffer.from('supportpilot-dummy-hash-fixed-salt-16b!', 'utf8').subarray(0, SALT_BYTES);
let dummyHashPromise: Promise<string> | undefined;

export function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = scryptAsync('dummy-password-never-matches-anything', DUMMY_SALT, SCRYPT_KEYLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: maxmemFor(SCRYPT_N, SCRYPT_R),
    }).then(
      (derivedKey) => serializeHash({ n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, keylen: SCRYPT_KEYLEN, salt: DUMMY_SALT, derivedKey }),
    );
  }
  return dummyHashPromise;
}

/** Always verifies against getDummyHash() - callers never pass the user's real submitted password through anything else for this path, so this is always a guaranteed non-match, at real scrypt cost. */
export async function verifyDummyHash(submittedPassword: string): Promise<boolean> {
  return verifyPasswordHash(submittedPassword, await getDummyHash());
}

/**
 * Item 2's concurrency cap - a bounded number of scrypt calls in flight at
 * once, plus a bounded QUEUE beyond that (never unbounded): a login flood
 * must get a fast, honest 429 once the queue itself is full, rather than
 * either exhausting process memory (each in-flight hash costs real RAM,
 * see this file's own module doc comment) or silently queueing requests
 * forever and starving the event loop's own responsiveness. Single
 * in-process instance - same accepted single-instance limitation every
 * other in-memory guard in this project already carries
 * (docs/known-limitations.md).
 */
export class HashConcurrencyLimiter {
  private inFlight = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly maxConcurrency: number,
    private readonly maxQueueLength: number,
  ) {}

  /** Resolves `{ok:false}` immediately (never queues past the cap) when the queue is already full. */
  async run<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    if (this.inFlight >= this.maxConcurrency) {
      if (this.queue.length >= this.maxQueueLength) {
        return { ok: false };
      }
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.inFlight++;
    try {
      const value = await fn();
      return { ok: true, value };
    } finally {
      this.inFlight--;
      const next = this.queue.shift();
      if (next) {
        next();
      }
    }
  }

  /** Test/diagnostic visibility only. */
  get snapshot(): { inFlight: number; queued: number } {
    return { inFlight: this.inFlight, queued: this.queue.length };
  }
}
