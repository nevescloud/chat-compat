'use strict';
// Drain complete SSE events (\n\n-delimited blocks) from a streaming buffer.
// Returns the parsed JSON from each block's `data:` lines plus the unparsed
// remainder to carry into the next chunk. Skips empty / [DONE] / malformed.
function drainSSE(buffer) {
  const events = [];
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop();
  for (const block of blocks) {
    const dataLines = block.split('\n').filter((l) => l.startsWith('data: '));
    if (!dataLines.length) continue;
    const json = dataLines.map((l) => l.slice(6)).join('\n').trim();
    if (!json || json === '[DONE]') continue;
    try { events.push(JSON.parse(json)); } catch { /* skip malformed */ }
  }
  return { events, rest };
}

module.exports = { drainSSE };
