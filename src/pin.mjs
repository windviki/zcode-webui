// Pin (置顶) guard shared by every renderer->host transport.
//
// A pinned task is moved into the renderer's "已置顶" group, which this web shell
// does not render next to the workspace list — one stray click on the tiny
// hover-only pin icon therefore makes the session disappear from the task list
// for good (the host serves pinned tasks from a separate listPinnedTasks /
// listPinnedTaskIds bucket, so they leave listTasks entirely). Pinning calls are
// answered with a synthetic success so the host-side pinned flag never flips;
// un-pin calls still reach the host, so a session that is pinned anyway can be
// restored from the UI.
//
// The guard must run on EVERY transport: the WS bridge (writeToHost) and the
// HTTP long-poll fallback (/bridge/send), which pushes straight into its own
// host pipe and would otherwise bypass writeToHost.
//
// Wire facts (verified against the 3.11.2 host runtime: the channel name and the
// args-array shape were read off a live zcode-task call — see the e2e notes in
// scripts/dev/pin-relay-probe.mjs; re-verify when the runtime is upgraded):
//   channel : "zcode-task"   — the renderer's ServiceChannels.ZCodeTask. The
//             client-side service object is merely NAMED zcodeTaskService, so
//             matching that name never fires on real traffic.
//   method  : setTaskPinned
//   args    : the host calls `handler.apply(ctx, arg)`, so params must arrive as
//             a one-element array: [{ taskId, workspacePath, pinned }]
import { decodeRpc, decodeRpcHeader, encodeRpcHeader } from './rpclog.mjs';

export const PIN_CHANNELS = ['zcode-task'];
export const PIN_METHOD = 'setTaskPinned';

// Decode a renderer call; returns { type, id, channel, method, params } or null.
// Header-first: the channel/method gate runs BEFORE the body is deserialized —
// this guard sees EVERY inbound frame, and big frames (long prompts, pasted
// content, uploads) must not pay a full JSON.parse just to learn they are not
// pin calls.
export function decodePinCall(payload) {
  let header;
  try { header = decodeRpcHeader(payload); } catch (_e) { return null; }
  if (!header) return null;
  if (PIN_CHANNELS.indexOf(header.channel) < 0 || header.method !== PIN_METHOD) return null;
  let body;
  try { body = decodeRpc(payload).body; } catch (_e) { body = null; }
  const params = Array.isArray(body) ? body[0] : body;   // host args array
  return { type: header.type, id: header.id, channel: header.channel, method: header.method, params: params };
}

// Returns the decoded call when it must be swallowed, or null when it may go
// through to the host.
export function interceptPinRpc(payload) {
  const call = decodePinCall(payload);
  if (!call) return null;
  if (call.type !== 100) return null;                             // 100 = call
  if (PIN_CHANNELS.indexOf(call.channel) < 0) return null;
  if (call.method !== PIN_METHOD) return null;
  if (!call.params || call.params.pinned !== true) return null;    // un-pin passes
  return call;
}

// Synthetic "ok" answer a swallowed call resolves with (201 = PromiseSuccess).
// The official renderer upserts the returned ZCodeTaskMeta into its pinned store
// (WorkspaceSidebarItem does upsertTask(result)), so the body must be a
// full-shaped meta object — an undefined body would plant a malformed entry.
// Fields we cannot know at intercept time get neutral defaults (the pinned
// section is not rendered in this shell anyway; the goal is a clean no-op).
function serializeObjectRpc(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  // preset 5 (object/JSON) + VQL length + payload, same wire format as the
  // official serializer's Object branch
  const len = [];
  let v = json.length;
  if (v === 0) len.push(0);
  else while (v !== 0) { len.push(v & 127); v = v >>> 7; }
  for (let i = 0; i < len.length - 1; i++) len[i] |= 128;
  return Buffer.concat([Buffer.from([5]), Buffer.from(len), json]);
}
export function pinAckFor(call, id) {
  const p = (call && call.params) || {};
  const now = Date.now();
  const meta = {
    taskId: typeof p.taskId === 'string' ? p.taskId : '',
    traceId: '',
    title: '',
    workspacePath: typeof p.workspacePath === 'string' ? p.workspacePath : '',
    createdAt: now,
    updatedAt: now,
    mode: 'build',
    status: 'completed',
    pinned: true,
  };
  if (typeof p.workspaceIdentity === 'string' && p.workspaceIdentity) meta.workspaceIdentity = p.workspaceIdentity;
  // Response wire shape per the official ChannelServer: serialize([201, id]) +
  // serialize(data) — the response header carries only [type, id] (no
  // channel/method), and data is the handler's RETURN VALUE itself
  // (ZCodeTaskMeta); the args-array wrapper exists only on the request side.
  return Buffer.concat([
    encodeRpcHeader([201, id]),
    serializeObjectRpc(meta),
  ]);
}

// A 202 PromiseError frame for a call id — official body shape {message, name}
// (the client reconstructs an Error from these). Used by the resume path to
// answer calls whose responses were lost across a disconnect: without it the
// renderer's promise settles never, and e.g. the file tree's expand dedup
// (`loading` set) stays stuck until a page refresh.
export function errorAckFor(id, message) {
  return Buffer.concat([
    encodeRpcHeader([202, id]),
    serializeObjectRpc({ message: String(message), name: 'Error' }),
  ]);
}
