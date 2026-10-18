// -----------------------------------------------------------------------------
// An in-memory ComfoConnect LAN C and ComfoAir Q: no socket, no network.
// `connect` is given to the client in place of net.createConnection; each
// call opens a session where the simulated bridge answers the registration,
// the session, the node request, the RMI reads and commands, the sensor
// subscriptions and the keep-alive the way aiocomfoconnect expects them;
// records what the client wrote; can stay silent, refuse, close the session.
//
// The packets are built with src/protocol/messages.js (its protobuf codec is
// pinned separately against the byte examples of aiocomfoconnect's
// docs/PROTOCOL.md in test/protocol.test.js).
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { OP, RESULT } from '../../src/constants.js';
import { decodePacket, encodePacket } from '../../src/protocol/messages.js';
import { PacketReader } from '../../src/protocol/reader.js';

export const BRIDGE_UUID = '0000000000251010800170b3d54264b4';

/** Lets every queued delivery and the promise chains behind it run. */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Settles until `check()` is true. */
export async function until(check, rounds = 400) {
  for (let i = 0; i < rounds; i += 1) {
    if (check()) return;
    await settle(5);
  }
  throw new Error('condition never met');
}

class FakeSocket extends EventEmitter {
  constructor(bridge) {
    super();
    this.bridge = bridge;
    this.destroyed = false;
    this.reader = new PacketReader({
      onPacket: (body) => bridge.receive(this, body),
      onError: () => this.destroy(),
    });
  }

  setNoDelay() {}

  setKeepAlive() {}

  write(bytes) {
    if (this.destroyed) throw new Error('write after destroy');
    const copy = Buffer.from(bytes);
    queueMicrotask(() => {
      if (!this.destroyed) this.reader.push(copy);
    });
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
  }

  /** Bridge side: a packet to the client. */
  send(type, { reference, result, message = {}, dst } = {}) {
    if (this.destroyed) return;
    const bytes = encodePacket({
      src: this.bridge.uuid,
      dst: dst ?? this.app,
      type,
      reference,
      message,
    });
    if (result) {
      // The result goes in the operation: re-encode it by hand (field 2, varint).
      const opLength = bytes.readUInt16BE(36);
      const op = bytes.subarray(38, 38 + opLength);
      const withResult = Buffer.concat([op, Buffer.from([0x10, result])]);
      const msg = bytes.subarray(38 + opLength);
      const out = Buffer.alloc(38 + withResult.length + msg.length);
      out.writeUInt32BE(out.length - 4, 0);
      bytes.copy(out, 4, 4, 36);
      out.writeUInt16BE(withResult.length, 36);
      withResult.copy(out, 38);
      msg.copy(out, 38 + withResult.length);
      return this.raw(out);
    }
    return this.raw(bytes);
  }

  raw(bytes) {
    queueMicrotask(() => {
      if (!this.destroyed) this.emit('data', Buffer.from(bytes));
    });
  }
}

const le16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeInt16LE(v);
  return b;
};

export class FakeBridge {
  constructor({
    pin = 0,
    registered = [],
    maxApps = 6,
    serial = 'BEA001122334455',
    model = 'ComfoAir Q450 B R RF ST Quality',
    speed = 2,
    manual = false,
    otherSession = undefined,
  } = {}) {
    this.uuid = BRIDGE_UUID;
    this.pin = pin;
    this.apps = new Map(registered.map((uuid) => [uuid, 'old app']));
    this.maxApps = maxApps;
    this.serial = serial;
    this.model = model;
    this.speed = speed;
    this.manual = manual;
    this.otherSession = otherSession;
    this.sockets = [];
    /** Every request: { session, type, reference, msg }. */
    this.log = [];
    /** (entry) -> true: that request gets no answer. */
    this.hold = () => false;
    /** (entry) -> delay in ms of the virtual clock before the answer, or 0. */
    this.refuseConnections = 0;
    this.sendZerosFirst = true;
    this.connect = this.connect.bind(this);
    this.values = new Map([
      [276, le16(85)],
      [274, le16(214)],
      [221, le16(190)],
      [275, le16(-12)],
      [292, Buffer.from([80])],
      [290, Buffer.from([48])],
      [294, Buffer.from([35])],
      [291, Buffer.from([90])],
      [120, Buffer.from([150, 0])],
      [119, Buffer.from([145, 0])],
      [227, Buffer.from([0])],
      [66, Buffer.from([0])],
      [192, Buffer.from([0x82, 0])],
      [49, Buffer.from([255])],
    ]);
  }

