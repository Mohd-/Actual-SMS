import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('Docker setup wrapper', () => {
  it.each([undefined, 'actual.example.test:192.0.2.10'])(
    'forwards CLI flags with optional host mapping %s',
    async host => {
      const directory = await mkdtemp(join(tmpdir(), 'sms-setup-test-'));
      try {
        const docker = join(directory, 'docker');
        await writeFile(docker, '#!/bin/sh\nprintf "ARG=%s\\n" "$@"\n');
        await chmod(docker, 0o700);
        const result = spawnSync('sh', ['scripts/setup-docker.sh', '--force'], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
            ACTUAL_SMS_ACTUAL_HOST: host ?? '',
          },
        });
        expect(result.status).toBe(0);
        const args = result.stdout.trim().split('\n');
        expect(args.at(-1)).toBe('ARG=--force');
        expect(args.filter(value => value === 'ARG=run')).toHaveLength(1);
        if (host) expect(args).toContain(`ARG=${host}`);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
