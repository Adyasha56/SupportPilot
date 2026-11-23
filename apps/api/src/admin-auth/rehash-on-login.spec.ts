import { describe, expect, it } from 'vitest';
import { InMemoryAdminCredentialRepository } from '../db/test-utils/in-memory-admin-credential.repository';
import { HashConcurrencyLimiter, hashPassword, parseHash } from './password-hash';
import { rehashOnLoginIfWeak } from './rehash-on-login';

describe('rehashOnLoginIfWeak (Part 0, item Q1)', () => {
  it('rewrites the stored hash to the current (stronger) parameters when the stored one is weak', async () => {
    const credentialRepository = new InMemoryAdminCredentialRepository();
    const weakHash = await hashPassword('the-real-password', { n: 16_384, r: 8, p: 1, keylen: 32 });
    await credentialRepository.upsert('acme', 'a@b.com', weakHash);

    await rehashOnLoginIfWeak(credentialRepository, new HashConcurrencyLimiter(4, 20), 'acme', 'the-real-password', weakHash);

    const after = await credentialRepository.findByTenantId('acme');
    expect(after!.passwordHash).not.toBe(weakHash);
    expect(parseHash(after!.passwordHash).p).toBe(5); // the current SCRYPT_P default
  });

  it('never touches an already-strong stored hash', async () => {
    const credentialRepository = new InMemoryAdminCredentialRepository();
    const strongHash = await hashPassword('the-real-password');
    await credentialRepository.upsert('acme', 'a@b.com', strongHash);

    await rehashOnLoginIfWeak(credentialRepository, new HashConcurrencyLimiter(4, 20), 'acme', 'the-real-password', strongHash);

    const after = await credentialRepository.findByTenantId('acme');
    expect(after!.passwordHash).toBe(strongHash);
  });

  it('never touches failedAttempts/lockedUntil - a narrow, single-field update', async () => {
    const credentialRepository = new InMemoryAdminCredentialRepository();
    const weakHash = await hashPassword('the-real-password', { n: 16_384, r: 8, p: 1, keylen: 32 });
    await credentialRepository.upsert('acme', 'a@b.com', weakHash);
    await credentialRepository.incrementFailedAttempts('acme', null); // simulate a prior unrelated failure, never reset here

    await rehashOnLoginIfWeak(credentialRepository, new HashConcurrencyLimiter(4, 20), 'acme', 'the-real-password', weakHash);

    const after = await credentialRepository.findByTenantId('acme');
    expect(after!.failedAttempts).toBe(1); // untouched by the rehash itself
  });

  it('skips rehashing (never throws) when the hash queue is full, rather than failing the caller', async () => {
    const credentialRepository = new InMemoryAdminCredentialRepository();
    const weakHash = await hashPassword('the-real-password', { n: 16_384, r: 8, p: 1, keylen: 32 });
    await credentialRepository.upsert('acme', 'a@b.com', weakHash);

    await rehashOnLoginIfWeak(credentialRepository, new HashConcurrencyLimiter(0, 0), 'acme', 'the-real-password', weakHash);

    const after = await credentialRepository.findByTenantId('acme');
    expect(after!.passwordHash).toBe(weakHash); // unchanged - skipped, not crashed
  });
});
