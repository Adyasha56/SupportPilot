import { describe, expect, it, vi } from 'vitest';
import { checkAdminOriginsAtBoot, warnIfAdminOriginsMisconfigured } from './admin-origins-boot-check';

describe('checkAdminOriginsAtBoot', () => {
  it('Part 0, item Q3 - warns when NODE_ENV is production and allowedOrigins is empty', () => {
    const result = checkAdminOriginsAtBoot([], 'production');
    expect(result).toEqual({ shouldWarn: true, allowedOriginsCount: 0, nodeEnvIsProduction: true });
  });

  it('never warns when allowedOrigins is non-empty, even in production', () => {
    const result = checkAdminOriginsAtBoot(['https://admin.example.com'], 'production');
    expect(result).toEqual({ shouldWarn: false, allowedOriginsCount: 1, nodeEnvIsProduction: true });
  });

  it('never warns outside production, even when allowedOrigins is empty', () => {
    expect(checkAdminOriginsAtBoot([], 'development').shouldWarn).toBe(false);
    expect(checkAdminOriginsAtBoot([], undefined).shouldWarn).toBe(false);
    expect(checkAdminOriginsAtBoot([], 'test').shouldWarn).toBe(false);
  });

  it('counts origins correctly regardless of warn outcome', () => {
    expect(checkAdminOriginsAtBoot(['a', 'b', 'c'], 'development').allowedOriginsCount).toBe(3);
  });
});

describe('warnIfAdminOriginsMisconfigured', () => {
  it('calls warn exactly once, with only a count and a boolean, never an origin string', () => {
    const warn = vi.fn();
    warnIfAdminOriginsMisconfigured([], 'production', warn);

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warn.mock.calls[0][0] as string);
    expect(logged).toEqual({
      event: 'admin_allowed_origins_empty_in_production',
      allowedOriginsCount: 0,
      nodeEnvIsProduction: true,
    });
  });

  it('never calls warn when origins are configured', () => {
    const warn = vi.fn();
    warnIfAdminOriginsMisconfigured(['https://admin.example.com'], 'production', warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never calls warn outside production', () => {
    const warn = vi.fn();
    warnIfAdminOriginsMisconfigured([], 'development', warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never logs the actual origin values, even when some are configured alongside a NODE_ENV that would otherwise warn', () => {
    const warn = vi.fn();
    warnIfAdminOriginsMisconfigured(['https://secret-admin-host.internal'], 'production', warn);
    expect(warn).not.toHaveBeenCalled();
  });
});
