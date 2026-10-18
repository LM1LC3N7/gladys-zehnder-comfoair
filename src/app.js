// -----------------------------------------------------------------------------
// The integration: one session with the ComfoConnect LAN C
// (src/protocol/link.js), the values the unit sends, the Gladys device and
// its states (src/devices.js), the two commands, the configuration buttons.
// index.js only wires the SDK handlers to it.
//
// - The model changes when the link emits a value, in the order of the
//   stream; Gladys gets the result once per turn of the event loop (a burst
//   is one publication).
// - Commands (speed, mode) only when the configuration allows them (off by
//   default), speed 0 ("away", the ventilation almost stops) only with its
//   own option (off by default). The options are checked when asked, and
//   again right before the socket write. The decision is taken on the state
//   read from the unit just before (an RMI read), never on memory: already
//   so, nothing is sent; not readable, nothing is sent.
// - A command is written within 3.5 s of the request or not at all, its
//   answer awaited until 4.5 s; a command that may have left is never
//   reported "not sent": "sent, without confirmation", then read again. The
//   ack never waits for the publication of the states. One command at a time.
// - Gladys registers once on the LAN C, under a UUID kept in /data; never
//   when that UUID could not be saved. The PIN is never logged nor saved.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, sessionKey } from './config.js';
import { AWAY_SPEED, FEATURES, MODES, RMI, SENSORS, SPEEDS, TIMINGS } from './constants.js';
import {
  COMMAND_ROLES,
  buildDevice,
  buildStates,
  parseFeatureId,
  unitIds,
  unitKey,
} from './devices.js';
import { ACTION_TEXTS, E, T, duration, fill, word } from './i18n.js';
import { ComfoClient, ComfoError, resultName } from './protocol/client.js';
import { discoverBridge } from './protocol/discovery.js';
import { ComfoLink, STOP_KINDS } from './protocol/link.js';
import { StatePublisher } from './publisher.js';
import { fileStore, newUuid, normalizeMemory } from './store.js';

/** A command refused before anything was sent. */
export class Refused extends Error {}

/** The keys of the values (fixed: from SENSORS, never from the wire). */
const VALUE_KEYS = [...SENSORS.values()].map((s) => s.key);
const emptyValues = () => Object.fromEntries(VALUE_KEYS.map((key) => [key, undefined]));

/** A strict speed: '0'..'3' or the integers 0..3 (null, '', 1.5, '01' are not). */
export function speedOf(value) {
  if (typeof value === 'string' && SPEEDS.includes(value)) return value;
  if (Number.isInteger(value) && value >= 0 && value <= 3) return String(value);
  return undefined;
}

/**
 * The answers of the schedule reads (aiocomfoconnect get_speed / get_mode):
 * 14 bytes, the speed in the last one (0..3), the manual flag in the first
 * one (0 or 1). Any other shape: undefined (state unknown, nothing decided).
 */
export function speedFrom(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length !== 14) return undefined;
  const speed = buffer[13];
  return speed <= 3 ? speed : undefined;
}

export function modeFrom(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length !== 14) return undefined;
  if (buffer[0] === 1) return 'manual';
  return buffer[0] === 0 ? 'auto' : undefined;
}

export const modeOf = (value) =>
  typeof value === 'string' && MODES.includes(value) ? value : undefined;

const STOP_MESSAGES = { pin_refused: T.pinRefused, full: T.full, unregistered: T.unregistered };

