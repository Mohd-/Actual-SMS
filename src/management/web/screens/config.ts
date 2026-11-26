import { api } from '../api.js';
import type { ConfigModelView, ConfigView } from '../../contracts.js';
import type { TxKind } from '../../../types.js';
import {
  alertBox,
  badge,
  button,
  card,
  cardHead,
  checkboxField,
  chipInput,
  confirmDialog,
  definitionList,
  field,
  iconButton,
  loadingBlock,
  pageHeader,
  toast,
} from '../components.js';
import { el } from '../dom.js';
import {
  categoryDisplayName,
  dateInputValue,
  formatAmount,
  formatExact,
  kindLabel,
  reasonLabel,
} from '../format.js';
import {
  bankOptionLabel,
  banksFromConfig,
  draftKey,
  groupRules,
  planAccountPatches,
  planBankPatches,
  rulesFromAccounts,
  type ParsingRuleDraft,
  type ParsingTemplateDraft,
  type PatchPlan,
  type PatternDraft,
  type RuleDraft,
  parsingFromConfig,
  planParsingPatches,
} from '../models.js';
import { setDirtyGuard } from '../state.js';

const txKinds: TxKind[] = [
  'purchase',
  'refund',
  'withdrawal',
  'transfer_in',
  'transfer_out',
  'card_payment',
];

function activeCategories(model: ConfigModelView) {
  return model.catalog.categories.filter(category => !category.hidden && !category.isIncome);
}

function revisionState(model: ConfigModelView) {
  const pending = model.revision !== model.activeRevision;
  return el(
    'div',
    { class: 'revision-strip' },
    el('span', {}, 'Persisted ', el('code', { text: model.revision.slice(0, 12) })),
    el('span', {}, 'Active ', el('code', { text: model.activeRevision?.slice(0, 12) ?? 'none' })),
    pending ? badge('Not active', 'warning') : badge('In sync', 'positive'),
    model.editableFiles.accounts || model.editableFiles.banks || model.editableFiles.parsing
      ? null
      : badge('Read only', 'neutral'),
  );
}

async function fetchModel() {
  return api<ConfigModelView>('config/model');
}

async function fetchSource() {
  return api<ConfigView>('config');
}

function sourceDisclosure(file: 'accounts' | 'banks' | 'parsing') {
  const body = el('pre', { class: 'raw-json', text: 'Loading source…' });
  const details = el(
    'details',
    { class: 'source-disclosure' },
    el('summary', { text: 'View source YAML (read-only)' }),
    body,
  );
  let loaded = false;
  details.addEventListener('toggle', () => {
    if (!details.open || loaded) return;
    loaded = true;
    void fetchSource()
      .then(source => {
        body.textContent = source[file];
      })
      .catch(caught => {
        body.textContent = caught instanceof Error ? caught.message : 'Could not load source';
      });
  });
  return details;
}

async function reviewPlan(
  file: 'accounts' | 'banks' | 'parsing',
  plan: PatchPlan,
  model: ConfigModelView,
) {
  if (!plan.patches.length) {
    toast('No changes to save', 'neutral');
    return false;
  }
  await api('config/model/preview', {
    file,
    revision: model.revision,
    patches: plan.patches,
  });
  const list = el(
    'ul',
    { class: 'plain-list' },
    ...plan.summary.map(item => el('li', { text: item })),
  );
  const confirmed = await confirmDialog({
    title:
      file === 'accounts'
        ? 'Save routing changes?'
        : file === 'banks'
          ? 'Save bank changes?'
          : 'Save grammar changes?',
    body: el(
      'div',
      {},
      el('p', {
        text: 'This will validate the complete configuration, write the YAML file, and activate the new snapshot.',
      }),
      list,
    ),
    confirmLabel: 'Save and activate',
  });
  if (!confirmed) return false;
  await api('config/model/save', {
    file,
    revision: model.revision,
    patches: plan.patches,
    confirmation: 'SAVE',
  });
  return true;
}

function conflictAlert(error: unknown, reload: () => void) {
  const message = error instanceof Error ? error.message : 'Configuration change failed';
  return alertBox(
    el(
      'div',
      {},
      el('p', { text: message }),
      el(
        'div',
        { class: 'form-actions' },
        button('Reload configuration', { kind: 'secondary', onClick: reload }),
      ),
    ),
    'danger',
    'Configuration not saved',
  );
}

