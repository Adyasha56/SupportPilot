import { describe, expect, it } from 'vitest';
import {
  buildListFilter,
  decodeCursor,
  encodeCursor,
  endOfUtcDay,
  resolveListLimit,
  startOfUtcDay,
} from './approval.repository';
import { DEFAULT_APPROVAL_LIST_LIMIT, MAX_APPROVAL_LIST_LIMIT } from '@supportpilot/shared';

describe('startOfUtcDay / endOfUtcDay', () => {
  it('returns midnight UTC on the same calendar day, regardless of the time-of-day component', () => {
    const start = startOfUtcDay(new Date('2026-11-09T23:59:59.999Z'));
    expect(start.toISOString()).toBe('2026-11-09T00:00:00.000Z');
  });

  it('is unaffected by a time right at the start of the day already', () => {
    const start = startOfUtcDay(new Date('2026-11-09T00:00:00.001Z'));
    expect(start.toISOString()).toBe('2026-11-09T00:00:00.000Z');
  });

  it('endOfUtcDay is exactly 24 hours after startOfUtcDay', () => {
    const date = new Date('2026-11-09T12:00:00.000Z');
    expect(endOfUtcDay(date).getTime() - startOfUtcDay(date).getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('never uses the server-local timezone - UTC-11:59pm and UTC-00:01am on different calendar days never collide', () => {
    const lateNight = startOfUtcDay(new Date('2026-11-09T23:30:00.000Z'));
    const earlyMorningNextDay = startOfUtcDay(new Date('2026-11-10T00:30:00.000Z'));
    expect(lateNight.getTime()).not.toBe(earlyMorningNextDay.getTime());
  });
});

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a cursor exactly', () => {
    const createdAt = new Date('2026-11-09T00:00:00.000Z');
    const cursor = encodeCursor({ createdAt, id: 'abc123' });
    expect(decodeCursor(cursor)).toEqual({ createdAt: createdAt.toISOString(), id: 'abc123' });
  });

  it('returns undefined for a malformed cursor rather than throwing', () => {
    expect(decodeCursor('not-valid-base64url-json')).toBeUndefined();
  });

  it('returns undefined for well-formed base64url JSON missing the expected fields', () => {
    const tampered = Buffer.from(JSON.stringify({ somethingElse: true }), 'utf8').toString('base64url');
    expect(decodeCursor(tampered)).toBeUndefined();
  });
});

describe('buildListFilter', () => {
  it('always scopes by tenantId', () => {
    expect(buildListFilter('acme', {})).toEqual({ tenantId: 'acme' });
  });

  it('adds a status filter when provided', () => {
    expect(buildListFilter('acme', { status: 'pending' })).toEqual({ tenantId: 'acme', status: 'pending' });
  });

  it('adds the keyset-pagination $or predicate for a valid cursor', () => {
    const createdAt = new Date('2026-11-09T00:00:00.000Z');
    const cursor = encodeCursor({ createdAt, id: '507f1f77bcf86cd799439011' });
    const filter = buildListFilter('acme', { cursor });
    expect(filter.tenantId).toBe('acme');
    expect(filter.$or).toBeDefined();
  });

  it('silently ignores a malformed cursor rather than throwing or filtering everything out', () => {
    expect(buildListFilter('acme', { cursor: 'garbage' })).toEqual({ tenantId: 'acme' });
  });
});

describe('resolveListLimit', () => {
  it('defaults when omitted', () => {
    expect(resolveListLimit(undefined)).toBe(DEFAULT_APPROVAL_LIST_LIMIT);
  });

  it('clamps to the hard cap rather than rejecting', () => {
    expect(resolveListLimit(MAX_APPROVAL_LIST_LIMIT + 1000)).toBe(MAX_APPROVAL_LIST_LIMIT);
  });

  it('clamps a non-positive value up to at least 1', () => {
    expect(resolveListLimit(0)).toBe(1);
    expect(resolveListLimit(-5)).toBe(1);
  });

  it('truncates a fractional value', () => {
    expect(resolveListLimit(5.9)).toBe(5);
  });
});
