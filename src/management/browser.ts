import type { PayeeView } from '../payees.js';
import type { ConfigView, EventPage, EventView, PayeePage, StatusView } from './contracts.js';
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
let payeePage: PayeePage | undefined;
let selectedPayee: PayeeView | undefined;
let payeeOffset = 0;
let payeeGeneration = 0;
let editorGeneration = 0;
let payeeSearch = '';
let targets: PayeeView[] = [];

function categoryName(id: string, page: PayeePage) {
  const category = page.categories.find(item => item.id === id);
  if (!category) return `Unavailable category (${id})`;
  const ambiguous = page.categories.some(item => item.id !== id && item.name === category.name);
  return ambiguous && category.groupName
    ? `${category.groupName} / ${category.name}`
    : category.name;
}

function payeeSettings(row: PayeeView, page: PayeePage) {
  const category = row.categoryId ? categoryName(row.categoryId, page) : 'No category';
  const tags = row.tagIds.map(id => {
    const tag = page.tags.find(tag => tag.id === id);
    return tag ? `#${tag.name}` : 'Unavailable tag';
  });
  return [category, ...tags, ...(row.conflict.length ? ['Migration conflict'] : [])].join(' · ');
}

async function editPayee(row: PayeeView, page: PayeePage) {
  const generation = ++editorGeneration;
  selectedPayee = row;
  element('payee-editor').hidden = false;
  text('payee-name', row.name);
  const conflicts = row.conflict.map(choice => {
    const account =
      page.accounts.find(account => account.id === choice.accountId)?.name ?? choice.accountId;
    return `${account} (${choice.merchant}${choice.payee ? ` → ${choice.payee}` : ''}): ${choice.categoryId ? categoryName(choice.categoryId, page) : 'Removed'}`;
  });
  text(
    'payee-state',
    [
      !page.editable ? 'Connect to Actual to edit defaults.' : '',
      row.unavailable
        ? 'This Actual payee is unavailable. Link it to another payee to move its defaults.'
        : '',
      conflicts.length
        ? `Previous settings differ. Choose a category or leave the payee uncategorized to resolve them. ${conflicts.join(' · ')}`
        : '',
    ]
      .filter(Boolean)
      .join(' '),
  );
  const category = element<HTMLSelectElement>('payee-category');
  category.replaceChildren(
    new Option(conflicts.length ? 'Keep category unresolved' : 'No category', ''),
    ...(conflicts.length ? [new Option('Leave uncategorized', '*')] : []),
    ...page.categories.map(item => new Option(categoryName(item.id, page), item.id)),
  );
  if (row.categoryId && !page.categories.some(item => item.id === row.categoryId))
    category.add(new Option(categoryName(row.categoryId, page), row.categoryId));
  category.value = row.categoryId ?? '';
  const tagLabels = [
    ...page.tags.map(tag => ({ id: tag.id, name: `#${tag.name}` })),
    ...row.tagIds
      .filter(id => !page.tags.some(tag => tag.id === id))
      .map(id => ({ id, name: `Unavailable tag (${id})` })),
  ];
  const tags = element('payee-tags');
  tags.replaceChildren();
  for (const tag of tagLabels) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = tag.id;
    checkbox.checked = row.tagIds.includes(tag.id);
    label.append(checkbox, ` ${tag.name}`);
    tags.append(label);
  }
  if (!tagLabels.length) tags.textContent = 'No tags available in Actual.';
  element<HTMLFieldSetElement>('payee-controls').disabled = !page.editable;

  const aliases = element<HTMLSelectElement>('payee-alias');
  aliases.replaceChildren(...row.aliases.map(alias => new Option(alias.name, alias.key)));
  if (row.unavailable) aliases.add(new Option('Move this payee and all descriptors', '*'), 0);
  if (row.unavailable) aliases.selectedIndex = 0;
  aliases.disabled = !page.editable || aliases.options.length === 0;
  const targetForm = element<HTMLFormElement>('payee-target-filter');
  for (const field of targetForm.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
    'input, button',
  ))
    field.disabled = aliases.disabled;
  element<HTMLInputElement>('payee-target-search').value = '';
  setPayeeTargets(page.rows.filter(target => target.id !== row.id && !target.unavailable));

  const suggestionStatus = element('payee-suggestion');
  const button = element<HTMLButtonElement>('payee-use-suggestion');
  button.hidden = true;
  button.onclick = null;
  suggestionStatus.hidden =
    !!row.categoryId || row.unavailable || !page.suggestions || !page.editable;
  category.onchange = () => {
    button.hidden = true;
    suggestionStatus.hidden = true;
  };
  if (suggestionStatus.hidden) return;
  suggestionStatus.textContent = 'Looking for a category suggestion…';
  try {
    const result = await request<{ suggestion: { categoryId: string; reason: string } | null }>(
      'payees/suggestion',
      { id: row.id, revision: row.revision },
    );
    if (generation !== editorGeneration || suggestionStatus.hidden) return;
    const suggestion = result.suggestion;
    if (!suggestion || !page.categories.some(item => item.id === suggestion.categoryId)) {
      suggestionStatus.textContent = 'No suggestion available.';
      return;
    }
    suggestionStatus.textContent = `${categoryName(suggestion.categoryId, page)} · ${suggestion.reason}`;
    button.hidden = false;
    button.onclick = () => {
      category.value = suggestion.categoryId;
      button.hidden = true;
    };
  } catch {
    if (generation === editorGeneration && !suggestionStatus.hidden)
      suggestionStatus.textContent = 'No suggestion available.';
  }
}

