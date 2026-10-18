// -----------------------------------------------------------------------------
// The session with the ComfoConnect LAN C: discovery of its UUID, the TCP
// connection, the registration (once), the session, the ventilation unit,
// the sensor subscriptions, the keep-alive, the reconnections. Ported from
// aiocomfoconnect comfoconnect.py (_reconnect_loop, register, _hold_sensor,
// _sensor_callback) and bridge.py (register, _process_node_notification,
// ventilation_node_id); MIT, see THIRD_PARTY_NOTICES.md.
//
// Changed from aiocomfoconnect:
// - never `takeover`: the session of another app (the Zehnder app on a phone)
//   is never closed by Gladys; Gladys waits and asks again later (1, 2, then
//   5 minutes), and 5 minutes after another app took its session over;
// - registration ONCE: only when the bridge refuses the session
//   (NOT_ALLOWED) and this UUID was never registered on this bridge; a PIN
//   refused, a full bridge, or a registration removed later all stop the
//   link (the app persists the stop): never a registration in a loop;
// - the values read from the bridge are taken at their exact size (1, 2 or 4
//   bytes, little-endian), not the whole data field, which the bridge may pad
//   to 8 bytes;
// - a keep-alive (time request) every 30 s that must be answered within
//   10 s, else the session is cut and opened again.
//
// Events: 'up' { serial, model, bridge }, 'down' { kind, reason, retryIn,
// devicename, wasReady }, 'stopped' { kind, reason }, 'value' { key, value }.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import {
  DEVICE_NAME,
  GATEWAY_TYPE,
  NODE_MODE,
  OP,
  PDO_LAYOUT,
  RESULT,
  RMI,
  SENSORS,
  TIMINGS,
  VENTILATION_PRODUCTS,
} from '../constants.js';
import { ComfoError, resultName } from './client.js';
import { uuidBytes } from './messages.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** Why a session ended: `stop` ends the link until the user acts. */
export class Halt extends Error {
  constructor(kind, { stop = false, reason, devicename } = {}) {
    super(reason ?? kind);
    this.kind = kind;
    this.stop = stop;
    this.devicename = devicename;
  }
}

/** The kinds of stop the app persists (the others are retried by themselves). */
export const STOP_KINDS = ['pin_refused', 'full', 'unregistered', 'registration_failed'];

/** A value of a sensor, at its exact size, little-endian; undefined when too short. */
export function decodeValue(data, type) {
  const layout = PDO_LAYOUT.get(type);
  if (!layout || !Buffer.isBuffer(data) || data.length < layout.size) return undefined;
  const { size, signed } = layout;
  if (size === 1) return signed ? data.readInt8(0) : data.readUInt8(0);
  if (size === 2) return signed ? data.readInt16LE(0) : data.readUInt16LE(0);
  return signed ? data.readInt32LE(0) : data.readUInt32LE(0);
}

/** An RMI string: up to the first NUL, printable ASCII only, trimmed. */
export function rmiText(buffer, max = 64) {
  if (!Buffer.isBuffer(buffer)) return '';
  const end = buffer.indexOf(0);
  return buffer
    .subarray(0, end === -1 ? buffer.length : end)
    .toString('latin1')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, max);
}

/** Control characters removed (a name shown in Gladys). */
export const printable = (text) =>
  [...text]
    .filter((char) => {
      const code = char.codePointAt(0);
      return (code >= 0x20 && code < 0x7f) || code >= 0xa0;
    })
    .join('');

export const isSerial = (text) => /^[A-Za-z0-9]{4,40}$/.test(text);

