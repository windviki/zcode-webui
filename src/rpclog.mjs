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
