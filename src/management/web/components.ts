import { clear, el, icon, type IconName, userText } from './dom.js';
import type { Tone } from './format.js';

let dialogId = 0;
const nextId = (prefix: string) => `${prefix}-${++dialogId}`;

export function badge(label: string, tone: Tone = 'neutral') {
  return el('span', { class: `badge badge-${tone}` }, label);
}

export function alertBox(
  message: string | Node,
  tone: Tone = 'neutral',
  title?: string,
): HTMLElement {
  return el(
    'div',
    {
      class: `alert alert-${tone}`,
      role: tone === 'danger' || tone === 'warning' ? 'alert' : 'status',
    },
    title ? el('strong', { text: title }) : null,
    typeof message === 'string' ? el('p', { text: message }) : message,
  );
}

export interface ButtonOptions {
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger';
  icon?: IconName;
  onClick?: (event: MouseEvent) => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
}
export function button(label: string, options: ButtonOptions = {}) {
  const node = el('button', {
    type: options.type ?? 'button',
    class: `btn btn-${options.kind ?? 'secondary'}`,
    disabled: options.disabled,
    title: options.title,
    onclick: (event: Event) => options.onClick?.(event as MouseEvent),
  });
  if (options.icon) node.append(icon(options.icon, 17));
  node.append(el('span', { text: label }));
  return node;
}

export function iconButton(
  name: IconName,
  label: string,
  onClick?: (event: MouseEvent) => void,
  kind: 'primary' | 'secondary' | 'ghost' | 'danger' = 'ghost',
) {
  const node = el('button', {
    type: 'button',
    class: `btn btn-${kind} btn-icon`,
    'aria-label': label,
    title: label,
    onclick: (event: Event) => onClick?.(event as MouseEvent),
  });
  node.append(icon(name, 18));
  return node;
}

export function copyText(value: string, message = 'Copied') {
  const fallback = () => {
    const area = el('textarea', { class: 'visually-hidden', value });
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  };
  const operation = navigator.clipboard?.writeText(value) ?? Promise.reject();
  void operation.then(
    () => toast(message, 'positive'),
    () => {
      fallback();
      toast(message, 'positive');
    },
  );
}

export function copyButton(value: string, label = 'Copy') {
  return iconButton('copy', label, () => copyText(value, 'Copied'), 'ghost');
}

export function pageHeader(options: {
  title: string;
  eyebrow?: string;
  description?: string;
  actions?: Node[];
}) {
  return el(
    'header',
    { class: 'page-header' },
    el(
      'div',
      { class: 'page-heading' },
      options.eyebrow ? el('p', { class: 'eyebrow', text: options.eyebrow }) : null,
      el('h1', { text: options.title, tabindex: '-1' }),
      options.description
        ? el('p', { class: 'page-description', text: options.description })
        : null,
    ),
    options.actions?.length ? el('div', { class: 'page-actions' }, ...options.actions) : null,
  );
}

export function card(...children: (Node | string | null | false | undefined)[]) {
  return el('section', { class: 'card' }, ...children);
}

export function cardHead(title: string, description?: string, actions?: Node[]) {
  return el(
    'div',
    { class: 'card-head' },
    el(
      'div',
      {},
      el('h2', { text: title }),
      description ? el('p', { class: 'card-description', text: description }) : null,
    ),
    actions?.length ? el('div', { class: 'card-actions' }, ...actions) : null,
  );
}

export function definitionList(rows: [string, Node | string][]) {
  const list = el('dl', { class: 'definition-list' });
  for (const [label, value] of rows) {
    list.append(el('div', {}, el('dt', { text: label }), el('dd', {}, value)));
  }
  return list;
}

export function field(labelText: string, control: HTMLElement, hint?: string) {
  const label = el(
    'label',
    { class: 'field' },
    el('span', { class: 'field-label', text: labelText }),
    control,
  );
  if (hint) label.append(el('span', { class: 'field-hint', text: hint }));
  return label;
}

export function checkboxField(labelText: string, control: HTMLInputElement, hint?: string) {
  return el(
    'label',
    { class: 'check-field' },
    control,
    el('span', { class: 'check-label', text: labelText }),
    hint ? el('span', { class: 'field-hint', text: hint }) : null,
  );
}

export function emptyState(
  iconName: IconName,
  title: string,
  description: string,
  action?: HTMLElement,
) {
  return el(
    'div',
    { class: 'empty-state' },
    el('span', { class: 'empty-icon' }, icon(iconName, 22)),
    el('h3', { text: title }),
    el('p', { text: description }),
    action ?? null,
  );
}

export function loadingBlock(lines = 4) {
  return el(
    'div',
    { class: 'skeleton', 'aria-label': 'Loading', role: 'status' },
    ...Array.from({ length: lines }, () => el('span', { class: 'skeleton-line' })),
  );
}

