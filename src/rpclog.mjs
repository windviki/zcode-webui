// Minimal ZCode RPC message decoder (for diagnostics). Decodes the serialized
// channel-protocol message envelope: serialize(header) + serialize(body),
// header = [type, id, channelName, method]. Presets: 0 undefined, 1 string,
// 2 buffer, 3 vsbuffer, 4 array, 5 object(json), 6 int(VQL).

function readVQL(buf, off) {
  let v = 0, n = 0;
  for (;;) {
    const b = buf[off++];
    v |= (b & 127) << n;
    if (!(b & 128)) return [v >>> 0, off];
    n += 7;
  }
}

function deserialize(buf, off) {
  const t = buf[off++];
  switch (t) {
    case 0: return [undefined, off];
    case 1: { const [len, o2] = readVQL(buf, off); return [buf.subarray(o2, o2 + len).toString('utf8'), o2 + len]; }
    case 2: case 3: { const [len, o2] = readVQL(buf, off); return [buf.subarray(o2, o2 + len), o2 + len]; }
    case 4: {
      const [len, o2] = readVQL(buf, off);
      const arr = [];
      let o3 = o2;
      for (let i = 0; i < len; i++) { const [v, o4] = deserialize(buf, o3); arr.push(v); o3 = o4; }
      return [arr, o3];
    }
    case 5: { const [len, o2] = readVQL(buf, off); return [JSON.parse(buf.subarray(o2, o2 + len).toString('utf8')), o2 + len]; }
    case 6: { const [v, o2] = readVQL(buf, off); return [v, o2]; }
    default: throw new Error('unknown preset ' + t);
  }
}

export function decodeRpc(payload) {
  try {
    const [header, off] = deserialize(payload, 0);
    if (!Array.isArray(header)) return null;
    const [body] = deserialize(payload, off);
    return { type: header[0], id: header[1], channel: header[2], method: header[3], body, bodyLen: payload.length - off };
  } catch (_e) {
    return { error: String(_e && _e.message) };
  }
}

// Header-only decode that also reports where the body bytes start, so a mux can
// splice the payload with a rewritten header while keeping the body untouched.
export function decodeRpcHeader(payload) {
  try {
    const [header, off] = deserialize(payload, 0);
    if (!Array.isArray(header)) return null;
    return { type: header[0], id: header[1], channel: header[2], method: header[3], headerEnd: off, headerLen: header.length };
  } catch (_e) {
    return null;
  }
}

function vqlBytes(v) {
  v = v >>> 0;
  if (v === 0) return Buffer.from([0]);
  const b = [];
  let x = v;
  while (x !== 0) { b.push(x & 127); x = x >>> 7; }
  for (let i = 0; i < b.length - 1; i++) b[i] |= 128;
  return Buffer.from(b);
}

// Byte length of the VQL varint starting at buf[off].
function vqlByteLen(buf, off) {
  let n = 0;
  while (off + n < buf.length && (buf[off + n] & 128)) n++;
  return n + 1;
}

// Replace ONLY the request/response id inside a serialized channel message
// (header element 1, always preset 6 + VQL) with a new id — everything else,
// including exotic presets the official serializer may use, stays byte-identical.
export function rewriteRpcId(payload, newId) {
  try {
    // payload[0] must be the array preset (4); [1] = element count (VQL)
    if (payload[0] !== 4) return null;
    const afterLen = 1 + vqlByteLen(payload, 1);
    if (payload[afterLen] !== 6) return null;              // type element: preset 6
    const typeVqlLen = vqlByteLen(payload, afterLen + 1);
    const idPresetOff = afterLen + 1 + typeVqlLen;
    if (payload[idPresetOff] !== 6) return null;           // id element: preset 6
    const idVqlLen = vqlByteLen(payload, idPresetOff + 1);
    return Buffer.concat([
      payload.subarray(0, idPresetOff + 1),
      vqlBytes(newId),
      payload.subarray(idPresetOff + 1 + idVqlLen),
    ]);
  } catch (_e) {
    return null;
  }
}

export function encodeRpcHeader(header) {
  const parts = [Buffer.from([4]), vqlBytes(header.length)];
  for (let i = 0; i < header.length; i++) {
    const v = header[i];
    if (v === undefined || v === null) parts.push(Buffer.from([0]));
    else if (i < 2) parts.push(Buffer.from([6]), vqlBytes(v));           // type, id: ints
    else if (typeof v === 'number') parts.push(Buffer.from([6]), vqlBytes(v));
    else {
      const b = Buffer.from(String(v), 'utf8');
      parts.push(Buffer.from([1]), vqlBytes(b.length), b);               // channel, method: strings
    }
  }
  return Buffer.concat(parts);
}

export function rpcLogLine(dir, payload) {
  const d = decodeRpc(payload);
  if (!d) return null;
  if (d.error) return dir + ' <undecodable: ' + d.error + '>';
  let bodyPreview = '';
  try {
    if (d.body !== undefined) bodyPreview = JSON.stringify(d.body).slice(0, 500);
  } catch (_e) { bodyPreview = String(d.body).slice(0, 200); }
  return dir + ' type=' + d.type + ' id=' + d.id + ' ' + d.channel + '.' + d.method + ' body=' + bodyPreview;
}
