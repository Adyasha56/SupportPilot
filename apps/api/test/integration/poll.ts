/**
 * Atlas Vector Search's own documented eventual consistency means a
 * chunk that was just committed can take several seconds (measured at up
 * to ~10s against this project's own cluster - see docs/learning-notes.md)
 * to become visible to $vectorSearch. Any integration test that uploads
 * then immediately searches MUST poll, never assert on the first try.
 */
export const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;

export async function pollUntil<T>(
  check: () => Promise<T | undefined>,
  description: string,
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastFailureReason = 'no attempt completed yet';

  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result !== undefined) {
        return result;
      }
      lastFailureReason = 'the check ran but did not yet find what it was looking for';
    } catch (err) {
      lastFailureReason = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for: ${description}. ` +
      `Last reason: ${lastFailureReason}. This is index lag, not necessarily a real failure - ` +
      're-run if this is the only failing test.',
  );
}
