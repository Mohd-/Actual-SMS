import { describe, expect, it, vi } from 'vitest';
import {
  ACTUAL_API_VERSION,
  installedApiVersion,
  reportActualCompatibility,
  preflightActualVersion,
} from '../src/actual-version.js';

describe('Actual version compatibility', () => {
  it('reads the installed package version', () => {
    expect(installedApiVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(ACTUAL_API_VERSION).toBe(installedApiVersion());
  });
  it('accepts an exact match', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    await reportActualCompatibility({ serverVersion: async () => ACTUAL_API_VERSION }, logger);
    expect(logger.info).toHaveBeenCalledWith(
      `Actual API ${ACTUAL_API_VERSION}; server ${ACTUAL_API_VERSION}`,
    );
  });
  it('blocks mismatches', async () => {
    await expect(reportActualCompatibility({ serverVersion: async () => '0.0.0' })).rejects.toThrow(
      'version mismatch',
    );
  });
  it('blocks failed discovery', async () => {
    await expect(
      reportActualCompatibility({
        serverVersion: async () => {
          throw new Error('network');
        },
      }),
    ).rejects.toThrow('network');
  });
  it('checks server metadata before opening a budget', async () => {
    const request = vi.fn(
      async (_url: unknown) =>
        new Response(JSON.stringify({ build: { version: ACTUAL_API_VERSION } })),
    );
    await preflightActualVersion('https://example.test/base/', request);
    expect(request.mock.calls[0]?.[0]).toBe('https://example.test/base/info');
  });
  it.each([new Response('{}'), new Response('', { status: 503 })])(
    'blocks missing metadata and failed HTTP',
    async response => {
      await expect(
        preflightActualVersion(
          'https://example.test',
          vi.fn(async () => response),
        ),
      ).rejects.toThrow('imports blocked');
    },
  );
});
