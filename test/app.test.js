// ComfoAirApp with the SDK's fake Gladys (createFakeGladys), the in-memory
// LAN C (test/helpers/fakeBridge.js) and a virtual clock: the whole chain
// from the registration to the Gladys device, its states and the commands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ComfoAirApp } from '../src/app.js';
import { OP } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import {
  BRIDGE_UUID,
  FakeBridge,
  FakeClock,
  quietLogger,
  settle,
  until,
} from './helpers/fakeBridge.js';

const BASE = { host: '192.0.2.20', language: 'en', pin: '1234' };
const ALLOWED = { allow_commands: true };
const SERIAL = 'bea001122334455';

async function setup(
  t,
  {
    config = {},
    bridge = new FakeBridge({ pin: 1234 }),
    store,
    devices,
    create = true,
    discover,
  } = {},
) {
  const clock = new FakeClock();
  const gladys = createFakeGladys({ config: { ...BASE, ...config }, devices });
  const logger = quietLogger();
  const memory = store ?? memoryStore();
  const app = new ComfoAirApp({
    gladys,
    logger,
    connect: bridge.connect,
    discover: discover ?? (async (host) => ({ uuid: BRIDGE_UUID, type: 0, ip: host })),
    store: memory,
    now: clock.now,
    timers: clock,
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  t.after(() => app.stop());
  const ids = gladys.externalIds('comfoair', SERIAL);
  const ctx = {
    gladys,
    bridge,
    app,
    clock,
    logger,
    store: memory,
    ids,
    device: () => gladys.fake.devices.find((d) => d.external_id === ids.device),
    discovered: () => gladys.fake.discoveredDevices.find((d) => d.external_id === ids.device),
    state: (role) => gladys.fake.lastState(ids.feature(role)),
    status: () => gladys.fake.connectionStatus,
    /** A command while the virtual clock runs. */
    set: async (role, value, ms = 6_000) => {
      const d = ctx.device();
      const f = d.features.find((x) => x.external_id === ids.feature(role));
      const pending = gladys.fake.setValue(d, f, value);
      await clock.advance(ms);
      return pending;
    },
    /** Opens the session and lets the hold of the sensors end. */
    up: async () => {
      await until(() => app.link.ready || app.linkState.kind !== 'connecting');
      await clock.advance(6_000);
      await app.chain;
      await settle();
    },
  };
  if (create) {
    await ctx.up();
    for (const d of [...gladys.fake.discoveredDevices]) await gladys.fake.deviceCreated(d);
    await clock.advance(1_000);
    await settle();
  }
  return ctx;
}

test('registers once with the PIN, opens the session, publishes the unit and its values', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store });
  const { bridge, gladys } = ctx;
  assert.equal(bridge.sent(OP.REGISTER_APP_REQUEST).length, 1);
  const register = bridge.sent(OP.REGISTER_APP_REQUEST)[0].msg;
  assert.equal(register.pin, 1234);
  assert.equal(register.devicename, 'Gladys');
  assert.equal(register.uuid.toString('hex'), store.data.uuid, 'the UUID kept in /data');
  assert.deepEqual(store.data.registered, [BRIDGE_UUID]);
  assert.ok(!JSON.stringify(store.data).includes('1234'), 'the PIN is never saved');
  assert.ok(!ctx.logger.lines.join('\n').includes('1234'), 'the PIN is never logged');
  // Never a takeover of the session of another app.
  assert.ok(bridge.sent(OP.START_SESSION_REQUEST).every((e) => !e.msg.takeover));
  assert.equal(ctx.status().connected, true);
  assert.match(ctx.status().message.en, /ComfoAir Q450/);
  const device = ctx.discovered();
  assert.equal(device.name, 'ComfoAir Q450 B R RF ST Quality');
  // No switch, no binary: an "everything off" never reaches the ventilation.
  assert.ok(device.features.every((f) => !['switch', 'binary'].includes(f.category)));
  assert.ok(device.features.every((f) => f.type !== 'binary'));
  const selects = device.features.filter((f) => !f.read_only);
  assert.deepEqual(
    selects.map((f) => [f.external_id.split(':').at(-1), f.category, f.type]),
    [
      ['speed', 'text', 'select'],
      ['mode', 'text', 'select'],
    ],
  );
  assert.deepEqual(
    selects[0].supported_options.map((o) => o.value),
    ['0', '1', '2', '3'],
  );
  // States after the hold (the zeros of the subscription are not published).
  assert.equal(ctx.state('speed'), '2');
  assert.equal(ctx.state('mode'), 'auto');
  assert.equal(ctx.state('operating-mode'), 'Automatic');
  assert.equal(ctx.state('temperature-outdoor'), 8.5);
  assert.equal(ctx.state('temperature-extract'), 21.4);
  assert.equal(ctx.state('temperature-supply'), 19);
  assert.equal(ctx.state('temperature-exhaust'), -1.2, 'signed, padded data read at its size');
  assert.equal(ctx.state('humidity-outdoor'), 80);
  assert.equal(ctx.state('humidity-exhaust'), 90);
  assert.equal(ctx.state('flow-supply'), 150);
  assert.equal(ctx.state('flow-exhaust'), 145);
  assert.equal(ctx.state('filter-days'), 130);
  assert.equal(ctx.state('bypass-open'), 0, 'a real zero, published at the end of the hold');
  assert.equal(ctx.state('bypass-mode'), 'Automatic');
  assert.ok(gladys.fake.transports.some((e) => e.transport === 'local'));
  // A restart with the same /data: no new registration.
  const again = await setup(t, { store, bridge, create: false });
  await again.up();
  assert.equal(bridge.sent(OP.REGISTER_APP_REQUEST).length, 1, 'registered once only');
  assert.equal(again.app.link.ready, true);
});

