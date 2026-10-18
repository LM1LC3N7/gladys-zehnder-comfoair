// -----------------------------------------------------------------------------
// One TCP connection to a ComfoConnect LAN C, and the requests on it. Ported
// from aiocomfoconnect bridge.py (Bridge._send, _read, _process_message,
// Message.encode / decode; MIT, see THIRD_PARTY_NOTICES.md).
//
// Changed from aiocomfoconnect:
// - an answer belongs to its request: the reference it echoes AND the confirm
//   type of that request (an RMI request is only answered by an RMI
//   response), sent to our UUID; anything else is ignored, never taken as
//   the answer of another request;
// - every request is written only if still in time (`sendBy`) and allowed
//   (`check`, called right before the socket write); a request refused there
//   was never written (`sent: false`); once written, a failure always says
//   `sent: true`;
// - the stream is cut by a bounded, linear reader (src/protocol/reader.js);
//   a malformed packet is dropped, a broken length cuts the session;
// - at most LIMITS.maxPending requests wait at once.
//
// Events: 'packet' is not emitted; notifications are: 'pdo' { pdid, data },
// 'node' { nodeId, productId, zoneId, mode }, 'close-request' (the bridge
// closes our session: another app took it over), 'down' { reason }.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { LIMITS, OP, PORT, RESULT, RESULT_NAMES, TIMINGS } from '../constants.js';
import { CONFIRM_OF, decodePacket, encodePacket } from './messages.js';
import { PacketReader } from './reader.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * kind: `offline`, `late`, `withdrawn`, `full` (never written: `sent` false),
 * `timeout` (written, no answer in time), `lost` (the connection ended),
 * `result` (the bridge answered with an error: `result`, `message`),
 * `protocol` (an answer that cannot be read).
 */
export class ComfoError extends Error {
  constructor(message, kind, { sent = false, result, reply } = {}) {
    super(message);
    this.kind = kind;
    this.sent = sent;
    this.result = result;
    this.reply = reply;
  }
}

export const resultName = (code) => RESULT_NAMES.get(code) ?? `result ${code}`;

function defaultConnect({ host, port }) {
  return createConnection({ host, port });
}

export class ComfoClient extends EventEmitter {
  constructor({
    connect = defaultConnect,
    timers = globalThis,
    now = Date.now,
    logger = silent,
  } = {}) {
    super();
    this.connectFn = connect;
    this.timers = timers;
    this.now = now;
    this.logger = logger;
    this.socket = undefined;
    this.generation = 0;
    this.connected = false;
    this.pending = new Map();
    this.reference = 0;
    this.localUuid = '';
    this.bridgeUuid = '';
    this.dropped = 0;
    this.dropLoggedAt = undefined;
  }

  /** Opens the connection; resolves once the TCP connection is up. */
  open({ host, port = PORT, localUuid, bridgeUuid }) {
    this.close('reopened');
    const generation = ++this.generation;
    this.localUuid = localUuid;
    this.bridgeUuid = bridgeUuid;
    this.reference = 0;
    return new Promise((resolve, reject) => {
      let socket;
      const fail = (reason) => {
        if (generation !== this.generation) return;
        if (!this.connected) {
          this.close(reason);
          reject(new ComfoError(reason, 'offline'));
          return;
        }
        this.lost(reason);
      };
      try {
        socket = this.connectFn({ host, port });
      } catch (err) {
        reject(new ComfoError(err.message, 'offline'));
        return;
      }
      this.socket = socket;
      const reader = new PacketReader({
        onPacket: (body) => {
          if (generation === this.generation) this.packet(body);
        },
        onError: (err) => fail(`protocol error: ${err.message}`),
      });
      const timer = this.timers.setTimeout(
        () => fail('connection timed out'),
        TIMINGS.connectTimeout,
      );
      socket.setNoDelay?.(true);
      socket.setKeepAlive?.(true, 30_000);
      socket.on('connect', () => {
        this.timers.clearTimeout(timer);
        if (generation !== this.generation) return;
        this.connected = true;
        resolve();
      });
      socket.on('data', (chunk) => {
        if (generation === this.generation) reader.push(chunk);
      });
      socket.on('error', (err) => {
        this.timers.clearTimeout(timer);
        fail(err.code ?? err.message);
      });
      socket.on('close', () => {
        this.timers.clearTimeout(timer);
        fail('connection closed by the bridge');
      });
    });
  }

  /** The connection ended by itself: every request waiting fails, 'down' is emitted. */
  lost(reason) {
    if (!this.socket) return;
    this.close(reason);
    this.emit('down', { reason });
  }

  /** Ends the connection; every request waiting fails as written. */
  close(reason = 'closed') {
    this.generation += 1;
    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    for (const entry of [...this.pending.values()]) {
      entry.fail(new ComfoError(`The connection ended (${reason})`, 'lost', { sent: true }));
    }
    this.pending.clear();
    if (!socket) return;
    socket.removeAllListeners();
    socket.on('error', () => undefined);
    socket.destroy();
  }

  /** The next reference: never 0 (the protocol keeps 0 for "none"), never one in use. */
  nextReference() {
    for (;;) {
      this.reference = this.reference >= 0x7fffffff ? 1 : this.reference + 1;
      if (!this.pending.has(this.reference)) return this.reference;
    }
  }

