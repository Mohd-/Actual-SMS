import { api } from '../api.js';
import type { PayeePage } from '../../contracts.js';
import type { PayeeView } from '../../../payees.js';
import {
  alertBox,
  badge,
  button,
  card,
  cardHead,
  checkboxField,
  combobox,
  confirmDialog,
  emptyState,
  field,
  iconButton,
  loadingBlock,
  openSheet,
  pageHeader,
  toast,
} from '../components.js';
import { el, userText } from '../dom.js';
import { categoryDisplayName } from '../format.js';
import {
  payeeCategoryLabel,
  payeeDescriptorSummary,
  payeeState,
  payeeTagLabel,
} from '../models.js';

export async function renderPayees(host: HTMLElement) {
  const screen = el('section', { class: 'screen' });
  host.append(screen);
  let page: PayeePage | undefined;
  let search = '';
  let offset = 0;
  let loading = false;
  let error = '';
  let generation = 0;
  let searchTimer: number | undefined;

  const count = el('p', { class: 'muted small', role: 'status' });
  const tableHost = el('div', { class: 'table-host' });
  const pagination = el('div', { class: 'pagination' });
  const searchInput = el('input', {
    id: 'payee-search',
    type: 'search',
    placeholder: 'Payee name or SMS descriptor',
    maxlength: '200',
    'aria-label': 'Search payees or SMS descriptors',
    value: search,
  });
  const applySearch = () => {
    search = searchInput.value.trim();
    offset = 0;
    void load(0);
  };
  const searchForm = el(
    'form',
    {
      class: 'search-form',
      on: {
        submit: event => {
          event.preventDefault();
          applySearch();
        },
      },
    },
    field('Search payees', searchInput),
    button('Search', { kind: 'primary', type: 'submit' }),
    search
      ? button('Clear', {
          kind: 'ghost',
          onClick: () => {
            search = '';
            searchInput.value = '';
            offset = 0;
            void load(0);
          },
        })
      : null,
  );
  const listCard = card(
    cardHead(
      'Payee defaults',
      'Defaults apply to future SMS imports. Actual rules can still override category, payee, or notes.',
      [button('Refresh', { kind: 'ghost', icon: 'refresh', onClick: () => void load(offset) })],
    ),
    tableHost,
    pagination,
  );
  screen.append(
    pageHeader({
      title: 'Payees',
      eyebrow: 'Catalog',
      description: 'Set default categories and tags, and link alternate SMS descriptors.',
    }),
    card(cardHead('Find a payee'), searchForm, count),
    listCard,
  );

  searchInput.addEventListener('input', () => {
    if (searchTimer) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      if (searchInput.value.trim() === search) return;
      search = searchInput.value.trim();
      offset = 0;
      void load(0);
    }, 350);
  });

  function renderList() {
    tableHost.replaceChildren();
    count.textContent = '';
    pagination.replaceChildren();
    if (loading && !page) {
      tableHost.append(loadingBlock(6));
      return;
    }
    if (error) {
      tableHost.append(alertBox(error, 'danger', 'Could not load payees'));
      return;
    }
    if (!page) return;
    if (page.migrationPending) {
      tableHost.append(
        alertBox(
          'Payee migration is waiting for Actual. Messages stay queued until it completes.',
          'warning',
          'Migration pending',
        ),
      );
    }
    if (!page.rows.length) {
      tableHost.append(
        emptyState(
          'payees',
          search ? 'No payees match' : 'No payees yet',
          search
            ? 'Try a different name or SMS descriptor.'
            : 'Reconnect Actual to refresh the payee catalog.',
        ),
      );
      return;
    }
    const table = el('table', { class: 'data-table payees-table' });
    table.append(
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', { scope: 'col', text: 'Payee' }),
          el('th', { scope: 'col', text: 'Category' }),
          el('th', { scope: 'col', text: 'Tags' }),
          el('th', { scope: 'col', text: 'Descriptors' }),
          el('th', { scope: 'col', text: 'State' }),
          el('th', { scope: 'col', text: '' }),
        ),
      ),
    );
    const body = el('tbody');
    for (const row of page.rows) {
      const open = (focus?: 'category') => openPayee(row, focus);
      const states = payeeState(row);
      const tagChips = row.tagIds.length
        ? el(
            'div',
            { class: 'chips' },
            ...row.tagIds.map(id =>
              el('span', { class: 'chip chip-static', text: payeeTagLabel(id, page!) }),
            ),
          )
        : el('span', { class: 'muted', text: 'No tags' });
      body.append(
        el(
          'tr',
          { class: 'data-row' },
          el(
            'td',
            { 'data-label': 'Payee' },
            el(
              'button',
              {
                type: 'button',
                class: 'link-button',
                onclick: () => open(),
              },
              userText(row.name),
            ),
            row.aliases.length
              ? el('span', {
                  class: 'muted small block',
                  text: `${row.aliases.length} descriptor${row.aliases.length === 1 ? '' : 's'}`,
                })
              : null,
          ),
          el('td', { 'data-label': 'Category' }, categoryCell(row, open)),
          el(
            'td',
            { 'data-label': 'Tags' },
            page!.editable
              ? el(
                  'button',
                  {
                    type: 'button',
                    class: 'cell-button',
                    onclick: () => open(),
                    'aria-label': `Edit tags for ${row.name}`,
                  },
                  tagChips,
                )
              : tagChips,
          ),
          el(
            'td',
            { 'data-label': 'Descriptors' },
            el('span', { class: 'descriptor-summary' }, userText(payeeDescriptorSummary(row))),
          ),
          el(
            'td',
            { 'data-label': 'State' },
            states.length
              ? el(
                  'div',
                  { class: 'chips' },
                  ...states.map(state => badge(state.label, state.tone)),
                )
              : badge('Ready', 'positive'),
          ),
          el(
            'td',
            { class: 'row-actions', 'data-label': 'Actions' },
            iconButton('arrowRight', `Open ${row.name}`, () => open()),
          ),
        ),
      );
    }
    table.append(body);
    tableHost.append(table);
    count.textContent = `Payees ${offset + 1}–${offset + page.rows.length}`;
    pagination.append(
      el('span', { class: 'muted small', text: count.textContent }),
      button('Previous', {
        kind: 'ghost',
        icon: 'arrowLeft',
        disabled: offset === 0 || loading,
        onClick: () => {
          offset = Math.max(0, offset - 50);
          void load(offset);
        },
      }),
      button('Next', {
        kind: 'ghost',
        icon: 'arrowRight',
        disabled: page.nextOffset === null || loading,
        onClick: () => {
          if (page?.nextOffset != null) void load(page.nextOffset);
        },
      }),
    );
  }

  function categoryCell(row: PayeeView, open: (focus?: 'category') => void) {
    if (!page || !page.editable || row.unavailable || row.conflict.length)
      return el(
        'button',
        {
          type: 'button',
          class: 'cell-button',
          onclick: () => open('category'),
        },
        payeeCategoryLabel(row, page!),
      );
    const select = el('select', {
      class: 'inline-select',
      'aria-label': `Category for ${row.name}`,
    });
    select.append(el('option', { value: '', text: 'No category' }));
    for (const category of page.categories)
      select.append(
        el('option', {
          value: category.id,
          text: categoryDisplayName(category, page.categories),
        }),
      );
    if (row.categoryId && !page.categories.some(category => category.id === row.categoryId))
      select.append(
        el('option', {
          value: row.categoryId,
          text: `Unavailable category (${row.categoryId})`,
        }),
      );
    select.value = row.categoryId ?? '';
    select.addEventListener('change', () => {
      select.disabled = true;
      void api('payees/save', {
        id: row.id,
        revision: row.revision,
        categoryId: select.value || null,
        tagIds: row.tagIds,
        resolveCategoryConflict: false,
      })
        .then(() => {
          toast('Category saved', 'positive');
          return load(offset);
        })
        .catch(caught => {
          select.disabled = false;
          select.value = row.categoryId ?? '';
          toast(caught instanceof Error ? caught.message : 'Could not save category', 'danger');
        });
    });
    return select;
  }

  async function load(nextOffset: number, reopen?: string) {
    const current = ++generation;
    loading = true;
    offset = nextOffset;
    renderList();
    const params = new URLSearchParams({ search, offset: String(offset) });
    try {
      const result = await api<PayeePage>(`payees?${params}`);
      if (current !== generation) return;
      if (offset > 0 && !result.rows.length) {
        await load(Math.max(0, offset - 50), reopen);
        return;
      }
      page = result;
      error = '';
      loading = false;
      renderList();
      if (reopen) {
        const row = page.rows.find(item => item.id === reopen);
        if (row) openPayee(row);
      }
    } catch (caught) {
      if (current !== generation) return;
      error = caught instanceof Error ? caught.message : 'Could not load payees';
      loading = false;
      renderList();
    }
  }

  function categoryOptions() {
    if (!page) return [];
    return [
      { value: '', label: 'No category' },
      ...page.categories.map(category => ({
        value: category.id,
        label: categoryDisplayName(category, page!.categories),
      })),
    ];
  }

  function openPayee(row: PayeeView, focus?: 'category') {
    if (!page) return;
    const editable = page.editable;
    const conflict = row.conflict.length > 0;
    const selectedCategory = el('input', { type: 'hidden', value: row.categoryId ?? '' });
    const category = combobox({
      options: categoryOptions(),
      value: row.categoryId ?? '',
      placeholder: 'Choose an Actual category',
      inputId: `payee-category-${row.id}`,
      ariaLabel: 'Actual category',
      disabled: !editable,
      onChange: value => {
        selectedCategory.value = value;
      },
    });
    if (conflict) {
      category.setOptions([
        ...categoryOptions(),
        { value: '__uncategorized__', label: 'Leave uncategorized' },
      ]);
    }
    if (row.categoryId && !page.categories.some(item => item.id === row.categoryId))
      category.setOptions([
        ...categoryOptions(),
        { value: row.categoryId, label: `Unavailable category (${row.categoryId})` },
      ]);
    const tagInputs = new Map<string, HTMLInputElement>();
    const tagsHost = el('div', { class: 'tag-picker' });
    const tagLabels = [
      ...page.tags.map(tag => ({ id: tag.id, name: tag.name, unavailable: false })),
      ...row.tagIds
        .filter(id => !page!.tags.some(tag => tag.id === id))
        .map(id => ({ id, name: id, unavailable: true })),
    ];
    if (!tagLabels.length)
      tagsHost.append(el('p', { class: 'muted small', text: 'No tags available in Actual.' }));
    for (const tag of tagLabels) {
      const input = el('input', { type: 'checkbox', value: tag.id });
      input.checked = row.tagIds.includes(tag.id);
      input.disabled = !editable;
      tagInputs.set(tag.id, input);
      tagsHost.append(
        checkboxField(tag.unavailable ? `Unavailable tag (${tag.id})` : `#${tag.name}`, input),
      );
    }
    const suggestion = el('div', { class: 'suggestion' });
    const controls = el('fieldset', { class: 'fieldset', disabled: !editable });
    const save = button('Save defaults', { kind: 'primary', type: 'submit', disabled: !editable });
    const form = el(
      'form',
      {
        class: 'stack',
        on: {
          submit: event => {
            event.preventDefault();
            if (!editable) return;
            const value = selectedCategory.value;
            const resolveCategoryConflict = value === '__uncategorized__';
            const categoryId = value && !resolveCategoryConflict ? value : null;
            save.disabled = true;
            controls.disabled = true;
            void api('payees/save', {
              id: row.id,
              revision: row.revision,
              categoryId,
              tagIds: [...tagInputs].filter(([, input]) => input.checked).map(([id]) => id),
              resolveCategoryConflict,
            })
              .then(() => {
                sheet.close();
                toast('Payee defaults saved', 'positive');
                return load(offset);
              })
              .catch(caught => {
                save.disabled = !editable;
                controls.disabled = !editable;
                form.prepend(
                  alertBox(
                    caught instanceof Error ? caught.message : 'Could not save payee defaults',
                    'danger',
                    'Save failed',
                  ),
                );
              });
          },
        },
      },
      controls,
      save,
    );
    controls.append(
      field('Actual category', category.root, 'Categories and groups come from Actual.'),
      el('div', { class: 'field' }, el('span', { class: 'field-label', text: 'Tags' }), tagsHost),
      suggestion,
    );
    form.append(el('div', { class: 'form-actions' }, save));
    if (page.suggestions && editable && !row.categoryId && !row.unavailable) {
      const suggest = button('Suggest category', {
        kind: 'ghost',
        icon: 'recognition',
        onClick: () => {
          suggest.disabled = true;
          suggestion.replaceChildren(
            el('p', { class: 'muted small', text: 'Looking for a suggestion…' }),
          );
          void api<{
            suggestion: { categoryId: string; confidence: number; reason: string } | null;
          }>('payees/suggestion', { id: row.id, revision: row.revision })
            .then(result => {
              if (!result.suggestion) {
                suggestion.replaceChildren(
                  el('p', { class: 'muted small', text: 'No suggestion available.' }),
                );
                return;
              }
              const foundCategory = page!.categories.find(
                item => item.id === result.suggestion!.categoryId,
              );
              if (!foundCategory) {
                suggestion.replaceChildren(
                  el('p', { class: 'muted small', text: 'No suggestion available.' }),
                );
                return;
              }
              suggestion.replaceChildren(
                alertBox(
                  el(
                    'div',
                    {},
                    el(
                      'p',
                      {},
                      `${categoryDisplayName(foundCategory, page!.categories)} · ${Math.round(result.suggestion.confidence * 100)}%`,
                    ),
                    el('p', { class: 'muted small', text: result.suggestion.reason }),
                  ),
                  'neutral',
                  'Suggestion',
                ),
                button('Use suggestion', {
                  kind: 'secondary',
                  onClick: () => {
                    category.setValue(result.suggestion!.categoryId);
                    selectedCategory.value = result.suggestion!.categoryId;
                    toast('Suggestion selected. Save defaults to apply it.', 'neutral');
                  },
                }),
              );
            })
            .catch(caught => {
              suggestion.replaceChildren(
                alertBox(caught instanceof Error ? caught.message : 'Suggestion failed', 'warning'),
              );
            })
            .finally(() => {
              suggest.disabled = false;
            });
        },
      });
      suggestion.append(suggest);
    }

    const descriptors = el('div', { class: 'descriptor-list' });
    const aliases = row.unavailable
      ? [{ key: '*', name: 'Move this payee and all descriptors', linked: false }]
      : row.aliases;
    for (const alias of aliases) {
      descriptors.append(
        el(
          'div',
          { class: 'descriptor-row' },
          el(
            'div',
            { class: 'descriptor-main' },
            el('strong', {}, userText(alias.name)),
            alias.linked ? badge('Shared defaults', 'accent') : badge('Separate payee', 'neutral'),
          ),
          el(
            'div',
            { class: 'descriptor-actions' },
            button('Link', {
              kind: 'ghost',
              icon: 'link',
              disabled: !editable || (!alias.linked && !row.unavailable && alias.key === '*'),
              onClick: () => openLink(row, alias, sheet),
            }),
            alias.linked
              ? button('Use as separate payee', {
                  kind: 'ghost',
                  disabled: !editable,
                  onClick: () => void unlink(row, alias.key, sheet),
                })
              : null,
          ),
        ),
      );
    }
    if (!aliases.length)
      descriptors.append(
        el('p', { class: 'muted small', text: 'No SMS descriptors are linked to this payee.' }),
      );

    const content = el(
      'div',
      { class: 'detail-stack' },
      el(
        'div',
        { class: 'detail-summary' },
        el(
          'div',
          { class: 'chips' },
          ...(payeeState(row).length
            ? payeeState(row).map(state => badge(state.label, state.tone))
            : [badge('Ready', 'positive')]),
        ),
      ),
      !editable
        ? alertBox(
            'Connect Actual and enable payee editing to change defaults.',
            'warning',
            'Read only',
          )
        : null,
      row.unavailable
        ? alertBox(
            'This Actual payee is unavailable. Link it to another payee to move its descriptors.',
            'warning',
            'Unavailable payee',
          )
        : null,
      conflict
        ? alertBox(
            el(
              'div',
              {},
              el('p', {
                text: 'Previous settings differ. Choose a category or leave the payee uncategorized to resolve them.',
              }),
              el(
                'ul',
                { class: 'plain-list' },
                ...row.conflict.map(choice => {
                  const account =
                    page!.accounts.find(item => item.id === choice.accountId)?.name ??
                    choice.accountId;
                  const category = choice.categoryId
                    ? page!.categories.find(item => item.id === choice.categoryId)
                    : undefined;
                  return el('li', {
                    text: `${account} · ${choice.merchant}${choice.payee ? ` → ${choice.payee}` : ''} · ${category ? categoryDisplayName(category, page!.categories) : 'Removed'}`,
                  });
                }),
              ),
            ),
            'warning',
            'Migration conflict',
          )
        : null,
      form,
      el(
        'section',
        { class: 'detail-section' },
        el('h3', { text: 'SMS descriptors' }),
        descriptors,
      ),
    );
    const sheet = openSheet({
      title: row.name,
      description: row.actualId ? 'Actual payee' : 'Local payee (not yet in Actual)',
      content,
      wide: true,
    });
    if (focus === 'category') category.input.focus();
  }

  function openLink(
    row: PayeeView,
    alias: { key: string; name: string },
    parent: ReturnType<typeof openSheet>,
  ) {
    if (!page) return;
    let target: PayeeView | undefined;
    let knownTargets = page.rows.filter(item => item.id !== row.id && !item.unavailable);
    const results = el('div', { class: 'link-results' });
    const preview = el('p', { class: 'muted small', role: 'status' });
    const link = button('Link descriptor', { kind: 'primary', disabled: true });
    const targetCombo = combobox({
      options: knownTargets.map(item => ({ value: item.id, label: item.name })),
      placeholder: 'Search for a payee',
      ariaLabel: 'Target payee',
      onChange: value => {
        target = knownTargets.find(item => item.id === value);
        renderPreview();
      },
    });
    const findTargets = () => {
      const value = targetCombo.input.value.trim();
      void api<PayeePage>(`payees?${new URLSearchParams({ search: value })}`)
        .then(result => {
          knownTargets = result.rows.filter(item => item.id !== row.id && !item.unavailable);
          targetCombo.setOptions(knownTargets.map(item => ({ value: item.id, label: item.name })));
          results.replaceChildren();
          if (!knownTargets.length)
            results.append(
              el('p', { class: 'muted small', text: 'No available payees match that search.' }),
            );
        })
        .catch(caught => {
          results.replaceChildren(
            alertBox(caught instanceof Error ? caught.message : 'Search failed', 'danger'),
          );
        });
    };
    const filter = el(
      'form',
      {
        class: 'search-form',
        on: {
          submit: event => {
            event.preventDefault();
            findTargets();
          },
        },
      },
      field('Find another payee', targetCombo.root),
      button('Find', { kind: 'secondary', type: 'submit' }),
    );
    const renderPreview = () => {
      if (!target) {
        preview.textContent = 'Choose a target payee to preview the effect.';
        link.disabled = true;
        return;
      }
      const tags = target.tagIds.map(id => payeeTagLabel(id, page!)).join(' ');
      preview.replaceChildren(
        userText(alias.name),
        ' → ',
        userText(target.name),
        el('span', {
          class: 'muted small block',
          text: `${payeeCategoryLabel(target, page!)}${tags ? ` · ${tags}` : ''}`,
        }),
      );
      link.disabled = false;
    };
    link.addEventListener('click', () => {
      if (!target) return;
      link.disabled = true;
      void api('payees/link', {
        key: alias.key === '*' ? null : alias.key,
        id: row.id,
        revision: row.revision,
        targetId: target.id,
        targetRevision: target.revision,
      })
        .then(() => {
          child.close();
          parent.close();
          toast('Descriptor linked', 'positive');
          return load(offset);
        })
        .catch(caught => {
          link.disabled = false;
          preview.replaceChildren(
            alertBox(caught instanceof Error ? caught.message : 'Link failed', 'danger'),
          );
        });
    });
    renderPreview();
    const child = openSheet({
      title: 'Link descriptor',
      description: `Choose the payee that should receive “${alias.name}”.`,
      content: el(
        'div',
        { class: 'stack' },
        alertBox(
          'The destination payee’s defaults apply to future imports. Existing transactions are not changed.',
          'neutral',
        ),
        filter,
        results,
        preview,
        el('div', { class: 'form-actions' }, link),
      ),
    });
  }

  async function unlink(row: PayeeView, key: string, sheet: ReturnType<typeof openSheet>) {
    const confirmed = await confirmDialog({
      title: 'Use this descriptor as a separate payee?',
      body: 'A new local payee with blank defaults will be created. Future imports for this descriptor will use it instead of the shared payee.',
      confirmLabel: 'Separate descriptor',
    });
    if (!confirmed) return;
    try {
      await api('payees/unlink', { key, id: row.id, revision: row.revision });
      sheet.close();
      toast('Descriptor is now a separate payee', 'positive');
      await load(offset);
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not separate descriptor', 'danger');
    }
  }

  renderList();
  await load(0);
  return () => {
    generation++;
    if (searchTimer) window.clearTimeout(searchTimer);
  };
}