test('units and categories are the ones the core lists', async (t) => {
  const ctx = await setup(t);
  const units = Object.fromEntries(
    ctx
      .discovered()
      .features.map((f) => [f.external_id.split(':').at(-1), [f.category, f.unit ?? null]]),
  );
  assert.deepEqual(units['temperature-outdoor'], ['temperature-sensor', 'celsius']);
  assert.deepEqual(units['humidity-extract'], ['humidity-sensor', 'percent']);
  assert.deepEqual(units['filter-days'], ['duration', 'days']);
  assert.deepEqual(units['flow-supply'], ['unknown', null]);
  assert.deepEqual(units['bypass-open'], ['unknown', null]);
});

test('commands are off by default: refused, nothing sent', async (t) => {
  const ctx = await setup(t);
  const before = ctx.bridge.rmis.length;
  const ack = await ctx.set('speed', '3');
  assert.equal(ack.success, false);
  assert.match(ack.error, /disabled.*nothing was sent/);
  assert.equal(ctx.bridge.rmis.length, before);
});

test('speed: decided on a fresh read, written, confirmed; already so: nothing sent', async (t) => {
  const ctx = await setup(t, { config: ALLOWED });
  let ack = await ctx.set('speed', '3');
  assert.equal(ack.success, true, ack.error);
  const rmis = ctx.bridge.rmis;
  assert.deepEqual(rmis.at(-2), [0x83, 0x15, 0x01, 0x01], 'the speed read first');
  assert.deepEqual(rmis.at(-1), [0x84, 0x15, 0x01, 0x01, 0, 0, 0, 0, 1, 0, 0, 0, 3]);
  await settle();
  assert.equal(ctx.state('speed'), '3');
  const count = ctx.bridge.rmis.length;
  ack = await ctx.set('speed', 3);
  assert.equal(ack.success, true, ack.error);
  assert.equal(ctx.bridge.rmis.length, count + 1, 'only the read: already at 3');
});

test('speed 0 (away) needs its own option', async (t) => {
  const ctx = await setup(t, { config: ALLOWED });
  const before = ctx.bridge.rmis.length;
  let ack = await ctx.set('speed', '0');
  assert.equal(ack.success, false);
  assert.match(ack.error, /away.*almost stops.*Nothing was sent/);
  assert.equal(ctx.bridge.rmis.length, before);
  await ctx.gladys.fake.configUpdated({ ...BASE, ...ALLOWED, allow_away: true });
  ack = await ctx.set('speed', '0');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.bridge.rmis.at(-1).at(-1), 0);
});

