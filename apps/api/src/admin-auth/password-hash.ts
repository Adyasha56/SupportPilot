import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Milestone 5, Stage 1b, item 2 - scrypt parameters, chosen against this
 * project's own stated hosting target (Render free web service, ~512MB
 * RAM - PROJECT.md section 4's free-tier constraints). scrypt's own peak
 * memory for ONE verification is approximately `128 * N * r * p` bytes:
 *
 *   128 * 16384 (N) * 8 (r) * 1 (p) = 16,777,216 bytes ~= 16 MiB.
 *
 * N=2^14, r=8, p=1 is OWASP's own current minimum recommendation for an
 * interactive login (Password Storage Cheat Sheet) - the smallest N OWASP
 * considers acceptable, chosen here deliberately on the small side (rather
 * than a larger, "more secure-looking" N) BECAUSE this project's real
 * memory budget is unusually tight for a scrypt deployment; raising N
 * doubles memory every step. 16 MiB/verification leaves comfortable room
 * for `PASSWORD_HASH_MAX_CONCURRENCY` (default 4) concurrent verifications
 * (~64 MiB worst case) alongside the rest of a 512MB Node process - and
 * node:crypto's own scrypt `maxmem` option defaults to 32 MiB, comfortably
 * above the ~16 MiB this needs, so it's left at its default rather than
 * raised (raising it would itself be a memory-exhaustion knob worth NOT
 * handing to a misconfiguration).
 */
export const SCRYPT_N = 16_384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;
const HASH_PREFIX = 'scrypt';

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

function scryptAsync(password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number }): Promise<Buffer> {
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
  const derivedKey = await scryptAsync(password, salt, params.keylen, { N: params.n, r: params.r, p: params.p });
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
  const candidate = await scryptAsync(password, parsed.salt, parsed.keylen, { N: parsed.n, r: parsed.r, p: parsed.p });
  if (candidate.length !== parsed.derivedKey.length) {
    return false;
  }
  return timingSafeEqual(candidate, parsed.derivedKey);
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
    dummyHashPromise = scryptAsync('dummy-password-never-matches-anything', DUMMY_SALT, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }).then(
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
