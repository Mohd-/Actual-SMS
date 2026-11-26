export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let unauthorizedHandler: (() => void) | undefined;
export function onUnauthorized(handler: () => void) {
  unauthorizedHandler = handler;
}

export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/management/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  let result: unknown = {};
  if (text) {
    try {
      result = JSON.parse(text);
    } catch {
      result = { error: text };
    }
  }
  if (!response.ok) {
    if (response.status === 401) unauthorizedHandler?.();
    const message =
      typeof result === 'object' && result && 'error' in result
        ? String(result.error)
        : 'Request failed';
    throw new ApiError(response.status, message, result);
  }
  return result as T;
}

export async function download(path: string, body: unknown, filename: string) {
  const response = await fetch(`/management/${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status === 401) unauthorizedHandler?.();
  if (!response.ok) {
    const text = await response.text();
    let message = 'Download failed';
    try {
      const result = JSON.parse(text) as { error?: unknown };
      if (typeof result.error === 'string') message = result.error;
    } catch {
      message = 'Download failed';
    }
    throw new ApiError(response.status, message);
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
