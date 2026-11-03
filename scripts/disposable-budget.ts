import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { loadActualApi } from '../src/actual-sdk.js';
import { ACTUAL_API_VERSION } from '../src/actual-version.js';

type Api = Awaited<ReturnType<typeof loadActualApi>>;
export type BudgetControl = Pick<Awaited<ReturnType<Api['init']>>, 'send'>;
export type LifecycleApi = {
  init(options: Parameters<Api['init']>[0]): Promise<BudgetControl>;
  shutdown: Api['shutdown'];
};
export interface DisposableContext {
  name: string;
  localId: string;
  syncId: string;
  cacheDir: string;
}
export async function withDisposableBudget(
  api: LifecycleApi,
  options: {
    serverURL: string;
    password: string;
    protectedSyncId?: string;
    onCleanupVerified?: () => Promise<void>;
  },
  run: (context: DisposableContext) => Promise<void>,
) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'actual-sms-disposable-'));
  await chmod(cacheDir, 0o700);
  const name = `actual-sms-smoke-${randomUUID()}`;
  let control: BudgetControl | undefined;
  let originalIds: Set<string> | undefined;
  let creationAttempted = false;
  let cleanupFailed = false;
  const remoteFiles = async () => {
    const files = await control!.send('get-remote-files');
    // The low-level budget catalog can return null on authentication or network failure.
    if (!Array.isArray(files)) throw new Error('Could not verify the remote budget catalog');
    return files.filter(file => !file.deleted);
  };
  const failures: unknown[] = [];
  try {
    control = await api.init({
      serverURL: options.serverURL,
      password: options.password,
      dataDir: cacheDir,
    });
    const version = await control.send('get-server-version');
    if (!('version' in version) || version.version !== ACTUAL_API_VERSION)
      throw new Error(
        `Smoke test requires Actual server ${ACTUAL_API_VERSION}; discovery returned ${JSON.stringify(version)}`,
      );
    if ((await control.send('get-budgets')).length !== 0)
      throw new Error('Disposable cache must contain no existing budgets');
    originalIds = new Set((await remoteFiles()).map(file => file.fileId));
    creationAttempted = true;
    const created = await control.send('create-budget', { budgetName: name, avoidUpload: true });
    if (created.error) throw new Error(`Disposable budget creation failed: ${created.error}`);
    let local = (await control.send('get-budgets')).filter(file => file.name === name);
    if (local.length !== 1 || local[0]!.cloudFileId)
      throw new Error('Could not establish ownership of the new local budget');
    const uploaded = await control.send('upload-budget');
    if (uploaded.error)
      throw new Error(`Disposable budget upload failed: ${uploaded.error.reason}`);
    local = (await control.send('get-budgets')).filter(file => file.name === name);
    const budget = local[0];
    if (
      local.length !== 1 ||
      !budget?.cloudFileId ||
      !budget.groupId ||
      originalIds.has(budget.cloudFileId) ||
      budget.groupId === options.protectedSyncId
    )
      throw new Error('Refusing to use an existing or unidentified remote budget');
    const remote = (await remoteFiles()).find(
      file => file.fileId === budget.cloudFileId && file.name === name,
    );
    if (!remote) throw new Error('Uploaded disposable budget was not found on the server');
    await run({ name, localId: budget.id, syncId: budget.groupId, cacheDir });
  } catch (error) {
    failures.push(error);
  }
  {
    if (control && creationAttempted && originalIds) {
      try {
        const owned = (await remoteFiles()).filter(
          file => file.name === name && !originalIds!.has(file.fileId),
        );
        if (owned.length > 1 || owned.some(file => file.fileId === options.protectedSyncId))
          throw new Error('Refusing ambiguous or protected budget cleanup');
        const local = (await control.send('get-budgets')).filter(file => file.name === name);
        if (local.length > 1) throw new Error('Refusing ambiguous local budget cleanup');
        await control.send('close-budget');
        if (owned[0] || local[0]) {
          const deleted = await control.send('delete-budget', {
            ...(owned[0] ? { cloudFileId: owned[0].fileId } : {}),
            ...(local[0] ? { id: local[0].id } : {}),
          });
          if (deleted !== 'ok') throw new Error('Disposable local budget deletion failed');
        }
        // delete-budget silently ignores remote deletion failures. Verify independently.
        const remaining = await remoteFiles();
        if (remaining.some(file => file.name === name && !originalIds!.has(file.fileId)))
          throw new Error('Disposable remote budget still exists after cleanup');
        if ([...originalIds].some(id => !remaining.some(file => file.fileId === id)))
          throw new Error('Existing remote budget catalog changed during the smoke test');
        if ((await control.send('get-budgets')).some(file => file.name === name))
          throw new Error('Disposable local budget still exists after cleanup');
        await options.onCleanupVerified?.();
      } catch (error) {
        cleanupFailed = true;
        failures.push(error);
      }
    }
    await api.shutdown().catch(error => {
      cleanupFailed = true;
      failures.push(error);
    });
    if (!cleanupFailed) await rm(cacheDir, { recursive: true, force: true });
    if (cleanupFailed)
      throw new AggregateError(
        failures,
        `Disposable smoke cleanup failed; inspect ${name} and retained cache ${cacheDir}`,
      );
    if (failures.length) throw failures[0];
  }
}
