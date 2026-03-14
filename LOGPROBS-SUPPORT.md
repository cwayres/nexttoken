# Logprobs Support Research

## Key Finding

**All text generation models support logprobs.** Logprobs is an inference engine feature (llama.cpp, MLX, etc.), not a per-model capability. Any model that generates text produces logits as part of its forward pass, from which logprobs are derived. Neither Ollama nor LM Studio treat logprobs as a model-level capability — it is a runtime/engine feature.

The real issue is **which API endpoints expose logprobs**, not which models support them.

## Provider Endpoint Support

| Provider | Endpoint | Logprobs Support |
|----------|----------|-----------------|
| **OpenAI** | `/v1/chat/completions` | Yes — pass `logprobs: true` and `top_logprobs: N` |
| **LM Studio** | `/v1/chat/completions` | **No** — accepts the parameter without error but silently ignores it (returns no logprobs data). Confirmed by testing 100 models. |
| **LM Studio** | `/v1/responses` (Open Responses spec) | **Yes** — pass `include: ["message.output_text.logprobs"]` with optional `top_logprobs`. This is the only working LM Studio endpoint for logprobs. |
| **Ollama** | `/v1/chat/completions` (OpenAI-compat) | **No** — explicitly listed as unsupported in Ollama's OpenAI compatibility docs |
| **Ollama** | `/api/chat` (native API) | **Yes** — pass `logprobs: true` and `top_logprobs: N` (since v0.12.11) |
| **Ollama** | `/api/generate` (native API) | **Yes** — same parameters as `/api/chat` |

**Summary:** Only one endpoint per local provider actually returns logprobs. The OpenAI-compatible `/v1/chat/completions` does not work for logprobs on either Ollama or LM Studio.

## Why There Is No "Supports Logprobs" Flag

Neither provider exposes logprobs as a discoverable model capability:

- **LM Studio** `/v1/models` returns a `capabilities` array per model, but only lists `"tool_use"`. No `"logprobs"` value exists.
- **Ollama** `/api/show` returns a `capabilities` field with values: `completion`, `vision`, `tools`, `insert`, `embedding`, `thinking`. No `"logprobs"` value exists.
- An Ollama PR (#10174) to add capabilities to `/api/tags` was merged then **reverted** due to 100x performance degradation from I/O overhead. Issue #10097 remains open.

This makes sense because logprobs is engine-level, not model-level — listing it per-model would be redundant.

## Programmatic Detection via Probe Request

Since there's no capability flag, the only way to confirm logprobs work for a given provider+endpoint combination is a minimal probe:

### Ollama (native API)
```json
POST http://localhost:11434/api/generate
{
  "model": "llama3",
  "prompt": "Hi",
  "logprobs": true,
  "top_logprobs": 1,
  "stream": false,
  "options": { "num_predict": 1 }
}
```
If supported, the response contains a `logprobs` array. If not, the field is absent or null. Setting `num_predict: 1` makes this very cheap (single token generated).

### LM Studio (Open Responses)
```json
POST http://localhost:1234/v1/responses
{
  "model": "your-model",
  "input": "Hi",
  "include": ["message.output_text.logprobs"],
  "top_logprobs": 1,
  "max_output_tokens": 1
}
```

### LM Studio (Chat Completions)

**Does not work.** The endpoint accepts `logprobs: true` without error but returns no logprobs data in the response. Do not use this endpoint for logprobs — use `/v1/responses` above instead.

### OpenAI
```json
POST https://api.openai.com/v1/chat/completions
{
  "model": "gpt-4.1-mini",
  "messages": [{"role": "user", "content": "Hi"}],
  "logprobs": true,
  "top_logprobs": 1,
  "max_tokens": 1
}
```

## Model Unloading

When testing multiple models, unloading between tests prevents memory exhaustion:

| Provider | Method | Request |
|----------|--------|---------|
| **Ollama** | `POST /api/generate` with `keep_alive: 0` | `{"model": "llama3", "keep_alive": 0}` |
| **LM Studio** | `POST /api/v1/models/unload` | `{"instance_id": "model-name"}` |

Ollama's `keep_alive` also accepts duration strings (`"10m"`, `"24h"`), `-1` for indefinite, or `0` for immediate unload. The default idle timeout is `"5m"`.

## CLI Tools

- **Ollama CLI**: `ollama list` shows downloaded models, `ollama ps` shows loaded models with memory usage. No capability inspection command.
- **LM Studio CLI (`lms`)**: `lms ls` lists models, `lms ls --json --llm` returns rich JSON metadata (sizeBytes, paramsString, architecture, quantization), `lms ps` shows loaded models, `lms load`/`lms unload` manage model lifecycle. No capability inspection command. Open issue [lms #60](https://github.com/lmstudio-ai/lms/issues/60) requests logprobs support in chat completions.

## Version Requirements

- **Ollama**: v0.12.11+ for native `/api/chat` logprobs support (tested and confirmed on v0.17.7)
- **LM Studio**: `/v1/responses` endpoint required — `/v1/chat/completions` does not return logprobs regardless of version. The `/v1/responses` endpoint was added in the Open Responses spec update (Jan 2026).
- **OpenAI**: Always supported on `/v1/chat/completions`

## LM Studio `/v1/models` Metadata Limitations

LM Studio's `/v1/models` endpoint returns minimal data: `{id, object, owned_by}`. It does **not** return `size_bytes`, `params_string`, `quantization`, `arch`, or `state` fields, despite what some documentation suggests. Ollama's `/api/tags` endpoint returns rich metadata including file size, parameter count, quantization level, and model family.

### Workaround: `lms ls --json --llm`

The LM Studio CLI (`lms`) provides rich metadata that the REST API does not:

```bash
lms ls --json --llm
```

Returns an array of model objects with: `modelKey`, `sizeBytes`, `paramsString`, `architecture`, `quantization` (with `name` and `bits`), `maxContextLength`, `format`, `vision`, and `type` (`llm` or `vlm`). This is what the scanner and server use when the CLI is available, falling back to the `/v1/models` API if `lms` is not installed.

## Sources

- [Ollama API docs — /api/generate](https://docs.ollama.com/api/generate)
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [Ollama logprobs feature request — issue #2415](https://github.com/ollama/ollama/issues/2415)
- [Ollama capabilities issue #10097](https://github.com/ollama/ollama/issues/10097)
- [LM Studio REST API endpoints](https://lmstudio.ai/docs/developer/rest/endpoints)
- [LM Studio API changelog](https://lmstudio.ai/docs/developer/api-changelog)
- [LM Studio chat completions docs](https://lmstudio.ai/docs/developer/openai-compat/chat-completions)
- [LM Studio Open Responses blog](https://lmstudio.ai/blog/openresponses)
- [LM Studio CLI docs](https://lmstudio.ai/docs/cli)
- [LM Studio lms logprobs issue #60](https://github.com/lmstudio-ai/lms/issues/60)
- [LM Studio MLX engine logprobs issue #37](https://github.com/lmstudio-ai/mlx-engine/issues/37)
