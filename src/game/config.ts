declare global {
  interface Window {
    UNSTABLE_TRUCK_API?: string;
    UNSTABLE_TRUCK_SHARE_URL?: string;
    UNSTABLE_TRUCK_SRC?: string;
  }
}

/** Resolves the base URL all API calls are built from.
 *
 * On the same-origin deploy (lewistrick.com/unstable-truck/) the document's own
 * directory is the right answer, identical to the pre-config behaviour. On itch
 * (or any other third-party embed) window.UNSTABLE_TRUCK_API overrides it to
 * point at the real backend.
 *
 * Trailing-slash normalisation matters: without it,
 * `new URL("api/runs", "https://x/unstable-truck")` silently resolves to
 * `https://x/api/runs` — the sub-path is eaten. */
export function resolveApiRoot(): URL {
  const override = window.UNSTABLE_TRUCK_API;
  if (override) {
    const base = override.endsWith("/") ? override : override + "/";
    return new URL(base);
  }
  return new URL(".", document.baseURI);
}

export function resolveShareUrl(): string | null {
  return window.UNSTABLE_TRUCK_SHARE_URL ?? null;
}

export function resolveSourceTag(): string | null {
  return window.UNSTABLE_TRUCK_SRC ?? null;
}

export function isEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    // Blocked cross-origin access to window.top — definitely embedded.
    return true;
  }
}