test('strict values: null, empty, out of range, other types are refused unsent', async (t) => {
  const ctx = await setup(t, { config: ALLOWED });
  const before = ctx.bridge.rmis.length;
  for (const value of [null, '', 4, '4', '1.0', 1.5, 'high', ' 1']) {
    const ack = await ctx.set('speed', value, 100);
    assert.equal(ack.success, false, JSON.stringify(value));
  }
  for (const value of ['AUTO', '', 0, 'away']) {
    const ack = await ctx.set('mode', value, 100);
    assert.equal(ack.success, false, JSON.stringify(value));
  }
  assert.equal(ctx.bridge.rmis.length, before);
  // A read-only feature takes no command.
  const d = ctx.device();
  const temp = d.features.find((f) => f.external_id === ctx.ids.feature('temperature-outdoor'));
  const ack = await ctx.gladys.fake.setValue(d, temp, 20);
  assert.equal(ack.success, false);
});

test('mode: manual is one write, auto two (manual mode and speed override cancelled)', async (t) => {
  const ctx = await setup(t, { config: ALLOWED });
  let ack = await ctx.set('mode', 'manual');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.bridge.rmis.at(-3), [0x83, 0x15, 0x08, 0x01], 'the mode read');
  assert.deepEqual(ctx.bridge.rmis.at(-2), [0x83, 0x15, 0x01, 0x01], 'the speed read (not 0)');
  assert.deepEqual(ctx.bridge.rmis.at(-1), [0x84, 0x15, 0x08, 0x01, 0, 0, 0, 0, 1, 0, 0, 0, 1]);
  await settle();
  assert.equal(ctx.state('mode'), 'manual');
  ack = await ctx.set('mode', 'auto');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.bridge.rmis.slice(-2), [
    [0x85, 0x15, 0x08, 0x01],
    [0x85, 0x15, 0x01, 0x01],
  ]);
  await settle();
  assert.equal(ctx.state('mode'), 'auto');
});

test('a command without answer: "sent, without confirmation", then read again', async (t) => {
  const ctx = await setup(t, { config: ALLOWED });
  ctx.bridge.hold = (e) => e.type === OP.CN_RMI_REQUEST && e.msg.message[0] === 0x84;
  const ack = await ctx.set('speed', '1', 5_000);
  assert.equal(ack.success, false);
  assert.match(ack.error, /sent, without confirmation/);
  assert.doesNotMatch(ack.error, /nothing was sent/);
  assert.match(ctx.logger.lines.join('\n'), /Command sent, NOT confirmed/);
  const reads = ctx.bridge.rmis.filter((m) => m[0] === 0x83).length;
  await ctx.clock.advance(3_000);
  assert.ok(ctx.bridge.rmis.filter((m) => m[0] === 0x83).length > reads, 'read again');
});

test('a command the unit refuses: "sent, refused by the unit"', async (t) => {
  const ctx = await setup(t, { config: ALLOWED });
  const original = ctx.bridge.rmi.bind(ctx.bridge);
  ctx.bridge.rmi = (socket, reply, bytes) =>
    bytes[0] === 0x84
      ? reply(OP.CN_RMI_RESPONSE, { result: 8, message: { result: 30 } })
      : original(socket, reply, bytes);
  const ack = await ctx.set('speed', '1');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Sent, refused by the unit/);
});

test('the option switched off during the fresh read: nothing written', async (t) => {
  const ctx = await setup(t, { config: ALLOWED });
  let release;
  ctx.bridge.hold = (e) => {
    if (e.type === OP.CN_RMI_REQUEST && e.msg.message[0] === 0x83 && !release) {
      release = () => ctx.bridge.respond(ctx.bridge.current, e);
      return true;
    }
    return false;
  };
  const d = ctx.device();
  const f = d.features.find((x) => x.external_id === ctx.ids.feature('speed'));
  const pending = ctx.gladys.fake.setValue(d, f, '3');
  await until(() => release);
  await ctx.gladys.fake.configUpdated({ ...BASE, allow_commands: false });
  release();
  await ctx.clock.advance(5_000);
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /nothing was sent/);
  assert.ok(!ctx.bridge.rmis.some((m) => m[0] === 0x84), 'never written');
});