export class ComfoLink extends EventEmitter {
  constructor({
    client,
    discover,
    registry,
    timers = globalThis,
    now = Date.now,
    logger = silent,
  }) {
    super();
    this.client = client;
    this.discover = discover;
    this.registry = registry;
    this.timers = timers;
    this.now = now;
    this.logger = logger;
    this.options = { host: '', pin: 0, localUuid: '' };
    this.running = false;
    this.generation = 0;
    this.state = 'idle';
    this.retryTimer = undefined;
    this.keepAliveTimer = undefined;
    this.holdTimers = new Set();
    this.failures = 0;
    this.busyCount = 0;
    this.nodes = new Map();
    this.nodeWaiters = new Set();
    this.held = new Map();
    this.released = new Set();
    /** pdid -> end of the hold of that sensor. */
    this.holdUntil = new Map();
    this.bridge = undefined;
    this.unit = undefined;
    this.keepAlivePending = false;
    client.on('pdo', (pdo) => this.onPdo(pdo));
    client.on('node', (node) => this.onNode(node));
    client.on('down', ({ reason }) => {
      // During a registration, its own failure (lost) is the one that counts.
      if (this.registering) return;
      if (this.state !== 'idle' && this.state !== 'stopped' && this.state !== 'waiting') {
        this.fail(this.generation, new ComfoError(reason, 'lost', { sent: true }));
      }
    });
    client.on('close-request', () => {
      if (this.state === 'ready' || this.state === 'connecting') {
        this.logger.warn('ComfoConnect: another app took the session over');
        this.fail(this.generation, new Halt('taken_over'));
      }
    });
  }

  /** host, pin (0..9999 or undefined when invalid), localUuid (32 hex digits, saved in /data). */
  configure({ host, pin, localUuid }) {
    this.options = { host, pin, localUuid };
  }

  get ready() {
    return this.state === 'ready';
  }

  start() {
    this.stop();
    this.running = true;
    this.failures = 0;
    this.busyCount = 0;
    this.run(this.generation);
  }

  /** `polite`: tell the bridge the session ends, so another app can take it at once. */
  stop({ polite = false } = {}) {
    if (polite && this.state === 'ready') this.client.notify(OP.CLOSE_SESSION_REQUEST);
    this.running = false;
    this.generation += 1;
    this.state = 'idle';
    this.clearTimers();
    this.client.close('stopped');
  }

  clearTimers() {
    if (this.retryTimer) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    for (const timer of this.holdTimers) this.timers.clearTimeout(timer);
    this.holdTimers.clear();
    if (this.keepAliveTimer) this.timers.clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = undefined;
    this.keepAlivePending = false;
    for (const waiter of this.nodeWaiters) waiter(undefined);
    this.nodeWaiters.clear();
  }

  // --- Session ----------------------------------------------------------------

  async run(generation) {
    if (generation !== this.generation || !this.running) return;
    this.state = 'connecting';
    this.nodes = new Map();
    try {
      const bridge = await this.findBridge();
      this.check(generation);
      await this.client.open({
        host: this.options.host,
        localUuid: this.options.localUuid,
        bridgeUuid: bridge.uuid,
      });
      this.check(generation);
      await this.login(bridge, generation);
      this.client.notify(OP.CN_NODE_REQUEST);
      const nodeId = await this.waitForUnit();
      this.check(generation);
      if (nodeId === undefined) {
        throw new Halt('no_unit', { reason: 'the bridge announced no ventilation unit' });
      }
      const serial = rmiText(await this.rmiNow(RMI.serial()), 40);
      const model = rmiText(await this.rmiNow(RMI.model()));
      this.check(generation);
      if (!isSerial(serial)) {
        throw new Halt('no_serial', { reason: 'the serial number of the unit is not readable' });
      }
      // Before the subscriptions: the values that follow belong to this unit.
      this.emit('unit', { serial, model });
      await this.subscribe(generation);
      this.check(generation);
      this.state = 'ready';
      this.failures = 0;
      this.busyCount = 0;
      this.unit = { serial, model };
      this.keepAliveTimer = this.timers.setInterval(
        () => this.keepAlive(generation),
        TIMINGS.keepAlive,
      );
      this.logger.info(`ComfoConnect: session open (${model || 'ComfoAir'}, node ${nodeId})`);
      this.emit('up', { serial, model, bridge });
    } catch (err) {
      this.fail(generation, err);
    }
  }