export async function renderAccounts(host: HTMLElement) {
  const screen = el('section', { class: 'screen' });
  host.append(screen);
  screen.append(pageHeader({ title: 'Routing', eyebrow: 'Configuration' }), loadingBlock(5));
  let model: ConfigModelView;
  try {
    model = await fetchModel();
  } catch (caught) {
    screen.replaceChildren(
      pageHeader({ title: 'Routing', eyebrow: 'Configuration' }),
      alertBox(caught instanceof Error ? caught.message : 'Could not load configuration', 'danger'),
    );
    return;
  }
  let rules = rulesFromAccounts(model.accounts);
  let bankFeesCategory = model.accounts.bankFeesCategory ?? '';
  let useAllEligible = model.accounts.eligibleCategories === undefined;
  let eligible = [...(model.accounts.eligibleCategories ?? [])];
  let dirty = false;
  let busy = false;
  let errorNode: HTMLElement | null = null;
  const editable = model.editableFiles.accounts;
  setDirtyGuard(() => dirty);

  const render = () => {
    const groups = groupRules(rules);
    const actions = [
      button('Review changes', {
        kind: 'primary',
        icon: 'check',
        disabled: !editable || busy,
        onClick: () => void save(),
      }),
      button('Reload', {
        kind: 'ghost',
        icon: 'refresh',
        disabled: busy,
        onClick: () => void reload(),
      }),
    ];
    const accountListId = `account-list-${draftKey()}`;
    const accountList = el(
      'datalist',
      { id: accountListId },
      ...model.catalog.accounts.map(account => el('option', { value: account.name })),
    );
    const cards = groups.map(group =>
      card(
        cardHead(
          group.name || 'Unnamed account',
          `${group.rules.length} routing rule${group.rules.length === 1 ? '' : 's'}`,
          [
            button('Add rule', {
              kind: 'ghost',
              icon: 'plus',
              disabled: !editable,
              onClick: () => {
                rules.push({
                  key: draftKey(),
                  actualName: group.rules[0]?.actualName ?? group.name,
                  match: { bank: model.banks.banks[0]?.id ?? '' },
                });
                markDirty();
                render();
              },
            }),
          ],
        ),
        el(
          'div',
          { class: 'stack' },
          field(
            'Actual account name',
            accountNameInput(group, accountListId),
            'Choose an existing Actual account. Names must resolve exactly once.',
          ),
          ...group.rules.map(rule => ruleCard(rule)),
        ),
      ),
    );
    const categoryOptions = activeCategories(model).map(category => ({
      value: category.name,
      label: categoryDisplayName(category, activeCategories(model)),
    }));
    if (bankFeesCategory && !categoryOptions.some(option => option.value === bankFeesCategory))
      categoryOptions.push({ value: bankFeesCategory, label: `${bankFeesCategory} (not active)` });
    const feeSelect = el('select', { disabled: !editable, value: bankFeesCategory });
    feeSelect.append(el('option', { value: '', text: 'Choose a category' }));
    for (const option of categoryOptions)
      feeSelect.append(el('option', { value: option.value, text: option.label }));
    feeSelect.value = bankFeesCategory;
    feeSelect.addEventListener('change', () => {
      bankFeesCategory = feeSelect.value;
      markDirty();
    });
    const allEligible = el('input', { type: 'checkbox', checked: useAllEligible });
    allEligible.disabled = !editable;
    allEligible.addEventListener('change', () => {
      useAllEligible = allEligible.checked;
      if (!useAllEligible && !eligible.length)
        eligible = activeCategories(model).map(category => category.name);
      markDirty();
      render();
    });
    const eligibleSearch = el('input', {
      type: 'search',
      placeholder: 'Filter categories',
      'aria-label': 'Filter eligible categories',
    });
    const eligibleList = el('div', { class: 'checkbox-list' });
    const renderEligible = () => {
      const query = eligibleSearch.value.trim().toLocaleLowerCase();
      eligibleList.replaceChildren(
        ...activeCategories(model)
          .filter(category => !query || category.name.toLocaleLowerCase().includes(query))
          .map(category => {
            const input = el('input', { type: 'checkbox', value: category.name });
            input.checked = eligible.includes(category.name);
            input.disabled = !editable;
            input.addEventListener('change', () => {
              eligible = input.checked
                ? [...new Set([...eligible, category.name])]
                : eligible.filter(name => name !== category.name);
              markDirty();
            });
            return checkboxField(categoryDisplayName(category, activeCategories(model)), input);
          }),
      );
    };
    eligibleSearch.addEventListener('input', renderEligible);
    renderEligible();
    const globalCard = card(
      cardHead('Global account options', 'Categories must already exist in Actual.'),
      el(
        'div',
        { class: 'stack' },
        field('Bank fees category', feeSelect),
        el('div', { class: 'field' }, checkboxField('Use all eligible categories', allEligible)),
        useAllEligible
          ? el('p', {
              class: 'muted small',
              text: 'All active expense categories are eligible for suggestions.',
            })
          : el(
              'div',
              { class: 'stack' },
              field('Eligible categories', eligibleSearch),
              eligibleList,
            ),
      ),
    );
    const page = el('div', { class: 'config-page' });
    page.append(
      pageHeader({
        title: 'Routing',
        eyebrow: 'Configuration',
        description:
          'Map SMS account references to existing Actual accounts. No YAML editing required.',
        actions,
      }),
      revisionState(model),
      !editable
        ? alertBox(
            'Account editing is disabled or the configuration directory is read-only. Enable MANAGEMENT_EDIT_ACCOUNTS and mount a writable configuration directory to make changes here.',
            'warning',
            'Read only',
          )
        : el('span', { hidden: true }),
      errorNode ?? el('span', { hidden: true }),
      el('p', { class: 'dirty-note', text: dirty ? 'Unsaved changes' : '' }),
      accountList,
      el('div', { class: 'grid two config-grid' }, ...cards, globalCard),
      button('Add account mapping', {
        kind: 'secondary',
        icon: 'plus',
        disabled: !editable,
        onClick: () => {
          rules.push({
            key: draftKey(),
            actualName: '',
            match: { bank: model.banks.banks[0]?.id ?? '' },
          });
          markDirty();
          render();
        },
      }),
      sourceDisclosure('accounts'),
    );
    screen.replaceChildren(page);
  };

  function accountNameInput(group: ReturnType<typeof groupRules>[number], listId: string) {
    const input = el('input', {
      type: 'text',
      value: group.rules[0]?.actualName ?? '',
      placeholder: 'Choose an Actual account',
      list: listId,
      disabled: !editable,
      'aria-label': 'Actual account name',
    });
    input.addEventListener('input', () => {
      for (const item of group.rules) item.actualName = input.value;
      markDirty();
    });
    return input;
  }

  function ruleCard(rule: RuleDraft) {
    const index = rules.indexOf(rule);
    const bankSelect = el('select', { disabled: !editable, 'aria-label': 'Bank' });
    bankSelect.append(el('option', { value: '', text: 'Choose a bank' }));
    for (const bank of model.banks.banks) {
      const option = el('option', { value: bank.id, text: bankOptionLabel(bank) });
      option.disabled = bank.disposition !== 'import';
      bankSelect.append(option);
    }
    bankSelect.value = rule.match.bank;
    bankSelect.addEventListener('change', () => {
      rule.match.bank = bankSelect.value;
      markDirty();
    });
    const suffixes = chipInput({
      values: rule.match.accountSuffixes ?? [],
      placeholder: 'e.g. 1234, 5678',
      ariaLabel: 'Account suffixes',
      split: 'tokens',
      inputMode: 'numeric',
      disabled: !editable,
      onChange: values => {
        rule.match.accountSuffixes = values.length ? values : undefined;
        markDirty();
      },
    });
    const advanced = el('details', { class: 'rule-advanced' });
    const kindChecks = el('div', { class: 'kind-list' });
    for (const kind of txKinds) {
      const input = el('input', { type: 'checkbox', value: kind });
      input.checked = (rule.match.transactionKinds ?? []).includes(kind);
      input.disabled = !editable;
      input.addEventListener('change', () => {
        const values = new Set(rule.match.transactionKinds ?? []);
        if (input.checked) values.add(kind);
        else values.delete(kind);
        rule.match.transactionKinds = values.size ? [...values] : undefined;
        markDirty();
      });
      kindChecks.append(checkboxField(kindLabel(kind), input));
    }
    const balance = el('select', { disabled: !editable });
    balance.append(
      el('option', { value: '', text: 'Any balance state' }),
      el('option', { value: 'true', text: 'Notification includes a balance' }),
      el('option', { value: 'false', text: 'Notification has no balance' }),
    );
    balance.value = rule.match.hasBalance === undefined ? '' : String(rule.match.hasBalance);
    balance.addEventListener('change', () => {
      rule.match.hasBalance = balance.value === '' ? undefined : balance.value === 'true';
      markDirty();
    });
    const transfer = chipInput({
      values: rule.match.transferIdentifiers ?? [],
      placeholder: 'Transfer identifiers',
      ariaLabel: 'Transfer identifiers',
      split: 'tokens',
      inputMode: 'numeric',
      disabled: !editable,
      onChange: values => {
        rule.match.transferIdentifiers = values.length ? values : undefined;
        markDirty();
      },
    });
    const bill = chipInput({
      values: rule.match.billPaymentIdentifiers ?? [],
      placeholder: 'Biller identifiers',
      ariaLabel: 'Bill payment identifiers',
      split: 'tokens',
      inputMode: 'numeric',
      disabled: !editable,
      onChange: values => {
        rule.match.billPaymentIdentifiers = values.length ? values : undefined;
        markDirty();
      },
    });
    advanced.append(
      el('summary', { text: 'Advanced matching' }),
      el(
        'div',
        { class: 'stack' },
        el(
          'div',
          { class: 'field' },
          el('span', { class: 'field-label', text: 'Transaction kinds' }),
          kindChecks,
        ),
        field('Balance presence', balance),
        field('Transfer identifiers', transfer.root),
        field('Bill payment identifiers', bill.root),
      ),
    );
    return el(
      'div',
      { class: 'rule-card' },
      el(
        'div',
        { class: 'rule-main' },
        field('Bank', bankSelect),
        field('Account suffixes', suffixes.root),
      ),
      advanced,
      el(
        'div',
        { class: 'rule-actions' },
        iconButton(
          'trash',
          `Remove rule ${index + 1}`,
          () => {
            rules.splice(index, 1);
            markDirty();
            render();
          },
          'danger',
        ),
      ),
    );
  }

  function markDirty() {
    if (!dirty) {
      dirty = true;
      const note = screen.querySelector('.dirty-note');
      if (note) note.textContent = 'Unsaved changes';
    }
  }

  async function save() {
    if (busy) return;
    if (!useAllEligible && !eligible.length) {
      toast('Select at least one eligible category or use all eligible categories', 'warning');
      return;
    }
    busy = true;
    errorNode = null;
    render();
    const plan = planAccountPatches(model.accounts, rules, {
      bankFeesCategory,
      eligibleCategories: useAllEligible ? undefined : eligible,
    });
    try {
      const saved = await reviewPlan('accounts', plan, model);
      if (!saved) return;
      model = await fetchModel();
      rules = rulesFromAccounts(model.accounts);
      bankFeesCategory = model.accounts.bankFeesCategory ?? '';
      useAllEligible = model.accounts.eligibleCategories === undefined;
      eligible = [...(model.accounts.eligibleCategories ?? [])];
      dirty = false;
      toast('Routing configuration saved and activated', 'positive');
    } catch (caught) {
      errorNode = conflictAlert(caught, () => void reload());
    } finally {
      busy = false;
      render();
    }
  }

  async function reload() {
    if (dirty) {
      const confirmed = await confirmDialog({
        title: 'Discard unsaved changes?',
        body: 'Reloading reads the files from disk and discards your current draft.',
        confirmLabel: 'Discard and reload',
        tone: 'danger',
      });
      if (!confirmed) return;
    }
    try {
      model = await fetchModel();
      rules = rulesFromAccounts(model.accounts);
      bankFeesCategory = model.accounts.bankFeesCategory ?? '';
      useAllEligible = model.accounts.eligibleCategories === undefined;
      eligible = [...(model.accounts.eligibleCategories ?? [])];
      dirty = false;
      errorNode = null;
      toast('Configuration reloaded', 'neutral');
      render();
    } catch (caught) {
      errorNode = conflictAlert(caught, () => void reload());
      render();
    }
  }

  render();
  return () => setDirtyGuard();
}

