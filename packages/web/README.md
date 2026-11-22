# @pi-archimedes/web

Web search and content extraction package for the Pi Archimedes agent.

## Tools

- `web_search`: Search the web using configured providers (Brave, Tavily, Perplexity, OpenAI, SearXNG, DuckDuckGo, and opt-in Keenable).
- `fetch_content`: Extract readable content from URLs, with specialized handlers for GitHub, YouTube, and PDFs.
- `get_search_content`: Retrieve and optionally search through cached search/fetch results.

## Configuration

Settings are read from `~/.pi/agent/settings.json` under the `archimedes.web` namespace, or via environment variables:

- `braveApiKey` / `BRAVE_API_KEY`
- `tavilyApiKey` / `TAVILY_API_KEY`
- `keenableApiKey` / `KEENABLE_API_KEY` (optional, see below)
- `openaiApiKey` / `OPENAI_API_KEY`
- `perplexityApiKey` / `PERPLEXITY_API_KEY`
- `searxngUrl` / `SEARXNG_URL`
- `proxy` / `HTTP_PROXY` / `HTTPS_PROXY`

### Keenable (opt-in)

[Keenable](https://keenable.ai) is never picked by the automatic Brave → Tavily → Perplexity → SearXNG → DuckDuckGo chain. Use it with `provider: "keenable"` on a `web_search` call, or set `"defaultProvider": "keenable"` under `archimedes.web`.

It works without a key: requests then go to Keenable's public endpoint, which is rate limited per IP. On its default data policy Keenable logs requests with the query, results and IP, with or without a key ([data and privacy](https://docs.keenable.ai/data-privacy)). Set `keenableApiKey` / `KEENABLE_API_KEY` to use the keyed endpoint and get higher limits.

## Features

- Multi-provider search routing.
- Cached content retrieval.
- Intelligent content extraction.
- Dynamic TUI rendering.