  check(generation) {
    if (generation !== this.generation || !this.running) throw new Halt('cancelled');
  }

  async findBridge() {
    const { host } = this.options;
    try {
      const bridge = await this.discover(host);
      this.bridge = bridge;
      await this.registry.rememberBridge(host, bridge);
      return bridge;
    } catch (err) {
      // No answer to the discovery (UDP filtered...): the UUID learnt before, if any.
      const known = this.registry.knownBridge(host);
      if (known) {
        this.logger.debug(
          `ComfoConnect: discovery failed (${err.message}), UUID learnt before used`,
        );
        this.bridge = known;
        return known;
      }
      throw new Halt('no_bridge', { reason: err.message });
    }
  }

  async startSession() {
    try {
      // Never takeover: the session of another app is never closed by Gladys.
      return await this.client.request(OP.START_SESSION_REQUEST, { takeover: false });
    } catch (err) {
      if (
        err instanceof ComfoError &&
        err.kind === 'result' &&
        err.result === RESULT.OTHER_SESSION
      ) {
        throw new Halt('other_session', {
          devicename: printable(String(err.reply?.devicename ?? '')).slice(0, 32),
        });
      }
      throw err;
    }
  }

  /** The session, with the registration when (and only when) it is needed. */
  async login(bridge, generation) {
    const registered = this.registry.registeredWith(bridge.uuid);
    // A ComfoConnect PRO times out a session of an app it does not know (aiocomfoconnect).
    if (bridge.type === GATEWAY_TYPE.PRO && !registered) {
      await this.register(bridge, generation);
      await this.startSession();
      return;
    }
    try {
      await this.startSession();
    } catch (err) {
      if (!(
        err instanceof ComfoError &&
        err.kind === 'result' &&
        err.result === RESULT.NOT_ALLOWED
      )) {
        throw err;
      }
      if (registered || this.registry.registeredWith(bridge.uuid)) {
        // Registered once, refused now: removed from the bridge. Never again by itself.
        throw new Halt('unregistered', { stop: true });
      }
      await this.register(bridge, generation);
      try {
        await this.startSession();
      } catch (again) {
        if (again instanceof ComfoError && again.result === RESULT.NOT_ALLOWED) {
          throw new Halt('unregistered', { stop: true });
        }
        throw again;
      }
    }
    if (!this.registry.registeredWith(bridge.uuid)) await this.registry.markRegistered(bridge.uuid);
  }

  /**
   * One registration. The attempt is persisted BEFORE the write: an attempt
   * never answered OK (an error code, a timeout, a cut, a crash) stops the
   * link, persisted, and is never repeated by itself: the PIN is sent once
   * per user action at most.
   */
  async register(bridge, generation) {
    this.check(generation);
    if (this.registry.attemptedWith(bridge.uuid)) {
      throw new Halt('registration_failed', {
        stop: true,
        reason: 'an earlier registration got no answer',
      });
    }
    if (!(await this.registry.markAttempt(bridge.uuid))) {
      throw new Halt('registration_failed', { stop: true, reason: '/data not writable' });
    }
    this.check(generation);
    const { pin, localUuid } = this.options;
    this.logger.info(`ComfoConnect: registering Gladys on the bridge (as "${DEVICE_NAME}")`);
    this.registering = true;
    try {
      await this.client.request(OP.REGISTER_APP_REQUEST, {
        uuid: uuidBytes(localUuid),
        pin,
        devicename: DEVICE_NAME,
      });
    } catch (err) {
      this.registering = false;
      if (err instanceof ComfoError && !err.sent) {
        // Never written: no attempt to remember.
        await this.registry.clearAttempt();
        throw err;
      }
      if (err instanceof ComfoError && err.kind === 'result') {
        if (err.result === RESULT.NOT_ALLOWED) throw new Halt('pin_refused', { stop: true });
        if (err.result === RESULT.NO_RESOURCES) throw new Halt('full', { stop: true });
        throw new Halt('registration_failed', { stop: true, reason: resultName(err.result) });
      }
      throw new Halt('registration_failed', {
        stop: true,
        reason: err instanceof ComfoError ? err.kind : 'error',
      });
    }
    this.registering = false;
    this.logger.info('ComfoConnect: Gladys is registered on the bridge');
    await this.registry.markRegistered(bridge.uuid);
  }

