// Offline self-check for the mode-boost pieces (no live host needed).
//   node scripts/dev/mode-boost-test.mjs
// Live e2e (against a running service with a session open):
//   node scripts/dev/mode-boost-test.mjs --live [base]
import { buildSetModeCall, serializeRpc, normalizeBoostMode, scanCommandSessionId, scanTopicSessionId, INJECTED_ID_BASE, MODE_CHANNEL, MODE_METHOD } from '../../src/mode-boost.mjs';
import { decodeRpc } from '../../src/rpclog.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// --- reference serializer (from the verified pin-relay-probe wire driver) ---
function refVQL(value) {
  const bytes = [];
  if (value === 0) return Buffer.from([0]);
  let v = value;
  while (v !== 0) { bytes.push(v & 127); v = v >>> 7; }
  for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 128;
  return Buffer.from(bytes);
}
function refSerialize(data) {
  if (data === undefined) return Buffer.from([0]);
  if (typeof data === 'string') { const b = Buffer.from(data, 'utf8'); return Buffer.concat([Buffer.from([1]), refVQL(b.length), b]); }
  if (Array.isArray(data)) { const p = [Buffer.from([4]), refVQL(data.length)]; for (const el of data) p.push(refSerialize(el)); return Buffer.concat(p); }
  if (typeof data === 'number') return Buffer.concat([Buffer.from([6]), refVQL(data)]);
  if (data && typeof data === 'object') { const b = Buffer.from(JSON.stringify(data), 'utf8'); return Buffer.concat([Buffer.from([5]), refVQL(b.length), b]); }
  throw new Error('unsupported');
}

console.log('serializeRpc matches the verified wire serializer');
for (const v of [
  'zcode-task', 100, 0x60000001, undefined,
  [{ taskId: 'sess_ab12cd34-ef', mode: 'yolo' }],
  [{ a: [1, 2, { b: 'x' }] }],
]) {
  const mine = serializeRpc(v);
  const ref = refSerialize(v);
  check(String(JSON.stringify(v) ?? 'undefined').slice(0, 40) + ' → ' + mine.length + 'B', mine.equals(ref), mine.toString('hex') + ' vs ' + ref.toString('hex'));
}

console.log('buildSetModeCall frame shape');
{
  const gid = INJECTED_ID_BASE + 1;
  const frame = buildSetModeCall(gid, 'sess_00112233-4455-6677-8899-aabbccddeeff', 'yolo');
  const d = decodeRpc(frame);
  check('type 100 (call)', d.type === 100, 'type=' + d.type);
  check('id preserved', d.id === gid, 'id=' + d.id);
  check('channel zcode-task', d.channel === MODE_CHANNEL && d.channel === 'zcode-task', d.channel);
  check('method setMode', d.method === MODE_METHOD, d.method);
  check('args = single-element host array', Array.isArray(d.body) && d.body.length === 1, JSON.stringify(d.body));
  check('arg payload {taskId, mode}', d.body[0] && d.body[0].taskId === 'sess_00112233-4455-6677-8899-aabbccddeeff' && d.body[0].mode === 'yolo', JSON.stringify(d.body && d.body[0]));
  check('id above renderer-mux range', gid > 0x10000 + 1e6, String(gid));
}

console.log('normalizeBoostMode accepts renderer value space + picker labels');
for (const [input, want] of [
  ['yolo', 'yolo'], ['Yolo', 'yolo'], ['完全访问', 'yolo'], ['dontAsk', 'yolo'], ['bypassPermissions', 'yolo'],
  ['build', 'build'], ['变更前确认', 'build'], ['default', 'build'], ['默认模式', 'build'], ['defaultMode', 'build'],
  ['edit', 'edit'], ['自动编辑', 'edit'], ['acceptEdits', 'edit'], ['autoEdit', 'autoEdit'],
  ['plan', 'plan'], ['计划模式', 'plan'], ['auto', 'auto'], ['自动', 'auto'],
]) check(String(input) + ' → ' + want, normalizeBoostMode(input) === want, 'got ' + normalizeBoostMode(input));
for (const bad of ['', 'nonsense', null, undefined, 42, {}, 'yoloo']) {
  check('reject ' + JSON.stringify(bad), normalizeBoostMode(bad) === null, 'got ' + normalizeBoostMode(bad));
}

console.log('scanCommandSessionId');
{
  const sid = 'sess_fe11aa22-bb33-cc44-dd55-ee66ff778899';
  const frame = Buffer.concat([
    refSerialize([100, 5, 'some-channel', 'sendCommand']),
    refSerialize({ commandId: 'c1', sessionId: sid, type: 'sendText', payload: {} }),
  ]);
  check('extracts sessionId from a command envelope', scanCommandSessionId(frame) === sid, scanCommandSessionId(frame));
  check('null on frames without sessionId', scanCommandSessionId(refSerialize([100, 5, 'x', 'y'])) === null);
  check('null on tiny/garbage input', scanCommandSessionId(Buffer.from([1, 2, 3])) === null);
  const big = Buffer.concat([frame, Buffer.alloc(600 * 1024)]);
  check('null on oversized frames (>512KB skipped)', scanCommandSessionId(big) === null);
  check('non-ascii noise does not throw', scanCommandSessionId(Buffer.from([0x4f, 0xd3, 0xff, 0x00, 0x99])) === null);
}

console.log('scanTopicSessionId');
{
  const sid = 'sess_abc12345-def6-7890-abcd-ef1234567890';
  const body = Buffer.from(JSON.stringify({ topic: 'conversation/' + sid, kind: 'complete' }));
  check('extracts from conversation topic frames', scanTopicSessionId(body) === sid, scanTopicSessionId(body));
  check('null when no topic', scanTopicSessionId(Buffer.from('{"topic":"sessions-index//home/coder"}')) === null);
  check('null on short input', scanTopicSessionId(Buffer.from('conv')) === null);
}

// ---------------- optional live e2e ----------------
if (process.argv.includes('--live')) {
  const base = (process.argv[process.argv.indexOf('--live') + 1] || 'http://127.0.0.1:3102/');
  console.log('LIVE ' + base);
  const { execSync } = await import('node:child_process');
  const res = await fetch(new URL('api/mode-boost', base), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: '完全访问' }),
  });
  const j = await res.json().catch(() => ({}));
  console.log('POST /api/mode-boost → ' + res.status + ' ' + JSON.stringify(j));
  if (j.ok) {
    await new Promise((r) => setTimeout(r, 2500));
    let mode = null;
    try {
      mode = execSync(`python3 -c "import sqlite3;c=sqlite3.connect('/home/coder/.zcode/v2/tasks-index.sqlite');print(list(c.execute(\\"select mode from tasks where task_id='${j.taskId}'\\"))[0][0])")`, { encoding: 'utf8' }).trim();
    } catch (e) { mode = 'ERR ' + e.message.slice(0, 80); }
    check('tasks index shows mode=yolo for ' + j.taskId, mode === 'yolo', 'mode=' + mode);
  } else {
    check('mode-boost rejected cleanly (no session?) — inspect manually', false, JSON.stringify(j));
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
