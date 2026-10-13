// Hash routes, e.g. #/posts/abc, #/clients/abc?pick=xyz.
import { useSyncExternalStore } from 'react';

export interface Route {
  parts: string[];
  query: URLSearchParams;
}

export function parseRoute(hash: string): Route {
  const [path, q = ''] = hash.replace(/^#\/?/, '').split('?');
  return { parts: path.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q) };
}

export function navigate(href: string): void {
  if (window.location.hash !== href) window.location.hash = href;
}

const subscribe = (cb: () => void) => {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
};

export function useRoute(): Route {
  return parseRoute(useSyncExternalStore(subscribe, () => window.location.hash));
}
