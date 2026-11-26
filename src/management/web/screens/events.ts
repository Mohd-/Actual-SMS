import { api } from '../api.js';
import type { EventPage, EventView } from '../../contracts.js';
import {
  alertBox,
  badge,
  button,
  card,
  cardHead,
  copyButton,
  definitionList,
  emptyState,
  field,
  iconButton,
  loadingBlock,
  openSheet,
  pageHeader,
  toast,
} from '../components.js';
import { el, userText } from '../dom.js';
import {
  endOfLocalDay,
  formatAmount,
  formatDateTime,
  formatExact,
  formatNumber,
  formatRelative,
  kindLabel,
  reasonLabel,
  startOfLocalDay,
  statusLabel,
  statusMeta,
  statusOrder,
  statusTone,
} from '../format.js';

interface Filters {
  status: string;
  from: string;
  to: string;
  enrichment: string;
}
interface EventInput {
  message?: string;
  sender?: string;
  receivedAt?: string;
  location?: { latitude?: number; longitude?: number; accuracyMeters?: number };
}
interface ParsedView {
  bank?: string;
  kind?: string;
  accountAlias?: string;
  amountCents?: number | null;
  feeCents?: number;
  payee?: string;
  occurredAt?: string;
  balanceCents?: number;
  foreign?: { currency?: string; amount?: number };
  note?: string;
  transferCounterpartyAlias?: string;
  billPaymentIdentifier?: string;
}

function filtersFrom(query: URLSearchParams): Filters {
  return {
    status: query.get('status') ?? '',
    from: query.get('from') ?? '',
    to: query.get('to') ?? '',
    enrichment: query.get('enrichment') ?? '',
  };
}

