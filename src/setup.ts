import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import YAML from 'yaml';
import { loadActualApi } from './actual-sdk.js';
import { loadBankConfigFile, validateAccountRules } from './config.js';
import type { AppConfigFile } from './types.js';

type Choice = { name: string };

export function encodeEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]*$/.test(value)) return value;
  return JSON.stringify(value);
}

export function renderEnv(values: Record<string, string>): string {
  return `${Object.entries(values)
    .map(([name, value]) => `${name}=${encodeEnvValue(value)}`)
    .join('\n')}\n`;
}

export function parseChoice(input: string, choices: Choice[]): Choice {
  const index = Number(input);
  if (!Number.isInteger(index) || index < 1 || index > choices.length) {
    throw new Error(`Enter a number from 1 to ${choices.length}`);
  }
  return choices[index - 1]!;
}

export function parseChoices(input: string, choices: Choice[]): Choice[] {
  const indexes = [...new Set(input.split(',').map(value => Number(value.trim())))];
  if (
    indexes.length === 0 ||
    indexes.some(index => !Number.isInteger(index) || index < 1 || index > choices.length)
  ) {
    throw new Error(`Enter comma-separated numbers from 1 to ${choices.length}`);
  }
  return indexes.map(index => choices[index - 1]!);
}

export async function verifyActualServer(
  serverURL: string,
  request: typeof fetch = fetch,
): Promise<string> {
  const infoURL = `${serverURL.replace(/\/$/, '')}/info`;
  const response = await request(infoURL, { signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Actual server preflight failed: ${infoURL} returned HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Actual server preflight failed: ${infoURL} did not return JSON`);
  }
  const version = (body as { build?: { version?: unknown } }).build?.version;
  if (typeof version !== 'string') {
    throw new Error(`Actual server preflight failed: ${infoURL} is not an Actual sync server`);
  }
  return version;
}

async function main() {
  const force = process.argv.includes('--force');
  const envPath = resolve('.env');
  const configPath = resolve('config/accounts.yaml');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (label: string, fallback?: string) => {
    const suffix = fallback ? ` [${fallback}]` : '';
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    return answer || fallback || '';
  };
  const required = async (label: string, fallback?: string) => {
    while (true) {
      const answer = await ask(label, fallback);
      if (answer) return answer;
      console.error(`${label} is required.`);
    }
  };
  const secret = async (label: string, optional = false): Promise<string> => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
      return optional ? ask(label) : required(label);
    }
    rl.pause();
    process.stdout.write(`${label}: `);
    return new Promise<string>((resolveSecret, rejectSecret) => {
      let value = '';
      const finish = (error?: Error) => {
        process.stdin.off('data', onData);
        process.stdin.setRawMode(false);
        process.stdout.write('\n');
        rl.resume();
        if (error) rejectSecret(error);
        else if (!optional && !value) rejectSecret(new Error(`${label} is required`));
        else resolveSecret(value);
      };
      const onData = (chunk: Buffer) => {
        for (const character of chunk.toString('utf8')) {
          if (character === '\r' || character === '\n') return finish();
          if (character === '\u0003') return finish(new Error('Setup cancelled'));
          if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
          else value += character;
        }
      };
      process.stdin.setRawMode(true);
      process.stdin.on('data', onData);
      process.stdin.resume();
    });
  };
  const choose = async (label: string, choices: Choice[]) => {
    console.log(`\n${label}`);
    choices.forEach((choice, index) => console.log(`  ${index + 1}. ${choice.name}`));
    while (true) {
      try {
        return parseChoice(await required('Selection'), choices);
      } catch (error) {
        console.error((error as Error).message);
      }
    }
  };
  const chooseMany = async (label: string, choices: Choice[]) => {
    console.log(`\n${label}`);
    choices.forEach((choice, index) => console.log(`  ${index + 1}. ${choice.name}`));
    while (true) {
      try {
        return parseChoices(await required('Selections (comma-separated)'), choices);
      } catch (error) {
        console.error((error as Error).message);
      }
    }
  };

  let cacheDir: string | undefined;
  let initialized = false;
  try {
    console.log('Tasker SMS → Actual first-time setup\n');
    if (!force) {
      const { access } = await import('node:fs/promises');
      for (const path of [envPath, configPath]) {
        await access(path)
          .then(() => {
            throw new Error(`${path} already exists; rerun with --force to replace setup files`);
          })
          .catch(error => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          });
      }
    }

    const banks = await loadBankConfigFile(
      process.env.BANKS_CONFIG_PATH || resolve('config/banks.yaml'),
    );
    const importBanks = banks.filter(bank => bank.disposition === 'import');
    if (!importBanks.length)
      throw new Error('Configure at least one import bank in config/banks.yaml');

    const serverURL = await required('Actual server URL', 'http://localhost:5006');
    new URL(serverURL);
    const serverVersion = await verifyActualServer(serverURL);
    console.log(`Connected to Actual sync server ${serverVersion}.`);
    const password = await secret('Actual server password');
    console.log('Find the Sync ID in Actual: Settings → Show advanced settings → Sync ID.');
    const syncId = await required('Budget Sync ID');
    const encryptionPassword = await secret('Budget encryption password (blank if none)', true);
    cacheDir = await mkdtemp(join(tmpdir(), 'actual-sms-setup-'));
    const actual = await loadActualApi();
    console.log('\nConnecting and downloading the budget…');
    await actual.init({ serverURL, password, dataDir: cacheDir });
    initialized = true;
    await actual.downloadBudget(syncId, { password: encryptionPassword || undefined });
    const accounts = (await actual.getAccounts()).filter(account => !account.closed);
    const categories = (await actual.getCategories()).filter(
      category => 'group_id' in category && !category.is_income && !category.hidden,
    );
    if (!accounts.length) throw new Error('The budget has no open accounts');
    if (!categories.length) throw new Error('The budget has no expense categories');

    const mappings: AppConfigFile['accounts'] = [];
    while (true) {
      const account = await choose(
        'Choose an account that receives bank SMS transactions:',
        accounts,
      );
      const bankChoices = importBanks.map(bank => ({ name: `${bank.name} (${bank.id})` }));
      const bank = await choose('Choose the bank that sends these SMS messages:', bankChoices);
      const bankId = importBanks[bankChoices.indexOf(bank)]!.id;
      const method = await choose('Choose how this account is identified in its SMS messages:', [
        { name: 'Account/card suffix' },
        { name: 'Transaction type' },
        { name: 'Account/card suffix and transaction type' },
        { name: 'A numeric balance is present' },
        { name: 'No numeric balance is present' },
      ]);
      const match: AppConfigFile['accounts'][number]['match'] = { bank: bankId };
      if (method.name.includes('Account/card suffix')) {
        const accountSuffixes = (await required('SMS account/card suffixes (comma-separated)'))
          .split(',')
          .map(value => value.trim())
          .filter(Boolean);
        if (!accountSuffixes.length) throw new Error('At least one account suffix is required');
        match.accountSuffixes = accountSuffixes;
      }
      if (method.name.includes('transaction type')) {
        const kinds = await chooseMany('Choose transaction types for this account:', [
          { name: 'Purchase' },
          { name: 'Refund' },
          { name: 'Withdrawal' },
          { name: 'Incoming transfer' },
          { name: 'Outgoing transfer' },
          { name: 'Card payment' },
        ]);
        const kindByName = {
          Purchase: 'purchase',
          Refund: 'refund',
          Withdrawal: 'withdrawal',
          'Incoming transfer': 'transfer_in',
          'Outgoing transfer': 'transfer_out',
          'Card payment': 'card_payment',
        } as const;
        match.transactionKinds = kinds.map(
          kind => kindByName[kind.name as keyof typeof kindByName],
        );
      } else if (!method.name.includes('Account/card suffix')) {
        match.hasBalance = method.name === 'A numeric balance is present';
      }
      mappings.push({ actualName: account.name, match });
      if ((await ask('Configure another account? (y/N)', 'n')).toLowerCase() !== 'y') break;
    }
    validateAccountRules(mappings);

    const bankFees = await choose('Choose the bank-fees category:', categories);
    const eligible = await chooseMany(
      'Choose categories eligible for merchant enrichment:',
      categories.filter(category => category.name !== bankFees.name),
    );
    const openCodeKey = await secret('OpenCode Go API key (blank to disable enrichment)', true);
    const apiKey = randomBytes(32).toString('base64url');
    const config: AppConfigFile = {
      accounts: mappings,
      bankFeesCategory: bankFees.name,
      eligibleCategories: eligible.map(category => category.name),
    };
    const env = renderEnv({
      API_KEY: apiKey,
      ACTUAL_SERVER_URL: serverURL,
      ACTUAL_PASSWORD: password,
      ACTUAL_SYNC_ID: syncId,
      ACTUAL_ENCRYPTION_PASSWORD: encryptionPassword,
      OPENCODE_GO_API_KEY: openCodeKey,
      OPENCODE_GO_MODEL: 'deepseek-v4-flash',
      CONFIG_PATH: '/config/accounts.yaml',
      BANKS_CONFIG_PATH: '/config/banks.yaml',
      DB_PATH: '/data/events.sqlite',
      ACTUAL_CACHE_DIR: '/actual-cache',
      PORT: '3000',
      LOG_LEVEL: 'info',
      MAX_ATTEMPTS: '5',
      ENRICHMENT_MIN_CONFIDENCE: '0.70',
      MAPPING_REFRESH_MINUTES: '60',
    });
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(envPath, env, { encoding: 'utf8', mode: 0o600, flag: force ? 'w' : 'wx' });
    try {
      await writeFile(configPath, YAML.stringify(config), {
        encoding: 'utf8',
        mode: 0o600,
        flag: force ? 'w' : 'wx',
      });
    } catch (error) {
      if (!force) await rm(envPath, { force: true });
      throw error;
    }
    console.log(`\nWrote ${envPath}`);
    console.log(`Wrote ${configPath}`);
    console.log(`Tasker API key: ${apiKey}`);
    console.log('Next: docker compose -f compose.example.yaml up --build -d');
    console.log('Then import tasker/Actual_SMS_Inbox.prj.xml and enter your HTTPS service URL');
    console.log('and the Tasker API key above. See README for permissions and a connection check.');
  } finally {
    rl.close();
    if (initialized) await (await loadActualApi()).shutdown().catch(() => {});
    if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(`Setup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
