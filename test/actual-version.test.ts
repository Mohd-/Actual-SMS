import { describe, expect, it, vi } from 'vitest';
import { reportActualCompatibility } from '../src/actual-version.js';

describe('Actual version compatibility reporting', () => {
  it('logs an exact version match without warning', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    await reportActualCompatibility({ serverVersion: async () => '26.10.0' }, logger);
    expect(logger.info).toHaveBeenCalledWith('Actual API 26.10.0; server 26.10.0');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns on a mismatch without failing startup', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    await expect(
      reportActualCompatibility({ serverVersion: async () => '26.6.0' }, logger),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('version mismatch'));
  });

  it('warns when discovery fails without failing startup', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    await expect(
      reportActualCompatibility(
        {
          serverVersion: async () => {
            throw new Error('network-failure');
          },
        },
        logger,
      ),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('network-failure'));
  });
});
