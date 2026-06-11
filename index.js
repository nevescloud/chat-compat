'use strict';
// One source of truth for the OpenAI-Codex and Gemini-Code-Assist ↔ Chat
// Completions translation, usable unchanged in a Node http server and a
// Cloudflare Worker. Pure transforms only; each runtime keeps its own
// streaming I/O and wraps these.
//
// CJS so it works in both: Node `require` natively, Workers via esbuild bundling.
// From an ESM Worker use a default import: `import cc from '@nevescloud/chat-compat'`.
module.exports = {
  openai: require('./openai.js'),
  gemini: require('./gemini.js'),
  drainSSE: require('./sse.js').drainSSE,
};