  /** Writes a message that has no answer (keep-alive, node request, close). */
  notify(type, message = {}) {
    if (!this.socket || !this.connected) return false;
    try {
      this.socket.write(encodePacket({ src: this.localUuid, dst: this.bridgeUuid, type, message }));
      return true;
    } catch (err) {
      this.logger.warn(`ComfoConnect: write failed (${err.message})`);
      return false;
    }
  }

  /**
   * A request and its answer. Options: `timeout` (ms from the write) or
   * `until` (a time), `sendBy` (never written after it), `check` (called right
   * before the write: false withdraws it), `onWritten`, `label` (logs).
   * Resolves with { op, msg } of the confirm; rejects with a ComfoError.
   */
  request(
    type,
    message = {},
    { timeout = TIMINGS.requestTimeout, until, sendBy, check, onWritten, label } = {},
  ) {
    return new Promise((resolve, reject) => {
      const expect = CONFIRM_OF.get(type);
      if (expect === undefined) {
        reject(new ComfoError(`No confirm for message type ${type}`, 'offline'));
        return;
      }
      if (!this.socket || !this.connected) {
        reject(new ComfoError('Not connected to the bridge', 'offline'));
        return;
      }
      if (this.pending.size >= LIMITS.maxPending) {
        reject(new ComfoError('Too many requests waiting', 'full'));
        return;
      }
      if (sendBy !== undefined && this.now() > sendBy) {
        reject(new ComfoError('Not written in time', 'late'));
        return;
      }
      if (check && !check()) {
        reject(new ComfoError('Withdrawn: not allowed any more', 'withdrawn'));
        return;
      }
      const reference = this.nextReference();
      let bytes;
      try {
        bytes = encodePacket({
          src: this.localUuid,
          dst: this.bridgeUuid,
          type,
          reference,
          message,
        });
      } catch (err) {
        reject(new ComfoError(err.message, 'offline'));
        return;
      }
      try {
        this.socket.write(bytes);
      } catch (err) {
        reject(new ComfoError(err.message, 'offline'));
        return;
      }
      onWritten?.();
      if (label) this.logger.debug(`ComfoConnect <- ${label} (#${reference})`);
      const ms = until !== undefined ? until - this.now() : timeout;
      const entry = {
        expect,
        done: (reply) => {
          this.timers.clearTimeout(entry.timer);
          this.pending.delete(reference);
          resolve(reply);
        },
        fail: (err) => {
          this.timers.clearTimeout(entry.timer);
          this.pending.delete(reference);
          reject(err);
        },
      };
      entry.timer = this.timers.setTimeout(
        () =>
          entry.fail(
            new ComfoError('No answer from the bridge in time', 'timeout', { sent: true }),
          ),
        Math.max(0, ms),
      );
      this.pending.set(reference, entry);
    });
  }

  /** Malformed packets: counted, one warning per minute at most. */
  noteDrop(reason) {
    this.dropped += 1;
    if (this.dropLoggedAt === undefined || this.now() - this.dropLoggedAt >= 60_000) {
      this.dropLoggedAt = this.now();
      this.logger.warn(`ComfoConnect: packet dropped (${reason}; ${this.dropped} so far)`);
    }
  }

  packet(body) {
    let packet;
    try {
      packet = decodePacket(body);
    } catch (err) {
      // The operation could not be read: no way to know which request it answers.
      this.noteDrop(err.message);
      return;
    }
    const { op, msg, dst } = packet;
    if (dst !== this.localUuid) {
      this.noteDrop('sent to another app');
      return;
    }
    switch (op.type) {
      case OP.CN_RPDO_NOTIFICATION:
        if (msg && Number.isInteger(msg.pdid) && Buffer.isBuffer(msg.data)) {
          this.emit('pdo', { pdid: msg.pdid, data: msg.data });
        }
        return;
      case OP.CN_NODE_NOTIFICATION:
        if (msg && Number.isInteger(msg.nodeId)) {
          this.emit('node', {
            nodeId: msg.nodeId,
            productId: msg.productId ?? 0,
            zoneId: msg.zoneId ?? 0,
            mode: msg.mode ?? 0,
          });
        }
        return;
      case OP.CLOSE_SESSION_REQUEST:
        this.emit('close-request');
        return;
      case OP.GATEWAY_NOTIFICATION:
      case OP.CN_ALARM_NOTIFICATION:
      case OP.KEEP_ALIVE:
        return;
      default:
        break;
    }
    const entry = op.reference ? this.pending.get(op.reference) : undefined;
    if (!entry) {
      this.logger.debug(`ComfoConnect: answer to no request (type ${op.type}, #${op.reference})`);
      return;
    }
    if (op.type !== entry.expect) {
      // The reference of a waiting request, but not its kind of answer: never taken.
      this.noteDrop(`answer of type ${op.type} for a request waiting for ${entry.expect}`);
      return;
    }
    if (op.result !== RESULT.OK) {
      entry.fail(
        new ComfoError(`The bridge answered ${resultName(op.result)}`, 'result', {
          sent: true,
          result: op.result,
          reply: msg,
        }),
      );
      return;
    }
    if (!msg) {
      entry.fail(new ComfoError('Answer not readable', 'protocol', { sent: true }));
      return;
    }
    entry.done({ op, msg });
  }
}
