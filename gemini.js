'use strict';
// Gemini (Google Code Assist `cloudcode-pa.googleapis.com`) ↔ Chat Completions.
// Pure transforms — no I/O. Code Assist has no function-calling, so tool
// messages are flattened into text. Gemini requires strict user/model alternation.

const MODEL_ALIASES = {
  'gemini-2.0-flash': 'gemini-3-flash-preview',
  'gemini-2.0-flash-lite': 'gemini-2.5-flash-lite',
  'gemini-2.5-flash': 'gemini-3-flash-preview',
  'gemini-2.5-pro': 'gemini-3.1-pro-preview',
  'gemini-pro': 'gemini-3.1-pro-preview',
};

function resolveGeminiModel(m) {
  return MODEL_ALIASES[m] || m || 'gemini-3-flash-preview';
}

function toCodeAssistRequest(msg, project) {
  const systemMsgs = msg.messages.filter((m) => m.role === 'system');
  const convMsgs = msg.messages.filter((m) => m.role !== 'system');
  const rawParts = [];
  for (const m of convMsgs) {
    if (m.role === 'tool') {
      const text = typeof m.content === 'string' ? m.content
        : Array.isArray(m.content) ? m.content.map((p) => p.text || JSON.stringify(p)).join('\n') : JSON.stringify(m.content);
      rawParts.push({ role: 'user', text: `[Tool result: ${text}]` });
      continue;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (m.tool_calls && m.tool_calls.length) {
      const calls = m.tool_calls.map((tc) => `${tc.function && tc.function.name}(${(tc.function && tc.function.arguments) || '{}'})`).join(', ');
      rawParts.push({ role, text: m.content ? `${m.content}\n[Called: ${calls}]` : `[Called: ${calls}]` });
      continue;
    }
    if (m.content == null) continue;
    rawParts.push({ role, text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
  }
  // Merge consecutive same-role parts (Gemini requires strict alternation).
  const contents = [];
  for (const p of rawParts) {
    const prev = contents[contents.length - 1];
    if (prev && prev.role === p.role) prev.parts.push({ text: p.text });
    else contents.push({ role: p.role, parts: [{ text: p.text }] });
  }
  const systemInstruction = systemMsgs.length > 0
    ? { role: 'user', parts: [{ text: systemMsgs.map((m) => m.content).join('\n') }] }
    : undefined;
  return {
    model: resolveGeminiModel(msg.model),
    project,
    user_prompt_id: globalThis.crypto.randomUUID(),
    request: {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: { maxOutputTokens: msg.max_tokens || 1024 },
    },
  };
}

function isRetryableGeminiError(body) {
  try {
    const parsed = JSON.parse(body);
    const reason = parsed && parsed.error && parsed.error.details
      && parsed.error.details.find((d) => d['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo');
    return (reason && reason.reason) === 'RATE_LIMIT_EXCEEDED';
  } catch { return false; }
}

// The text out of one Code Assist SSE event (either wrapped in `response` or not).
function extractGeminiText(parsed) {
  return (parsed && parsed.response && parsed.response.candidates && parsed.response.candidates[0]
    && parsed.response.candidates[0].content && parsed.response.candidates[0].content.parts
    && parsed.response.candidates[0].content.parts[0] && parsed.response.candidates[0].content.parts[0].text)
    ?? (parsed && parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content
    && parsed.candidates[0].content.parts && parsed.candidates[0].content.parts[0]
    && parsed.candidates[0].content.parts[0].text)
    ?? null;
}

// Convenience: build the Chat-Completion streaming chunk for a piece of text.
function geminiTextChunk(text) {
  return { choices: [{ delta: { content: text }, index: 0 }] };
}

module.exports = {
  resolveGeminiModel,
  toCodeAssistRequest,
  isRetryableGeminiError,
  extractGeminiText,
  geminiTextChunk,
};
