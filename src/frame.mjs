// Wire frame codec for the stdio protocol spoken by the official zcode host service.
// Frame layout (big-endian, 13-byte header):
//   byte 0      : message type (1 = Regular)
//   bytes 1..4  : id (u32 BE)
//   bytes 5..8  : ack (u32 BE)
//   bytes 9..12 : payload length (u32 BE)
//   payload     : length bytes (the serialized channel-protocol message)

export const HEADER_SIZE = 13;

export function encodeFrame(payload) {
  const buf = Buffer.alloc(HEADER_SIZE + payload.length);
  buf.writeUInt8(1, 0);            // Regular
  buf.writeUInt32BE(0, 1);         // id
  buf.writeUInt32BE(0, 5);         // ack
  buf.writeUInt32BE(payload.length, 9);
  payload.copy(buf, HEADER_SIZE);
  return buf;
}

// Incremental parser that splits a byte stream into payload buffers.
export class FrameParser {
  constructor(onFrame) {
    this._onFrame = onFrame;
    this._buf = Buffer.alloc(0);
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    this._buf = this._buf.length === 0 ? chunk : Buffer.concat([this._buf, chunk]);
    for (;;) {
      if (this._buf.length < HEADER_SIZE) return;
      const len = this._buf.readUInt32BE(9);
      const total = HEADER_SIZE + len;
      if (this._buf.length < total) return;
      const payload = this._buf.subarray(HEADER_SIZE, total);
      this._buf = this._buf.subarray(total);
      try {
        this._onFrame(payload);
      } catch (err) {
        console.error('[frame] onFrame error:', err);
      }
    }
  }
}
