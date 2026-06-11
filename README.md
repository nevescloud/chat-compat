# @nevescloud/chat-compat

One source of truth for the **OpenAI-Codex** (`chatgpt.com` Responses API) and **Gemini-Code-Assist** (`cloudcode-pa.googleapis.com`) ↔ **Chat Completions** translation. Pure transforms, no I/O — runtime-agnostic (CJS), so the same logic runs unchanged in a Node `http` server and a Cloudflare Worker (`fetch`). Each runtime keeps its own streaming I/O and wraps these.

```sh
npm i @nevescloud/chat-compat
```

```js
const { openai, gemini, drainSSE } = require('@nevescloud/chat-compat');         // Node
// import cc from '@nevescloud/chat-compat'; const { openai, gemini, drainSSE } = cc; // ESM/Worker (default import — CJS)
```

- `openai`: `normalizeModel` · `resolveCodexModel` · `chatToResponsesPayload` · `responsesToChatCompletion` · `newCodexStream` + `transformCodexEvent` (per-SSE-event → Chat-Completion chunks).
- `gemini`: `resolveGeminiModel` · `toCodeAssistRequest` · `isRetryableGeminiError` · `extractGeminiText` · `geminiTextChunk`.
- `drainSSE(buffer)` → `{ events, rest }` — drains `\n\n`-delimited SSE events, keeps the remainder.

Streaming pattern (per runtime): accumulate bytes → `drainSSE` → per event call the transform → write returned chunks → on `done`/stream-end emit `data: [DONE]\n\n`.

`npm test` — golden tests lock the exact output.
