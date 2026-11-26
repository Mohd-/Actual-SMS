export type Page = 'status' | 'events' | 'payees' | 'config' | 'tasker';
export type ConfigSection = 'accounts' | 'banks' | 'parsing';
export interface Route {
  page: Page;
  section?: ConfigSection;
  query: URLSearchParams;
}
export const defaultRoute = '#/status';
const configSections: ConfigSection[] = ['accounts', 'banks', 'parsing'];
export function parseRoute(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [path = '/status', search = ''] = raw.split('?', 2);
  const parts = path.split('/').filter(Boolean);
  const page = parts[0] as Page | undefined;
  if (page === 'events' || page === 'payees' || page === 'tasker')
    return { page, query: new URLSearchParams(search) };
  if (page === 'config') {
    const candidate = parts[1] as ConfigSection | undefined;
    return {
      page: 'config',
      section: candidate && configSections.includes(candidate) ? candidate : 'accounts',
      query: new URLSearchParams(search),
    };
  }
  return { page: 'status', query: new URLSearchParams(search) };
}
export function routeHref(route: Route) {
  const path = route.page === 'config' ? `config/${route.section ?? 'accounts'}` : route.page;
  const search = route.query.toString();
  return `#/${path}${search ? `?${search}` : ''}`;
}
export function pageTitle(route: Route) {
  if (route.page === 'status') return 'Overview';
  if (route.page === 'events') return 'SMS audit';
  if (route.page === 'payees') return 'Payees';
  if (route.page === 'tasker') return 'Phone setup';
  return route.section === 'banks'
    ? 'Banks'
    : route.section === 'parsing'
      ? 'Recognition'
      : 'Routing';
}
export function routeKey(route: Route) {
  return `${route.page}/${route.section ?? ''}`;
}