export function toast(message: string, tone: Tone = 'neutral') {
  let region = document.getElementById('toasts');
  if (!region) {
    region = el('div', { id: 'toasts', class: 'toast-region', 'aria-live': 'polite' });
    document.body.append(region);
  }
  const item = el('div', { class: `toast toast-${tone}` }, el('span', { text: message }));
  region.append(item);
  setTimeout(() => item.classList.add('toast-out'), 3200);
  setTimeout(() => item.remove(), 3700);
}

export interface SheetOptions {
  title: string;
  description?: string;
  content: Node;
  footer?: Node;
  wide?: boolean;
  onClose?: () => void;
}
export interface Sheet {
  dialog: HTMLDialogElement;
  body: HTMLElement;
  footer: HTMLElement;
  close: () => void;
}
export function openSheet(options: SheetOptions): Sheet {
  const id = nextId('sheet-title');
  const dialog = el('dialog', {
    class: `sheet${options.wide ? ' sheet-wide' : ''}`,
    'aria-labelledby': id,
  });
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    options.onClose?.();
    dialog.remove();
  };
  const close = () => {
    if (dialog.open) dialog.close();
    else finish();
  };
  const body = el('div', { class: 'sheet-body' }, options.content);
  const footer = el('footer', { class: 'sheet-footer' }, options.footer ?? null);
  dialog.append(
    el(
      'header',
      { class: 'sheet-head' },
      el(
        'div',
        {},
        el('p', { class: 'eyebrow', text: 'Details' }),
        el('h2', { id, text: options.title }),
        options.description
          ? el('p', { class: 'sheet-description', text: options.description })
          : null,
      ),
      iconButton('close', 'Close', close),
    ),
    body,
    options.footer ? footer : el('span', { hidden: true }),
  );
  dialog.addEventListener('close', finish);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    close();
  });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, body, footer, close };
}

export interface ConfirmOptions {
  title: string;
  body: string | Node;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
}
export function confirmDialog(options: ConfirmOptions) {
  return new Promise<boolean>(resolve => {
    const id = nextId('dialog-title');
    const dialog = el('dialog', { class: 'modal', 'aria-labelledby': id });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
      dialog.close();
      dialog.remove();
    };
    const cancel = button(options.cancelLabel ?? 'Cancel', {
      kind: 'ghost',
      onClick: () => finish(false),
    });
    const confirm = button(options.confirmLabel, {
      kind: options.tone === 'danger' ? 'danger' : 'primary',
      onClick: () => finish(true),
    });
    dialog.append(
      el(
        'div',
        { class: 'modal-body' },
        el('h2', { id, text: options.title }),
        typeof options.body === 'string' ? el('p', { text: options.body }) : options.body,
      ),
      el('footer', { class: 'modal-actions' }, cancel, confirm),
    );
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener('close', () => finish(false));
    dialog.addEventListener('click', event => {
      if (event.target === dialog) finish(false);
    });
    document.body.append(dialog);
    dialog.showModal();
    confirm.focus();
  });
}

