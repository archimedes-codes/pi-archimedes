import { describe, it, expect, vi, afterEach } from 'vitest';
import { KeenableProvider } from './keenable.js';
import { resolveProvider } from './registry.js';
import * as fetchModule from '../network/fetch.js';

const ok = (body: unknown) =>
  ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as any;

describe('KeenableProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('uses the public endpoint with the title header when no key is set', async () => {
    vi.stubEnv('KEENABLE_API_KEY', '');
    const spy = vi.spyOn(fetchModule, 'safeFetch').mockResolvedValue(
      ok({
        results: [
          { title: 'A', url: 'https://a.example', snippet: 'about a', published_at: '2026-11-01T00:00:00Z' },
          { title: 'no url' },
        ],
      }),
    );

    const results = await KeenableProvider.search('q', { numResults: 3 }, {});

    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('https://api.keenable.ai/v1/search/public');
    const headers = init!.headers as Record<string, string>;
    expect(headers['X-Keenable-Title']).toBe('pi-archimedes');
    expect(headers['X-API-Key']).toBeUndefined();
    expect(JSON.parse(init!.body as string)).toEqual({ query: 'q', max_results: 3 });
    expect(results).toEqual([
      { url: 'https://a.example', title: 'A', snippet: 'about a', publishedDate: '2026-11-01T00:00:00Z' },
    ]);
  });

  it('uses the keyed endpoint and does not follow redirects when a key is set', async () => {
    const spy = vi.spyOn(fetchModule, 'safeFetch').mockResolvedValue(ok({ results: [] }));

    await KeenableProvider.search('q', {}, { keenableApiKey: 'k' });

    const [url, init, opts] = spy.mock.calls[0]!;
    expect(url).toBe('https://api.keenable.ai/v1/search');
    expect((init!.headers as Record<string, string>)['X-API-Key']).toBe('k');
    expect(opts?.maxRedirects).toBe(0);
  });

  it('throws on a non-OK response', async () => {
    vi.spyOn(fetchModule, 'safeFetch').mockResolvedValue({ ok: false, status: 429, statusText: 'Too Many Requests' } as any);
    await expect(KeenableProvider.search('q', {}, {})).rejects.toThrow('[keenable] error: 429');
  });
});

describe('Keenable in the registry', () => {
  it('is picked by id', () => {
    expect(resolveProvider('keenable', {}).id).toBe('keenable');
  });

  it('is picked by defaultProvider', () => {
    expect(resolveProvider(undefined, { defaultProvider: 'keenable' }).id).toBe('keenable');
  });

  it('is never picked by the auto chain', () => {
    vi.stubEnv('BRAVE_API_KEY', '');
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.stubEnv('PERPLEXITY_API_KEY', '');
    vi.stubEnv('SEARXNG_URL', '');
    expect(resolveProvider(undefined, {}).id).toBe('duckduckgo');
    expect(resolveProvider(undefined, { defaultProvider: 'auto' }).id).toBe('duckduckgo');
    vi.unstubAllEnvs();
  });
});
