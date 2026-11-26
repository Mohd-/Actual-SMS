export type Child = Node | string | number | null | undefined | false;
export type Props = {
  class?: string;
  text?: string;
  dataset?: Record<string, string>;
  on?: Record<string, (event: Event) => void>;
  [key: string]: unknown;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (name === 'class') node.className = String(value ?? '');
    else if (name === 'text') node.textContent = String(value ?? '');
    else if (name === 'dataset' && value && typeof value === 'object')
      for (const [key, item] of Object.entries(value as Record<string, string>))
        node.dataset[key] = item;
    else if (name === 'on' && value && typeof value === 'object')
      for (const [event, handler] of Object.entries(value as Record<string, (e: Event) => void>))
        node.addEventListener(event, handler);
    else if (value === undefined || value === null || value === false) continue;
    else if (name === 'list' || name === 'form') node.setAttribute(name, String(value));
    else if (name in node) (node as unknown as Record<string, unknown>)[name] = value;
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  append(node, ...children);
  return node;
}

export function append(parent: Node, ...children: Child[]) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(
      typeof child === 'string' || typeof child === 'number'
        ? document.createTextNode(String(child))
        : child,
    );
  }
  return parent;
}

export function clear(parent: Element) {
  parent.replaceChildren();
  return parent;
}

export function fragment(...children: Child[]) {
  return append(document.createDocumentFragment(), ...children);
}

