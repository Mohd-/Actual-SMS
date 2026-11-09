import type { ConfigView, EventPage, EventView, StatusView } from './contracts.js';
import type { InboxCheckpoint } from '../types.js';

const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const text = (id: string, value: unknown) => {
  element(id).textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
};
const errorBox = element('error');
let config: ConfigView | undefined;
let checkpoint: InboxCheckpoint | null = null;
let nextCursor: string | undefined;
let preview: { accounts: string; revision: string } | undefined;
let editGeneration = 0;
let loadGeneration = 0;
let loading = false;
let saving = false;
let previewPending = false;
function signedOut() {
  element('login').hidden = false;
  element('workspace').hidden = true;
  element<HTMLInputElement>('tasker-key').value = '';
  invalidate();
}
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/management/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    if (response.status === 401) signedOut();
    throw new Error(
      typeof result === 'object' && result && 'error' in result
        ? String(result.error)
        : 'Request failed',
    );
  }
  return result as T;
}
function action(id: string, handler: () => Promise<void>, event = 'click') {
  element(id).addEventListener(event, e => {
    e.preventDefault();
    errorBox.hidden = true;
    const button = e.currentTarget;
    if (button instanceof HTMLButtonElement) button.disabled = true;
    void handler()
      .catch(error => {
        errorBox.textContent = error instanceof Error ? error.message : 'Operation failed';
        errorBox.hidden = false;
      })
      .finally(() => {
        if (button instanceof HTMLButtonElement) button.disabled = false;
        element<HTMLButtonElement>('next').disabled = !nextCursor;
        updateSave();
      });
  });
}
async function status() {
  text('status-data', await request<StatusView>('status'));
}
async function loadConfig() {
  if (saving) return;
  const generation = ++loadGeneration;
  loading = true;
  invalidate();
  try {
    const loaded = await request<ConfigView>('config');
    if (generation !== loadGeneration) return;
    config = loaded;
    element<HTMLTextAreaElement>('accounts').value = config.accounts;
    text('banks', config.banks);
    text('parsing', config.parsing);
    text('config-state', {
      editable: config.editable,
      persistedRevision: config.revision,
      activeRevision: config.activeRevision,
      pending: config.revision !== config.activeRevision,
    });
    invalidate();
  } finally {
    if (generation === loadGeneration) loading = false;
    updateSave();
  }
}
function previewMatches() {
  return (
    preview &&
    preview.revision === config?.revision &&
    preview.accounts === element<HTMLTextAreaElement>('accounts').value
  );
}
function updateSave() {
  const busy = loading || saving;
  element<HTMLTextAreaElement>('accounts').readOnly = busy || !config?.editable;
  element<HTMLButtonElement>('preview').disabled = busy || previewPending || !config?.editable;
  for (const id of ['config-load', 'config-reload', 'confirm-save'])
    element<HTMLInputElement | HTMLButtonElement>(id).disabled = busy;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-page="config"]'))
    button.disabled = busy;
  element<HTMLButtonElement>('save').disabled =
    busy ||
    !config?.editable ||
    !previewMatches() ||
    !element<HTMLInputElement>('confirm-save').checked;
}
function invalidate() {
  editGeneration++;
  preview = undefined;
  element('diff').hidden = true;
  element<HTMLInputElement>('confirm-save').checked = false;
  updateSave();
}
async function loadCheckpoint() {
  const result = await request<{ checkpoint: InboxCheckpoint | null }>('tasker/checkpoint');
  checkpoint = result.checkpoint;
  text(
    'checkpoint-state',
    checkpoint
      ? { date: new Date(checkpoint.date).toISOString(), rowId: checkpoint.rowId }
      : 'Not initialized (default: seven-day lookback)',
  );
}
async function events(cursor?: string) {
  const params = new URLSearchParams({ limit: '25' });
  const filter = element<HTMLSelectElement>('filter-status').value;
  if (filter) params.set('status', filter);
  if (cursor) params.set('cursor', cursor);
  const page = await request<EventPage>(`events?${params}`);
  const list = element('events');
  list.replaceChildren();
  for (const event of page.events) {
    const li = document.createElement('li'),
      button = document.createElement('button');
    button.textContent = `${event.status} · ${event.createdAt} · ${event.eventId}`;
    button.addEventListener('click', () => {
      void request<EventView>(`events/${encodeURIComponent(event.eventId)}`)
        .then(data => text('event-detail', data))
        .catch(error => {
          errorBox.textContent = String(error);
          errorBox.hidden = false;
        });
    });
    li.append(button);
    list.append(li);
  }
  nextCursor = page.nextCursor;
  element<HTMLButtonElement>('next').disabled = !nextCursor;
}
async function show(page: string) {
  for (const id of ['status', 'inbox', 'config', 'tasker']) element(id).hidden = id !== page;
  if (page === 'status') await status();
  if (page === 'inbox') await events();
  if (page === 'config') await loadConfig();
  if (page === 'tasker') await loadCheckpoint();
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-page]')) {
  button.addEventListener('click', () => {
    errorBox.hidden = true;
    void show(button.dataset.page!).catch(error => {
      text('error', String(error));
      errorBox.hidden = false;
    });
  });
}
action(
  'login',
  async () => {
    const password = element<HTMLInputElement>('password');
    try {
      await request('login', { password: password.value });
    } finally {
      password.value = '';
    }
    element('login').hidden = true;
    element('workspace').hidden = false;
    await show('status');
  },
  'submit',
);
action('logout', async () => {
  await request('logout', {});
  signedOut();
});
action('revoke', async () => {
  if (confirm('Sign out every browser session?')) {
    await request('sessions/revoke', {});
    signedOut();
  }
});
action('refresh', status);
action('reconnect', async () => {
  await request('reconnect', {});
  await status();
});
action('filter', () => events(), 'submit');
action('next', () => events(nextCursor));
action('config-load', async () => {
  if (confirm('Discard unsaved edits and reload files?')) await loadConfig();
});
action('config-reload', async () => {
  if (config && confirm('Validate and activate the configuration currently on disk?')) {
    await request('config/reload', { revision: config.revision });
    await loadConfig();
  }
});
element('accounts').addEventListener('input', invalidate);
element('confirm-save').addEventListener('change', updateSave);
action('preview', async () => {
  if (!config || loading || saving) return;
  invalidate();
  const generation = editGeneration;
  const candidate = {
    accounts: element<HTMLTextAreaElement>('accounts').value,
    revision: config.revision,
  };
  const before = config.accounts;
  previewPending = true;
  updateSave();
  try {
    await request('config/preview', candidate);
    if (
      generation !== editGeneration ||
      candidate.revision !== config?.revision ||
      candidate.accounts !== element<HTMLTextAreaElement>('accounts').value
    )
      return;
    text('before', before);
    text('after', candidate.accounts);
    element('diff').hidden = false;
    preview = candidate;
  } finally {
    previewPending = false;
    updateSave();
  }
});
action('save', async () => {
  if (
    !config ||
    !preview ||
    !previewMatches() ||
    loading ||
    saving ||
    !element<HTMLInputElement>('confirm-save').checked
  )
    return;
  const confirmed = preview;
  saving = true;
  updateSave();
  try {
    await request('config/save', { ...confirmed, confirmation: 'SAVE' });
  } finally {
    saving = false;
    invalidate();
  }
  await loadConfig();
});
action('rotate', async () => {
  if (
    !confirm(
      'Replace the restricted key? Existing restricted-key projects will stop working until re-imported.',
    )
  )
    return;
  const result = await request<{ key: string }>('tasker/rotate', { confirmation: 'ROTATE' });
  element<HTMLInputElement>('tasker-key').value = result.key;
});
action('export', async () => {
  const response = await fetch('/management/tasker/export', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      origin: element<HTMLInputElement>('tasker-origin').value,
      key: element<HTMLInputElement>('tasker-key').value,
    }),
  });
  if (!response.ok)
    throw new Error('Export failed. Check the HTTPS origin and current restricted key.');
  const url = URL.createObjectURL(await response.blob()),
    link = document.createElement('a');
  link.href = url;
  link.download = 'Actual_SMS_Inbox.prj.xml';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
action('checkpoint-load', loadCheckpoint);
action('checkpoint-save', async () => {
  const date = new Date(element<HTMLInputElement>('checkpoint-date').value).getTime();
  if (!Number.isFinite(date) || date > Date.now())
    throw new Error('Choose a valid date that is not in the future');
  if (
    !confirm(
      `Move inbox checkpoint to ${new Date(date).toISOString()}? This may skip unread SMS or recheck older SMS.`,
    )
  )
    return;
  try {
    await request('tasker/checkpoint', { date, expected: checkpoint, confirmation: 'CHANGE' });
  } finally {
    await loadCheckpoint();
  }
});
void request<StatusView>('status')
  .then(async () => {
    element('login').hidden = true;
    element('workspace').hidden = false;
    await show('status');
  })
  .catch(() => {});
