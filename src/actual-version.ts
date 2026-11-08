import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ActualAdapter } from './types.js';

export function installedApiVersion(): string {
  let directory = dirname(createRequire(import.meta.url).resolve('@actual-app/api'));
  while (true) {
    try {
      const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (metadata.name === '@actual-app/api' && typeof metadata.version === 'string')
        return metadata.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Cannot discover installed Actual API version');
    directory = parent;
  }
}
export const ACTUAL_API_VERSION = installedApiVersion();

export interface VersionLogger {
  info(message: string): void;
  warn(message: string): void;
}

export async function reportActualCompatibility(
  adapter: Pick<ActualAdapter, 'serverVersion'>,
  logger: VersionLogger = console,
): Promise<void> {
  const version = await adapter.serverVersion();
  logger.info(`Actual API ${ACTUAL_API_VERSION}; server ${version}`);
  if (version !== ACTUAL_API_VERSION)
    throw new Error(
      `Actual version mismatch: API ${ACTUAL_API_VERSION}, server ${version}; imports blocked`,
    );
}

export async function preflightActualVersion(
  serverURL: string,
  request: typeof fetch = fetch,
): Promise<void> {
  const response = await request(`${serverURL.replace(/\/$/, '')}/info`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Actual version preflight failed; imports blocked');
  const body = (await response.json()) as { build?: { version?: unknown } };
  const version = body.build?.version;
  if (typeof version !== 'string')
    throw new Error('Actual version discovery failed; imports blocked');
  await reportActualCompatibility({ serverVersion: async () => version });
}
