import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActualApiAdapter } from '../src/actual.js';

const sdk = vi.hoisted(() => ({ sync: vi.fn<() => Promise<void>>() }));
vi.mock('../src/actual-sdk.js', () => ({ loadActualApi: async () => sdk }));
afterEach(() => {
  sdk.sync.mockReset();
});
const adapter = () =>
  new ActualApiAdapter({
    serverURL: 'https://actual.example.test',
    password: 'synthetic',
    syncId: 'synthetic',
    dataDir: '/unused',
  });

describe('Actual synchronization boundary', () => {
  it('accepts the SDK void success result', async () => {
    sdk.sync.mockResolvedValue(undefined);
    await expect(adapter().sync()).resolves.toBeUndefined();
  });
  it('propagates SDK sync rejection rather than accepting cached budget data', async () => {
    // The pinned SDK api/sync handler converts unsuccessful sync results to rejections.
    const error = new Error('Synthetic synchronization failure');
    sdk.sync.mockRejectedValue(error);
    await expect(adapter().sync()).rejects.toBe(error);
  });
});
