import { safeFetch } from '../network/fetch.js';
import type { SearchProvider } from './types.js';

// Keenable search: https://docs.keenable.ai/api-reference/search
// Without a key it uses the public endpoint, which needs an X-Keenable-Title
// header and is rate limited per IP. A key switches to the keyed endpoint.
const PUBLIC_URL = 'https://api.keenable.ai/v1/search/public';
const KEYED_URL = 'https://api.keenable.ai/v1/search';
const MAX_RESULTS = 50;

/**
 * Opt-in only: picked by `provider: "keenable"` or `defaultProvider`, never by
 * the auto chain. It needs no key, so `isAvailable` is always true and it
 * would otherwise jump ahead of the DuckDuckGo fallback.
 */
export const KeenableProvider: SearchProvider = {
  id: 'keenable',
  name: 'Keenable',
  isAvailable: () => true,
  search: async (query, options, config) => {
    const apiKey = config.keenableApiKey ?? process.env.KEENABLE_API_KEY;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Keenable-Title': 'pi-archimedes',
    };
    if (apiKey) headers['X-API-Key'] = apiKey;

    const numResults = Math.min(Math.max(options.numResults ?? 5, 1), MAX_RESULTS);
    const response = await safeFetch(
      apiKey ? KEYED_URL : PUBLIC_URL,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, max_results: numResults }),
      },
      { proxy: options.proxy, signal: options.signal, maxRedirects: 0 },
    );

    if (!response.ok) {
      throw new Error(`[keenable] error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return (data.results ?? [])
      .filter((r: any) => typeof r?.url === 'string' && r.url)
      .map((r: any) => ({
        url: r.url,
        title: r.title ?? '',
        snippet: r.snippet ?? '',
        ...(typeof r.published_at === 'string' && { publishedDate: r.published_at }),
      }));
  },
};
