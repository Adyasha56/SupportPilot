import { createHash, timingSafeEqual } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

/**
 * Hash both sides before comparing: timingSafeEqual requires equal-length
 * buffers (and throws otherwise), and hashing normalizes length regardless
 * of the submitted token's length, avoiding both a throw and a length-based
 * timing signal.
 */
function timingSafeTokenEquals(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * Bearer auth, applied to every route. Error responses are deliberately
 * generic and never echo the submitted token or any request details.
 */
export function createAuthMiddleware(expectedToken: string) {
  return function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    const header = req.header('authorization');

    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const token = header.slice('Bearer '.length);
    if (!timingSafeTokenEquals(token, expectedToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    next();
  };
}
