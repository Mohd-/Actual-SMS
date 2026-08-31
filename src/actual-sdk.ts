type ActualApi = typeof import('@actual-app/api');

let api: Promise<ActualApi> | undefined;

export function loadActualApi(): Promise<ActualApi> {
  // Actual 26.5.2 reads the browser navigator during module evaluation even in
  // its supported Node 20 environment.
  if (!('navigator' in globalThis)) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { platform: 'linux', userAgent: 'node' },
      configurable: true,
    });
  }
  return (api ??= import('@actual-app/api'));
}
