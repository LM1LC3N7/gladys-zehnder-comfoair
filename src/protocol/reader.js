// -----------------------------------------------------------------------------
// Cuts the TCP stream of the bridge into packets: a 4-byte big-endian length,
// then that many bytes. Bounded and linear:
// - a length under the fixed header (34 bytes) or over LIMITS.maxPacket is a
//   protocol error: the stream cannot be resynchronised, the session is cut
//   (onError), nothing more is read;
// - the chunks are kept in a list and joined once per packet (never the whole
//   buffer copied again at each chunk); at most one packet is held.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';

const MIN_BODY = 16 + 16 + 2;

export class PacketReader {
  constructor({ onPacket, onError, maxPacket = LIMITS.maxPacket }) {
    this.onPacket = onPacket;
    this.onError = onError;
    this.maxPacket = maxPacket;
    this.chunks = [];
    this.size = 0;
    this.need = undefined;
    this.dead = false;
  }

  /** The first `n` bytes held (n <= this.size), removed from the list. */
  take(n) {
    const parts = [];
    let left = n;
    while (left > 0) {
      const head = this.chunks[0];
      if (head.length <= left) {
        parts.push(head);
        this.chunks.shift();
        left -= head.length;
      } else {
        parts.push(head.subarray(0, left));
        this.chunks[0] = head.subarray(left);
        left = 0;
      }
    }
    this.size -= n;
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, n);
  }

  push(chunk) {
    if (this.dead || chunk.length === 0) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    for (;;) {
      if (this.dead) return;
      if (this.need === undefined) {
        if (this.size < 4) return;
        const length = this.take(4).readUInt32BE(0);
        if (length < MIN_BODY || length > this.maxPacket) {
          this.fail(`invalid packet length ${length}`);
          return;
        }
        this.need = length;
      }
      if (this.size < this.need) return;
      const body = this.take(this.need);
      this.need = undefined;
      this.onPacket(body);
    }
  }

  fail(reason) {
    this.dead = true;
    this.chunks = [];
    this.size = 0;
    this.onError(new Error(reason));
  }
}