export class ComfoAirApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'comfoair' }),
    client,
    connect,
    discover,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.client = client ?? new ComfoClient({ connect, timers, now, logger });
    const find = discover ?? ((host) => discoverBridge(host, { timers }));
    this.link = new ComfoLink({
      client: this.client,
      discover: find,
      registry: this,
      timers,
      now,
      logger,
    });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.key = undefined;
    this.memory = normalizeMemory(null);
    /** 'ok', 'not_saved' or 'unreadable' (src/store.js). */
    this.uuidState = 'not_saved';
    this.memoryUnreadable = false;
    this.unit = undefined;
    this.values = emptyValues();
    /** What the link said last: { kind, ... }. */
    this.linkState = { kind: 'idle' };
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.started = false;
    this.starting = Promise.resolve();
    this.flushScheduled = false;
    this.inFlight = undefined;
    this.readBacks = new Set();
    this.waiters = new Set();
    this.link.on('up', (info) => this.guard(() => this.onUp(info)));
    this.link.on('down', (info) => this.guard(() => this.onDown(info)));
    this.link.on('stopped', (info) => this.guard(() => this.onStopped(info)));
    // Applied at once, in the order of the stream: a session with another
    // unit drops the values of the old one before its own values come.
    this.link.on('unit', ({ serial }) => {
      if (this.unit && this.unit.serial !== serial) {
        this.logger.warn('ComfoConnect: another ventilation unit answers at this address');
        this.values = emptyValues();
      }
    });
    this.link.on('value', ({ key, value }) => this.applyValue(key, value));
  }

  /** What talks to Gladys runs one after the other, in order. */
  guard(fn) {
    this.chain = (this.chain ?? Promise.resolve())
      .then(fn)
      .catch((err) => this.logger.error(`ComfoAir event failed: ${err.message}`));
    return this.chain;
  }

  get language() {
    return this.config.language;
  }

  refusal(entry) {
    return new Refused(word(entry, this.language));
  }

  // --- /data (the registry of the link) -----------------------------------------

  async saveMemory() {
    // A state file that could not be read is never overwritten (its UUID holds a place).
    if (this.memoryUnreadable) return false;
    try {
      await this.store.save(this.memory);
      return true;
    } catch (err) {
      this.logger.warn(`Saving the state to /data failed: ${err.message}`);
      return false;
    }
  }

  /**
   * The UUID Gladys registers under: created once, saved, read back. Without
   * it saved, no registration (a new UUID at each restart would take a new
   * place on the bridge each time). A state file that exists but cannot be
   * read (or holds no valid UUID) is never replaced: nothing starts, the
   * status says so.
   */
  async ensureUuid() {
    let raw;
    try {
      raw = await this.store.load();
    } catch (err) {
      this.logger.error(`ComfoConnect: the state file in /data is unreadable (${err.message})`);
      this.memoryUnreadable = true;
      this.memory = normalizeMemory(null);
      return 'unreadable';
    }
    this.memory = normalizeMemory(raw);
    if (raw !== null && (typeof raw !== 'object' || raw.uuid !== undefined) && !this.memory.uuid) {
      this.logger.error('ComfoConnect: the state file in /data holds no valid identifier');
      this.memoryUnreadable = true;
      return 'unreadable';
    }
    this.memoryUnreadable = false;
    if (this.memory.uuid) return 'ok';
    const uuid = newUuid();
    this.memory.uuid = uuid;
    if (!(await this.saveMemory())) {
      this.memory.uuid = null;
      return 'not_saved';
    }
    const back = normalizeMemory(await this.store.load().catch(() => null));
    if (back.uuid !== uuid) {
      this.memory.uuid = null;
      return 'not_saved';
    }
    this.logger.info('ComfoConnect: new identifier for Gladys created and kept in /data');
    return 'ok';
  }

  attemptedWith(uuid) {
    return this.memory.attempt?.bridge === uuid;
  }

  /** Persisted BEFORE the RegisterApp is written; false when /data cannot keep it. */
  async markAttempt(uuid) {
    this.memory.attempt = { bridge: uuid, at: this.now() };
    return this.saveMemory();
  }

  async clearAttempt() {
    if (!this.memory.attempt) return;
    this.memory.attempt = null;
    await this.saveMemory();
  }

  knownBridge(host) {
    return this.memory.bridges.find((b) => b.host === host);
  }

  async rememberBridge(host, bridge) {
    const known = this.knownBridge(host);
    if (known && known.uuid === bridge.uuid && known.type === bridge.type) return;
    this.memory.bridges = [
      { host, uuid: bridge.uuid, type: bridge.type },
      ...this.memory.bridges.filter((b) => b.host !== host),
    ].slice(0, 8);
    await this.saveMemory();
  }

  registeredWith(uuid) {
    return this.memory.registered.includes(uuid);
  }

  async markRegistered(uuid) {
    if (this.registeredWith(uuid) && !this.memory.attempt) return;
    if (!this.registeredWith(uuid)) {
      this.memory.registered = [uuid, ...this.memory.registered].slice(0, 8);
    }
    this.memory.attempt = null;
    await this.saveMemory();
  }

  // --- Lifecycle -------------------------------------------------------------------

  /** Starts (or restarts); two starts never overlap. */
  start(raw = {}) {
    const run = this.starting.then(() => this.startNow(raw));
    this.starting = run.catch(() => undefined);
    return run;
  }

  async startNow(raw = {}) {
    this.stop();
    const next = normalizeConfig(raw);
    this.config = next;
    this.key = sessionKey(next);
    this.uuidState = await this.ensureUuid();
    if (!this.unit && this.memory.unit) this.unit = { ...this.memory.unit };
    this.linkState = { kind: 'idle' };
    await this.publishDevices();
    await this.publishBadge();
    if (this.configProblem()) {
      await this.updateStatus();
      return;
    }
    const stop = this.memory.stop;
    if (stop && stop.place === next.host) {
      this.logger.warn(
        `ComfoConnect: stopped before (${stop.kind}): no connection until the configuration changes or "Test the connection" is clicked`,
      );
      this.linkState = { kind: 'stopped', stop: stop.kind, detail: stop.detail };
      await this.updateStatus();
      return;
    }
    this.connect();
    await this.updateStatus();
  }

  /** Every 5 minutes: the heartbeats of the unchanged values that are due (publisher). */
  startSweeper() {
    if (this.sweeper) return;
    this.sweeper = this.timers.setInterval(
      () => this.guard(() => this.publishStates()),
      TIMINGS.sweep,
    );
  }

  connect() {
    this.startSweeper();
    this.linkState = { kind: 'connecting' };
    this.link.configure({
      host: this.config.host,
      pin: this.config.pin,
      localUuid: this.memory.uuid,
    });
    this.link.start();
  }

  stop({ polite = false } = {}) {
    this.link.stop({ polite });
    this.publisher.stop();
    if (this.sweeper) this.timers.clearInterval(this.sweeper);
    this.sweeper = undefined;
    for (const timer of this.readBacks) this.timers.clearTimeout(timer);
    this.readBacks.clear();
  }

  configProblem() {
    if (this.config.hostInvalid) return T.hostInvalid;
    if (!this.config.host) return T.noHost;
    if (this.config.pin === undefined) return T.pinInvalid;
    if (this.uuidState === 'unreadable') return T.stateUnreadable;
    if (this.uuidState !== 'ok') return T.notSaved;
    return undefined;
  }

  /** First connection to Gladys: start; a reconnection (Gladys restarted): resend everything. */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    // Gladys keeps the connection status, the Discovery and the badges in memory only.
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.forget();
    if (sessionKey(normalizeConfig(raw)) !== this.key) {
      await this.configUpdated(raw);
      return;
    }
    this.config = normalizeConfig(raw);
    await this.publishAll();
  }

  /** A new address or PIN reconnects (and lifts a stop); the options apply at once. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    if (sessionKey(next) !== this.key) {
      // The options hold at once, even while the restart waits.
      this.config = {
        ...this.config,
        allowCommands: next.allowCommands,
        allowAway: next.allowAway,
      };
      await this.liftStop();
      return this.start(raw);
    }
    const previous = this.config;
    this.config = next;
    if (previous.allowCommands !== next.allowCommands || previous.allowAway !== next.allowAway) {
      this.logger.info(
        `ComfoAir commands ${next.allowCommands ? 'allowed' : 'disabled'}, away ${next.allowAway ? 'allowed' : 'disabled'}`,
      );
    }
    await this.publishAll();
    return undefined;
  }

  /**
   * Lifts a stop (a user action: a new address or PIN, or the button). After
   * "registration removed", the bridges are forgotten as registered too, and
   * an unanswered registration attempt is forgotten: the user's action
   * allows exactly one new registration.
   */
  async liftStop() {
    const stop =
      this.memory.stop ??
      (this.linkState.kind === 'stopped' ? { kind: this.linkState.stop } : null);
    if (!stop && !this.memory.attempt) return;
    if (stop?.kind === 'unregistered') this.memory.registered = [];
    this.memory.stop = null;
    this.memory.attempt = null;
    await this.saveMemory();
  }

  async publishAll() {
    await this.publishDevices();
    await this.publishStates();
    await this.publishBadge();
    await this.updateStatus();
  }

  // --- Link events ---------------------------------------------------------------

  async onUp({ serial, model }) {
    this.unit = { serial, model };
    this.linkState = { kind: 'ready' };
    if (this.memory.unit?.serial !== serial || this.memory.unit?.model !== model) {
      this.memory.unit = { serial, model };
      await this.saveMemory();
    }
    this.badge = undefined;
    await this.publishAll();
  }

  async onDown({ kind, reason, retryIn, devicename }) {
    this.linkState = { kind, reason, retryIn, devicename };
    if (kind === 'other_session' || kind === 'taken_over') {
      this.logger.info(`ComfoConnect: ${kind}; next try in ${Math.round(retryIn / 1000)} s`);
    } else {
      this.logger.warn(
        `ComfoConnect: ${kind} (${reason}); next try in ${Math.round(retryIn / 1000)} s`,
      );
    }
    await this.publishBadge();
    await this.updateStatus();
    this.wake('down');
  }

  async onStopped({ kind, reason }) {
    const detail = String(reason ?? '').slice(0, 60);
    this.linkState = { kind: 'stopped', stop: kind, detail };
    if (STOP_KINDS.includes(kind)) {
      this.memory.stop = { place: this.config.host, kind, at: this.now(), detail };
      await this.saveMemory();
    }
    await this.publishBadge();
    await this.updateStatus();
    this.wake('down');
  }

  /** A value from the unit, applied at once; the publication follows once per turn. */
  applyValue(key, value) {
    if (!Object.hasOwn(this.values, key)) return;
    if (this.values[key] === value) return;
    this.values[key] = value;
    this.noteChange();
  }

  noteChange() {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.guard(() => this.publishStates());
    });
  }

  // --- Gladys ----------------------------------------------------------------------

  createdDevice(externalId) {
    return (this.gladys.devices ?? []).find((d) => d?.external_id === externalId);
  }

  /** Our created devices (this unit, or another one seen before). */
  ourDevices() {
    return (this.gladys.devices ?? []).filter(
      (d) => typeof d?.external_id === 'string' && /:comfoair:[a-z0-9]{4,40}$/.test(d.external_id),
    );
  }

  async publishDevices() {
    if (!this.unit) return;
    const ids = unitIds(this.gladys, this.unit.serial);
    const device = buildDevice(this.gladys, this.unit, {
      language: this.language,
      created: this.createdDevice(ids.device),
    });
    const json = JSON.stringify(device);
    if (json === this.published) return;
    try {
      await this.gladys.publishDiscoveredDevices([device]);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the devices failed: ${err.message}`);
    }
  }

  /** The values of an open session, to the features created in Gladys. */
  publishStates() {
    if (!this.unit || !this.link.ready) return Promise.resolve();
    const ids = unitIds(this.gladys, this.unit.serial);
    const created = new Set(
      (this.createdDevice(ids.device)?.features ?? []).map((f) => f?.external_id),
    );
    const states = buildStates(ids, this.values, this.language).filter((s) =>
      created.has(s.device_feature_external_id),
    );
    return this.publisher.publish(states);
  }

  async publishBadge() {
    const current = this.unit ? unitIds(this.gladys, this.unit.serial).device : undefined;
    const entries = this.ourDevices().map((d) => ({
      external_id: d.external_id,
      transport:
        d.external_id === current && this.link.ready
          ? DEVICE_TRANSPORTS.LOCAL
          : DEVICE_TRANSPORTS.UNREACHABLE,
    }));
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) return;
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Publishing the transports failed: ${err.message}`);
    }
  }

  /** The connection status of the configuration screen, from what is known now. */
  status() {
    const problem = this.configProblem();
    if (problem) return [false, problem];
    const s = this.linkState;
    const wait = duration(s.retryIn ?? 0);
    switch (s.kind) {
      case 'ready':
        return [true, fill(T.connected, this.unit?.model || 'ComfoAir')];
      case 'stopped':
        if (s.stop === 'registration_failed') {
          return [false, fill(T.registrationFailed, s.detail || '?')];
        }
        return [false, STOP_MESSAGES[s.stop] ?? T.unregistered];
      case 'other_session':
        return [false, fill(T.otherSession, s.devicename, wait)];
      case 'taken_over':
        return [false, fill(T.takenOver, wait)];
      case 'no_bridge':
        return [false, fill(T.noBridge, s.reason, wait)];
      case 'no_unit':
        return [false, fill(T.noUnit, wait)];
      case 'no_serial':
        return [false, fill(T.noSerial, wait)];
      case 'unreachable':
        return [false, fill(T.unreachable, s.reason, wait)];
      default:
        return [false, T.connecting];
    }
  }

  async updateStatus() {
    const [connected, message] = this.status();
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** "Scan" in Gladys: the device sent again. */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  /** The user created or updated a device: Gladys has none of its states yet. */
  async deviceChanged(device) {
    this.publisher.forget(device?.external_id);
    this.badge = undefined;
    await this.publishStates();
    await this.publishBadge();
  }

  // --- Commands ------------------------------------------------------------------

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const asked = this.now();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) throw this.refusal(E.readOnly);
    const wanted = target.role === FEATURES.SPEED ? speedOf(value) : modeOf(value);
    if (wanted === undefined) throw this.refusal(fill(E.badValue, JSON.stringify(value) ?? '?'));
    if (!this.config.allowCommands) throw this.refusal(E.disabled);
    if (target.role === FEATURES.SPEED && wanted === AWAY_SPEED && !this.config.allowAway) {
      throw this.refusal(E.awayDisabled);
    }
    if (!this.unit || target.key !== unitKey(this.unit.serial) || !this.link.ready) {
      throw this.refusal(E.offline);
    }
    if (this.inFlight) throw this.refusal(E.busy);
    const run =
      target.role === FEATURES.SPEED ? this.setSpeed(wanted, asked) : this.setMode(wanted, asked);
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = undefined;
    }
  }

  /** The options, read again now (the configuration may have changed meanwhile). */
  allowed(role, wanted) {
    if (!this.config.allowCommands) return false;
    return !(role === FEATURES.SPEED && wanted === AWAY_SPEED && !this.config.allowAway);
  }

  checkAllowed(role, wanted) {
    if (this.allowed(role, wanted)) return;
    this.logger.warn(`Command REFUSED (${role} ${wanted}): disabled in the configuration`);
    throw this.refusal(this.config.allowCommands ? E.awayDisabled : E.disabled);
  }

  /** The state read from the unit now (an RMI answer to a request written now). */
  async freshRead(message, asked) {
    const sendBy = asked + TIMINGS.sendBy;
    const until = Math.min(this.now() + TIMINGS.readMax, sendBy - TIMINGS.minSend);
    if (until <= this.now()) throw this.refusal(E.tooLate);
    try {
      return await this.link.rmi(message, { until, sendBy });
    } catch (err) {
      if (err instanceof ComfoError && err.kind === 'late') throw this.refusal(E.tooLate);
      if (err instanceof ComfoError && err.kind === 'offline') throw this.refusal(E.offline);
      if (err instanceof ComfoError && err.kind === 'full') throw this.refusal(E.busy);
      throw this.refusal(E.stateUnknown);
    }
  }

  async setSpeed(speed, asked) {
    const what = fill(E.speed, speed);
    this.checkAllowed(FEATURES.SPEED, speed);
    const current = speedFrom(await this.freshRead(RMI.getSpeed(), asked));
    if (current === undefined) throw this.refusal(E.stateUnknown);
    this.link.release('speed');
    this.applyValue('speed', current);
    if (String(current) === speed) {
      this.logger.info(`ComfoAir already at speed ${speed}: nothing sent`);
      return;
    }
    this.checkAllowed(FEATURES.SPEED, speed);
    this.logger.info(`SPEED from Gladys: ${speed} (was ${current})`);
    await this.write([RMI.setSpeed(Number(speed))], what, asked, () =>
      this.allowed(FEATURES.SPEED, speed),
    );
  }

  async setMode(mode, asked) {
    const what = fill(E.mode, mode);
    this.checkAllowed(FEATURES.MODE, mode);
    const current = modeFrom(await this.freshRead(RMI.getMode(), asked));
    if (current === undefined) throw this.refusal(E.stateUnknown);
    this.link.release('manual');
    this.applyValue('manual', current === 'manual' ? 1 : 255);
    if (current === mode) {
      this.logger.info(`ComfoAir already in ${mode} mode: nothing sent`);
      return;
    }
    if (mode === 'manual' && !this.config.allowAway) {
      // Manual keeps the current speed: at 0 (away) it would keep the
      // ventilation almost stopped, which needs the away option.
      const speed = speedFrom(await this.freshRead(RMI.getSpeed(), asked));
      if (speed === undefined) throw this.refusal(E.stateUnknown);
      this.link.release('speed');
      this.applyValue('speed', speed);
      if (speed === 0) {
        this.logger.warn('Command REFUSED (mode manual): the speed is 0 (away), not allowed');
        throw this.refusal(E.manualAtAway);
      }
    }
    this.checkAllowed(FEATURES.MODE, mode);
    this.logger.info(`MODE from Gladys: ${mode} (was ${current})`);
    const messages = mode === 'auto' ? RMI.setAuto() : RMI.setManual();
    await this.write(messages, what, asked, () => this.allowed(FEATURES.MODE, mode));
  }

  /**
   * Writes the RMI messages of a command, one after the other, each checked
   * right before the write. Nothing written: refused "nothing was sent". Once
   * one is written, a failure is "sent, without confirmation" (or refused by
   * the unit when it answered an error), then read again.
   */
  async write(messages, what, asked, check) {
    const sendBy = asked + TIMINGS.sendBy;
    const until = asked + TIMINGS.answerBy;
    let written = false;
    for (const [index, message] of messages.entries()) {
      try {
        await this.link.rmi(message, {
          sendBy,
          until,
          check,
          onWritten: () => {
            written = true;
          },
          label: word(what, 'en'),
        });
      } catch (err) {
        const sent = written || (err instanceof ComfoError && err.sent);
        if (!sent) {
          this.logger.warn(`Command NOT sent (${word(what, 'en')}): ${err.message}`);
          if (err instanceof ComfoError && err.kind === 'withdrawn') {
            throw this.refusal(this.config.allowCommands ? E.awayDisabled : E.disabled);
          }
          if (err instanceof ComfoError && err.kind === 'late') throw this.refusal(E.tooLate);
          if (err instanceof ComfoError && err.kind === 'full') throw this.refusal(E.busy);
          throw this.refusal(E.offline);
        }
        this.scheduleReadBack();
        if (index > 0) {
          // The first message was applied, this one not (or not confirmed).
          this.logger.warn(
            `Command PARTLY applied (${word(what, 'en')}): message ${index + 1} failed (${err.message})`,
          );
          throw new Error(word(fill(E.partial, word(what, this.language)), this.language), {
            cause: err,
          });
        }
        if (err instanceof ComfoError && err.kind === 'result') {
          const why = err.reply?.result
            ? `${resultName(err.result)} ${err.reply.result}`
            : resultName(err.result);
          this.logger.warn(`Command refused by the unit (${word(what, 'en')}): ${why}`);
          throw new Error(word(fill(E.refusedByUnit, why), this.language), { cause: err });
        }
        this.logger.warn(`Command sent, NOT confirmed (${word(what, 'en')}): ${err.message}`);
        throw new Error(word(fill(E.unconfirmed, word(what, this.language)), this.language), {
          cause: err,
        });
      }
    }
    this.logger.info(`Command confirmed by the unit (${word(what, 'en')})`);
  }

  /** Speed and mode read again from the unit, 2 s later (the model follows the answers). */
  scheduleReadBack() {
    const timer = this.timers.setTimeout(async () => {
      this.readBacks.delete(timer);
      if (!this.link.ready) return;
      try {
        const speed = speedFrom(await this.link.rmi(RMI.getSpeed()));
        if (speed !== undefined) {
          this.link.release('speed');
          this.applyValue('speed', speed);
        }
        const mode = modeFrom(await this.link.rmi(RMI.getMode()));
        if (mode !== undefined) {
          this.link.release('manual');
          this.applyValue('manual', mode === 'manual' ? 1 : 255);
        }
      } catch (err) {
        this.logger.warn(`ComfoAir: read back after the command failed (${err.message})`);
      }
    }, TIMINGS.readBack);
    this.readBacks.add(timer);
  }

  // --- Configuration buttons -------------------------------------------------------

  wake(result) {
    for (const waiter of [...this.waiters]) waiter(result);
  }

  /** Waits for the session to open or fail, at most `timeout` ms. */
  waitForLink(timeout) {
    if (this.link.ready) return Promise.resolve('up');
    return new Promise((resolve) => {
      const done = (result) => {
        this.waiters.delete(done);
        this.link.off('up', onUp);
        this.timers.clearTimeout(timer);
        resolve(result);
      };
      const onUp = () => done('up');
      const timer = this.timers.setTimeout(() => done('timeout'), timeout);
      this.waiters.add(done);
      this.link.on('up', onUp);
    });
  }

  /**
   * "Test the connection": lifts a stop (one new registration may follow);
   * connects now unless a session is open or opening; tells how it went.
   */
  async testConnection() {
    const problem = this.configProblem();
    if (problem) throw new Error(word(problem, this.language));
    if (!this.link.ready && this.linkState.kind !== 'connecting') {
      await this.liftStop();
      this.connect();
      await this.updateStatus();
    }
    const result = await this.waitForLink(TIMINGS.testWait);
    await this.chain;
    if (result === 'timeout') throw new Error(word(ACTION_TEXTS.stillConnecting, this.language));
    const [connected, message] = this.status();
    if (!connected) throw new Error(word(message, this.language));
    return message;
  }

  /** "List the registered apps": what the LAN C knows, this integration marked. */
  async listApps() {
    if (!this.link.ready) throw new Error(word(E.offline, this.language));
    const apps = await this.link.listApps();
    if (apps.length === 0) return ACTION_TEXTS.noApps;
    const line = (lang) =>
      apps
        .map(
          (app) =>
            `${app.name || '?'} [${app.uuid}]${app.uuid === this.memory.uuid ? word(ACTION_TEXTS.thisIsGladys, lang) : ''}`,
        )
        .join(', ');
    return {
      en: word(ACTION_TEXTS.apps, 'en')(line('en')),
      fr: word(ACTION_TEXTS.apps, 'fr')(line('fr')),
    };
  }
}