test('the fresh read gets no answer: refused, nothing written', async (t) => {
  const ctx = await setup(t, { config: ALLOWED });
  ctx.bridge.hold = (e) => e.type === OP.CN_RMI_REQUEST && e.msg.message[0] === 0x83;
  const ack = await ctx.set('speed', '3');
  assert.equal(ack.success, false);
  assert.match(ack.error, /not readable: nothing was sent/);
  assert.ok(!ctx.bridge.rmis.some((m) => m[0] === 0x84));
});

test('the ack never waits for the publication of the states', async (t) => {
  const ctx = await setup(t, { config: ALLOWED });
  ctx.gladys.publishStates = () => new Promise(() => {});
  const ack = await ctx.set('speed', '1');
  assert.equal(ack.success, true, ack.error);
});

test('one command at a time', async (t) => {
  const ctx = await setup(t, { config: ALLOWED });
  ctx.bridge.hold = (e) => e.type === OP.CN_RMI_REQUEST && e.msg.message[0] === 0x83;
  const d = ctx.device();
  const f = d.features.find((x) => x.external_id === ctx.ids.feature('speed'));
  const first = ctx.gladys.fake.setValue(d, f, '3');
  await settle();
  const second = await ctx.gladys.fake.setValue(d, f, '1');
  assert.equal(second.success, false);
  assert.match(second.error, /Another command is running/);
  await ctx.clock.advance(5_000);
  await first;
});

test('a wrong PIN stops the registration, persisted; a new PIN makes one new try', async (t) => {
  const bridge = new FakeBridge({ pin: 4321 });
  const store = memoryStore();
  const ctx = await setup(t, { bridge, store, create: false });
  await ctx.up();
  assert.equal(ctx.status().connected, false);
  assert.match(ctx.status().message.en, /PIN refused/);
  assert.equal(store.data.stop.kind, 'pin_refused');
  await ctx.clock.advance(30 * 60_000);
  assert.equal(bridge.sent(OP.REGISTER_APP_REQUEST).length, 1, 'never in a loop');
  // A restart keeps the stop.
  const again = await setup(t, { bridge, store, create: false });
  await again.clock.advance(60_000);
  assert.equal(bridge.sent(OP.REGISTER_APP_REQUEST).length, 1);
  assert.match(again.status().message.en, /PIN refused/);
  // The right PIN: one new try, registered.
  await again.gladys.fake.configUpdated({ ...BASE, pin: '4321' });
  await again.up();
  assert.equal(bridge.sent(OP.REGISTER_APP_REQUEST).length, 2);
  assert.equal(again.app.link.ready, true);
  assert.equal(store.data.stop, null);
});

test('a full LAN C: stopped with how to free a place', async (t) => {
  const bridge = new FakeBridge({
    pin: 1234,
    registered: ['aa'.repeat(16), 'bb'.repeat(16)],
    maxApps: 2,
  });
  const ctx = await setup(t, { bridge, create: false });
  await ctx.up();
  assert.match(ctx.status().message.en, /no room for another app.*free a place/);
  await ctx.clock.advance(30 * 60_000);
  assert.equal(bridge.sent(OP.REGISTER_APP_REQUEST).length, 1);
});

test('registration removed later: stopped, no new registration until the button', async (t) => {
  const bridge = new FakeBridge({ pin: 1234 });
  const store = memoryStore();
  const ctx = await setup(t, { bridge, store });
  bridge.apps.clear();
  bridge.drop();
  await ctx.clock.advance(15_000);
  await ctx.app.chain;
  assert.match(ctx.status().message.en, /no longer registered/);
  assert.equal(bridge.sent(OP.REGISTER_APP_REQUEST).length, 1);
  await ctx.clock.advance(30 * 60_000);
  assert.equal(bridge.sent(OP.REGISTER_APP_REQUEST).length, 1, 'never by itself');
  const ack = ctx.gladys.fake.action('test_connection');
  await ctx.clock.advance(7_000);
  const result = await ack;
  assert.equal(result.success, true, result.error);
  assert.equal(bridge.sent(OP.REGISTER_APP_REQUEST).length, 2, 'one new registration');
});

