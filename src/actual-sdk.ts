type ActualApi = typeof import('@actual-app/api');

let api: Promise<ActualApi> | undefined;

export function loadActualApi(): Promise<ActualApi> {
  // Supply browser-platform detection only when the runtime lacks navigator.
  if (!('navigator' in globalThis)) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { platform: 'linux', userAgent: 'node' },
      configurable: true,
    });
  }
  return (api ??= import('@actual-app/api'));
}