  connect(options) {
    this.options = options;
    const socket = new FakeSocket(this);
    socket.session = this.sockets.length + 1;
    this.sockets.push(socket);
    if (this.refuseConnections > 0) {
      this.refuseConnections -= 1;
      queueMicrotask(() => {
        const err = new Error('connect ECONNREFUSED');
        err.code = 'ECONNREFUSED';
        socket.emit('error', err);
      });
      return socket;
    }
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  }

  get current() {
    return this.sockets.at(-1);
  }

  /** Requests of a type. */
  sent(type) {
    return this.log.filter((e) => e.type === type);
  }

  /** The RMI messages written, as arrays of bytes. */
  get rmis() {
    return this.sent(OP.CN_RMI_REQUEST).map((e) => [...e.msg.message]);
  }

  receive(socket, body) {
    const { src, op, msg } = decodePacket(body);
    socket.app = src;
    const entry = { session: socket.session, type: op.type, reference: op.reference, msg, src };
    this.log.push(entry);
    if (this.hold(entry)) return;
    this.respond(socket, entry);
  }

  pdoValue(pdid) {
    if (pdid === 65) return Buffer.from([this.speed]);
    if (pdid === 56) return Buffer.from([this.manual ? 1 : 255]);
    return this.values.get(pdid);
  }

  /** A sensor notification, padded to 8 bytes as the bridge may do. */
  notify(socket, pdid, data = this.pdoValue(pdid)) {
    if (!data) return;
    const padded = Buffer.alloc(8);
    data.copy(padded);
    socket.send(OP.CN_RPDO_NOTIFICATION, { message: { pdid, data: padded } });
  }

  nodes(socket) {
    socket.send(OP.CN_NODE_NOTIFICATION, {
      message: { nodeId: 1, productId: 1, zoneId: 1, mode: 2 },
    });
    socket.send(OP.CN_NODE_NOTIFICATION, {
      message: { nodeId: 48, productId: 5, zoneId: 255, mode: 2 },
    });
  }

  respond(socket, { type, reference, msg, src }) {
    const reply = (confirm, options = {}) => socket.send(confirm, { reference, ...options });
    switch (type) {
      case OP.START_SESSION_REQUEST:
        if (!this.apps.has(src))
          return reply(OP.START_SESSION_CONFIRM, { result: RESULT.NOT_ALLOWED });
        if (this.otherSession !== undefined && !msg.takeover) {
          return reply(OP.START_SESSION_CONFIRM, {
            result: RESULT.OTHER_SESSION,
            message: { devicename: this.otherSession },
          });
        }
        reply(OP.START_SESSION_CONFIRM);
        return this.nodes(socket);
      case OP.REGISTER_APP_REQUEST:
        if (msg.pin !== this.pin)
          return reply(OP.REGISTER_APP_CONFIRM, { result: RESULT.NOT_ALLOWED });
        if (!this.apps.has(src) && this.apps.size >= this.maxApps) {
          return reply(OP.REGISTER_APP_CONFIRM, { result: RESULT.NO_RESOURCES });
        }
        this.apps.set(msg.uuid.toString('hex'), msg.devicename);
        return reply(OP.REGISTER_APP_CONFIRM);
      case OP.CN_NODE_REQUEST:
        return this.nodes(socket);
      case OP.CN_TIME_REQUEST:
        return reply(OP.CN_TIME_CONFIRM, { message: { currentTime: 123456 } });
      case OP.LIST_REGISTERED_APPS_REQUEST:
        return reply(OP.LIST_REGISTERED_APPS_CONFIRM, {
          message: {
            apps: [...this.apps].map(([uuid, devicename]) => ({
              uuid: Buffer.from(uuid, 'hex'),
              devicename,
            })),
          },
        });
      case OP.CN_RPDO_REQUEST: {
        reply(OP.CN_RPDO_CONFIRM);
        // The bridge sends a zero first, then the real value (aiocomfoconnect's hold).
        if (this.sendZerosFirst && this.pdoValue(msg.pdid))
          this.notify(socket, msg.pdid, Buffer.alloc(2));
        return this.notify(socket, msg.pdid);
      }
      case OP.CN_RMI_REQUEST:
        return this.rmi(socket, reply, [...msg.message]);
      default:
        return undefined;
    }
  }

