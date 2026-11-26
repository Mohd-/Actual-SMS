import { api } from '../api.js';
import type { StatusView } from '../../contracts.js';
import {
  alertBox,
  badge,
  button,
  card,
  cardHead,
  emptyState,
  loadingBlock,
  pageHeader,
  toast,
} from '../components.js';
import { el, icon } from '../dom.js';
import {
  formatExact,
  formatNumber,
  formatRelative,
  statusMeta,
  statusOrder,
  type Tone,
} from '../format.js';

export async function renderStatus(host: HTMLElement) {
  const screen = el('section', { class: 'screen' });
  host.append(screen);
  let loading = false;
  let lastLoaded = 0;
  let data: StatusView | undefined;
  let errorMessage = '';

  const render = () => {
    const scroll = (screen.closest('.content') as HTMLElement | null)?.scrollTop ?? 0;
    screen.replaceChildren();
    if (!data) {
      screen.append(pageHeader({ title: 'Overview', eyebrow: 'Importer' }), loadingBlock(6));
      return;
    }
    const ready = data.ready;
    const changing = data.changing;
    const connectionTone: Tone = changing ? 'warning' : ready ? 'positive' : 'danger';
    const connectionLabel = changing ? 'Updating' : ready ? 'Ready' : 'Paused';
    const counts = new Map(data.counts.map(item => [item.status, item.count]));
    const total = data.counts.reduce((sum, item) => sum + item.count, 0);
    const actions = [
      button('Refresh', { kind: 'ghost', icon: 'refresh', onClick: () => void load(true) }),
      button('Reconnect Actual', {
        kind: 'secondary',
        icon: 'link',
        disabled: changing,
        onClick: () => void reconnect(),
      }),
    ];
    const queue = el('div', { class: 'queue-list' });
    for (const status of statusOrder) {
      const count = counts.get(status) ?? 0;
      const meta = statusMeta[status];
      const href = `#/events?status=${status}`;
      queue.append(
        el(
          'a',
          { class: 'queue-row', href },
          el(
            'span',
            { class: 'queue-label' },
            badge(meta.label, meta.tone),
            el('span', { text: meta.description }),
          ),
          el('strong', { text: formatNumber(count) }),
        ),
      );
    }
    const bar = el('div', {
      class: 'queue-bar',
      role: 'img',
      'aria-label': `${formatNumber(total)} events by status`,
    });
    for (const status of statusOrder) {
      const count = counts.get(status) ?? 0;
      if (!count || !total) continue;
      const segment = el('span', {
        class: `queue-segment tone-${statusMeta[status].tone}`,
        title: `${statusMeta[status].label}: ${count}`,
      });
      bar.append(segment);
    }
    if (!total) bar.append(el('span', { class: 'queue-segment tone-neutral', title: 'No events' }));

    const connection = card(
      cardHead('Connection', 'Actual credentials stay in the deployment environment.'),
      el(
        'div',
        { class: 'metric-row' },
        el(
          'div',
          { class: 'metric' },
          el('span', { class: 'metric-label', text: 'State' }),
          el('div', { class: 'metric-value' }, badge(connectionLabel, connectionTone)),
        ),
        el(
          'div',
          { class: 'metric' },
          el('span', { class: 'metric-label', text: 'Active revision' }),
          el(
            'div',
            { class: 'metric-value mono' },
            data.activeRevision ? data.activeRevision.slice(0, 12) : 'Not active',
          ),
        ),
        el(
          'div',
          { class: 'metric' },
          el('span', { class: 'metric-label', text: 'Last checked' }),
          el('div', { class: 'metric-value' }, lastLoaded ? formatRelative(lastLoaded) : '—'),
        ),
      ),
      data.error ? alertBox(data.error, 'danger', 'Recovery needed') : null,
    );

    screen.append(
      pageHeader({
        title: 'Overview',
        eyebrow: 'Importer',
        description: 'Readiness, queue health, and the configured Actual connection.',
        actions,
      }),
      el(
        'div',
        { class: `hero-status hero-${connectionTone}` },
        el(
          'div',
          { class: 'hero-main' },
          el('span', { class: 'hero-icon' }, icon(ready ? 'check' : 'alert', 24)),
          el(
            'div',
            {},
            el('p', { class: 'eyebrow', text: 'Import status' }),
            el('h2', {
              text: ready
                ? 'Imports are running'
                : changing
                  ? 'Applying changes'
                  : 'Imports are paused',
            }),
            el('p', {
              text: ready
                ? 'The queue is being processed and Actual is connected.'
                : (data.error ?? 'Finish the recovery action below, then refresh this page.'),
            }),
          ),
        ),
        el(
          'div',
          { class: 'hero-side' },
          badge(connectionLabel, connectionTone),
          el('span', { class: 'mono small', text: `Updated ${formatRelative(lastLoaded)}` }),
        ),
      ),
      data.payeeMigrationPending
        ? alertBox(
            'Payee migration is waiting for a successful Actual connection. SMS messages remain queued.',
            'warning',
            'Migration pending',
          )
        : el('span', { hidden: true }),
      errorMessage ? alertBox(errorMessage, 'danger') : el('span', { hidden: true }),
      el(
        'div',
        { class: 'grid two' },
        card(
          cardHead('Queue', `${formatNumber(total)} retained event${total === 1 ? '' : 's'}`),
          bar,
          queue,
          total
            ? null
            : emptyState('events', 'No events yet', 'New SMS messages will appear in the audit.'),
        ),
        connection,
      ),
      el(
        'div',
        { class: 'footer-note' },
        el('span', {
          text: data.activeRevision ? 'Configuration active' : 'No active configuration',
        }),
        el('span', { text: `Checked ${formatExact(lastLoaded)}` }),
      ),
    );
    const content = screen.closest('.content') as HTMLElement | null;
    if (content) content.scrollTop = scroll;
  };

  async function load(silent = false) {
    if (loading) return;
    if (document.hidden && silent) return;
    loading = true;
    if (!silent) render();
    try {
      data = await api<StatusView>('status');
      lastLoaded = Date.now();
      errorMessage = '';
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Could not load status';
      if (!data) render();
    } finally {
      loading = false;
      render();
    }
  }

  async function reconnect() {
    try {
      await api('reconnect', {});
      toast('Actual session reconnected', 'positive');
      await load(true);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Reconnect failed', 'danger');
    }
  }

  const visibility = () => {
    if (!document.hidden) void load(true);
  };
  document.addEventListener('visibilitychange', visibility);
  await load();
  const timer = window.setInterval(() => void load(true), 10_000);
  render();
  return () => {
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', visibility);
  };
}