function setPayeeTargets(rows: PayeeView[]) {
  targets = rows;
  const field = element<HTMLSelectElement>('payee-target');
  field.replaceChildren(
    new Option('Choose a payee', ''),
    ...rows.map(row => new Option(row.name, row.id)),
  );
  field.disabled = element<HTMLSelectElement>('payee-alias').disabled || rows.length === 0;
  updatePayeeLink();
}

function updatePayeeLink() {
  const source = selectedPayee;
  const alias = element<HTMLSelectElement>('payee-alias');
  const target = targets.find(row => row.id === element<HTMLSelectElement>('payee-target').value);
  element<HTMLButtonElement>('payee-unlink').disabled =
    alias.disabled || !source?.aliases.some(item => item.key === alias.value && item.linked);
  element<HTMLButtonElement>('payee-link').disabled = alias.disabled || !alias.value || !target;
  const page = payeePage;
  text(
    'payee-link-preview',
    source && target && page
      ? `${alias.selectedOptions[0]?.textContent} → ${target.name} (${payeeSettings(target, page)}). ` +
          (alias.value === '*' || (!source.actualId && source.aliases.length === 1)
            ? 'Saved defaults move with the descriptor when the settings agree or the destination has room for them.'
            : 'The destination payee’s defaults apply to this descriptor.')
      : '',
  );
}

async function loadPayees(offset = 0, reopen?: string) {
  const generation = ++payeeGeneration;
  ++editorGeneration;
  const params = new URLSearchParams({ search: payeeSearch, offset: String(offset) });
  const page = await request<PayeePage>(`payees?${params}`);
  if (generation !== payeeGeneration) return;
  if (offset > 0 && !page.rows.length) return loadPayees(Math.max(0, offset - 50));
  payeePage = page;
  selectedPayee = undefined;
  payeeOffset = offset;
  element('payee-editor').hidden = true;
  const list = element('payee-list');
  list.replaceChildren();
  for (const row of page.rows) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.textContent = `${row.name} · ${payeeSettings(row, page)}${row.unavailable ? ' · Unavailable' : ''}`;
    button.addEventListener('click', () => void editPayee(row, page));
    item.append(button);
    list.append(item);
  }
  text(
    'payee-count',
    page.migrationPending
      ? 'Payee migration is waiting for Actual. SMS messages remain queued.'
      : page.rows.length
        ? `Payees ${offset + 1}–${offset + page.rows.length}`
        : 'No payees found.',
  );
  element<HTMLButtonElement>('payee-previous').disabled = offset === 0;
  element<HTMLButtonElement>('payee-next').disabled = page.nextOffset === null;
  const row = page.rows.find(row => row.id === reopen);
  if (row) void editPayee(row, page);
}

