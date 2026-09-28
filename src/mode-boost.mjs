// Mode boost — push a collaboration-mode change straight to the agent for the
// conversation the user is looking at, without going through the official
// composer dropdown.
//
// Why: while a permission card is pending the official renderer REPLACES the
// composer with the card, so the mode dropdown is not even in the DOM — and
// cards arrive every couple of seconds during a build-mode multi-step turn.
// The user is locked into clicking 允许 for every step and can never flip to
// 完全访问 mid-turn. On the agent side, though, the switch is instant: the
// v4 switchCollaborationMode command handler is `await app.setMode(mode)` and
// every tool call re-reads the live mode (`let mode = app.getMode()`) when it
// evaluates permissions ("Yolo mode bypasses permission prompts"). So once the
// mode reaches the agent, the very NEXT step stops asking.
//
// How: the host exposes a setMode({taskId, mode}) method on the zcode-task
// channel (ServiceChannels.ZCodeTask — same channel as setTaskPinned) which
// internally goes switchCollaborationModeViaProtocol → v4 command →
// app.setMode, with the host's own CAS stale-retry. The server synthesises
// that call itself, exactly like the renderer would have sent it. No renderer
// state is touched; the official dropdown keeps working and stays the source
// of truth for the NEXT prompt's session config.
//
// Wire facts (verified against host 3.12.3):
//   channel: 'zcode-task'   method: setMode   args: [{ taskId, mode }]
//   mode is the renderer's value space; the host maps it via toZCodeMode()
//   → build | edit | plan | yolo (auto falls back to a legacy session/setMode
//   RPC, so it is accepted too).
import { encodeRpcHeader } from './rpclog.mjs';

// Calls this shim injects use their own id space, far above the renderer-mux
// range (0x10000…) so they can never alias a renderer id.
export const INJECTED_ID_BASE = 0x60000000;

export const MODE_CHANNEL = 'zcode-task';
export const MODE_METHOD = 'setMode';

function vqlBytes(value) {
  value = value >>> 0;
  if (value === 0) return Buffer.from([0]);
  const bytes = [];
  let v = value;
  while (v !== 0) { bytes.push(v & 127); v = v >>> 7; }
  for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 128;
  return Buffer.from(bytes);
}

// Serializer for the channel-protocol presets (same wire format as
// rpclog.mjs / scripts/dev/pin-relay-probe.mjs, which drove a real host call).
export function serializeRpc(data) {
  if (data === undefined || data === null) return Buffer.from([0]);
  if (typeof data === 'string') {
    const b = Buffer.from(data, 'utf8');
    return Buffer.concat([Buffer.from([1]), vqlBytes(b.length), b]);
  }
  if (Array.isArray(data)) {
    const parts = [Buffer.from([4]), vqlBytes(data.length)];
    for (const el of data) parts.push(serializeRpc(el));
    return Buffer.concat(parts);
  }
  if (typeof data === 'number') return Buffer.concat([Buffer.from([6]), vqlBytes(data)]);
  if (typeof data === 'object') {
    const b = Buffer.from(JSON.stringify(data), 'utf8');
    return Buffer.concat([Buffer.from([5]), vqlBytes(b.length), b]);
  }
  throw new Error('mode-boost: unsupported preset for ' + typeof data);
}

// A renderer-shaped `zcode-task.setMode` call. Body is the host args array
// (handler.apply(ctx, args) — one-element array, like setTaskPinned).
export function buildSetModeCall(gid, taskId, mode) {
  return Buffer.concat([
    encodeRpcHeader([100, gid, MODE_CHANNEL, MODE_METHOD]),
    serializeRpc([{ taskId, mode }]),
  ]);
}

// Accept the renderer's full mode value space plus the zh/en picker labels.
// Official ZCodeTaskMode = yolo|plan|edit|auto|autoEdit|build (zcode-task-types-
// core.ts); the composer's submission space is only build|edit|plan|yolo
// (submission.ts). 'auto' routes to a legacy session/setMode RPC inside the
// host instead of the v4 command, 'autoEdit' is host-mapped onto build — both
// are accepted and passed through; the host owns the mapping.
const MODE_ALIASES = {
  default: 'build', build: 'build', 自动编辑: 'edit', edit: 'edit', acceptedits: 'edit',
  计划模式: 'plan', plan: 'plan', 完全访问: 'yolo', yolo: 'yolo',
  defaultmode: 'build', 默认模式: 'build', 变更前确认: 'build',
  dontask: 'yolo', bypasspermissions: 'yolo', autoedit: 'autoEdit',
  自动: 'auto', auto: 'auto',
};
export function normalizeBoostMode(v) {
  if (typeof v !== 'string') return null;
  return MODE_ALIASES[v.trim().toLowerCase()] || null;
}

// The conversation a mode push should target. Best signal: the sessionId
// inside a renderer→host command envelope (every v4 conversation command
// carries one; sending a prompt is the clearest "user is working HERE").
// Cheap prefilter on the raw bytes before any regex work.
export function scanCommandSessionId(payload) {
  if (!payload || payload.length < 16 || payload.length > 512 * 1024) return null;
  if (payload.indexOf('sessionId') < 0) return null;
  const m = payload.toString('utf8').match(/"sessionId":"(sess_[0-9a-f-]{8,})"/);
  return m ? m[1] : null;
}

// Fallback signal: the host streams conversation topic frames
// ("conversation/sess_xxx") for the active dialogue — remember the most
// recent one so a mode push still has a target when the user has not sent a
// prompt since the last host restart.
export function scanTopicSessionId(payload) {
  if (!payload || payload.length < 16) return null;
  if (payload.indexOf('conversation/sess_') < 0) return null;
  const m = payload.toString('utf8').match(/conversation\/(sess_[0-9a-f-]{8,})/);
  return m ? m[1] : null;
}