export interface ComboOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
  disabled?: boolean;
}
export interface ComboboxOptions {
  options: ComboOption[];
  value?: string;
  placeholder?: string;
  inputId?: string;
  ariaLabel?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
}
export interface Combobox {
  root: HTMLElement;
  input: HTMLInputElement;
  value: () => string;
  setValue: (value: string) => void;
  setOptions: (options: ComboOption[]) => void;
  setDisabled: (disabled: boolean) => void;
}
export function combobox(options: ComboboxOptions): Combobox {
  const listId = nextId('combo-list');
  const input = el('input', {
    type: 'text',
    class: 'combo-input',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': listId,
    autocomplete: 'off',
    placeholder: options.placeholder ?? '',
    id: options.inputId,
    'aria-label': options.ariaLabel,
    disabled: options.disabled,
  });
  const list = el('ul', { class: 'combo-list', id: listId, role: 'listbox', hidden: true });
  const root = el('div', { class: 'combo' }, input, list);
  let all = [...options.options];
  let selected = options.value ?? '';
  let active = -1;
  let typed = false;
  let filtered: ComboOption[] = [];

  const sync = () => {
    input.value = all.find(option => option.value === selected)?.label ?? selected;
  };
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };
  const choose = (option: ComboOption) => {
    if (option.disabled) return;
    selected = option.value;
    typed = false;
    sync();
    close();
    options.onChange?.(selected);
  };
  const render = () => {
    clear(list);
    const query = typed ? input.value.trim().toLocaleLowerCase() : '';
    filtered = query ? all.filter(option => option.label.toLocaleLowerCase().includes(query)) : all;
    let group: string | undefined;
    filtered.forEach((option, index) => {
      if (option.group && option.group !== group) {
        group = option.group;
        list.append(el('li', { class: 'combo-group', role: 'presentation', text: option.group }));
      }
      const id = `${listId}-${index}`;
      list.append(
        el(
          'li',
          {
            id,
            role: 'option',
            class: `combo-option${option.value === selected ? ' is-selected' : ''}${option.disabled ? ' is-disabled' : ''}${index === active ? ' is-active' : ''}`,
            'aria-selected': String(option.value === selected),
            'aria-disabled': String(Boolean(option.disabled)),
            on: {
              pointerdown: event => event.preventDefault(),
              click: () => choose(option),
            },
          },
          el('span', { text: option.label }),
          option.description
            ? el('span', { class: 'combo-description', text: option.description })
            : null,
        ),
      );
    });
    if (!filtered.length) list.append(el('li', { class: 'combo-empty', text: 'No matches' }));
  };
  const open = () => {
    render();
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };
  input.addEventListener('focus', () => {
    typed = false;
    open();
  });
  input.addEventListener('input', () => {
    typed = true;
    active = -1;
    open();
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (root.contains(document.activeElement)) return;
      typed = false;
      sync();
      close();
    }, 100);
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      typed = false;
      sync();
      close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (list.hidden) open();
      if (!filtered.length) return;
      active =
        event.key === 'ArrowDown'
          ? (active + 1) % filtered.length
          : (active - 1 + filtered.length) % filtered.length;
      render();
      return;
    }
    if (event.key === 'Enter' && !list.hidden) {
      event.preventDefault();
      const option = filtered[active >= 0 ? active : 0];
      if (option) choose(option);
    }
  });
  sync();
  return {
    root,
    input,
    value: () => selected,
    setValue: value => {
      selected = value;
      typed = false;
      sync();
    },
    setOptions: next => {
      all = [...next];
      if (!all.some(option => option.value === selected) && selected)
        all.push({ value: selected, label: selected });
      sync();
      if (!list.hidden) render();
    },
    setDisabled: disabled => {
      input.disabled = disabled;
      if (disabled) close();
    },
  };
}

export interface ChipInputOptions {
  values: string[];
  placeholder?: string;
  ariaLabel: string;
  split?: 'commas' | 'tokens';
  inputMode?: string;
  disabled?: boolean;
  onChange?: (values: string[]) => void;
}
export interface ChipInput {
  root: HTMLElement;
  values: () => string[];
  setValues: (values: string[]) => void;
}
export function chipInput(options: ChipInputOptions): ChipInput {
  let values = [...options.values];
  const root = el('div', { class: 'chip-input' });
  const input = el('input', {
    type: 'text',
    class: 'chip-input-field',
    placeholder: options.placeholder ?? 'Add…',
    'aria-label': options.ariaLabel,
    inputmode: options.inputMode,
    disabled: options.disabled,
  });
  const commit = (raw: string) => {
    const pieces = options.split === 'tokens' ? raw.split(/[,\s]+/u) : raw.split(/[,\n]+/u);
    let changed = false;
    for (const piece of pieces) {
      const value = piece.trim();
      if (!value || values.includes(value)) continue;
      values = [...values, value];
      changed = true;
    }
    if (changed) {
      input.value = '';
      render();
      options.onChange?.([...values]);
    }
  };
  const remove = (value: string) => {
    values = values.filter(item => item !== value);
    render();
    options.onChange?.([...values]);
  };
  function render() {
    clear(root);
    for (const value of values) {
      root.append(
        el(
          'span',
          { class: 'chip' },
          el('span', { text: value }),
          el('button', {
            type: 'button',
            class: 'chip-remove',
            'aria-label': `Remove ${value}`,
            text: '×',
            onclick: () => remove(value),
            disabled: options.disabled,
          }),
        ),
      );
    }
    root.append(input);
  }
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' || (options.split === 'tokens' && event.key === ',')) {
      event.preventDefault();
      commit(input.value);
    } else if (event.key === 'Backspace' && !input.value && values.length) {
      event.preventDefault();
      remove(values.at(-1)!);
    }
  });
  input.addEventListener('paste', () => {
    setTimeout(() => {
      if (/[,\n]/u.test(input.value) || (options.split === 'tokens' && /\s/u.test(input.value)))
        commit(input.value);
    });
  });
  input.addEventListener('blur', () => {
    if (input.value.trim()) commit(input.value);
  });
  render();
  return {
    root,
    values: () => [...values],
    setValues: next => {
      values = [...next];
      render();
    },
  };
}

export function directionBlock(value: string) {
  return userText(value, true);
}
