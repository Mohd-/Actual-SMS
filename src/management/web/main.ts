import { ApiError, api, onUnauthorized } from './api.js';
import {
  alertBox,
  button,
  card,
  cardHead,
  confirmDialog,
  field,
  iconButton,
} from './components.js';
import { clear, el, icon } from './dom.js';
import { hasUnsavedChanges, installBeforeUnload, setDirtyGuard } from './state.js';
import { pageTitle, parseRoute, routeHref, type Route } from './router.js';
import { renderStatus } from './screens/status.js';
import { renderEvents } from './screens/events.js';
import { renderPayees } from './screens/payees.js';
import { renderAccounts, renderBanks, renderParsing } from './screens/config.js';
import { renderTasker } from './screens/tasker.js';

interface NavItem {
  href: string;
  label: string;
  icon: Parameters<typeof icon>[0];
}
const navItems: NavItem[] = [
  { href: '#/status', label: 'Overview', icon: 'overview' },
  { href: '#/events', label: 'SMS audit', icon: 'events' },
  { href: '#/payees', label: 'Payees', icon: 'payees' },
  { href: '#/config/accounts', label: 'Routing', icon: 'routing' },
  { href: '#/config/banks', label: 'Banks', icon: 'banks' },
  { href: '#/config/parsing', label: 'Recognition', icon: 'recognition' },
  { href: '#/tasker', label: 'Phone setup', icon: 'phone' },
];

const root = document.getElementById('app')!;
let signedIn = false;
let cleanup: (() => void) | undefined;
let currentHash = location.hash || '#/status';
let routeGeneration = 0;
let changingRoute = false;
let passwordInput: HTMLInputElement | undefined;
let loginError: HTMLElement | undefined;
let shell: HTMLElement | undefined;
let contentHost: HTMLElement | undefined;
let navLinks: HTMLAnchorElement[] = [];
let menu: HTMLElement | undefined;

function closeDialogs() {
  for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) dialog.close();
}

function setDocumentTitle(route: Route) {
  document.title = `${pageTitle(route)} · Actual SMS`;
}

function showLogin(message?: string) {
  signedIn = false;
  routeGeneration++;
  setDirtyGuard();
  cleanup?.();
  cleanup = undefined;
  closeDialogs();
  if (shell) shell.hidden = true;
  clear(root);
  shell = undefined;
  contentHost = undefined;
  menu = undefined;
  navLinks = [];
  const error = el('div', { class: 'auth-error' });
  loginError = error;
  if (message) error.append(alertBox(message, 'warning'));
  const password = el('input', {
    id: 'password',
    type: 'password',
    autocomplete: 'current-password',
    required: true,
    maxlength: '72',
    placeholder: 'Management password',
  });
  passwordInput = password;
  const submit = button('Sign in', { kind: 'primary', type: 'submit' });
  const form = el(
    'form',
    { class: 'auth-form', on: { submit: event => event.preventDefault() } },
    field('Management password', password),
    submit,
    error,
  );
  form.addEventListener('submit', () => void login());
  const page = el(
    'main',
    { id: 'main', class: 'auth-page' },
    el(
      'div',
      { class: 'auth-brand' },
      el('span', { class: 'brand-mark' }, icon('recognition', 24)),
      el('span', { class: 'brand-name', text: 'Actual SMS' }),
      el('span', { class: 'brand-sub', text: 'Management console' }),
    ),
    card(cardHead('Sign in', 'Use the management password configured for this deployment.'), form),
    el('p', {
      class: 'auth-footnote',
      text: 'Sessions expire after eight hours. Credentials are never stored in this browser.',
    }),
  );
  root.append(page);
  setDocumentTitle({ page: 'status', query: new URLSearchParams() });
  requestAnimationFrame(() => password.focus());
}

async function login() {
  if (!passwordInput) return;
  const value = passwordInput.value;
  if (!value) return;
  const form = passwordInput.closest('form') as HTMLFormElement | null;
  const submit = form?.querySelector('button[type="submit"]') as HTMLButtonElement | null;
  if (submit) submit.disabled = true;
  try {
    await api('login', { password: value });
    passwordInput.value = '';
    signedIn = true;
    showApp();
    await renderRoute();
  } catch (caught) {
    if (loginError) {
      loginError.replaceChildren(
        alertBox(
          caught instanceof ApiError && caught.status === 429
            ? 'Too many attempts. Wait a minute and try again.'
            : caught instanceof Error
              ? caught.message
              : 'Sign in failed',
          caught instanceof ApiError && caught.status === 429 ? 'warning' : 'danger',
        ),
      );
    }
    passwordInput?.focus();
  } finally {
    if (submit) submit.disabled = false;
  }
}

