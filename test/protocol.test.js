// The protocol layer against the byte examples of aiocomfoconnect's
// docs/PROTOCOL.md, and its bounds: the protobuf codec, the packet reader,
// the attribution of the answers, the discovery, the sensor values.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { OP, PDO_TYPE, RESULT } from '../src/constants.js';
import { ComfoClient, ComfoError } from '../src/protocol/client.js';
import { discoverBridge, parseDiscovery } from '../src/protocol/discovery.js';
import { decodeValue, rmiText } from '../src/protocol/link.js';
import {
  GatewayOperation,
  RegisterAppRequest,
  decodePacket,
  encodePacket,
} from '../src/protocol/messages.js';
import { ProtobufError, decode, encode, field } from '../src/protocol/protobuf.js';
import { PacketReader } from '../src/protocol/reader.js';
import { FakeClock, settle } from './helpers/fakeBridge.js';

const hex = (text) => Buffer.from(text.replace(/\s+/g, ''), 'hex');

// docs/PROTOCOL.md, "Manually decoding a packet".
const APP = 'a886190220044d68a07d85a2e3866fce';
const BRIDGE = '0000000000251010800170b3d54264b4';
const OP_HEX = '08022002';
const MSG_HEX = '0a10a886190220044d68a07d85a2e3866fce10001a126950686f6e652076616e2044657374696e79';

test('protobuf: the RegisterApp example of PROTOCOL.md, byte for byte', () => {
  assert.deepEqual(encode(GatewayOperation, { type: 2, reference: 2 }), hex(OP_HEX));
  const message = { uuid: hex(APP), pin: 0, devicename: 'iPhone van Destiny' };
  assert.deepEqual(encode(RegisterAppRequest, message), hex(MSG_HEX));
  const packet = encodePacket({ src: APP, dst: BRIDGE, type: 2, reference: 2, message });
  assert.deepEqual(packet, hex(`0000004e ${APP} ${BRIDGE} 0004 ${OP_HEX} ${MSG_HEX}`));
  const back = decodePacket(packet.subarray(4));
  assert.equal(back.src, APP);
  assert.equal(back.dst, BRIDGE);
  assert.equal(back.op.type, 2);
  assert.equal(back.op.reference, 2);
  assert.equal(back.op.result, 0, 'proto2 default');
  assert.equal(back.msg.devicename, 'iPhone van Destiny');
  assert.equal(back.msg.pin, 0);
});

test('discovery: the answer of PROTOCOL.md', () => {
  const answer = parseDiscovery(
    hex('12230a0d3139322e3136382e312e32313312100000000000251010800170b3d54264b41801'),
  );
  assert.deepEqual(answer, { uuid: BRIDGE, type: 0, ip: '192.168.1.213' });
  assert.equal(parseDiscovery(hex('0a00')), undefined, 'our own request');
  assert.equal(parseDiscovery(Buffer.alloc(600)), undefined, 'too long');
  assert.equal(parseDiscovery(hex('120412020000')), undefined, 'a short UUID');
});

test('discovery: unicast to the address, answers of others ignored, two tries', async () => {
  const clock = new FakeClock();
  const sockets = [];
  const factory = () => {
    const socket = new EventEmitter();
    socket.sent = [];
    socket.send = (data, port, host, cb) => {
      socket.sent.push([Buffer.from(data).toString('hex'), port, host]);
      cb?.();
    };
    socket.close = () => {
      socket.closed = true;
    };
    sockets.push(socket);
    return socket;
  };
  const pending = discoverBridge('192.0.2.20', { timers: clock, socketFactory: factory });
  const socket = sockets[0];
  assert.deepEqual(socket.sent[0], ['0a00', 56747, '192.0.2.20']);
  const reply = hex('12230a0d3139322e3136382e312e32313312100000000000251010800170b3d54264b41801');
  socket.emit('message', reply, { address: '192.0.2.99' });
  await clock.advance(2_100);
  assert.equal(socket.sent.length, 2, 'asked again');
  socket.emit('message', reply, { address: '192.0.2.20' });
  const answer = await pending;
  assert.equal(answer.uuid, BRIDGE);
  assert.ok(socket.closed);
  const silent = discoverBridge('192.0.2.20', { timers: clock, socketFactory: factory });
  const failed = assert.rejects(silent, /did not answer/);
  await clock.advance(5_000);
  await failed;
});

