// -----------------------------------------------------------------------------
// The ComfoConnect messages this integration uses (aiocomfoconnect
// protobuf/zehnder.proto) and the packet around them (docs/PROTOCOL.md):
//
//   length   uint32 BE   length of what follows
//   src      16 bytes    the app UUID
//   dst      16 bytes    the bridge UUID
//   oplen    uint16 BE   length of the GatewayOperation
//   op       GatewayOperation (type, result, reference)
//   msg      the message named by op.type
//
// Only the message types listed in MESSAGE_SCHEMAS are decoded; any other
// type is kept as an operation without a message.
// -----------------------------------------------------------------------------

import { OP } from '../constants.js';
import { ProtobufError, decode, encode, field } from './protobuf.js';

export const GatewayOperation = [
  field(1, 'type', 'enum'),
  field(2, 'result', 'enum'),
  field(3, 'resultDescription', 'string'),
  field(4, 'reference', 'uint32'),
];

const empty = [];

export const RegisterAppRequest = [
  field(1, 'uuid', 'bytes'),
  field(2, 'pin', 'uint32'),
  field(3, 'devicename', 'string'),
];
export const StartSessionRequest = [field(1, 'takeover', 'bool')];
export const StartSessionConfirm = [field(1, 'devicename', 'string'), field(2, 'resumed', 'bool')];
const App = [field(1, 'uuid', 'bytes'), field(2, 'devicename', 'string')];
export const ListRegisteredAppsConfirm = [field(1, 'apps', 'message', { of: App, repeated: true })];
export const CnTimeRequest = [field(1, 'setTime', 'uint32')];
export const CnTimeConfirm = [field(1, 'currentTime', 'uint32')];
export const CnNodeNotification = [
  field(1, 'nodeId', 'uint32'),
  field(2, 'productId', 'uint32'),
  field(3, 'zoneId', 'uint32'),
  field(4, 'mode', 'enum'),
];
export const CnRmiRequest = [field(1, 'nodeId', 'uint32'), field(2, 'message', 'bytes')];
export const CnRmiResponse = [field(1, 'result', 'uint32'), field(2, 'message', 'bytes')];
export const CnRpdoRequest = [
  field(1, 'pdid', 'uint32'),
  field(2, 'zone', 'uint32'),
  field(3, 'type', 'uint32'),
  field(4, 'timeout', 'uint32'),
  field(5, 'interval', 'uint32'),
];
export const CnRpdoNotification = [
  field(1, 'pdid', 'uint32'),
  field(2, 'data', 'bytes'),
  field(3, 'zone', 'uint32'),
];

const SearchGatewayResponse = [
  field(1, 'ipaddress', 'string'),
  field(2, 'uuid', 'bytes'),
  field(3, 'version', 'uint32'),
  field(4, 'type', 'enum'),
];
export const DiscoveryOperation = [
  field(1, 'searchGatewayRequest', 'message', { of: empty }),
  field(2, 'searchGatewayResponse', 'message', { of: SearchGatewayResponse }),
];

/** The request "0a 00": an empty searchGatewayRequest. */
export const DISCOVERY_REQUEST = Buffer.from([0x0a, 0x00]);

/** Message type -> schema, for what the integration sends and reads. */
export const MESSAGE_SCHEMAS = new Map([
  [OP.REGISTER_APP_REQUEST, RegisterAppRequest],
  [OP.START_SESSION_REQUEST, StartSessionRequest],
  [OP.CLOSE_SESSION_REQUEST, empty],
  [OP.LIST_REGISTERED_APPS_REQUEST, empty],
  [OP.REGISTER_APP_CONFIRM, empty],
  [OP.START_SESSION_CONFIRM, StartSessionConfirm],
  [OP.CLOSE_SESSION_CONFIRM, empty],
  [OP.LIST_REGISTERED_APPS_CONFIRM, ListRegisteredAppsConfirm],
  [OP.KEEP_ALIVE, empty],
  [OP.CN_TIME_REQUEST, CnTimeRequest],
  [OP.CN_TIME_CONFIRM, CnTimeConfirm],
  [OP.CN_NODE_REQUEST, empty],
  [OP.CN_NODE_NOTIFICATION, CnNodeNotification],
  [OP.CN_RMI_REQUEST, CnRmiRequest],
  [OP.CN_RMI_RESPONSE, CnRmiResponse],
  [OP.CN_RPDO_REQUEST, CnRpdoRequest],
  [OP.CN_RPDO_CONFIRM, empty],
  [OP.CN_RPDO_NOTIFICATION, CnRpdoNotification],
]);

/** The confirm type expected for each request type that has one. */
export const CONFIRM_OF = new Map([
  [OP.REGISTER_APP_REQUEST, OP.REGISTER_APP_CONFIRM],
  [OP.START_SESSION_REQUEST, OP.START_SESSION_CONFIRM],
  [OP.LIST_REGISTERED_APPS_REQUEST, OP.LIST_REGISTERED_APPS_CONFIRM],
  [OP.CN_TIME_REQUEST, OP.CN_TIME_CONFIRM],
  [OP.CN_RMI_REQUEST, OP.CN_RMI_RESPONSE],
  [OP.CN_RPDO_REQUEST, OP.CN_RPDO_CONFIRM],
]);

const HEADER = 4 + 16 + 16 + 2;

/** 32 hex digits -> 16 bytes; throws otherwise. */
export function uuidBytes(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{32}$/.test(hex)) {
    throw new ProtobufError('a UUID is 32 lower-case hexadecimal digits');
  }
  return Buffer.from(hex, 'hex');
}

/** One packet, length prefix included. */
export function encodePacket({ src, dst, type, reference, message = {} }) {
  const schema = MESSAGE_SCHEMAS.get(type);
  if (!schema) throw new ProtobufError(`message type ${type} not supported`);
  const op = encode(GatewayOperation, { type, reference });
  const msg = encode(schema, message);
  const out = Buffer.alloc(HEADER + op.length + msg.length);
  out.writeUInt32BE(out.length - 4, 0);
  uuidBytes(src).copy(out, 4);
  uuidBytes(dst).copy(out, 20);
  out.writeUInt16BE(op.length, 36);
  op.copy(out, 38);
  msg.copy(out, 38 + op.length);
  return out;
}

/**
 * The body of one packet (after its length prefix) -> { src, dst, op, msg }.
 * `op.result` defaults to OK and `op.reference` to 0 (proto2 defaults); `msg`
 * is undefined for a message type this integration does not read. Throws
 * ProtobufError on a malformed packet.
 */
export function decodePacket(body) {
  if (body.length < HEADER - 4) throw new ProtobufError('packet too short');
  const opLength = body.readUInt16BE(32);
  if (34 + opLength > body.length) throw new ProtobufError('operation longer than the packet');
  const op = decode(GatewayOperation, body.subarray(34, 34 + opLength));
  op.type ??= OP.NO_OPERATION;
  op.result ??= 0;
  op.reference ??= 0;
  const schema = MESSAGE_SCHEMAS.get(op.type);
  const msg = schema ? decode(schema, body.subarray(34 + opLength)) : undefined;
  return {
    src: body.subarray(0, 16).toString('hex'),
    dst: body.subarray(16, 32).toString('hex'),
    op,
    msg,
  };
}
