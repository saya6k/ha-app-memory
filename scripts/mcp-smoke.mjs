// Full-container smoke test: exercises the MCP endpoint end to end against the
// real local embedding sidecar (no mocks anywhere in this path).
const URL = 'http://127.0.0.1:8099/mcp';
let failures = 0;

async function rpc(method, params) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  // Streamable HTTP may answer as SSE; take the last data: line.
  const line = text.includes('data:')
    ? text.split('\n').filter((l) => l.startsWith('data:')).pop().slice(5).trim()
    : text;
  const json = JSON.parse(line);
  if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  return json.result;
}

function check(label, ok, detail = '') {
  console.log(`  [${ok ? 'OK ' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

const content = (r) => JSON.parse(r.content[0].text);

console.log('\n=== 0. initialize (serverInfo.name) ===');
const info = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '1' },
});
console.log('  ', JSON.stringify(info.serverInfo));
check('server name is "Memory"', info.serverInfo?.name === 'Memory', String(info.serverInfo?.name));

console.log('\n=== 1. tools/list ===');
const tools = (await rpc('tools/list', {})).tools.map((t) => t.name).sort();
console.log('  ', tools.join(', '));
check('6 tools exposed', tools.length === 6, `got ${tools.length}`);

console.log('\n=== 2. save (실제 로컬 임베딩) ===');
const saved = content(
  await rpc('tools/call', {
    name: 'save',
    arguments: { content: '사용자가 가장 좋아하는 프로그래밍 언어는 타입스크립트다.', tags: ['pref'] },
  }),
);
console.log('  ', JSON.stringify(saved));
check('returned an id', typeof saved.id === 'string' && saved.id.length > 0);

await rpc('tools/call', {
  name: 'save',
  arguments: { content: '내일 서울 날씨는 비가 오고 최고기온은 24도다.', tags: ['weather'] },
});

console.log('\n=== 3. get ===');
const got = content(await rpc('tools/call', { name: 'get', arguments: { id: saved.id } }));
check('round-trips content', got.content.includes('타입스크립트'), got.content);

console.log('\n=== 4. search (의미 기반 검색) ===');
const found = content(
  await rpc('tools/call', { name: 'search', arguments: { query: 'what language do I like to code in?' } }),
);
console.log('  ', JSON.stringify(found).slice(0, 400));
const top = found.results?.[0] ?? found[0];
check(
  'cross-lingual semantic hit ranks first',
  top && JSON.stringify(top).includes('타입스크립트'),
  top ? JSON.stringify(top).slice(0, 120) : 'no results',
);

console.log('\n=== 5. similar ===');
const sim = content(await rpc('tools/call', { name: 'similar', arguments: { id: saved.id } }));
const simStr = JSON.stringify(sim);
check('excludes self', !simStr.includes(saved.id), simStr.slice(0, 160));

console.log('\n=== 6. delete ===');
await rpc('tools/call', { name: 'delete', arguments: { id: saved.id } });
// A tool that throws surfaces as an error *result* (isError), not a JSON-RPC error.
const after = await rpc('tools/call', { name: 'get', arguments: { id: saved.id } });
check(
  'deleted fact is gone (explicit error result, not silent success)',
  after.isError === true,
  JSON.stringify(after).slice(0, 160),
);

console.log(`\n===== ${failures === 0 ? '전부 통과' : failures + '건 실패'} =====`);
process.exit(failures ? 1 : 0);