test('protobuf: unknown fields skipped, bounds checked, no prototype pollution', () => {
  const schema = [field(1, 'a', 'uint32'), field(2, 'b', 'string')];
  // Field 3 (unknown, varint), field 9 (unknown, bytes), field 4 (fixed32), then a = 300.
  const data = hex('1801 4a03616263 2d01020304 08ac02');
  const out = decode(schema, data);
  assert.deepEqual(Object.keys(out).sort(), ['a']);
  assert.equal(out.a, 300);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.throws(() => decode(schema, hex('1205 6162')), ProtobufError, 'length over the buffer');
  assert.throws(
    () => decode(schema, hex('08ffffffffffffffffffff01')),
    ProtobufError,
    'varint too long',
  );
  assert.throws(() => decode(schema, hex('0b')), ProtobufError, 'groups');
  assert.throws(() => decode(schema, hex('08')), ProtobufError, 'truncated');
  // A uint32 above 32 bits keeps its low 32 bits, never a huge number.
  assert.equal(decode(schema, hex('08ffffffffff01')).a, 0xffffffff);
  assert.throws(() => encode(schema, { a: -1 }), ProtobufError);
  assert.throws(() => encode(schema, { a: 2 ** 32 }), ProtobufError);
});

test('reader: a packet cut anywhere, several in one chunk; a bad length stops it', () => {
  const packets = [];
  const errors = [];
  const reader = new PacketReader({
    onPacket: (b) => packets.push(b),
    onError: (e) => errors.push(e),
  });
  const one = encodePacket({ src: APP, dst: BRIDGE, type: OP.KEEP_ALIVE });
  const two = encodePacket({
    src: APP,
    dst: BRIDGE,
    type: OP.CN_TIME_CONFIRM,
    reference: 5,
    message: { currentTime: 7 },
  });
  const stream = Buffer.concat([one, two, one]);
  for (const byte of stream) reader.push(Buffer.from([byte]));
  assert.equal(packets.length, 3);
  assert.deepEqual(packets[1], two.subarray(4));
  reader.push(Buffer.concat([one, two]));
  assert.equal(packets.length, 5);
  assert.equal(errors.length, 0);
  reader.push(hex('00100000'));
  assert.equal(errors.length, 1, 'a length over the limit');
  reader.push(one);
  assert.equal(packets.length, 5, 'nothing more read after a broken length');
  const short = new PacketReader({ onPacket: () => {}, onError: (e) => errors.push(e) });
  short.push(hex('00000004 01020304'));
  assert.equal(errors.length, 2, 'a length under the header');
});

test('reader: a large stream is cut in linear time', () => {
  let count = 0;
  const reader = new PacketReader({ onPacket: () => (count += 1), onError: assert.fail });
  const one = encodePacket({ src: APP, dst: BRIDGE, type: OP.KEEP_ALIVE });
  const stream = Buffer.concat(Array.from({ length: 20_000 }, () => one));
  const started = process.hrtime.bigint();
  for (let i = 0; i < stream.length; i += 7) reader.push(stream.subarray(i, i + 7));
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(count, 20_000);
  assert.ok(ms < 2_000, `${ms} ms`);
});

/** A client on a socket the test drives by hand. */
function wired() {
  const clock = new FakeClock();
  const socket = new EventEmitter();
  socket.written = [];
  socket.write = (bytes) => socket.written.push(decodePacket(Buffer.from(bytes).subarray(4)));
  socket.destroy = () => {};
  socket.removeAllListeners = EventEmitter.prototype.removeAllListeners.bind(socket);
  const client = new ComfoClient({ connect: () => socket, timers: clock, now: clock.now });
  const answer = (type, reference, { result, message = {}, dst = APP } = {}) => {
    const bytes = encodePacket({ src: BRIDGE, dst, type, reference, message });
    let out = bytes;
    if (result) {
      const opLength = bytes.readUInt16BE(36);
      const op = Buffer.concat([bytes.subarray(38, 38 + opLength), Buffer.from([0x10, result])]);
      const msg = bytes.subarray(38 + opLength);
      out = Buffer.alloc(38 + op.length + msg.length);
      out.writeUInt32BE(out.length - 4, 0);
      bytes.copy(out, 4, 4, 36);
      out.writeUInt16BE(op.length, 36);
      op.copy(out, 38);
      msg.copy(out, 38 + op.length);
    }
    socket.emit('data', out);
  };
  return { clock, socket, client, answer };
}

async function opened() {
  const w = wired();
  const opening = w.client.open({ host: 'h', localUuid: APP, bridgeUuid: BRIDGE });
  w.socket.emit('connect');
  await opening;
  return w;
}

