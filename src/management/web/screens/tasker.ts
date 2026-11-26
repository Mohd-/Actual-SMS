import { api, download } from '../api.js';
import type { InboxCheckpoint } from '../../../types.js';
import {
  alertBox,
  button,
  card,
  cardHead,
  confirmDialog,
  copyButton,
  definitionList,
  field,
  iconButton,
  loadingBlock,
  openSheet,
  pageHeader,
  toast,
} from '../components.js';
import { el, icon } from '../dom.js';
import { dateInputValue, formatExact, formatUtc } from '../format.js';

export async function renderTasker(host: HTMLElement) {
  const screen = el('section', { class: 'screen' });
  host.append(screen);
  let checkpoint: InboxCheckpoint | null = null;
  let loaded = false;
  let key = '';
  let keyVisible = false;

  const checkpointHost = el('div', { class: 'checkpoint-host' }, loadingBlock(3));
  const keyInput = el('input', {
    type: 'password',
    id: 'tasker-key',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'Paste the current restricted key',
  });
  const keyReveal = iconButton('eye', 'Show key', () => {
    keyVisible = !keyVisible;
    keyInput.type = keyVisible ? 'text' : 'password';
    keyReveal.setAttribute('aria-label', keyVisible ? 'Hide key' : 'Show key');
    keyReveal.replaceChildren(icon(keyVisible ? 'eyeOff' : 'eye', 18));
  });
  const originInput = el('input', {
    type: 'url',
    id: 'tasker-origin',
    placeholder: 'https://sms.example.test',
    autocomplete: 'url',
  });
  const keyField = el('div', { class: 'input-with-action' }, keyInput, keyReveal);

  const keyCard = card(
    cardHead(
      'Restricted key',
      'The key is returned only once. It is never stored in this browser.',
    ),
    el(
      'div',
      { class: 'stack' },
      alertBox(
        'Replacing the key immediately invalidates the current one. Phones using it will stop syncing until the new Tasker project is imported.',
        'warning',
        'Replacing a key is disruptive',
      ),
      field('Restricted key', keyField),
      el(
        'div',
        { class: 'form-actions' },
        button('Generate / replace key', {
          kind: 'secondary',
          icon: 'key',
          onClick: () => void rotate(),
        }),
      ),
    ),
  );
  const exportCard = card(
    cardHead(
      'Tasker project',
      'Download a project pre-filled with the service origin and current key.',
    ),
    el(
      'div',
      { class: 'stack' },
      field(
        'Public HTTPS service origin',
        originInput,
        'The exact origin reachable by your phone. No path, query, fragment, or credentials.',
      ),
      el(
        'div',
        { class: 'form-actions' },
        button('Download configured project', {
          kind: 'primary',
          icon: 'download',
          onClick: () => void exportProject(),
        }),
      ),
    ),
  );
  screen.append(
    pageHeader({
      title: 'Phone setup',
      eyebrow: 'Tasker',
      description: 'Connect the phone that forwards bank SMS to this service.',
    }),
    el('div', { class: 'grid two' }, keyCard, exportCard),
    card(
      cardHead(
        'Inbox checkpoint',
        'The checkpoint decides which inbox messages are read next. Viewing this page never moves it.',
        [
          button('Refresh', {
            kind: 'ghost',
            icon: 'refresh',
            onClick: () => void loadCheckpoint(),
          }),
        ],
      ),
      checkpointHost,
    ),
  );

  async function loadCheckpoint() {
    try {
      const result = await api<{ checkpoint: InboxCheckpoint | null }>('tasker/checkpoint');
      checkpoint = result.checkpoint;
      loaded = true;
      renderCheckpoint();
    } catch (caught) {
      checkpointHost.replaceChildren(
        alertBox(caught instanceof Error ? caught.message : 'Could not load checkpoint', 'danger'),
      );
    }
  }

  function renderCheckpoint() {
    if (!loaded) return;
    if (!checkpoint) {
      checkpointHost.replaceChildren(
        emptyCheckpoint(),
        el(
          'p',
          { class: 'muted small' },
          'Not initialized. The first phone sync starts seven days back unless you choose another time.',
        ),
        el(
          'div',
          { class: 'form-actions' },
          button('Choose a starting point', { kind: 'primary', onClick: () => editCheckpoint() }),
        ),
      );
      return;
    }
    checkpointHost.replaceChildren(
      definitionList([
        ['Device-local time', formatExact(checkpoint.date)],
        ['UTC', formatUtc(checkpoint.date)],
        ['Inbox row ID', String(checkpoint.rowId)],
      ]),
      el(
        'p',
        { class: 'muted small' },
        'Moving backward rechecks older messages without replaying imported events. Moving forward skips unread messages before the selected time.',
      ),
      el(
        'div',
        { class: 'form-actions' },
        button('Change checkpoint', { kind: 'secondary', onClick: () => editCheckpoint() }),
      ),
    );
  }

  function emptyCheckpoint() {
    return el(
      'div',
      { class: 'empty-state compact' },
      el('span', { class: 'empty-icon' }, icon('clock', 20)),
      el('p', { text: 'Not initialized' }),
    );
  }

  async function rotate() {
    const confirmed = await confirmDialog({
      title: 'Replace the restricted key?',
      body: 'The current restricted key stops working immediately. Every phone using it must import a new Tasker project before it can send SMS again.',
      confirmLabel: 'Replace key',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      const result = await api<{ key: string }>('tasker/rotate', { confirmation: 'ROTATE' });
      key = result.key;
      keyInput.value = key;
      keyInput.type = 'text';
      keyVisible = true;
      showSecret(result.key);
      toast('Restricted key replaced', 'positive');
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not rotate key', 'danger');
    }
  }

  function showSecret(value: string) {
    const secret = el('input', { type: 'text', readonly: true, value, class: 'mono' });
    secret.addEventListener('focus', () => secret.select());
    const sheet = openSheet({
      title: 'Save the new key now',
      description: 'This is the only time the key is shown. It is not saved by the browser.',
      content: el(
        'div',
        { class: 'stack' },
        alertBox(
          'Store the key securely. If you lose it, generate another key and import a new project.',
          'warning',
        ),
        field('Restricted key', secret),
        el('div', { class: 'secret-actions' }, copyButton(value, 'Copy key')),
      ),
      footer: button('I have saved the key', {
        kind: 'primary',
        onClick: () => {
          secret.value = '';
          sheet.close();
        },
      }),
    });
  }

  async function exportProject() {
    if (!key.trim()) {
      toast('Paste the current restricted key or generate a new one first', 'warning');
      keyInput.focus();
      return;
    }
    try {
      const parsed = new URL(originInput.value);
      if (parsed.origin !== originInput.value || !originInput.value.startsWith('https://'))
        throw new Error('Use an exact HTTPS origin without a path or credentials');
    } catch {
      toast('Enter a valid HTTPS service origin', 'warning');
      originInput.focus();
      return;
    }
    try {
      await download(
        'tasker/export',
        { origin: originInput.value, key: key.trim() },
        'Actual_SMS_Inbox.prj.xml',
      );
      toast('Tasker project downloaded', 'positive');
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not download project', 'danger');
    }
  }

  function editCheckpoint() {
    const initial = checkpoint?.date ?? Date.now() - 7 * 24 * 60 * 60 * 1000;
    const input = el('input', {
      type: 'datetime-local',
      step: '1',
      id: 'checkpoint-date',
      value: dateInputValue(initial),
    });
    const latest = checkpoint;
    const save = button('Confirm checkpoint change', { kind: 'primary' });
    const sheet = openSheet({
      title: 'Change inbox checkpoint',
      description: 'The checkpoint is compared with the current phone state before saving.',
      content: el(
        'div',
        { class: 'stack' },
        field('Start at device-local time', input),
        el(
          'div',
          { class: 'preset-row' },
          button('7 days ago', {
            kind: 'ghost',
            onClick: () => {
              input.value = dateInputValue(Date.now() - 7 * 24 * 60 * 60 * 1000);
            },
          }),
          button('30 days ago', {
            kind: 'ghost',
            onClick: () => {
              input.value = dateInputValue(Date.now() - 30 * 24 * 60 * 60 * 1000);
            },
          }),
        ),
        alertBox(
          'Moving forward can skip unread messages. Moving backward can recheck older messages, but already imported events remain deduplicated.',
          'warning',
        ),
      ),
      footer: save,
    });
    save.addEventListener('click', () => {
      const date = new Date(input.value).getTime();
      if (!Number.isFinite(date) || date > Date.now()) {
        toast('Choose a valid date that is not in the future', 'warning');
        return;
      }
      save.disabled = true;
      void api('tasker/checkpoint', { date, expected: latest, confirmation: 'CHANGE' })
        .then(result => {
          checkpoint = (result as { checkpoint: InboxCheckpoint }).checkpoint;
          sheet.close();
          renderCheckpoint();
          toast('Inbox checkpoint updated', 'positive');
        })
        .catch(caught => {
          save.disabled = false;
          toast(caught instanceof Error ? caught.message : 'Could not change checkpoint', 'danger');
          void loadCheckpoint();
        });
    });
  }

  await loadCheckpoint();
  return () => {
    key = '';
    keyInput.value = '';
  };
}
