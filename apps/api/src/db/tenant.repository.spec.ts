import { describe, expect, it, vi } from 'vitest';
import { DEMO_TENANT_SETTINGS, MongooseTenantRepository, TenantNotFoundError, toTenant } from './tenant.repository';
import { TenantSettingsValidationError } from './tenant-settings-validation';

describe('toTenant (amendment N-e: defaults applied at read time)', () => {
  it('applies every demo default when settings is entirely absent (a pre-Milestone-4 legacy document)', () => {
    const tenant = toTenant({ _id: 'acme', name: 'Acme', settings: {} });
    expect(tenant.refundCap).toBe(DEMO_TENANT_SETTINGS.refundCap);
    expect(tenant.approvalThreshold).toBe(DEMO_TENANT_SETTINGS.approvalThreshold);
    expect(tenant.refundWindowDays).toBe(DEMO_TENANT_SETTINGS.refundWindowDays);
    expect(tenant.autoExecuteRefunds).toBe(DEMO_TENANT_SETTINGS.autoExecuteRefunds);
    expect(tenant.approvalExpiryDays).toBe(DEMO_TENANT_SETTINGS.approvalExpiryDays);
  });

  it('applies defaults field-by-field for a partially-populated legacy document', () => {
    const tenant = toTenant({ _id: 'acme', name: 'Acme', settings: { refundCap: 500 } });
    expect(tenant.refundCap).toBe(500);
    expect(tenant.approvalThreshold).toBe(DEMO_TENANT_SETTINGS.approvalThreshold);
  });

  it('never defaults dailyRefundCountLimit - undefined means "no limit", not a gap to fill', () => {
    const tenant = toTenant({ _id: 'acme', name: 'Acme', settings: {} });
    expect(tenant.dailyRefundCountLimit).toBeUndefined();
  });

  it('prefers a stored value over the default when both exist', () => {
    const tenant = toTenant({ _id: 'acme', name: 'Acme', settings: { refundCap: 999, autoExecuteRefunds: true } });
    expect(tenant.refundCap).toBe(999);
    expect(tenant.autoExecuteRefunds).toBe(true);
  });
});

/** A minimal fake of the one Mongoose Model surface MongooseTenantRepository actually calls - avoids needing a real database connection for pure merge/validate/audit logic. */
function fakeModel(initialDoc: { _id: string; name: string; settings: Record<string, unknown> } | null) {
  let stored = initialDoc;
  return {
    findById: vi.fn(() => ({
      lean: () => Promise.resolve(stored ? { ...stored, settings: { ...stored.settings } } : null),
    })),
    findByIdAndUpdate: vi.fn((_id: string, update: { $set: Record<string, unknown> }) => ({
      lean: () => {
        if (!stored) return Promise.resolve(null);
        for (const [path, value] of Object.entries(update.$set)) {
          const key = path.replace('settings.', '');
          stored.settings[key] = value;
        }
        return Promise.resolve({ ...stored, settings: { ...stored.settings } });
      },
    })),
  };
}

describe('MongooseTenantRepository.updateSettings (amendments N-b/N-d)', () => {
  it('rejects approvalThreshold above the already-stored refundCap, even when refundCap is not part of this call', async () => {
    const model = fakeModel({ _id: 'acme', name: 'Acme', settings: { refundCap: 2000, approvalThreshold: 250 } });
    const repo = new MongooseTenantRepository(model as never);

    await expect(repo.updateSettings('acme', { approvalThreshold: 5000 })).rejects.toBeInstanceOf(TenantSettingsValidationError);
  });

  it('rejects enabling autoExecuteRefunds without dailyRefundCountLimit set or being set now', async () => {
    const model = fakeModel({ _id: 'acme', name: 'Acme', settings: {} });
    const repo = new MongooseTenantRepository(model as never);

    await expect(repo.updateSettings('acme', { autoExecuteRefunds: true })).rejects.toThrow(/dailyRefundCountLimit/);
  });

  it('accepts enabling autoExecuteRefunds when dailyRefundCountLimit is set in the same call', async () => {
    const model = fakeModel({ _id: 'acme', name: 'Acme', settings: {} });
    const repo = new MongooseTenantRepository(model as never);

    const result = await repo.updateSettings('acme', { autoExecuteRefunds: true, dailyRefundCountLimit: 3 });
    expect(result.autoExecuteRefunds).toBe(true);
    expect(result.dailyRefundCountLimit).toBe(3);
  });

  it('throws TenantNotFoundError rather than silently creating a partial tenant', async () => {
    const model = fakeModel(null);
    const repo = new MongooseTenantRepository(model as never);

    await expect(repo.updateSettings('ghost', { refundCap: 100 })).rejects.toBeInstanceOf(TenantNotFoundError);
  });

  it('logs a structured audit line naming only the keys that actually changed', async () => {
    const model = fakeModel({ _id: 'acme', name: 'Acme', settings: { refundCap: 2000, approvalThreshold: 250 } });
    const repo = new MongooseTenantRepository(model as never);
    const logSpy = vi.spyOn((repo as unknown as { logger: { log: (msg: string) => void } }).logger, 'log');

    await repo.updateSettings('acme', { refundCap: 3000, approvalThreshold: 250 });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(payload.event).toBe('tenant_settings_changed');
    expect(payload.changedKeys).toEqual(['refundCap']);
    expect(payload.before).toEqual({ refundCap: 2000 });
    expect(payload.after).toEqual({ refundCap: 3000 });
  });

  it('does not write or log anything when the patch changes nothing', async () => {
    const model = fakeModel({ _id: 'acme', name: 'Acme', settings: { refundCap: 2000 } });
    const repo = new MongooseTenantRepository(model as never);
    const logSpy = vi.spyOn((repo as unknown as { logger: { log: (msg: string) => void } }).logger, 'log');

    const result = await repo.updateSettings('acme', { refundCap: 2000 });

    expect(result.refundCap).toBe(2000);
    expect(model.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });
});