function buildShell() {
  const sidebarNav = el('nav', { class: 'sidebar-nav', 'aria-label': 'Management sections' });
  for (const item of navItems) {
    const link = el(
      'a',
      { href: item.href, class: 'nav-link', dataset: { route: item.href } },
      icon(item.icon, 18),
      el('span', { text: item.label }),
    );
    sidebarNav.append(link);
  }
  const footer = el(
    'div',
    { class: 'sidebar-footer' },
    button('Sign out', { kind: 'ghost', icon: 'logout', onClick: () => void signOut() }),
    button('Sign out all sessions', {
      kind: 'ghost',
      onClick: () => void revokeAll(),
    }),
  );
  const sidebar = el(
    'aside',
    { class: 'sidebar' },
    el(
      'div',
      { class: 'brand' },
      el('span', { class: 'brand-mark' }, icon('recognition', 20)),
      el('div', {}, el('strong', { text: 'Actual SMS' }), el('span', { text: 'Management' })),
    ),
    sidebarNav,
    footer,
  );
  const mobileBar = el(
    'header',
    { class: 'mobile-bar' },
    iconButton('menu', 'Open navigation', () => toggleMenu()),
    el('span', { class: 'mobile-title', text: 'Actual SMS' }),
    el('span', { class: 'mobile-status' }, icon('lock', 15)),
  );
  contentHost = el('div', { class: 'content' });
  const main = el('main', { id: 'main', class: 'main-area' }, mobileBar, contentHost);
  menu = el(
    'div',
    { class: 'mobile-menu', hidden: true },
    el(
      'div',
      { class: 'mobile-menu-panel' },
      el(
        'div',
        { class: 'mobile-menu-head' },
        el('strong', { text: 'Navigate' }),
        iconButton('close', 'Close navigation', () => toggleMenu(false)),
      ),
      el(
        'nav',
        { class: 'mobile-nav', 'aria-label': 'Mobile management sections' },
        ...navItems.map(item =>
          el(
            'a',
            {
              href: item.href,
              class: 'nav-link',
              dataset: { route: item.href },
              on: { click: () => toggleMenu(false) },
            },
            icon(item.icon, 18),
            el('span', { text: item.label }),
          ),
        ),
      ),
      el(
        'div',
        { class: 'mobile-menu-footer' },
        button('Sign out', { kind: 'ghost', icon: 'logout', onClick: () => void signOut() }),
        button('Sign out all sessions', { kind: 'ghost', onClick: () => void revokeAll() }),
      ),
    ),
  );
  menu.addEventListener('click', event => {
    if (event.target === menu) toggleMenu(false);
  });
  shell = el('div', { class: 'app-shell', hidden: true }, sidebar, main, menu);
  root.append(shell);
  navLinks = [...shell.querySelectorAll<HTMLAnchorElement>('.nav-link')];
}

function toggleMenu(open = menu?.hidden ?? true) {
  if (!menu) return;
  menu.hidden = !open;
  document.body.classList.toggle('menu-open', open);
  if (open) menu.querySelector<HTMLAnchorElement>('a')?.focus();
}

function showApp() {
  if (!shell) buildShell();
  clear(root);
  root.append(shell!);
  shell!.hidden = false;
  menu!.hidden = true;
  document.body.classList.remove('menu-open');
}

function updateActive(route: Route) {
  const key = routeHref(route);
  for (const link of navLinks) {
    const active =
      link.dataset.route === key ||
      (route.page === 'events' && link.dataset.route === '#/events') ||
      (route.page === 'config' && link.dataset.route === `#/config/${route.section ?? 'accounts'}`);
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

async function screenFor(route: Route, host: HTMLElement) {
  if (route.page === 'status') return renderStatus(host);
  if (route.page === 'events') return renderEvents(host, route.query);
  if (route.page === 'payees') return renderPayees(host);
  if (route.page === 'tasker') return renderTasker(host);
  if (route.section === 'banks') return renderBanks(host);
  if (route.section === 'parsing') return renderParsing(host);
  return renderAccounts(host);
}

async function renderRoute() {
  if (!signedIn || !contentHost) return;
  const generation = ++routeGeneration;
  cleanup?.();
  cleanup = undefined;
  closeDialogs();
  setDirtyGuard();
  const route = parseRoute(location.hash);
  currentHash = routeHref(route);
  updateActive(route);
  setDocumentTitle(route);
  clear(contentHost);
  try {
    const result = await screenFor(route, contentHost);
    if (generation !== routeGeneration) {
      result?.();
      return;
    }
    cleanup = result;
    const heading = contentHost.querySelector<HTMLElement>('h1');
    heading?.focus({ preventScroll: true });
  } catch (caught) {
    if (generation !== routeGeneration) return;
    contentHost.append(
      alertBox(caught instanceof Error ? caught.message : 'Could not load this page', 'danger'),
    );
  }
}

async function signOut() {
  try {
    await api('logout', {});
  } finally {
    showLogin();
  }
}

async function revokeAll() {
  const confirmed = await confirmDialog({
    title: 'Sign out every browser session?',
    body: 'All management sessions will be revoked. This browser will also be signed out.',
    confirmLabel: 'Sign out all sessions',
    tone: 'danger',
  });
  if (!confirmed) return;
  try {
    await api('sessions/revoke', {});
  } finally {
    showLogin();
  }
}

async function handleHashChange() {
  if (!signedIn) return;
  if (changingRoute) return;
  const next = location.hash || '#/status';
  if (hasUnsavedChanges() && next !== currentHash) {
    changingRoute = true;
    const confirmed = await confirmDialog({
      title: 'Discard unsaved changes?',
      body: 'This page has unsaved configuration changes. Leaving now will discard the draft.',
      confirmLabel: 'Discard and leave',
      tone: 'danger',
    });
    changingRoute = false;
    if (!confirmed) {
      history.replaceState(null, '', currentHash);
      return;
    }
    setDirtyGuard();
  }
  currentHash = next;
  await renderRoute();
}

onUnauthorized(() => {
  if (signedIn) showLogin('Your management session expired. Sign in again.');
});

installBeforeUnload();
window.addEventListener('hashchange', () => void handleHashChange());

async function boot() {
  if (!location.hash) history.replaceState(null, '', '#/status');
  try {
    await api('status');
    signedIn = true;
    showApp();
    await renderRoute();
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 401) showLogin();
    else showLogin(caught instanceof Error ? caught.message : 'Could not reach the service');
  }
}

void boot();
