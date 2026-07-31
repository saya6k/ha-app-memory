# ha-app-memory

Source repo for the **Memory** Home Assistant app — a personal fact memory for
Assist conversation agents, exposed over MCP (streamable HTTP) with vector
semantic search.

Embeddings are produced by a local [llama.cpp](https://github.com/ggml-org/llama.cpp)
sidecar running [Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF),
so nothing leaves the machine and no API key is needed. Search works across
languages: a fact stored in Korean is found by an English question about the
same thing.

Install it from the [saya6k/ha-apps](https://github.com/saya6k/ha-apps)
catalog. This repo carries the source, Dockerfile, and CI; the catalog carries
the metadata.

- App docs: [memory/DOCS.md](memory/DOCS.md)
- Design spec: [SPEC.md](SPEC.md)

## Tools

`save`, `get`, `search`, `similar`, `update`, `delete` — Home Assistant
namespaces them per server, so the model sees them as `memory__search` and so
on.

## Development

```sh
cd memory
npm ci
npm run typecheck && npm run lint && npm test
```

The unit tests need neither a model nor a GPU. For the full container
round-trip against the real embedding sidecar:

```sh
sh scripts/smoke.sh            # builds the image first
sh scripts/smoke.sh <image>    # or reuse one CI already built
```