  rmi(socket, reply, bytes) {
    const answer = (data) => reply(OP.CN_RMI_RESPONSE, { message: { message: Buffer.from(data) } });
    const key = bytes.slice(0, 4).join(',');
    if (key === '1,1,1,16' && bytes[4] === 4)
      return answer(Buffer.from(`${this.serial}\0`, 'latin1'));
    if (key === '1,1,1,16' && bytes[4] === 8)
      return answer(Buffer.from(`${this.model}\0`, 'latin1'));
    if (key === '131,21,1,1') {
      return answer([1, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, this.speed]);
    }
    if (key === '131,21,8,1') {
      return answer(
        this.manual
          ? [1, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 1]
          : [0, 0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0, 1],
      );
    }
    if (key === '132,21,1,1' && bytes.length === 13) {
      this.speed = bytes[12];
      answer([]);
      return this.notify(socket, 65);
    }
    if (key === '132,21,8,1' && bytes.length === 13) {
      this.manual = true;
      answer([]);
      return this.notify(socket, 56);
    }
    if (key === '133,21,8,1') {
      this.manual = false;
      answer([]);
      return this.notify(socket, 56);
    }
    if (key === '133,21,1,1') return answer([]);
    return reply(OP.CN_RMI_RESPONSE, { result: RESULT.RMI_ERROR, message: { result: 11 } });
  }

  /** Another app takes the session over. */
  takeOver() {
    this.current.send(OP.CLOSE_SESSION_REQUEST);
  }

  drop() {
    this.current.destroy();
  }
}

/**
 * A virtual clock for the client and the app (`timers` and `now`): nothing
 * waits for real; advance() runs the timers due, in order, letting the
 * promises settle between them.
 */
export class FakeClock {
  constructor(start = 1_000_000) {
    this.time = start;
    this.entries = new Map();
    this.ids = 0;
    this.now = () => this.time;
    this.setTimeout = (fn, ms) => this.add(fn, ms, undefined);
    this.setInterval = (fn, ms) => this.add(fn, ms, ms);
    this.clearTimeout = (id) => this.entries.delete(id);
    this.clearInterval = (id) => this.entries.delete(id);
  }

  add(fn, ms, every) {
    this.ids += 1;
    this.entries.set(this.ids, { at: this.time + Math.max(0, ms || 0), fn, every });
    return this.ids;
  }

  async advance(ms) {
    const end = this.time + ms;
    for (;;) {
      await settle(3);
      let next;
      for (const [id, entry] of this.entries) {
        if (entry.at <= end && (!next || entry.at < next[1].at)) next = [id, entry];
      }
      if (!next) break;
      const [id, entry] = next;
      this.time = Math.max(this.time, entry.at);
      if (entry.every) entry.at = this.time + entry.every;
      else this.entries.delete(id);
      entry.fn();
    }
    this.time = end;
    await settle();
  }
}

export const quietLogger = () => {
  const lines = [];
  const log = (level) => (message) => lines.push(`${level} ${message}`);
  return {
    lines,
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
};
