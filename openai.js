'use strict';
// OpenAI Codex (chatgpt.com Responses API) ↔ Chat Completions translation.
// Pure transforms — no I/O. Each runtime (Node http / Cloudflare Worker) wraps
// these with its own streaming.

const DEFAULT_MODEL = 'gpt-5.4';
// gpt-5.4 is the canonical name; older versions use the -codex suffix.
const CODEX_SUFFIX_EXCEPTIONS = new Set(['gpt-5.4']);

function resolveCodexModel(name) {
  const base = String(name).replace(/^openai-codex\//, '').replace(/-codex$/, '');
  if (!base.match(/^gpt-\d+\.\d+$/)) return null;
  return CODEX_SUFFIX_EXCEPTIONS.has(base) ? base : `${base}-codex`;
}

function normalizeModel(rawModel) {
  const requested = String(rawModel || '').trim();
  if (!requested) return { ok: true, model: DEFAULT_MODEL };
  const resolved = resolveCodexModel(requested.toLowerCase());
  if (resolved) return { ok: true, model: resolved };
  return { ok: false, message: `Model "${requested}" is not a recognized Codex model (expected gpt-X.Y pattern)` };
}

function mapChatMessageToResponseInput(msg) {
  const role = msg.role === 'tool' ? 'user' : msg.role;
  const type = role === 'assistant' ? 'output_text' : 'input_text';
  const content = [];
  if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (typeof part === 'string') content.push({ type, text: part });
      else if (part && part.type === 'text') content.push({ type, text: part.text || '' });
      else content.push({ type, text: JSON.stringify(part) });
    }
  } else if (msg.content) {
    content.push({ type, text: msg.content });
  }
  if (!content.length) content.push({ type, text: '(empty)' });
  return { type: 'message', role, content };
}

function chatToResponsesPayload(msg) {
  const system = [];
  const input = [];
  for (const entry of msg.messages || []) {
    if (entry.role === 'system') {
      system.push(typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content));
      continue;
    }
    // Tool result → function_call_output (Responses API format)
    if (entry.role === 'tool') {
      const output = Array.isArray(entry.content)
        ? entry.content.map((p) => (typeof p === 'string' ? p : p.text || JSON.stringify(p))).join('')
        : (entry.content || '');
      input.push({ type: 'function_call_output', call_id: entry.tool_call_id, output });
      continue;
    }
    // Assistant with tool_calls → function_call items (preceded by any text)
    if (entry.role === 'assistant' && entry.tool_calls && entry.tool_calls.length) {
      const text = typeof entry.content === 'string' ? entry.content
        : Array.isArray(entry.content) ? entry.content.filter((p) => p.type === 'text').map((p) => p.text).join('') : '';
      if (text) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const tc of entry.tool_calls) {
        input.push({
          type: 'function_call',
          id: `fc_${tc.id}`, // Responses API requires id to start with 'fc'
          call_id: tc.id, // function_call_output.call_id references this
          name: tc.function && tc.function.name,
          arguments: (tc.function && tc.function.arguments) || '{}',
          status: 'completed',
        });
      }
      continue;
    }
    input.push(mapChatMessageToResponseInput(entry));
  }
  return {
    model: msg.model,
    stream: !!msg.stream,
    input,
    instructions: system.length ? system.join('\n') : undefined,
    max_output_tokens: msg.max_tokens,
    temperature: msg.temperature,
    top_p: msg.top_p,
    // Chat Completions tool → Responses API tool (flatten the `function` wrapper).
    tools: Array.isArray(msg.tools) ? msg.tools.map((t) => (t.function
      ? { type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters }
      : t)) : [],
    tool_choice: typeof msg.tool_choice === 'string' ? msg.tool_choice : 'auto',
    parallel_tool_calls: false,
    reasoning: null,
    store: false,
    include: [],
  };
}

function extractResponseText(response) {
  if (typeof (response && response.output_text) === 'string' && response.output_text) return response.output_text;
  const parts = [];
  for (const item of (response && response.output) || []) {
    for (const content of (item && item.content) || []) {
      if (content && content.type === 'output_text' && content.text) parts.push(content.text);
    }
  }
  return parts.join('');
}

function extractResponseToolCalls(response) {
  const toolCalls = [];
  for (const item of (response && response.output) || []) {
    if (item && item.type === 'function_call') {
      toolCalls.push({ id: item.call_id || item.id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' } });
    }
  }
  return toolCalls;
}

function responsesToChatCompletion(response, requestedModel) {
  const text = extractResponseText(response);
  const toolCalls = extractResponseToolCalls(response);
  const hasTools = toolCalls.length > 0;
  return {
    id: response.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: response.model || requestedModel,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text || null,
        refusal: null,
        annotations: [],
        ...(hasTools ? { tool_calls: toolCalls.map((tc, i) => ({ ...tc, index: i })) } : {}),
      },
      logprobs: null,
      finish_reason: hasTools ? 'tool_calls' : (response.status === 'incomplete' ? 'length' : 'stop'),
    }],
    usage: response.usage ? {
      prompt_tokens: response.usage.input_tokens || 0,
      completion_tokens: response.usage.output_tokens || 0,
      total_tokens: (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0),
    } : undefined,
  };
}

// ── Streaming: pure per-event transform (Codex SSE event → Chat-Completion chunks) ──
// Each runtime drains SSE events (see sse.drainSSE), calls this per event, writes
// the returned `chunks`, and on `done` emits the terminal `data: [DONE]\n\n` + close.
function newCodexStream() {
  return { toolCalls: new Map(), toolCallCount: 0, hasToolCalls: false };
}

function transformCodexEvent(parsed, state) {
  const chunks = [];
  let done = false;
  if (parsed.type === 'response.output_text.delta' && parsed.delta) {
    chunks.push({ choices: [{ delta: { content: parsed.delta }, index: 0 }] });
  }
  if (parsed.type === 'response.output_item.added' && parsed.item && parsed.item.type === 'function_call') {
    const item = parsed.item;
    const idx = state.toolCallCount++;
    const callId = item.call_id || item.id;
    state.toolCalls.set(item.id, { idx, callId, name: item.name });
    state.hasToolCalls = true;
    chunks.push({ choices: [{ delta: { tool_calls: [{ index: idx, id: callId, type: 'function', function: { name: item.name || '', arguments: '' } }] }, index: 0 }] });
  }
  if (parsed.type === 'response.function_call_arguments.delta' && parsed.delta !== undefined) {
    const tc = state.toolCalls.get(parsed.item_id);
    if (tc) chunks.push({ choices: [{ delta: { tool_calls: [{ index: tc.idx, function: { arguments: parsed.delta } }] }, index: 0 }] });
  }
  if (parsed.type === 'response.completed') {
    if (state.hasToolCalls) chunks.push({ choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] });
    done = true;
  }
  return { chunks, done };
}

module.exports = {
  DEFAULT_MODEL,
  resolveCodexModel,
  normalizeModel,
  chatToResponsesPayload,
  responsesToChatCompletion,
  newCodexStream,
  transformCodexEvent,
};
