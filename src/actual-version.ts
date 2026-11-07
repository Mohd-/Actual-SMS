import type { ActualAdapter } from './types.js';

export const ACTUAL_API_VERSION = '26.11.0';

export interface VersionLogger {
  info(message: string): void;
  warn(message: string): void;
}

export async function reportActualCompatibility(
  adapter: Pick<ActualAdapter, 'serverVersion'>,
  logger: VersionLogger = console,
): Promise<void> {
  try {
    const serverVersion = await adapter.serverVersion();
    logger.info(`Actual API ${ACTUAL_API_VERSION}; server ${serverVersion}`);
    if (serverVersion !== ACTUAL_API_VERSION) {
      logger.warn(
        `Actual version mismatch: API ${ACTUAL_API_VERSION}, server ${serverVersion}; continuing startup`,
      );
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn(
      `Could not discover Actual server version (API ${ACTUAL_API_VERSION}): ${detail}; continuing startup`,
    );
  }
}