test('client: an answer belongs to its request (reference AND type AND our UUID)', async () => {
  const { client, socket, answer, clock } = await opened();
  const rmi = client.request(OP.CN_RMI_REQUEST, { nodeId: 1, message: hex('83150101') });
  const time = client.request(OP.CN_TIME_REQUEST);
  const [first, second] = socket.written;
  assert.notEqual(first.op.reference, second.op.reference);
  assert.ok(first.op.reference > 0);
  // The reference of the RMI with the type of another answer: never taken.
  answer(OP.CN_TIME_CONFIRM, first.op.reference, { message: { currentTime: 1 } });
  // The right answer sent to another app: ignored.
  answer(OP.CN_RMI_RESPONSE, first.op.reference, { message: { message: hex('09') }, dst: BRIDGE });
  // An answer to no request: ignored.
  answer(OP.CN_RMI_RESPONSE, 999, { message: { message: hex('07') } });
  answer(OP.CN_TIME_CONFIRM, second.op.reference, { message: { currentTime: 42 } });
  answer(OP.CN_RMI_RESPONSE, first.op.reference, { message: { message: hex('02') } });
  assert.deepEqual((await rmi).msg.message, hex('02'));
  assert.equal((await time).msg.currentTime, 42);
  await clock.advance(10);
});

test('client: an error result, a timeout after the write, a deadline before it', async () => {
  const { client, socket, answer, clock } = await opened();
  const refused = client.request(OP.START_SESSION_REQUEST, { takeover: false });
  answer(OP.START_SESSION_CONFIRM, socket.written[0].op.reference, {
    result: RESULT.OTHER_SESSION,
    message: { devicename: 'Phone' },
  });
  await assert.rejects(refused, (err) => {
    assert.ok(err instanceof ComfoError);
    assert.equal(err.kind, 'result');
    assert.equal(err.result, RESULT.OTHER_SESSION);
    assert.equal(err.reply.devicename, 'Phone');
    assert.equal(err.sent, true);
    return true;
  });
  const silent = client.request(OP.CN_TIME_REQUEST, {}, { timeout: 1_000 });
  const rejected = assert.rejects(silent, (err) => err.kind === 'timeout' && err.sent === true);
  await clock.advance(1_100);
  await rejected;
  const written = socket.written.length;
  await assert.rejects(
    client.request(OP.CN_TIME_REQUEST, {}, { sendBy: clock.now() - 1 }),
    (err) => err.kind === 'late' && err.sent === false,
  );
  await assert.rejects(
    client.request(OP.CN_TIME_REQUEST, {}, { check: () => false }),
    (err) => err.kind === 'withdrawn' && err.sent === false,
  );
  assert.equal(socket.written.length, written, 'neither was written');
  // The connection ends: a written request fails as written.
  const lost = client.request(OP.CN_TIME_REQUEST);
  socket.emit('close');
  await assert.rejects(lost, (err) => err.kind === 'lost' && err.sent === true);
  await settle();
});

test('client: a malformed packet is dropped, the session goes on', async () => {
  const { client, socket, answer } = await opened();
  const time = client.request(OP.CN_TIME_REQUEST);
  // An operation length over the packet.
  socket.emit('data', hex(`00000024 ${APP} ${BRIDGE} 00ff 0801`));
  answer(OP.CN_TIME_CONFIRM, socket.written[0].op.reference, { message: { currentTime: 3 } });
  assert.equal((await time).msg.currentTime, 3);
  assert.equal(client.connected, true);
});

test('sensor values: exact size, little-endian, signed or not, padding ignored', () => {
  const padded = (bytes) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(8 - bytes.length)]);
  assert.equal(decodeValue(padded([0xf4, 0xff]), PDO_TYPE.INT16), -12);
  assert.equal(decodeValue(padded([0xf4, 0xff]), PDO_TYPE.UINT16), 0xfff4);
  assert.equal(decodeValue(padded([0xff]), PDO_TYPE.UINT8), 255);
  assert.equal(decodeValue(padded([0x82, 0x00]), PDO_TYPE.UINT16), 130);
  assert.equal(decodeValue(Buffer.from([1]), PDO_TYPE.UINT16), undefined, 'too short');
  assert.equal(decodeValue(Buffer.from([1, 2]), 0x99), undefined, 'unknown type');
  assert.equal(rmiText(Buffer.from('BEA0012\0junk')), 'BEA0012');
  assert.equal(rmiText(Buffer.from([0x41, 0x07, 0x42])), 'AB');
});