  onNode({ nodeId, productId, zoneId, mode }) {
    const offline = mode === NODE_MODE.OFFLINE || (mode === NODE_MODE.LEGACY && productId === 0);
    if (offline) this.nodes.delete(nodeId);
    else if (this.nodes.size < 64 || this.nodes.has(nodeId)) {
      this.nodes.set(nodeId, { nodeId, productId, zoneId });
    }
    const unit = this.unitNode;
    if (unit !== undefined) {
      for (const waiter of this.nodeWaiters) waiter(unit);
      this.nodeWaiters.clear();
    }
  }

  /** The ventilation unit: the lowest node id whose product is a ComfoAir Q or Flex. */
  get unitNode() {
    let best;
    for (const node of this.nodes.values()) {
      if (VENTILATION_PRODUCTS.has(node.productId) && (best === undefined || node.nodeId < best)) {
        best = node.nodeId;
      }
    }
    return best;
  }

  waitForUnit() {
    const known = this.unitNode;
    if (known !== undefined) return Promise.resolve(known);
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(() => {
        this.nodeWaiters.delete(waiter);
        resolve(this.unitNode);
      }, TIMINGS.nodeWait);
      const waiter = (value) => {
        this.timers.clearTimeout(timer);
        resolve(value);
      };
      this.nodeWaiters.add(waiter);
    });
  }

  /** Subscribes every sensor; one refused (absent on this unit) never blocks the others. */
  async subscribe(generation) {
    this.held = new Map();
    this.released = new Set();
    this.holdUntil = new Map();
    for (const [pdid, { type }] of SENSORS) {
      this.check(generation);
      // A hold per sensor, counted from its own subscription, its end armed
      // now: a sensor subscribed late keeps its whole hold, and a held zero
      // is never emitted after a real value that came in between.
      this.holdUntil.set(pdid, this.now() + TIMINGS.sensorHold);
      const timer = this.timers.setTimeout(() => {
        this.holdTimers.delete(timer);
        this.releaseHold(generation, pdid);
      }, TIMINGS.sensorHold);
      this.holdTimers.add(timer);
      try {
        await this.client.request(OP.CN_RPDO_REQUEST, { pdid, zone: 1, type });
      } catch (err) {
        if (err instanceof ComfoError && (err.kind === 'result' || err.kind === 'timeout')) {
          this.logger.warn(`ComfoConnect: sensor ${pdid} not subscribed (${err.message})`);
          continue;
        }
        throw err;
      }
    }
  }

  /** A value of `key` was read another way (an RMI read): its held zero is void. */
  release(key) {
    for (const [pdid, sensor] of SENSORS) {
      if (sensor.key !== key) continue;
      this.held.delete(pdid);
      this.released.add(pdid);
    }
  }

  /** The end of the hold of a sensor: its last value still held, zero included. */
  releaseHold(generation, pdid) {
    if (generation !== this.generation || this.released.has(pdid)) return;
    this.released.add(pdid);
    if (!this.held.has(pdid)) return;
    const value = this.held.get(pdid);
    this.held.delete(pdid);
    this.emit('value', { key: SENSORS.get(pdid).key, value });
  }

  onPdo({ pdid, data }) {
    const sensor = SENSORS.get(pdid);
    if (!sensor) return;
    const value = decodeValue(data, sensor.type);
    if (value === undefined) return;
    // The bridge sends zeros right after a subscription: held until a
    // non-zero value or the end of the hold (aiocomfoconnect _hold_sensor).
    if (!this.released.has(pdid) && this.now() < (this.holdUntil.get(pdid) ?? -Infinity)) {
      if (value === 0) {
        this.held.set(pdid, value);
        return;
      }
      this.released.add(pdid);
    }
    // Emitted now: a zero held before is void.
    this.held.delete(pdid);
    this.emit('value', { key: sensor.key, value });
  }

  async keepAlive(generation) {
    if (generation !== this.generation || this.state !== 'ready' || this.keepAlivePending) return;
    this.keepAlivePending = true;
    try {
      await this.client.request(OP.CN_TIME_REQUEST, {}, { timeout: TIMINGS.keepAliveTimeout });
    } catch (err) {
      if (generation === this.generation && err instanceof ComfoError && err.kind === 'timeout') {
        this.logger.warn('ComfoConnect: no answer to the keep-alive, reconnecting');
        this.fail(generation, new ComfoError('no answer to the keep-alive', 'timeout'));
      }
    } finally {
      if (generation === this.generation) this.keepAlivePending = false;
    }
  }

  /** The session ended (or never opened): a retry later, or a stop. */
  fail(generation, err) {
    if (generation !== this.generation || !this.running) return;
    if (err instanceof Halt && err.kind === 'cancelled') return;
    const wasReady = this.state === 'ready';
    this.generation += 1;
    this.clearTimers();
    this.client.close('session ended');
    if (err instanceof Halt && err.stop) {
      this.running = false;
      this.state = 'stopped';
      this.logger.error(`ComfoConnect: stopped (${err.kind}), no new try by itself`);
      this.emit('stopped', { kind: err.kind, reason: err.message });
      return;
    }
    this.state = 'waiting';
    let retryIn;
    let kind = 'unreachable';
    if (err instanceof Halt && err.kind === 'other_session') {
      kind = 'other_session';
      retryIn = TIMINGS.otherSession[Math.min(this.busyCount, TIMINGS.otherSession.length - 1)];
      this.busyCount += 1;
    } else if (err instanceof Halt && err.kind === 'taken_over') {
      kind = 'taken_over';
      retryIn = TIMINGS.takenOver;
    } else {
      if (err instanceof Halt) kind = err.kind;
      retryIn = TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)];
      this.failures = wasReady ? 1 : this.failures + 1;
    }
    const reason =
      err instanceof ComfoError && err.kind === 'result' ? resultName(err.result) : err.message;
    const next = this.generation;
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = undefined;
      this.run(next);
    }, retryIn);
    this.emit('down', { kind, reason, retryIn, devicename: err.devicename, wasReady });
  }

  // --- Requests of the app -----------------------------------------------------

  async rmiNow(message, options = {}) {
    const nodeId = this.unitNode;
    if (nodeId === undefined) throw new ComfoError('No ventilation unit', 'offline');
    const { msg } = await this.client.request(OP.CN_RMI_REQUEST, { nodeId, message }, options);
    if (msg.result) {
      throw new ComfoError(`The unit answered error ${msg.result}`, 'result', {
        sent: true,
        result: RESULT.RMI_ERROR,
        reply: msg,
      });
    }
    return msg.message ?? Buffer.alloc(0);
  }

  /** An RMI request to the ventilation unit, during an open session only. */
  rmi(message, options = {}) {
    if (!this.ready) return Promise.reject(new ComfoError('Not connected', 'offline'));
    return this.rmiNow(message, options);
  }

  /** The apps registered on the bridge: [{ uuid, name }]. */
  async listApps() {
    if (!this.ready) throw new ComfoError('Not connected', 'offline');
    const { msg } = await this.client.request(OP.LIST_REGISTERED_APPS_REQUEST);
    return (msg.apps ?? [])
      .filter((app) => Buffer.isBuffer(app.uuid))
      .map((app) => ({
        uuid: app.uuid.toString('hex'),
        // Printable characters only: the name is shown in Gladys.
        name: printable(String(app.devicename ?? '')),
      }));
  }
}
