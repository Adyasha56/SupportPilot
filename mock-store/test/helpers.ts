import { createApp } from '../src/app';

export const TEST_TOKEN = 'test-token';
export const FIXED_NOW = new Date('2026-01-15T00:00:00.000Z');

export function createTestApp() {
  return createApp({ clock: () => FIXED_NOW, token: TEST_TOKEN });
}

export function authHeader(token: string = TEST_TOKEN): string {
  return `Bearer ${token}`;
}