test('/data not writable: no registration at all', async (t) => {
  const bridge = new FakeBridge({ pin: 1234 });
  const ctx = await setup(t, {
    bridge,
    store: memoryStore(null, { failSaves: true }),
    create: false,
  });
  await ctx.clock.advance(60_000);
  assert.equal(bridge.sent(OP.REGISTER_APP_REQUEST).length, 0);
  assert.equal(bridge.log.length, 0);
  assert.match(ctx.status().message.en, /Cannot write to \/data/);
});

test('another app holds the session: Gladys waits, never takes it', async (t) => {
  const bridge = new FakeBridge({ pin: 1234, otherSession: 'iPhone' });
  const ctx = await setup(t, { bridge, create: false });
  await ctx.up();
  assert.match(ctx.status().message.en, /Another app \(iPhone\) holds the session.*1 min/);
  bridge.otherSession = undefined;
  await ctx.clock.advance(61_000);
  await ctx.app.chain;
  assert.equal(ctx.app.link.ready, true);
  assert.ok(bridge.sent(OP.START_SESSION_REQUEST).every((e) => !e.msg.takeover));
});

test('the session taken over by another app: Gladys asks again 5 minutes later', async (t) => {
  const ctx = await setup(t);
  ctx.bridge.takeOver();
  await settle();
  await ctx.app.chain;
  assert.match(ctx.status().message.en, /took the session of the LAN C over.*5 min/);
  assert.ok(ctx.gladys.fake.transports.at(-1).transport === 'unreachable');
  const sessions = ctx.bridge.sockets.length;
  await ctx.clock.advance(4 * 60_000);
  assert.equal(ctx.bridge.sockets.length, sessions);
  await ctx.clock.advance(70_000);
  await ctx.app.chain;
  assert.equal(ctx.app.link.ready, true);
});

test('the keep-alive: no answer cuts the session, which opens again', async (t) => {
  const ctx = await setup(t);
  const sessions = ctx.bridge.sockets.length;
  ctx.bridge.hold = (e) => e.type === OP.CN_TIME_REQUEST;
  // The keep-alive is due within 30 s, unanswered 10 s later.
  await ctx.clock.advance(41_000);
  await ctx.app.chain;
  assert.match(ctx.logger.lines.join('\n'), /no answer to the keep-alive, reconnecting/);
  assert.equal(ctx.app.link.ready, false);
  assert.equal(ctx.gladys.fake.transports.at(-1).transport, 'unreachable');
  ctx.bridge.hold = () => false;
  await ctx.clock.advance(15_000);
  await ctx.app.chain;
  assert.equal(ctx.app.link.ready, true);
  assert.ok(ctx.bridge.sockets.length > sessions);
  assert.equal(ctx.gladys.fake.transports.at(-1).transport, 'local');
});

test('a reconnection to Gladys sends the status, the Discovery and the states again', async (t) => {
  const ctx = await setup(t);
  const statuses = ctx.gladys.fake.connectionStatuses.length;
  const requests = ctx.gladys.fake.requests.length;
  const before = ctx.gladys.fake.states.length;
  await ctx.app.connected({ ...BASE });
  await settle();
  assert.equal(ctx.gladys.fake.connectionStatuses.length, statuses + 1, 'status sent again');
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  const paths = ctx.gladys.fake.requests.slice(requests).map((r) => r.path);
  assert.ok(
    paths.some((p) => /discover/i.test(p)),
    `Discovery sent again: ${paths.join(', ')}`,
  );
  assert.ok(
    paths.some((p) => /transport/i.test(p)),
    'badge sent again',
  );
  assert.ok(ctx.gladys.fake.states.length > before, 'states sent again');
});

