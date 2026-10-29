// Child-side preload for ZCode >= 3.16 hosts.
//
// The 3.16 desktop no longer spawns a standalone `zcode-server.cjs`; it forks
// `out/host/index.js` as an Electron `utilityProcess` and drives it through
// `process.parentPort` (structured control messages, with MessagePorts
// transferred for the renderer channel). This preload recreates that contract in
// plain Node so the shim can keep running the official host as a child process:
//
//   * `process.parentPort` — an EventEmitter with `postMessage`, bridged over the
//     Node IPC channel (`child_process.fork`, advanced serialization);
//   * relay ports — duck-typed MessagePorts (on/once/off, addEventListener,
//     postMessage, start, close) whose traffic is forwarded over the same IPC
//     channel. The host treats them like the Electron ports the desktop hands it.
//
// Wire (parent <-> child), all over `process.send` / `process.on('message')`:
//   parent -> child  {__z:'pp', msg, ports:[id,...]}   control message + transferred port ids
//   parent -> child  {__z:'port-in', id, d}            one payload for a relay port
//   parent -> child  {__z:'port-close', id}            peer closed the relay port
//   child -> parent  {__z:'pp', msg, ports:[id,...]}   control message back (database-startup-state, log, ...)
//   child -> parent  {__z:'port', id, d}               one payload from a relay port
//   child -> parent  {__z:'port-close', id}            host closed its end
//
// Payloads stay binary (Buffer/Uint8Array) in both directions — the service
// connection speaks raw protocol payloads on a port (the 13-byte frame header
// belongs to stream transports only, see frame.mjs).
import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';

// Diagnostic trace (ZCODE_WEBUI_SHIM_TRACE=<path>): every control/port message
// between the host and this agent, with a monotonic timestamp. Used to locate
// stalls that show no logs on either side (eg. a 30 s admission wait).
const TRACE = process.env.ZCODE_WEBUI_SHIM_TRACE || '';
const tr = (dir, what, len) => {
  if (!TRACE) return;
  try { appendFileSync(TRACE, `${Date.now()} ${dir} ${what} ${len}\n`); } catch (_e) { /* ignore */ }
};

const ports = new Map();

class RelayPort extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this._closed = false;
    this._started = false;
  }

  postMessage(data) {
    if (this._closed) return;
    tr('out', 'port' + this.id, (data && data.length) || (data && data.byteLength) || 0);
    try { process.send({ __z: 'port', id: this.id, d: data }); } catch (_e) { /* channel gone */ }
  }

  start() { this._started = true; }

  close() {
    if (this._closed) return;
    this._closed = true;
    try { process.send({ __z: 'port-close', id: this.id }); } catch (_e) { /* channel gone */ }
    this.emit('close');
  }

  addEventListener(type, fn) {
    this.on(type, (ev) => fn(ev));
  }

  removeEventListener(type, fn) {
    this.off(type, fn);
  }

  _deliver(data) {
    if (this._closed) return;
    tr('in', 'port' + this.id, (data && data.length) || (data && data.byteLength) || 0);
    this.emit('message', { data });
  }
}

class ParentPort extends EventEmitter {
  postMessage(msg, transfer) {
    const ids = [];
    if (Array.isArray(transfer)) {
      for (const p of transfer) if (p instanceof RelayPort) ids.push(p.id);
    }
    tr('out', 'parentPort', ids.length);
    try { process.send({ __z: 'pp', msg, ports: ids }); } catch (_e) { /* channel gone */ }
  }

  start() {}
  close() { /* the host never closes the control channel itself */ }
}

const parentPort = new ParentPort();
Object.defineProperty(process, 'parentPort', {
  value: parentPort, configurable: true, writable: true, enumerable: false,
});

process.on('message', (raw) => {
  if (!raw || typeof raw !== 'object') return;
  if (raw.__z === 'pp') {
    const incoming = [];
    if (Array.isArray(raw.ports)) {
      for (const id of raw.ports) {
        const port = new RelayPort(id);
        ports.set(id, port);
        incoming.push(port);
      }
    }
    tr('in', 'parentPort', incoming.length);
    parentPort.emit('message', { data: raw.msg, ports: incoming });
    return;
  }
  if (raw.__z === 'port-in') {
    const port = ports.get(raw.id);
    if (port) port._deliver(raw.d);
    return;
  }
  if (raw.__z === 'port-close') {
    const port = ports.get(raw.id);
    if (port) {
      port._closed = true;
      port.emit('close');
      ports.delete(raw.id);
    }
  }
});

// A dead IPC channel must not leave the host thinking the desktop is alive.
process.on('disconnect', () => { try { process.exit(0); } catch (_e) { /* ignore */ } });

try { process.send({ __z: "ready" }); } catch (_e) { /* no IPC channel */ }