export async function renderBanks(host: HTMLElement) {
  const screen = el('section', { class: 'screen' });
  host.append(screen);
  screen.append(pageHeader({ title: 'Banks', eyebrow: 'Configuration' }), loadingBlock(5));
  let model: ConfigModelView;
  try {
    model = await fetchModel();
  } catch (caught) {
    screen.replaceChildren(
      pageHeader({ title: 'Banks', eyebrow: 'Configuration' }),
      alertBox(caught instanceof Error ? caught.message : 'Could not load configuration', 'danger'),
    );
    return;
  }
  let banks = banksFromConfig(model.banks);
  let dirty = false;
  let busy = false;
  let errorNode: HTMLElement | null = null;
  const editable = model.editableFiles.banks;
  setDirtyGuard(() => dirty);

  const markDirty = () => {
    if (dirty) return;
    dirty = true;
    const note = screen.querySelector('.dirty-note');
    if (note) note.textContent = 'Unsaved changes';
  };

  const render = () => {
    const cards = banks.map(bank => {
      const idField =
        bank.sourceIndex === undefined
          ? el('input', {
              type: 'text',
              value: bank.id,
              placeholder: 'bank-id',
              disabled: !editable,
              class: 'mono',
              'aria-label': 'Bank ID',
            })
          : el('code', { class: 'mono', text: bank.id });
      if (bank.sourceIndex === undefined) {
        idField.addEventListener('input', event => {
          bank.id = (event.currentTarget as HTMLInputElement).value.trim().toLowerCase();
          markDirty();
        });
      }
      const name = el('input', {
        type: 'text',
        value: bank.name,
        disabled: !editable,
        'aria-label': 'Bank name',
      });
      name.addEventListener('input', () => {
        bank.name = name.value;
        markDirty();
      });
      const disposition = el('select', {
        disabled: !editable,
        'aria-label': 'Disposition',
        value: bank.disposition,
      });
      disposition.append(
        el('option', { value: 'import', text: 'Import messages' }),
        el('option', { value: 'needs_review', text: 'Hold for review' }),
      );
      disposition.value = bank.disposition;
      disposition.addEventListener('change', () => {
        bank.disposition = disposition.value as 'import' | 'needs_review';
        markDirty();
      });
      const senders = chipInput({
        values: bank.senders,
        placeholder: 'Sender aliases',
        ariaLabel: 'Sender aliases',
        split: 'commas',
        disabled: !editable,
        onChange: values => {
          bank.senders = values;
          markDirty();
        },
      });
      const aliases = chipInput({
        values: bank.messageAliases,
        placeholder: 'Message aliases',
        ariaLabel: 'Message aliases',
        split: 'commas',
        disabled: !editable,
        onChange: values => {
          bank.messageAliases = values;
          markDirty();
        },
      });
      const templates = el('div', { class: 'checkbox-list' });
      if (!model.parsing.templates.length)
        templates.append(
          el('p', { class: 'muted small', text: 'No parsing templates are defined.' }),
        );
      for (const template of model.parsing.templates) {
        const input = el('input', { type: 'checkbox', value: template.id });
        input.checked = bank.templates.includes(template.id);
        input.disabled = !editable;
        input.addEventListener('change', () => {
          bank.templates = input.checked
            ? [...new Set([...bank.templates, template.id])]
            : bank.templates.filter(id => id !== template.id);
          markDirty();
        });
        templates.append(checkboxField(template.id, input));
      }
      return card(
        cardHead(
          bank.name || bank.id || 'New bank',
          bank.sourceIndex === undefined ? 'New bank' : 'Bank registry',
          [
            iconButton(
              'trash',
              `Remove ${bank.name || 'bank'}`,
              () => {
                banks = banks.filter(item => item !== bank);
                markDirty();
                render();
              },
              'danger',
            ),
          ],
        ),
        el(
          'div',
          { class: 'stack' },
          el(
            'div',
            { class: 'inline-fields' },
            field('ID', idField),
            field('Name', name),
            field('Disposition', disposition),
          ),
          field(
            'Sender aliases',
            senders.root,
            'Case and extra whitespace are ignored; aliases must be unique.',
          ),
          field(
            'Message aliases',
            aliases.root,
            'Legacy messages without a sender can use these aliases.',
          ),
          el(
            'div',
            { class: 'field' },
            el('span', { class: 'field-label', text: 'Parsing templates' }),
            templates,
          ),
        ),
      );
    });
    const page = el('div', { class: 'config-page' });
    page.append(
      pageHeader({
        title: 'Banks',
        eyebrow: 'Configuration',
        description: 'Stable bank IDs, sender aliases, and import disposition.',
        actions: [
          button('Review changes', {
            kind: 'primary',
            icon: 'check',
            disabled: !editable || busy,
            onClick: () => void save(),
          }),
          button('Reload', {
            kind: 'ghost',
            icon: 'refresh',
            disabled: busy,
            onClick: () => void reload(),
          }),
        ],
      }),
      revisionState(model),
      !editable
        ? alertBox(
            'Bank editing is disabled or the configuration directory is read-only. Enable MANAGEMENT_EDIT_BANKS and mount a writable configuration directory.',
            'warning',
            'Read only',
          )
        : el('span', { hidden: true }),
      errorNode ?? el('span', { hidden: true }),
      el('p', { class: 'dirty-note', text: dirty ? 'Unsaved changes' : '' }),
      el(
        'div',
        { class: 'grid two config-grid' },
        ...cards,
        card(
          cardHead('Add a bank'),
          el(
            'p',
            { class: 'muted small' },
            'Bank IDs are permanent: account routes and SMS deduplication use them. Add a new bank only when its messages need separate recognition.',
          ),
          button('Add bank', {
            kind: 'secondary',
            icon: 'plus',
            disabled: !editable,
            onClick: () => {
              banks.push({
                key: draftKey(),
                id: '',
                name: '',
                senders: [],
                messageAliases: [],
                disposition: 'import',
                templates: [],
              });
              markDirty();
              render();
            },
          }),
        ),
      ),
      sourceDisclosure('banks'),
    );
    screen.replaceChildren(page);
  };

  async function save() {
    if (busy) return;
    busy = true;
    errorNode = null;
    render();
    const plan = planBankPatches(model.banks, banks);
    try {
      const saved = await reviewPlan('banks', plan, model);
      if (!saved) return;
      model = await fetchModel();
      banks = banksFromConfig(model.banks);
      dirty = false;
      toast('Bank configuration saved and activated', 'positive');
    } catch (caught) {
      errorNode = conflictAlert(caught, () => void reload());
    } finally {
      busy = false;
      render();
    }
  }

  async function reload() {
    if (dirty) {
      const confirmed = await confirmDialog({
        title: 'Discard unsaved changes?',
        body: 'Reloading reads the files from disk and discards your current draft.',
        confirmLabel: 'Discard and reload',
        tone: 'danger',
      });
      if (!confirmed) return;
    }
    try {
      model = await fetchModel();
      banks = banksFromConfig(model.banks);
      dirty = false;
      errorNode = null;
      toast('Configuration reloaded', 'neutral');
      render();
    } catch (caught) {
      errorNode = conflictAlert(caught, () => void reload());
      render();
    }
  }

  render();
  return () => setDirtyGuard();
}