test('a device published again keeps the features of the created one', async (t) => {
  const ctx = await setup(t, { create: false });
  await ctx.up();
  const created = JSON.parse(JSON.stringify(ctx.discovered()));
  created.features.push({
    name: 'Old feature',
    external_id: ctx.ids.feature('legacy'),
    category: 'unknown',
    type: 'integer',
    min: 0,
    max: 1,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  });
  await ctx.gladys.fake.deviceCreated(created);
  ctx.app.published = undefined;
  await ctx.app.publishDevices();
  assert.ok(ctx.discovered().features.some((f) => f.external_id === ctx.ids.feature('legacy')));
});

test('list the registered apps, this integration marked', async (t) => {
  const ctx = await setup(t);
  const ack = await ctx.gladys.fake.action('list_apps');
  assert.equal(ack.success, true, ack.error);
  assert.match(JSON.stringify(ack.data), /Gladys \[[0-9a-f]{32}\] \(this integration\)/);
});

test('no address, a bad address, a bad PIN: a clear status, nothing sent', async (t) => {
  for (const [config, pattern] of [
    [{ host: '' }, /Enter the IP address/],
    [{ host: 'tcp://x:1' }, /Address not understood/],
    [{ pin: '12345' }, /PIN not understood/],
  ]) {
    const bridge = new FakeBridge();
    const ctx = await setup(t, { config, bridge, create: false });
    await ctx.clock.advance(1_000);
    assert.match(ctx.status().message.en, pattern);
    assert.equal(bridge.sockets.length, 0);
  }
});

test('discovery without answer: the UUID learnt before is used', async (t) => {
  const store = memoryStore();
  const bridge = new FakeBridge({ pin: 1234 });
  await setup(t, { store, bridge });
  const again = await setup(t, {
    store,
    bridge,
    create: false,
    discover: async () => {
      throw new Error('no answer');
    },
  });
  await again.up();
  assert.equal(again.app.link.ready, true);
});

test('another unit at the same address: a new device, never the values of the old one', async (t) => {
  const ctx = await setup(t);
  ctx.bridge.serial = 'BEA009999999999';
  ctx.bridge.values.delete(192);
  ctx.bridge.drop();
  await ctx.clock.advance(20_000);
  await ctx.app.chain;
  assert.equal(ctx.app.link.ready, true);
  const ids = ctx.gladys.externalIds('comfoair', 'bea009999999999');
  const other = ctx.gladys.fake.discoveredDevices.find((d) => d.external_id === ids.device);
  assert.ok(other, 'the new unit is discovered');
  await ctx.gladys.fake.deviceCreated(other);
  await ctx.clock.advance(1_000);
  assert.equal(ctx.gladys.fake.lastState(ids.feature('filter-days')), undefined);
  assert.equal(ctx.gladys.fake.lastState(ids.feature('speed')), '2');
  // The old device is shown unreachable.
  const badge = (id) =>
    ctx.gladys.fake.transports.filter((e) => e.device_external_id === id).at(-1)?.transport;
  assert.equal(badge(ctx.ids.device), 'unreachable');
  assert.equal(badge(ids.device), 'local');
});

test('an unchanged value is sent again every 30 minutes (heartbeat)', async (t) => {
  const ctx = await setup(t);
  const id = ctx.ids.feature('filter-days');
  const count = () =>
    ctx.gladys.fake.states.filter((s) => s.device_feature_external_id === id).length;
  const before = count();
  await ctx.clock.advance(20 * 60_000);
  assert.equal(count(), before, 'nothing new in 20 minutes');
  await ctx.clock.advance(20 * 60_000);
  assert.equal(count(), before + 1);
});

/** A bridge whose RegisterApp gets `outcome`: a result code, 'timeout' or 'cut'. */
function registrationBridge(outcome, store) {
  const bridge = new FakeBridge({ pin: 1234 });
  bridge.attempts = [];
  const respond = bridge.respond.bind(bridge);
  bridge.respond = (socket, entry) => {
    if (entry.type !== OP.REGISTER_APP_REQUEST) return respond(socket, entry);
    // The attempt is in /data before the request is written.
    bridge.attempts.push(store.data?.attempt?.bridge);
    if (outcome === 'timeout') return undefined;
    if (outcome === 'cut') return socket.destroy();
    return socket.send(OP.REGISTER_APP_CONFIRM, { reference: entry.reference, result: outcome });
  };
  return bridge;
}