action(
  'payee-filter',
  async () => {
    payeeSearch = element<HTMLInputElement>('payee-search').value;
    await loadPayees();
  },
  'submit',
);
action('payee-previous', () => loadPayees(Math.max(0, payeeOffset - 50)));
action('payee-next', async () => {
  if (payeePage?.nextOffset != null) await loadPayees(payeePage.nextOffset);
});
action(
  'payee-form',
  async () => {
    const row = selectedPayee;
    if (!row) return;
    const controls = element<HTMLFieldSetElement>('payee-controls');
    if (controls.disabled) return;
    const generation = editorGeneration;
    const selectedCategory = element<HTMLSelectElement>('payee-category').value;
    const resolveCategoryConflict = selectedCategory === '*';
    const categoryId = selectedCategory && !resolveCategoryConflict ? selectedCategory : null;
    const tagIds = Array.from(
      element('payee-tags').querySelectorAll<HTMLInputElement>('input:checked'),
      item => item.value,
    );
    controls.disabled = true;
    try {
      await request('payees/save', {
        id: row.id,
        revision: row.revision,
        categoryId,
        tagIds,
        resolveCategoryConflict,
      });
    } finally {
      if (generation === editorGeneration) controls.disabled = false;
    }
    if (generation === editorGeneration) await loadPayees(payeeOffset, row.id);
  },
  'submit',
);
element('payee-alias').addEventListener('change', updatePayeeLink);
element('payee-target').addEventListener('change', updatePayeeLink);
action(
  'payee-target-filter',
  async () => {
    const generation = editorGeneration;
    const search = element<HTMLInputElement>('payee-target-search').value;
    const page = await request<PayeePage>(`payees?${new URLSearchParams({ search })}`);
    if (generation !== editorGeneration) return;
    setPayeeTargets(page.rows.filter(row => row.id !== selectedPayee?.id && !row.unavailable));
    if (!targets.length) text('payee-link-preview', 'No available payees match that search.');
    else if (page.nextOffset !== null)
      text('payee-link-preview', 'Refine the search to see additional matches.');
  },
  'submit',
);
action('payee-link', async () => {
  const source = selectedPayee;
  const key = element<HTMLSelectElement>('payee-alias').value;
  const target = targets.find(row => row.id === element<HTMLSelectElement>('payee-target').value);
  if (!source || !key || !target) return;
  await request('payees/link', {
    key: key === '*' ? null : key,
    id: source.id,
    revision: source.revision,
    targetId: target.id,
    targetRevision: target.revision,
  });
  await loadPayees(payeeOffset, target.id);
});
action('payee-unlink', async () => {
  const source = selectedPayee;
  const key = element<HTMLSelectElement>('payee-alias').value;
  if (!source || !key || key === '*') return;
  if (!window.confirm('Use this SMS descriptor as a separate payee with blank defaults?')) return;
  await request('payees/unlink', { key, id: source.id, revision: source.revision });
  await loadPayees(payeeOffset, source.id);
});

async function show(page: string) {
  for (const id of ['status', 'inbox', 'payees', 'config', 'tasker'])
    element(id).hidden = id !== page;
  if (page !== 'payees') {
    ++payeeGeneration;
    ++editorGeneration;
  }
  if (page === 'status') await status();
  if (page === 'inbox') await events();
  if (page === 'payees') await loadPayees();
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
