// -----------------------------------------------------------------------------
// The UUID of the bridge, asked by UDP (aiocomfoconnect discovery.py): the
// request `0a 00` sent to the address of the bridge, port 56747, answers a
// DiscoveryOperation with its IP address, UUID and type. Unicast only (to
// the address typed in the configuration): a broadcast does not leave a
// Docker bridge network.
//
// Bounded: an answer over LIMITS.maxDatagram bytes is ignored; only an answer
// from the address asked counts when it is an IP address; two tries of 2 s.
// -----------------------------------------------------------------------------

import { createSocket } from 'node:dgram';
import { isIP } from 'node:net';
import { GATEWAY_TYPE, LIMITS, PORT, TIMINGS } from '../constants.js';
import { DISCOVERY_REQUEST, DiscoveryOperation } from './messages.js';
import { decode } from './protobuf.js';

/** A datagram -> { uuid, type, ip } or undefined when it is not a bridge's answer. */
export function parseDiscovery(data) {
  if (!Buffer.isBuffer(data) || data.length === 0 || data.length > LIMITS.maxDatagram) {
    return undefined;
  }
  let answer;
  try {
    answer = decode(DiscoveryOperation, data).searchGatewayResponse;
  } catch {
    return undefined;
  }
  if (!answer || !Buffer.isBuffer(answer.uuid) || answer.uuid.length !== 16) return undefined;
  const type = answer.type ?? GATEWAY_TYPE.LANC;
  return {
    uuid: answer.uuid.toString('hex'),
    type: Object.values(GATEWAY_TYPE).includes(type) ? type : GATEWAY_TYPE.LANC,
    ip: typeof answer.ipaddress === 'string' ? answer.ipaddress.slice(0, 45) : '',
  };
}

/** Asks the bridge at `host` for its UUID; rejects when nothing answers. */
export function discoverBridge(
  host,
  {
    timers = globalThis,
    socketFactory = () => createSocket('udp4'),
    tries = TIMINGS.discoveryTries,
    timeout = TIMINGS.discoveryTimeout,
  } = {},
) {
  return new Promise((resolve, reject) => {
    let socket;
    let timer;
    let attempt = 0;
    let finished = false;
    const finish = (err, value) => {
      if (finished) return;
      finished = true;
      timers.clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // already closed
      }
      if (err) reject(err);
      else resolve(value);
    };
    const send = () => {
      attempt += 1;
      socket.send(DISCOVERY_REQUEST, PORT, host, (err) => {
        if (err) finish(new Error(`discovery request failed: ${err.code ?? err.message}`));
      });
      timer = timers.setTimeout(() => {
        if (attempt >= tries) finish(new Error('the bridge did not answer the discovery'));
        else send();
      }, timeout);
    };
    try {
      socket = socketFactory();
    } catch (err) {
      finish(err);
      return;
    }
    socket.on('error', (err) => finish(new Error(`discovery failed: ${err.code ?? err.message}`)));
    socket.on('message', (data, rinfo) => {
      if (isIP(host) && rinfo?.address !== host) return;
      const answer = parseDiscovery(data);
      if (answer) finish(undefined, answer);
    });
    try {
      send();
    } catch (err) {
      finish(err);
    }
  });
}