type IconShape = {
  tag: 'path' | 'circle' | 'rect' | 'line' | 'polyline';
  attrs: Record<string, string>;
};
export type IconName = keyof typeof icons;
const icons: Record<string, IconShape[]> = {
  overview: [
    { tag: 'rect', attrs: { x: '3', y: '3', width: '7', height: '7', rx: '1.5' } },
    { tag: 'rect', attrs: { x: '14', y: '3', width: '7', height: '7', rx: '1.5' } },
    { tag: 'rect', attrs: { x: '3', y: '14', width: '7', height: '7', rx: '1.5' } },
    { tag: 'rect', attrs: { x: '14', y: '14', width: '7', height: '7', rx: '1.5' } },
  ],
  events: [
    { tag: 'path', attrs: { d: 'M4 6h16M4 12h16M4 18h10' } },
    { tag: 'circle', attrs: { cx: '20', cy: '18', r: '2' } },
  ],
  payees: [
    { tag: 'circle', attrs: { cx: '9', cy: '8', r: '3.5' } },
    { tag: 'path', attrs: { d: 'M2.5 20c0-3.2 3-5.5 6.5-5.5s6.5 2.3 6.5 5.5' } },
    { tag: 'path', attrs: { d: 'M17 8h5M19.5 5.5v5' } },
  ],
  routing: [
    { tag: 'circle', attrs: { cx: '5', cy: '6', r: '2' } },
    { tag: 'circle', attrs: { cx: '19', cy: '18', r: '2' } },
    { tag: 'path', attrs: { d: 'M7 6h5a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h8' } },
  ],
  banks: [
    { tag: 'path', attrs: { d: 'M3 9.5 12 4l9 5.5' } },
    { tag: 'path', attrs: { d: 'M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18' } },
  ],
  recognition: [
    { tag: 'path', attrs: { d: 'M4 7h10M18 7h2M4 17h2M10 17h10' } },
    { tag: 'circle', attrs: { cx: '16', cy: '7', r: '2' } },
    { tag: 'circle', attrs: { cx: '8', cy: '17', r: '2' } },
  ],
  phone: [
    { tag: 'rect', attrs: { x: '7', y: '2.5', width: '10', height: '19', rx: '2' } },
    { tag: 'path', attrs: { d: 'M11 18.5h2' } },
  ],
  menu: [{ tag: 'path', attrs: { d: 'M4 6h16M4 12h16M4 18h16' } }],
  close: [{ tag: 'path', attrs: { d: 'M6 6l12 12M18 6 6 18' } }],
  refresh: [
    { tag: 'path', attrs: { d: 'M20 6v5h-5' } },
    { tag: 'path', attrs: { d: 'M4 18v-5h5' } },
    { tag: 'path', attrs: { d: 'M6.2 9A7 7 0 0 1 18.5 7M17.8 15A7 7 0 0 1 5.5 17' } },
  ],
  alert: [
    { tag: 'path', attrs: { d: 'M12 3 2.5 20h19L12 3Z' } },
    { tag: 'path', attrs: { d: 'M12 9v5' } },
    { tag: 'circle', attrs: { cx: '12', cy: '17.5', r: '.7', fill: 'currentColor' } },
  ],
  check: [{ tag: 'polyline', attrs: { points: '4 12.5 9.5 18 20 6' } }],
  search: [
    { tag: 'circle', attrs: { cx: '11', cy: '11', r: '6.5' } },
    { tag: 'path', attrs: { d: 'm16 16 4.5 4.5' } },
  ],
  plus: [{ tag: 'path', attrs: { d: 'M12 5v14M5 12h14' } }],
  copy: [
    { tag: 'rect', attrs: { x: '8', y: '8', width: '12', height: '12', rx: '2' } },
    { tag: 'path', attrs: { d: 'M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2' } },
  ],
  trash: [
    { tag: 'path', attrs: { d: 'M4 7h16M10 11v6M14 11v6' } },
    { tag: 'path', attrs: { d: 'M6 7l1 14h10l1-14M9 7V4h6v3' } },
  ],
  link: [
    { tag: 'path', attrs: { d: 'M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2' } },
    { tag: 'path', attrs: { d: 'M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2' } },
  ],
  unlink: [
    { tag: 'path', attrs: { d: 'M9 15l-2 2a4 4 0 0 1-5.5-5.5l2-2' } },
    { tag: 'path', attrs: { d: 'M15 9l2-2a4 4 0 0 1 5.5 5.5l-2 2' } },
    { tag: 'path', attrs: { d: 'M4 4l16 16' } },
  ],
  chevron: [{ tag: 'polyline', attrs: { points: '8 10 12 14 16 10' } }],
  up: [{ tag: 'path', attrs: { d: 'M6 15l6-6 6 6' } }],
  down: [{ tag: 'path', attrs: { d: 'M6 9l6 6 6-6' } }],
  clock: [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '9' } },
    { tag: 'path', attrs: { d: 'M12 7v5l3 2' } },
  ],
  info: [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '9' } },
    { tag: 'path', attrs: { d: 'M12 11v5' } },
    { tag: 'circle', attrs: { cx: '12', cy: '8', r: '.7', fill: 'currentColor' } },
  ],
  arrowLeft: [{ tag: 'path', attrs: { d: 'M19 12H5M11 18l-6-6 6-6' } }],
  arrowRight: [{ tag: 'path', attrs: { d: 'M5 12h14M13 6l6 6-6 6' } }],
  download: [
    { tag: 'path', attrs: { d: 'M12 3v12M7 10l5 5 5-5' } },
    { tag: 'path', attrs: { d: 'M4 19h16' } },
  ],
  key: [
    { tag: 'circle', attrs: { cx: '8', cy: '8', r: '4' } },
    { tag: 'path', attrs: { d: 'm11 11 9 9M16 16l2-2M19 19l2-2' } },
  ],
  lock: [
    { tag: 'rect', attrs: { x: '5', y: '10', width: '14', height: '10', rx: '2' } },
    { tag: 'path', attrs: { d: 'M8 10V7a4 4 0 0 1 8 0v3' } },
  ],
  eye: [
    { tag: 'path', attrs: { d: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z' } },
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '2.5' } },
  ],
  eyeOff: [
    { tag: 'path', attrs: { d: 'M3 3l18 18' } },
    {
      tag: 'path',
      attrs: {
        d: 'M10.6 6.2A11 11 0 0 1 12 6c6.5 0 10 6 10 6a18 18 0 0 1-3 3.5M6.5 7.5A18 18 0 0 0 2 12s3.5 6 10 6a11 11 0 0 0 4-.7',
      },
    },
  ],
  logout: [
    { tag: 'path', attrs: { d: 'M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5' } },
    { tag: 'path', attrs: { d: 'M14 8l4 4-4 4M18 12H9' } },
  ],
  warning: [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '9' } },
    { tag: 'path', attrs: { d: 'M12 7v6' } },
    { tag: 'circle', attrs: { cx: '12', cy: '16.5', r: '.7', fill: 'currentColor' } },
  ],
};

export function icon(name: IconName, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const shape of icons[name] ?? []) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', shape.tag);
    for (const [key, value] of Object.entries(shape.attrs)) element.setAttribute(key, value);
    svg.appendChild(element);
  }
  return svg;
}

const rtlPattern = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/u;

export function directionOf(value: string): 'rtl' | 'ltr' {
  return rtlPattern.test(value) ? 'rtl' : 'ltr';
}

export function userText(value: string, block = false) {
  const container = el(block ? 'div' : 'span', { class: `user-text${block ? ' block' : ''}` });
  const lines = value.split('\n');
  lines.forEach((line, index) => {
    const dir = directionOf(line);
    container.append(
      el('span', {
        class: 'user-line',
        dir,
        lang: dir === 'rtl' ? 'ar' : 'en',
        text: line,
      }),
    );
    if (index < lines.length - 1) container.append(document.createTextNode('\n'));
  });
  return container;
}

export function setBusy(button: HTMLButtonElement, busy: boolean, label?: string) {
  button.disabled = busy;
  if (label) button.setAttribute('aria-label', label);
  button.classList.toggle('is-busy', busy);
}
