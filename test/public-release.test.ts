import { banks } from './fixtures/banks.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { loadConfigFile } from '../src/config.js';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('public release configuration', () => {
  it('keeps personal configuration local and ships a valid synthetic example', async () => {
    expect(read('.gitignore')).toContain('config/accounts.yaml');
    const config = await loadConfigFile(
      new URL('../config/accounts.example.yaml', import.meta.url).pathname,
      banks,
    );
    expect(config.accounts).toHaveLength(6);
    expect(config.bankFeesCategory).toBe('Bank Fees');
  });

  it('keeps the base Compose file independent of private DNS and proxy topology', () => {
    const compose = YAML.parse(read('compose.example.yaml')) as {
      services: { 'actual-sms': { extra_hosts?: unknown; networks?: unknown } };
      networks?: unknown;
    };
    expect(compose.services['actual-sms'].extra_hosts).toBeUndefined();
    expect(compose.services['actual-sms'].networks).toBeUndefined();
    expect(compose.networks).toBeUndefined();
    expect(read('compose.host-override.example.yaml')).toContain('${ACTUAL_HOSTNAME:');
    expect(read('compose.proxy.example.yaml')).toContain('${PROXY_NETWORK:-caddy}');
  });

  it('does not require a deployment-specific host mapping during setup', () => {
    expect(read('.env.example')).not.toContain('ACTUAL_HOST_IP=');
    const setupScript = read('scripts/setup-docker.sh');
    expect(setupScript).toContain('ACTUAL_SMS_ACTUAL_HOST:-}');
    expect(setupScript).not.toContain('ACTUAL_SMS_ACTUAL_HOST:-actual.');
  });
});

it('excludes credentials, account mappings and private state from Docker build contexts', () => {
  const ignored = read('.dockerignore').split('\n');
  for (const path of [
    '.git',
    '.env',
    '.env.*',
    '.gitenv',
    'config/accounts.yaml',
    'config/*.local.yaml',
    'data',
    'actual-cache',
    '.migration-private',
  ])
    expect(ignored).toContain(path);
  expect(read('.gitignore')).toContain('config/*.local.yaml');
  expect(read('scripts/telegram-report.sh')).not.toMatch(/\/home\/[^/]+\//);
});
