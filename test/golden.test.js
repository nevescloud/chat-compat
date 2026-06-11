'use strict';
// Golden tests — lock the EXACT output of the transforms so downstream
// consumers can adopt them without re-verifying against live traffic.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openai, gemini, drainSSE } = require('..');

// ── OpenAI / Codex ──────────────────────────────────────────────────────────

test('resolveCodexModel: suffix rules', () => {
  assert.equal(openai.resolveCodexModel('gpt-5.4'), 'gpt-5.4');            // exception: no suffix
  assert.equal(openai.resolveCodexModel('gpt-5.1'), 'gpt-5.1-codex');     // suffix added
  assert.equal(openai.resolveCodexModel('openai-codex/gpt-5.1'), 'gpt-5.1-codex'); // prefix stripped
  assert.equal(openai.resolveCodexModel('gpt-5.1-codex'), 'gpt-5.1-codex'); // already-suffixed
  assert.equal(openai.resolveCodexModel('claude'), null);                  // not a gpt-X.Y
});

test('normalizeModel: empty → default, bad → error', () => {
  assert.deepEqual(openai.normalizeModel(''), { ok: true, model: 'gpt-5.4' });
  assert.deepEqual(openai.normalizeModel('gpt-5.1'), { ok: true, model: 'gpt-5.1-codex' });
  assert.equal(openai.normalizeModel('nope').ok, false);
});

test('chatToResponsesPayload: messages, tools, tool results', () => {
  const out = openai.chatToResponsesPayload({
    model: 'gpt-5.4', stream: true, max_tokens: 100, temperature: 0.5, top_p: 0.9,
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'result' },
    ],
    tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }],
  });
  assert.equal(out.model, 'gpt-5.4');
  assert.equal(out.stream, true);
  assert.equal(out.instructions, 'be brief');
  assert.equal(out.max_output_tokens, 100);
  assert.equal(out.top_p, 0.9);
  assert.equal(out.parallel_tool_calls, false);
  assert.deepEqual(out.input[0], { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] });
  // assistant text precedes the function_call item
  assert.deepEqual(out.input[1], { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] });
  assert.deepEqual(out.input[2], { type: 'function_call', id: 'fc_c1', call_id: 'c1', name: 'f', arguments: '{"a":1}', status: 'completed' });
  assert.deepEqual(out.input[3], { type: 'function_call_output', call_id: 'c1', output: 'result' });
  assert.deepEqual(out.tools[0], { type: 'function', name: 'f', description: 'd', parameters: { type: 'object' } });
});

test('responsesToChatCompletion: text + usage + tool_calls', () => {
  const out = openai.responsesToChatCompletion({
    id: 'r1', model: 'gpt-5.4-codex', status: 'completed',
    output: [
      { type: 'message', content: [{ type: 'output_text', text: 'hello' }] },
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{"x":1}' },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  }, 'gpt-5.4');
  assert.equal(out.object, 'chat.completion');
  assert.equal(out.model, 'gpt-5.4-codex');
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
  assert.equal(out.choices[0].message.content, 'hello');
  assert.deepEqual(out.choices[0].message.tool_calls[0], { id: 'c1', type: 'function', function: { name: 'f', arguments: '{"x":1}' }, index: 0 });
  assert.deepEqual(out.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});

test('responsesToChatCompletion: incomplete → length, no tools → stop', () => {
  const plain = openai.responsesToChatCompletion({ id: 'r2', output_text: 'hi', status: 'completed' }, 'm');
  assert.equal(plain.choices[0].finish_reason, 'stop');
  assert.equal(plain.choices[0].message.content, 'hi');
  const inc = openai.responsesToChatCompletion({ id: 'r3', output_text: 'partial', status: 'incomplete' }, 'm');
  assert.equal(inc.choices[0].finish_reason, 'length');
});

test('transformCodexEvent: text, tool call, args, completion', () => {
  const st = openai.newCodexStream();
  assert.deepEqual(openai.transformCodexEvent({ type: 'response.output_text.delta', delta: 'Hel' }, st),
    { chunks: [{ choices: [{ delta: { content: 'Hel' }, index: 0 }] }], done: false });
  const add = openai.transformCodexEvent({ type: 'response.output_item.added', item: { type: 'function_call', id: 'i1', call_id: 'c1', name: 'f' } }, st);
  assert.deepEqual(add.chunks[0].choices[0].delta.tool_calls[0], { index: 0, id: 'c1', type: 'function', function: { name: 'f', arguments: '' } });
  const args = openai.transformCodexEvent({ type: 'response.function_call_arguments.delta', item_id: 'i1', delta: '{"a":1}' }, st);
  assert.deepEqual(args.chunks[0].choices[0].delta.tool_calls[0], { index: 0, function: { arguments: '{"a":1}' } });
  const end = openai.transformCodexEvent({ type: 'response.completed' }, st);
  assert.equal(end.done, true);
  assert.equal(end.chunks[0].choices[0].finish_reason, 'tool_calls');
});

// ── Gemini / Code Assist ────────────────────────────────────────────────────

test('resolveGeminiModel: aliases + default', () => {
  assert.equal(gemini.resolveGeminiModel('gemini-2.5-pro'), 'gemini-3.1-pro-preview');
  assert.equal(gemini.resolveGeminiModel('gemini-x'), 'gemini-x');
  assert.equal(gemini.resolveGeminiModel(''), 'gemini-3-flash-preview');
});

test('toCodeAssistRequest: flattens tools, merges same-role, system instruction', () => {
  const out = gemini.toCodeAssistRequest({
    model: 'gemini-2.5-pro', max_tokens: 256,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c', tool_calls: [{ function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', content: 'res' },
    ],
  }, 'proj-1');
  assert.equal(out.model, 'gemini-3.1-pro-preview');
  assert.equal(out.project, 'proj-1');
  assert.equal(typeof out.user_prompt_id, 'string');
  assert.equal(out.request.generationConfig.maxOutputTokens, 256);
  assert.deepEqual(out.request.systemInstruction, { role: 'user', parts: [{ text: 'sys' }] });
  // consecutive users merged into one content with two parts
  assert.deepEqual(out.request.contents[0], { role: 'user', parts: [{ text: 'a' }, { text: 'b' }] });
  assert.equal(out.request.contents[1].role, 'model');
  assert.match(out.request.contents[1].parts[0].text, /\[Called: f\(\{\}\)\]/);
  assert.match(out.request.contents[2].parts[0].text, /\[Tool result: res\]/);
});

test('extractGeminiText: both shapes + null', () => {
  assert.equal(gemini.extractGeminiText({ response: { candidates: [{ content: { parts: [{ text: 'x' }] } }] } }), 'x');
  assert.equal(gemini.extractGeminiText({ candidates: [{ content: { parts: [{ text: 'y' }] } }] }), 'y');
  assert.equal(gemini.extractGeminiText({ nope: 1 }), null);
});

test('isRetryableGeminiError', () => {
  assert.equal(gemini.isRetryableGeminiError(JSON.stringify({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RATE_LIMIT_EXCEEDED' }] } })), true);
  assert.equal(gemini.isRetryableGeminiError(JSON.stringify({ error: { details: [] } })), false);
  assert.equal(gemini.isRetryableGeminiError('not json'), false);
});

// ── SSE ─────────────────────────────────────────────────────────────────────

test('drainSSE: parses complete events, keeps remainder, skips [DONE]', () => {
  const { events, rest } = drainSSE('data: {"a":1}\n\ndata: [DONE]\n\ndata: {"b":2');
  assert.deepEqual(events, [{ a: 1 }]);
  assert.equal(rest, 'data: {"b":2');
});