function updateHash(filters: Filters) {
  const query = new URLSearchParams();
  if (filters.status) query.set('status', filters.status);
  if (filters.from) query.set('from', filters.from);
  if (filters.to) query.set('to', filters.to);
  if (filters.enrichment) query.set('enrichment', filters.enrichment);
  const hash = `#/events${query.toString() ? `?${query}` : ''}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

export async function renderEvents(host: HTMLElement, initialQuery = new URLSearchParams()) {
  const screen = el('section', { class: 'screen' });
  host.append(screen);
  let filters = filtersFrom(initialQuery);
  let cursorStack: (string | undefined)[] = [undefined];
  let pageIndex = 0;
  let page: EventPage | undefined;
  let loading = false;
  let error = '';
  let generation = 0;

  const tableHost = el('div', { class: 'table-host' });
  const range = el('p', { class: 'muted small' });

  const filterCard = card(
    cardHead('Filter', 'Summary lists never include the SMS body.'),
    buildFilters(),
  );
  const listCard = card(
    cardHead(
      'Messages',
      'Select a message to inspect its original input, parsed result, and audit trail.',
      [button('Refresh', { kind: 'ghost', icon: 'refresh', onClick: () => void load(pageIndex) })],
    ),
    tableHost,
    el('div', { class: 'pagination' }, range),
  );
  screen.append(
    pageHeader({
      title: 'SMS audit',
      eyebrow: 'Review',
      description: 'Read-only review of every retained message and its processing history.',
      actions: [
        button('Refresh', { kind: 'ghost', icon: 'refresh', onClick: () => void load(pageIndex) }),
      ],
    }),
    filterCard,
    listCard,
  );

  function buildFilters() {
    const status = el('select', {
      id: 'filter-status',
      name: 'status',
      disabled: loading,
    });
    status.append(el('option', { value: '', text: 'All statuses' }));
    for (const value of statusOrder)
      status.append(el('option', { value, text: statusMeta[value].label }));
    status.value = filters.status;
    const from = el('input', { type: 'date', id: 'filter-from', value: filters.from });
    const to = el('input', { type: 'date', id: 'filter-to', value: filters.to });
    const enrichment = el('input', {
      type: 'search',
      id: 'filter-enrichment',
      value: filters.enrichment,
      placeholder: 'e.g. success, timeout, not_applicable',
      maxlength: '100',
    });
    const apply = () => {
      filters = {
        status: status.value,
        from: from.value,
        to: to.value,
        enrichment: enrichment.value.trim(),
      };
      updateHash(filters);
      cursorStack = [undefined];
      pageIndex = 0;
      void load(0);
    };
    const form = el(
      'form',
      {
        class: 'filter-form',
        on: {
          submit: event => {
            event.preventDefault();
            apply();
          },
        },
      },
      field('Status', status),
      field('From', from),
      field('To', to),
      el(
        'details',
        { class: 'advanced-filter' },
        el('summary', { text: 'More filters' }),
        field('Enrichment status', enrichment),
      ),
      el(
        'div',
        { class: 'filter-actions' },
        button('Apply filters', { kind: 'primary', type: 'submit' }),
        button('Clear', {
          kind: 'ghost',
          onClick: () => {
            filters = { status: '', from: '', to: '', enrichment: '' };
            status.value = '';
            from.value = '';
            to.value = '';
            enrichment.value = '';
            updateHash(filters);
            cursorStack = [undefined];
            pageIndex = 0;
            void load(0);
          },
        }),
      ),
    );
    return form;
  }

  function renderList() {
    tableHost.replaceChildren();
    if (loading && !page) {
      tableHost.append(loadingBlock(6));
      return;
    }
    if (error) {
      tableHost.append(alertBox(error, 'danger', 'Could not load messages'));
      return;
    }
    if (!page?.events.length) {
      tableHost.append(
        emptyState(
          'events',
          filters.status || filters.from || filters.to || filters.enrichment
            ? 'No matching messages'
            : 'No messages yet',
          filters.status || filters.from || filters.to || filters.enrichment
            ? 'Try clearing a filter or widening the date range.'
            : 'Messages sent by Tasker will appear here after they are accepted.',
        ),
      );
      range.textContent = '';
      return;
    }
    const table = el('table', { class: 'data-table events-table' });
    const head = el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { scope: 'col', text: 'Status' }),
        el('th', { scope: 'col', text: 'Received' }),
        el('th', { scope: 'col', text: 'Event' }),
        el('th', { scope: 'col', text: 'Reason' }),
        el('th', { scope: 'col', text: 'Attempts' }),
        el('th', { scope: 'col', text: 'Enrichment' }),
        el('th', { scope: 'col', text: '' }),
      ),
    );
    const body = el('tbody');
    for (const event of page.events) {
      const open = () => void openDetail(event.eventId);
      body.append(
        el(
          'tr',
          { class: 'data-row' },
          el(
            'td',
            { 'data-label': 'Status' },
            badge(statusLabel(event.status), statusTone(event.status)),
          ),
          el(
            'td',
            { 'data-label': 'Received' },
            el('span', {
              title: formatExact(event.createdAt),
              text: formatDateTime(event.createdAt),
            }),
            el('span', { class: 'muted small block', text: formatRelative(event.createdAt) }),
          ),
          el(
            'td',
            { 'data-label': 'Event' },
            el('button', {
              type: 'button',
              class: 'link-button mono',
              text: event.eventId.length > 18 ? `${event.eventId.slice(0, 16)}…` : event.eventId,
              title: event.eventId,
              'aria-label': `Open event ${event.eventId}`,
              onclick: open,
            }),
          ),
          el('td', { 'data-label': 'Reason', text: reasonLabel(event.parserReason) || '—' }),
          el('td', { 'data-label': 'Attempts', text: formatNumber(event.attempts) }),
          el('td', { 'data-label': 'Enrichment', text: event.enrichmentStatus ?? '—' }),
          el(
            'td',
            { class: 'row-actions', 'data-label': 'Actions' },
            iconButton('arrowRight', `View event ${event.eventId}`, open),
          ),
        ),
      );
    }
    table.append(head, body);
    tableHost.append(table);
    const first = pageIndex * 25 + 1;
    const last = pageIndex * 25 + page.events.length;
    range.textContent = `Showing ${first}–${last}`;
  }

  function renderPagination() {
    const footer = listCard.querySelector('.pagination');
    if (!footer || !page) return;
    footer.replaceChildren(
      el('span', { class: 'muted small', text: range.textContent ?? '' }),
      button('Newer', {
        kind: 'ghost',
        icon: 'arrowLeft',
        disabled: pageIndex === 0 || loading,
        onClick: () => {
          if (pageIndex === 0) return;
          pageIndex--;
          void load(pageIndex);
        },
      }),
      button('Older', {
        kind: 'ghost',
        icon: 'arrowRight',
        disabled: !page.nextCursor || loading,
        onClick: () => {
          if (!page?.nextCursor) return;
          if (!cursorStack[pageIndex + 1]) cursorStack[pageIndex + 1] = page.nextCursor;
          pageIndex++;
          void load(pageIndex);
        },
      }),
    );
  }

  async function load(index: number) {
    const current = ++generation;
    loading = true;
    renderList();
    const query = new URLSearchParams({ limit: '25' });
    if (filters.status) query.set('status', filters.status);
    if (filters.enrichment) query.set('enrichmentStatus', filters.enrichment);
    if (filters.from) query.set('from', startOfLocalDay(filters.from));
    if (filters.to) query.set('to', endOfLocalDay(filters.to));
    const cursor = cursorStack[index];
    if (cursor) query.set('cursor', cursor);
    try {
      const result = await api<EventPage>(`events?${query}`);
      if (current !== generation) return;
      page = result;
      if (result.nextCursor) cursorStack[index + 1] = result.nextCursor;
      else cursorStack = cursorStack.slice(0, index + 1);
      error = '';
    } catch (caught) {
      if (current !== generation) return;
      error = caught instanceof Error ? caught.message : 'Could not load messages';
    } finally {
      if (current === generation) {
        loading = false;
        renderList();
        renderPagination();
      }
    }
  }

  async function openDetail(eventId: string) {
    try {
      const detail = await api<EventView>(`events/${encodeURIComponent(eventId)}`);
      const input = (detail.input ?? {}) as EventInput;
      const parsed = detail.parsed as ParsedView | undefined;
      const content = el('div', { class: 'detail-stack' });
      content.append(
        el(
          'div',
          { class: 'detail-summary' },
          el(
            'div',
            { class: 'detail-status' },
            badge(statusLabel(detail.status), statusTone(detail.status)),
            el('span', { class: 'muted small', text: formatExact(detail.createdAt) }),
          ),
          copyButton(detail.eventId, 'Copy event ID'),
        ),
        definitionList([
          ['Event ID', el('span', { class: 'mono', text: detail.eventId })],
          ['Created', formatExact(detail.createdAt)],
          ['Updated', formatExact(detail.updatedAt)],
          ['Attempts', formatNumber(detail.attempts)],
          ['Parser reason', reasonLabel(detail.parserReason) || '—'],
          ['Enrichment', detail.enrichmentStatus ?? '—'],
          ['Actual transaction', detail.actualTransactionId ?? '—'],
        ]),
      );
      if (input.message) {
        content.append(
          el(
            'section',
            { class: 'detail-section' },
            el('h3', { text: 'Original input' }),
            definitionList([
              ['Sender', input.sender ?? '—'],
              ['Received', input.receivedAt ? formatExact(input.receivedAt) : '—'],
              [
                'Location',
                input.location ? `${input.location.latitude}, ${input.location.longitude}` : '—',
              ],
            ]),
            el('div', { class: 'raw-message' }, userText(input.message, true)),
          ),
        );
      }
      if (parsed) {
        const rows: [string, string | Node][] = [
          ['Bank', parsed.bank ?? '—'],
          ['Kind', kindLabel(parsed.kind ?? '')],
          ['Amount', formatAmount(parsed.amountCents)],
          ['Fee', formatAmount(parsed.feeCents ?? 0)],
          ['Payee', parsed.payee ?? '—'],
          ['Occurred', parsed.occurredAt ? formatExact(parsed.occurredAt) : '—'],
          ['Account alias', parsed.accountAlias ?? '—'],
          ['Balance', parsed.balanceCents !== undefined ? formatAmount(parsed.balanceCents) : '—'],
        ];
        if (parsed.foreign)
          rows.push([
            'Foreign amount',
            `${parsed.foreign.currency ?? ''} ${formatNumber(parsed.foreign.amount)}`.trim(),
          ]);
        if (parsed.transferCounterpartyAlias)
          rows.push(['Counterparty', parsed.transferCounterpartyAlias]);
        if (parsed.billPaymentIdentifier)
          rows.push(['Bill payment identifier', parsed.billPaymentIdentifier]);
        if (parsed.note) rows.push(['Note', userText(parsed.note)]);
        content.append(
          el(
            'section',
            { class: 'detail-section' },
            el('h3', { text: 'Parsed transaction' }),
            definitionList(rows),
          ),
        );
      }
      if (detail.suggestion) {
        content.append(
          el(
            'section',
            { class: 'detail-section' },
            el('h3', { text: 'Category suggestion' }),
            el('pre', { class: 'raw-json', text: JSON.stringify(detail.suggestion, null, 2) }),
          ),
        );
      }
      if (detail.enrichmentAttempts.length) {
        content.append(
          el(
            'section',
            { class: 'detail-section' },
            el('h3', { text: 'Enrichment attempts' }),
            el(
              'div',
              { class: 'timeline' },
              ...detail.enrichmentAttempts.map(item =>
                el(
                  'div',
                  { class: 'timeline-item' },
                  el('span', { class: 'timeline-dot' }),
                  el(
                    'div',
                    {},
                    el('strong', { text: item.status }),
                    el('span', { class: 'muted small block', text: formatExact(item.createdAt) }),
                    el('pre', { class: 'raw-json', text: JSON.stringify(item.details, null, 2) }),
                  ),
                ),
              ),
            ),
          ),
        );
      }
      if (detail.history.length) {
        content.append(
          el(
            'section',
            { class: 'detail-section' },
            el('h3', { text: 'Processing history' }),
            el(
              'div',
              { class: 'timeline' },
              ...detail.history.map(item =>
                el(
                  'div',
                  { class: 'timeline-item' },
                  el('span', { class: 'timeline-dot' }),
                  el(
                    'div',
                    {},
                    el('strong', { text: `${item.fromStatus ?? 'new'} → ${item.toStatus}` }),
                    el('span', { class: 'muted small block', text: formatExact(item.createdAt) }),
                    el('pre', { class: 'raw-json', text: JSON.stringify(item.details, null, 2) }),
                  ),
                ),
              ),
            ),
          ),
        );
      }
      content.append(
        el(
          'details',
          { class: 'detail-raw' },
          el('summary', { text: 'Raw input and parsed JSON' }),
          el('pre', {
            class: 'raw-json',
            text: JSON.stringify({ input: detail.input, parsed: detail.parsed }, null, 2),
          }),
        ),
      );
      openSheet({
        title: 'Message detail',
        description: 'Authenticated content. Do not share message bodies casually.',
        content,
        wide: true,
      });
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not load message', 'danger');
    }
  }

  renderList();
  renderPagination();
  await load(0);
  return () => {
    generation++;
  };
}