for (const [name, outcome, code] of [
  ['no answer', 'timeout', /timeout/],
  ['INTERNAL_ERROR', 2, /INTERNAL_ERROR/],
  ['BAD_REQUEST', 1, /BAD_REQUEST/],
  ['a cut connection', 'cut', /lost/],
]) {
  test(`registration with ${name}: one attempt, persisted before, never repeated in 2 hours`, async (t) => {
    const store = memoryStore();
    const bridge = registrationBridge(outcome, store);
    const ctx = await setup(t, { bridge, store, create: false });
    await ctx.clock.advance(2 * 60 * 60_000);
    await ctx.app.chain;
    assert.equal(bridge.sent(OP.REGISTER_APP_REQUEST).length, 1);
    assert.deepEqual(bridge.attempts, [BRIDGE_UUID], 'persisted before the write');
    assert.equal(store.data.stop.kind, 'registration_failed');
    assert.match(ctx.status().message.en, /did not succeed/);
    assert.match(ctx.status().message.en, code);
    // A restart keeps the stop.
    const again = await setup(t, { bridge, store, create: false });
    await again.clock.advance(60 * 60_000);
    assert.equal(bridge.sent(OP.REGISTER_APP_REQUEST).length, 1);
    // The button: exactly one new attempt.
    const ack = again.gladys.fake.action('test_connection');
    await again.clock.advance(25_000);
    await ack;
    await again.clock.advance(60 * 60_000);
    assert.equal(bridge.sent(OP.REGISTER_APP_REQUEST).length, 2);
  });
}

test('an attempt left pending (crash before the answer): no new RegisterApp by itself', async (t) => {
  const store = memoryStore({ uuid: 'ab'.repeat(16), attempt: { bridge: BRIDGE_UUID, at: 1 } });
  const bridge = new FakeBridge({ pin: 1234 });
  const ctx = await setup(t, { bridge, store, create: false });
  await ctx.clock.advance(60 * 60_000);
  assert.equal(bridge.sent(OP.REGISTER_APP_REQUEST).length, 0);
  assert.match(ctx.status().message.en, /did not succeed/);
});

test('the hold: a held zero is never emitted after the real value (slow subscriptions)', async (t) => {
  const bridge = new FakeBridge({ pin: 1234 });
  const held = new Map();
  bridge.hold = (e) => {
    if (e.type === OP.CN_RPDO_REQUEST && (e.msg.pdid === 65 || e.msg.pdid === 56)) {
      if (held.has(e.msg.pdid)) return false;
      held.set(e.msg.pdid, e);
      if (e.msg.pdid === 65) bridge.notify(bridge.current, 65, Buffer.alloc(1));
      return true;
    }
    return false;
  };
  const ctx = await setup(t, { bridge, create: false });
  const speeds = [];
  ctx.app.link.on('value', ({ key, value }) => key === 'speed' && speeds.push(value));
  await until(() => held.has(65));
  bridge.sendZerosFirst = false;
  await ctx.clock.advance(4_000);
  bridge.current.send(OP.CN_RPDO_CONFIRM, { reference: held.get(65).reference });
  await until(() => held.has(56));
  await ctx.clock.advance(2_000);
  bridge.notify(bridge.current, 65);
  await ctx.clock.advance(2_000);
  bridge.respond(bridge.current, held.get(56));
  await ctx.clock.advance(10_000);
  await ctx.app.chain;
  assert.equal(ctx.app.link.ready, true);
  assert.equal(speeds.at(-1), 2, JSON.stringify(speeds));
  assert.ok(
    !speeds.some((v, i) => v === 0 && speeds.slice(0, i).includes(2)),
    JSON.stringify(speeds),
  );
  assert.equal(ctx.app.values.speed, 2);
});

