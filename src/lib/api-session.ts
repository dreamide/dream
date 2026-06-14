import { getDesktopApi } from "./electron";

export const API_SESSION_TOKEN_HEADER = "x-dream-api-token";

export function getApiSessionToken(): string | null {
  return getDesktopApi()?.apiSessionToken ?? null;
}

function getRequestUrlString(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}

function isSameOriginApiRequest(urlString: string): boolean {
  let url: URL;
  try {
    url = new URL(urlString, window.location.href);
  } catch {
    return false;
  }

  return (
    url.origin === window.location.origin && url.pathname.startsWith("/api/")
  );
}

function setHeader(
  headers: HeadersInit | undefined,
  name: string,
  value: string,
): HeadersInit {
  if (headers instanceof Headers) {
    const merged = new Headers(headers);
    merged.set(name, value);
    return merged;
  }

  if (Array.isArray(headers)) {
    return [...headers, [name, value]];
  }

  return { ...(headers ?? {}), [name]: value };
}

/**
 * Patches `window.fetch` so that same-origin `/api/*` requests automatically
 * include the per-launch API session token header. This is installed once at
 * renderer startup; existing fetch call sites do not need to change.
 */
export function installApiSessionGuard(): void {
  if (typeof window === "undefined") {
    return;
  }

  const originalFetch = window.fetch;

  window.fetch = (input, init) => {
    const token = getApiSessionToken();
    if (!token) {
      return originalFetch(input, init);
    }

    const urlString = getRequestUrlString(input);
    if (!isSameOriginApiRequest(urlString)) {
      return originalFetch(input, init);
    }

    const headers =
      init?.headers ?? (input instanceof Request ? input.headers : undefined);

    return originalFetch(input, {
      ...init,
      headers: setHeader(headers, API_SESSION_TOKEN_HEADER, token),
    });
  };
}