export async function renderParsing(host: HTMLElement) {
  const screen = el('section', { class: 'screen' });
  host.append(screen);
  screen.append(pageHeader({ title: 'Recognition', eyebrow: 'Configuration' }), loadingBlock(5));
  let model: ConfigModelView;
  try {
    model = await fetchModel();
  } catch (caught) {
    screen.replaceChildren(
      pageHeader({ title: 'Recognition', eyebrow: 'Configuration' }),
      alertBox(caught instanceof Error ? caught.message : 'Could not load configuration', 'danger'),
    );
    return;
  }
  let draft = parsingFromConfig(model.parsing);
  let dirty = false;
  let busy = false;
  let errorNode: HTMLElement | null = null;
  const editable = model.editableFiles.parsing;
  setDirtyGuard(() => dirty);

  const resultHost = el('div', { class: 'test-result' });
  const sender = el('input', { type: 'text', placeholder: 'SAB', 'aria-label': 'Sender' });
  const message = el('textarea', {
    rows: '7',
    placeholder: 'Paste a bank SMS to test the grammar…',
    'aria-label': 'Sample SMS',
  });
  const received = el('input', {
    type: 'datetime-local',
    step: '1',
    value: dateInputValue(),
    'aria-label': 'Received time',
  });
  const testButton = button('Test message', {
    kind: 'primary',
    icon: 'recognition',
    onClick: () => void testMessage(),
  });
  const testForm = el(
    'form',
    {
      class: 'stack',
      on: {
        submit: event => {
          event.preventDefault();
          void testMessage();
        },
      },
    },
    el('div', { class: 'inline-fields' }, field('Sender', sender), field('Received', received)),
    field('Sample SMS', message),
    el('div', { class: 'form-actions' }, testButton),
    resultHost,
  );

  const markDirty = () => {
    if (dirty) return;
    dirty = true;
    const note = screen.querySelector('.dirty-note');
    if (note) note.textContent = 'Unsaved changes';
  };

  function patternEditor(patterns: PatternDraft[], label: string) {
    const rows = el('div', { class: 'pattern-editor-list' });
    patterns.forEach((pattern, index) => {
      const source = el('input', {
        type: 'text',
        class: 'mono pattern-source',
        value: pattern.source,
        'aria-label': `${label} pattern source ${index + 1}`,
        spellcheck: 'false',
      });
      source.addEventListener('input', () => {
        pattern.source = source.value;
        markDirty();
      });
      const flags = el('input', {
        type: 'text',
        class: 'mono pattern-flags',
        value: pattern.flags,
        'aria-label': `${label} pattern flags ${index + 1}`,
        spellcheck: 'false',
      });
      flags.addEventListener('input', () => {
        pattern.flags = flags.value;
        markDirty();
      });
      rows.append(
        el(
          'div',
          { class: 'pattern-row' },
          source,
          flags,
          el(
            'div',
            { class: 'pattern-actions' },
            iconButton('up', 'Move pattern up', () => {
              if (index === 0) return;
              const [item] = patterns.splice(index, 1);
              patterns.splice(index - 1, 0, item!);
              markDirty();
              render();
            }),
            iconButton('down', 'Move pattern down', () => {
              if (index >= patterns.length - 1) return;
              const [item] = patterns.splice(index, 1);
              patterns.splice(index + 1, 0, item!);
              markDirty();
              render();
            }),
            iconButton(
              'trash',
              'Remove pattern',
              () => {
                patterns.splice(index, 1);
                markDirty();
                render();
              },
              'danger',
            ),
          ),
        ),
      );
    });
    return el(
      'div',
      { class: 'pattern-editor' },
      rows,
      button('Add pattern', {
        kind: 'ghost',
        icon: 'plus',
        onClick: () => {
          patterns.push({ key: draftKey(), source: '', flags: 'iu' });
          markDirty();
          render();
        },
      }),
    );
  }

  function ruleEditor(
    file: 'ignored' | 'kinds',
    values: { value: string; label: string }[],
    rule: ParsingRuleDraft,
    rules: ParsingRuleDraft[],
  ) {
    const value = el('select', { 'aria-label': 'Rule outcome' });
    for (const option of values)
      value.append(el('option', { value: option.value, text: option.label }));
    value.value = rule.value;
    const label = () =>
      `${values.find(option => option.value === rule.value)?.label ?? rule.value} · ${rule.patterns.length} pattern${rule.patterns.length === 1 ? '' : 's'}`;
    const summaryText = el('span', { text: label() });
    value.addEventListener('change', () => {
      rule.value = value.value;
      summaryText.textContent = label();
      markDirty();
    });
    return el(
      'details',
      { class: 'grammar-group rule-editor', open: rule.sourceIndex === undefined },
      el('summary', {}, summaryText),
      el(
        'div',
        { class: 'stack grammar-body' },
        el(
          'div',
          { class: 'rule-edit-head' },
          field('Outcome', value),
          el(
            'div',
            { class: 'pattern-actions' },
            iconButton('up', 'Move rule up', () => {
              const index = rules.indexOf(rule);
              if (index <= 0) return;
              rules.splice(index, 1);
              rules.splice(index - 1, 0, rule);
              markDirty();
              render();
            }),
            iconButton('down', 'Move rule down', () => {
              const index = rules.indexOf(rule);
              if (index < 0 || index >= rules.length - 1) return;
              rules.splice(index, 1);
              rules.splice(index + 1, 0, rule);
              markDirty();
              render();
            }),
            iconButton(
              'trash',
              'Remove rule',
              () => {
                rules.splice(rules.indexOf(rule), 1);
                markDirty();
                render();
              },
              'danger',
            ),
          ),
        ),
        patternEditor(rule.patterns, file === 'ignored' ? 'ignored' : 'kind'),
      ),
    );
  }

  function templateEditor(template: ParsingTemplateDraft, templates: ParsingTemplateDraft[]) {
    const id =
      template.sourceIndex === undefined
        ? el('input', {
            type: 'text',
            value: template.id,
            placeholder: 'template-id',
            'aria-label': 'Template ID',
            class: 'mono',
          })
        : el('code', { class: 'mono', text: template.id });
    if (template.sourceIndex === undefined) {
      id.addEventListener('input', () => {
        template.id = (id as HTMLInputElement).value.trim();
        markDirty();
      });
    }
    const kind = el('select', { 'aria-label': 'Template kind' });
    for (const value of txKinds) kind.append(el('option', { value, text: kindLabel(value) }));
    kind.value = template.kind;
    kind.addEventListener('change', () => {
      template.kind = kind.value;
      markDirty();
    });
    const required = el('div', { class: 'checkbox-list' });
    for (const field of draft.fields) {
      const input = el('input', { type: 'checkbox', value: field.name });
      input.checked = template.required.includes(field.name);
      input.addEventListener('change', () => {
        template.required = input.checked
          ? [...new Set([...template.required, field.name])]
          : template.required.filter(name => name !== field.name);
        markDirty();
      });
      required.append(checkboxField(field.name, input));
    }
    const overrideHost = el('div', { class: 'stack' });
    for (const field of template.fields) {
      overrideHost.append(
        el(
          'div',
          { class: 'field-override' },
          el(
            'div',
            { class: 'rule-edit-head' },
            el('strong', { text: field.name }),
            iconButton(
              'trash',
              `Remove ${field.name} override`,
              () => {
                template.fields = template.fields.filter(item => item !== field);
                markDirty();
                render();
              },
              'danger',
            ),
          ),
          patternEditor(field.patterns, `${field.name} override`),
        ),
      );
    }
    const available = draft.fields.filter(
      field => !template.fields.some(item => item.name === field.name),
    );
    const overrideField = el('select', { 'aria-label': 'New field override' });
    overrideField.append(el('option', { value: '', text: 'Add field override…' }));
    for (const field of available)
      overrideField.append(el('option', { value: field.name, text: field.name }));
    overrideField.addEventListener('change', () => {
      if (!overrideField.value) return;
      const field = draft.fields.find(item => item.name === overrideField.value);
      if (!field) return;
      template.fields.push({
        name: field.name,
        patterns: [{ key: draftKey(), source: '', flags: 'iu' }],
      });
      markDirty();
      render();
    });
    return el(
      'details',
      { class: 'grammar-group template-editor', open: template.sourceIndex === undefined },
      el('summary', { text: `Template · ${template.id || 'unnamed'}` }),
      el(
        'div',
        { class: 'stack grammar-body' },
        el(
          'div',
          { class: 'rule-edit-head' },
          field('Template ID', id),
          field('Kind', kind),
          iconButton(
            'trash',
            'Remove template',
            () => {
              templates.splice(templates.indexOf(template), 1);
              markDirty();
              render();
            },
            'danger',
          ),
        ),
        field('Match patterns', patternEditor(template.match, 'template match')),
        el(
          'div',
          { class: 'field' },
          el('span', { class: 'field-label', text: 'Required fields' }),
          required,
        ),
        el(
          'div',
          { class: 'field' },
          el('span', { class: 'field-label', text: 'Field overrides' }),
          overrideHost,
          overrideField,
        ),
      ),
    );
  }

  function grammarEditor() {
    const ignoredValues = [
      { value: 'otp_or_login', label: 'One-time code or login alert' },
      { value: 'declined_or_insufficient_funds', label: 'Declined or insufficient funds' },
      { value: 'duplicate_fee_notification', label: 'Duplicate fee notification' },
    ];
    const kindValues = txKinds.map(value => ({ value, label: kindLabel(value) }));
    return el(
      'div',
      { class: 'stack' },
      card(
        cardHead(
          'Ignored messages',
          'Checked before transaction classification. First match wins.',
          [
            button('Add rule', {
              kind: 'ghost',
              icon: 'plus',
              onClick: () => {
                draft.ignored.push({
                  key: draftKey(),
                  value: ignoredValues[0]!.value,
                  patterns: [{ key: draftKey(), source: '', flags: 'iu' }],
                });
                markDirty();
                render();
              },
            }),
          ],
        ),
        el(
          'div',
          { class: 'grammar-groups' },
          ...draft.ignored.map(rule => ruleEditor('ignored', ignoredValues, rule, draft.ignored)),
        ),
      ),
      card(
        cardHead(
          'Transaction kinds',
          'Order defines precedence. Specific kinds must precede generic purchase rules.',
          [
            button('Add rule', {
              kind: 'ghost',
              icon: 'plus',
              onClick: () => {
                draft.kinds.push({
                  key: draftKey(),
                  value: 'purchase',
                  patterns: [{ key: draftKey(), source: '', flags: 'iu' }],
                });
                markDirty();
                render();
              },
            }),
          ],
        ),
        el(
          'div',
          { class: 'grammar-groups' },
          ...draft.kinds.map(rule => ruleEditor('kinds', kindValues, rule, draft.kinds)),
        ),
      ),
      card(
        cardHead(
          'Shared extractors',
          'Each field needs a named capture. Templates override selected fields.',
        ),
        el(
          'div',
          { class: 'grammar-groups' },
          ...draft.fields.map(field =>
            el(
              'details',
              { class: 'grammar-group' },
              el('summary', { text: `${field.name} · ${field.patterns.length}` }),
              el('div', { class: 'grammar-body' }, patternEditor(field.patterns, field.name)),
            ),
          ),
        ),
      ),
      card(
        cardHead(
          'Templates',
          'Optional bank-specific overrides. Bank associations are edited in Banks.',
          [
            button('Add template', {
              kind: 'ghost',
              icon: 'plus',
              onClick: () => {
                draft.templates.push({
                  key: draftKey(),
                  id: '',
                  kind: 'purchase',
                  required: [],
                  match: [{ key: draftKey(), source: '', flags: 'iu' }],
                  fields: [],
                });
                markDirty();
                render();
              },
            }),
          ],
        ),
        draft.templates.length
          ? el(
              'div',
              { class: 'grammar-groups' },
              ...draft.templates.map(template => templateEditor(template, draft.templates)),
            )
          : el('p', {
              class: 'muted small',
              text: 'No templates defined. Shared rules apply to every bank.',
            }),
      ),
    );
  }

  function readOnlyGrammar() {
    const parsing = model.parsing;
    const sharedFields = parsing.shared?.fields ?? {};
    const templates = parsing.templates ?? [];
    return card(
      cardHead(
        'Grammar overview',
        'Order matters. The first matching ignored reason or transaction kind wins.',
      ),
      el(
        'div',
        { class: 'grammar-groups' },
        grammarGroup(
          'Ignored reasons',
          parsing.shared.ignored.map(rule => ({
            title: reasonLabel(rule.value),
            patterns: rule.patterns,
          })),
        ),
        grammarGroup(
          'Transaction kinds',
          parsing.shared.kinds.map(rule => ({
            title: kindLabel(rule.value),
            patterns: rule.patterns,
          })),
        ),
        el(
          'details',
          { class: 'grammar-group' },
          el('summary', { text: `Shared fields · ${Object.keys(sharedFields).length}` }),
          el(
            'div',
            { class: 'grammar-body' },
            ...Object.entries(sharedFields).map(([name, patterns]) =>
              el(
                'div',
                { class: 'grammar-rule' },
                el('strong', { text: name }),
                el(
                  'div',
                  { class: 'pattern-list' },
                  ...patterns.map(pattern =>
                    el('code', { class: 'pattern', text: `/${pattern.source}/${pattern.flags}` }),
                  ),
                ),
              ),
            ),
          ),
        ),
        el(
          'details',
          { class: 'grammar-group' },
          el('summary', { text: `Templates · ${templates.length}` }),
          el(
            'div',
            { class: 'grammar-body' },
            ...templates.map(template =>
              el(
                'div',
                { class: 'grammar-rule' },
                el('strong', { text: template.id }),
                el('span', {
                  class: 'muted small block',
                  text: `${kindLabel(template.kind)}${template.required?.length ? ` · required: ${template.required.join(', ')}` : ''}`,
                }),
                el(
                  'div',
                  { class: 'pattern-list' },
                  ...(template.match ?? []).map(pattern =>
                    el('code', { class: 'pattern', text: `/${pattern.source}/${pattern.flags}` }),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  async function testMessage() {
    if (!message.value.trim()) {
      toast('Paste a message to test', 'warning');
      message.focus();
      return;
    }
    testButton.disabled = true;
    resultHost.replaceChildren(loadingBlock(3));
    try {
      const plan = planParsingPatches(model.parsing, draft);
      const result = await api<{ result: unknown }>('config/test-message', {
        sender: sender.value,
        message: message.value,
        receivedAt: new Date(received.value).toISOString(),
        ...(plan.patches.length
          ? { file: 'parsing', revision: model.revision, patches: plan.patches }
          : {}),
      });
      resultHost.replaceChildren(renderResult(result.result));
    } catch (caught) {
      resultHost.replaceChildren(
        alertBox(caught instanceof Error ? caught.message : 'Test failed', 'danger'),
      );
    } finally {
      testButton.disabled = false;
    }
  }

  function renderResult(result: unknown) {
    const value = result as {
      type?: string;
      reason?: string;
      transaction?: {
        bank?: string;
        kind?: string;
        amountCents?: number | null;
        payee?: string;
        occurredAt?: string;
        accountAlias?: string;
        note?: string;
      };
    };
    if (!value.type) return alertBox('The parser returned no result.', 'warning');
    if (value.type !== 'transaction')
      return alertBox(
        `The active grammar would mark this message as ${value.type.replaceAll('_', ' ')}${value.reason ? ` (${reasonLabel(value.reason)})` : ''}.`,
        value.type === 'needs_review' ? 'warning' : 'neutral',
      );
    const transaction = value.transaction ?? {};
    return el(
      'div',
      { class: 'stack' },
      alertBox('Recognized as a transaction. No message was queued or imported.', 'positive'),
      definitionList([
        ['Bank', transaction.bank ?? '—'],
        ['Kind', kindLabel(transaction.kind ?? '')],
        ['Amount', formatAmount(transaction.amountCents)],
        ['Payee', transaction.payee ?? '—'],
        ['Account alias', transaction.accountAlias ?? '—'],
        ['Occurred', transaction.occurredAt ? formatExact(transaction.occurredAt) : '—'],
        ['Note', transaction.note ?? '—'],
      ]),
    );
  }

  const testCard = card(
    cardHead('SMS tester', 'Runs the draft grammar without creating an event.'),
    testForm,
  );
  testCard.classList.add('sticky-card');

  function render() {
    const page = el('div', { class: 'config-page' });
    page.append(
      pageHeader({
        title: 'Recognition',
        eyebrow: 'Configuration',
        description:
          'Edit the English/Arabic grammar or inspect the active rules and test a message.',
        actions: editable
          ? [
              button('Review changes', {
                kind: 'primary',
                icon: 'check',
                disabled: busy,
                onClick: () => void save(),
              }),
              button('Reload', {
                kind: 'ghost',
                icon: 'refresh',
                disabled: busy,
                onClick: () => void reload(),
              }),
            ]
          : [],
      }),
      revisionState(model),
      !editable
        ? alertBox(
            'Grammar editing is disabled or the configuration directory is read-only. Enable MANAGEMENT_EDIT_PARSING and mount a writable configuration directory to edit recognition rules.',
            'warning',
            'Read only',
          )
        : alertBox(
            'Changes affect new and replayed parser outcomes. Test a sample message and review the generated changes before saving.',
            'warning',
            'High-impact configuration',
          ),
      errorNode ?? el('span', { hidden: true }),
      el('p', { class: 'dirty-note', text: dirty ? 'Unsaved changes' : '' }),
      el(
        'div',
        { class: 'grid two config-grid' },
        editable ? grammarEditor() : readOnlyGrammar(),
        testCard,
      ),
      sourceDisclosure('parsing'),
    );
    screen.replaceChildren(page);
  }

  async function save() {
    if (busy) return;
    busy = true;
    errorNode = null;
    render();
    const plan = planParsingPatches(model.parsing, draft);
    try {
      const saved = await reviewPlan('parsing', plan, model);
      if (!saved) return;
      model = await fetchModel();
      draft = parsingFromConfig(model.parsing);
      dirty = false;
      toast('Recognition configuration saved and activated', 'positive');
    } catch (caught) {
      errorNode = conflictAlert(caught, () => void reload());
    } finally {
      busy = false;
      render();
    }
  }

  async function reload() {
    if (dirty) {
      const confirmed = await confirmDialog({
        title: 'Discard unsaved changes?',
        body: 'Reloading reads the files from disk and discards your current draft.',
        confirmLabel: 'Discard and reload',
        tone: 'danger',
      });
      if (!confirmed) return;
    }
    try {
      model = await fetchModel();
      draft = parsingFromConfig(model.parsing);
      dirty = false;
      errorNode = null;
      toast('Configuration reloaded', 'neutral');
      render();
    } catch (caught) {
      errorNode = conflictAlert(caught, () => void reload());
      render();
    }
  }

  render();
  return () => setDirtyGuard();
}

function grammarGroup(
  title: string,
  rules: { title: string; patterns: { source: string; flags: string }[] }[],
) {
  return el(
    'details',
    { class: 'grammar-group', open: true },
    el('summary', { text: `${title} · ${rules.length}` }),
    el(
      'div',
      { class: 'grammar-body' },
      ...rules.map(rule =>
        el(
          'div',
          { class: 'grammar-rule' },
          el('strong', { text: rule.title }),
          el(
            'div',
            { class: 'pattern-list' },
            ...rule.patterns.map(pattern =>
              el('code', { class: 'pattern', text: `/${pattern.source}/${pattern.flags}` }),
            ),
          ),
        ),
      ),
    ),
  );
}