test('an unreadable state file is never replaced: nothing starts', async (t) => {
  const failing = memoryStore({ uuid: 'ab'.repeat(16) }, { failLoads: true });
  const bridge = new FakeBridge({ pin: 1234 });
  const ctx = await setup(t, { bridge, store: failing, create: false });
  await ctx.clock.advance(60_000);
  assert.match(ctx.status().message.en, /exists but cannot be read/);
  assert.equal(bridge.sockets.length, 0);
  assert.equal(failing.data.uuid, 'ab'.repeat(16));
  const broken = memoryStore({ uuid: 'not-a-uuid', registered: [] });
  const other = await setup(t, { bridge, store: broken, create: false });
  await other.clock.advance(60_000);
  assert.match(other.status().message.en, /exists but cannot be read/);
  assert.equal(broken.data.uuid, 'not-a-uuid', 'never overwritten');
  assert.equal(bridge.sockets.length, 0);
});

test('manual at speed 0 needs the away option', async (t) => {
  const bridge = new FakeBridge({ pin: 1234, speed: 0 });
  const ctx = await setup(t, { config: ALLOWED, bridge });
  const ack = await ctx.set('mode', 'manual');
  assert.equal(ack.success, false);
  assert.match(ack.error, /speed is 0 \(away\).*Nothing was sent/);
  assert.ok(!bridge.rmis.some((m) => m[0] === 0x84));
});

test('mode auto refused on its second message: "partly applied"', async (t) => {
  const bridge = new FakeBridge({ pin: 1234, manual: true });
  const ctx = await setup(t, { config: ALLOWED, bridge });
  const original = bridge.rmi.bind(bridge);
  bridge.rmi = (socket, reply, bytes) =>
    bytes[0] === 0x85 && bytes[2] === 0x01
      ? reply(OP.CN_RMI_RESPONSE, { result: 8, message: { result: 30 } })
      : original(socket, reply, bytes);
  const ack = await ctx.set('mode', 'auto');
  assert.equal(ack.success, false);
  assert.match(ack.error, /partly applied/);
});

test('a schedule read of an unexpected shape: state unknown, nothing sent', async (t) => {
  const ctx = await setup(t, { config: ALLOWED });
  const original = ctx.bridge.rmi.bind(ctx.bridge);
  ctx.bridge.rmi = (socket, reply, bytes) =>
    bytes[0] === 0x83
      ? reply(OP.CN_RMI_RESPONSE, { message: { message: Buffer.from([1, 2, 1]) } })
      : original(socket, reply, bytes);
  for (const [role, value] of [
    ['speed', '3'],
    ['mode', 'manual'],
  ]) {
    const ack = await ctx.set(role, value);
    assert.equal(ack.success, false);
    assert.match(ack.error, /not readable: nothing was sent/);
  }
  assert.ok(!ctx.bridge.rmis.some((m) => m[0] === 0x84));
});

test('only IPv4 addresses are taken', async (t) => {
  const bridge = new FakeBridge();
  const ctx = await setup(t, { config: { host: 'lanc.local' }, bridge, create: false });
  await ctx.clock.advance(1_000);
  assert.match(ctx.status().message.en, /Address not understood/);
  assert.equal(bridge.sockets.length, 0);
});

test('a measure goes to Gladys at most every 30 s; the latest value is kept', async (t) => {
  const ctx = await setup(t);
  await ctx.clock.advance(40_000);
  const id = ctx.ids.feature('temperature-outdoor');
  const sent = () => ctx.gladys.fake.states.filter((s) => s.device_feature_external_id === id);
  const before = sent().length;
  const le = (v) => {
    const b = Buffer.alloc(2);
    b.writeInt16LE(v);
    return b;
  };
  ctx.bridge.notify(ctx.bridge.current, 276, le(90));
  await ctx.clock.advance(1_000);
  ctx.bridge.notify(ctx.bridge.current, 276, le(95));
  await ctx.clock.advance(5_000);
  ctx.bridge.notify(ctx.bridge.current, 276, le(97));
  await ctx.clock.advance(5_000);
  assert.equal(sent().length, before + 1, 'one value in 11 s');
  await ctx.clock.advance(30_000);
  assert.equal(sent().length, before + 2);
  assert.equal(ctx.state('temperature-outdoor'), 9.7);
});
