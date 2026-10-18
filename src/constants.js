// -----------------------------------------------------------------------------
// ComfoConnect LAN C constants, manifest keys, limits and timings.
//
// The ComfoConnect LAN C (and PRO) speaks a length-prefixed protobuf protocol
// on TCP port 56747, and answers a protobuf discovery request on UDP port
// 56747, as aiocomfoconnect (MIT, 0.3.4) documents and implements it
// (docs/PROTOCOL.md, protobuf/zehnder.proto, bridge.py, comfoconnect.py,
// sensors.py, const.py).
// -----------------------------------------------------------------------------

export const PORT = 56747;

/** GatewayOperation.OperationType: only the ones this integration sends or reads. */
export const OP = Object.freeze({
  NO_OPERATION: 0,
  REGISTER_APP_REQUEST: 2,
  START_SESSION_REQUEST: 3,
  CLOSE_SESSION_REQUEST: 4,
  LIST_REGISTERED_APPS_REQUEST: 5,
  REGISTER_APP_CONFIRM: 52,
  START_SESSION_CONFIRM: 53,
  CLOSE_SESSION_CONFIRM: 54,
  LIST_REGISTERED_APPS_CONFIRM: 55,
  GATEWAY_NOTIFICATION: 100,
  KEEP_ALIVE: 101,
  CN_TIME_REQUEST: 30,
  CN_TIME_CONFIRM: 31,
  CN_NODE_NOTIFICATION: 32,
  CN_RMI_REQUEST: 33,
  CN_RMI_RESPONSE: 34,
  CN_RPDO_REQUEST: 38,
  CN_RPDO_CONFIRM: 39,
  CN_RPDO_NOTIFICATION: 40,
  CN_ALARM_NOTIFICATION: 41,
  CN_NODE_REQUEST: 42,
});

/** GatewayOperation.GatewayResult. */
export const RESULT = Object.freeze({
  OK: 0,
  BAD_REQUEST: 1,
  INTERNAL_ERROR: 2,
  NOT_REACHABLE: 3,
  OTHER_SESSION: 4,
  NOT_ALLOWED: 5,
  NO_RESOURCES: 6,
  NOT_EXIST: 7,
  RMI_ERROR: 8,
});

export const RESULT_NAMES = new Map(Object.entries(RESULT).map(([name, code]) => [code, name]));

/** SearchGatewayResponse.GatewayType. */
export const GATEWAY_TYPE = Object.freeze({ LANC: 0, SEASON: 1, PRO: 2 });

/** CnNodeNotification.NodeModeType. */
export const NODE_MODE = Object.freeze({ LEGACY: 0, OFFLINE: 1, NORMAL: 2, UPDATE: 3 });

/** The product ids that take the ventilation unit RMI commands (ComfoAir Q, ComfoAir Flex). */
export const VENTILATION_PRODUCTS = new Set([0x01, 0x08]);

/** PDO types (aiocomfoconnect PdoType): size in bytes and sign. */
export const PDO_TYPE = Object.freeze({
  BOOL: 0x00,
  UINT8: 0x01,
  UINT16: 0x02,
  UINT32: 0x03,
  INT8: 0x05,
  INT16: 0x06,
  INT64: 0x08,
});

export const PDO_LAYOUT = new Map([
  [PDO_TYPE.BOOL, { size: 1, signed: false }],
  [PDO_TYPE.UINT8, { size: 1, signed: false }],
  [PDO_TYPE.UINT16, { size: 2, signed: false }],
  [PDO_TYPE.UINT32, { size: 4, signed: false }],
  [PDO_TYPE.INT8, { size: 1, signed: true }],
  [PDO_TYPE.INT16, { size: 2, signed: true }],
]);

/**
 * The sensors read (aiocomfoconnect sensors.py, docs/PROTOCOL-PDO.md): PDO id
 * -> { key, type }. `key` names the value in the model.
 */
export const SENSORS = new Map([
  [65, { key: 'speed', type: PDO_TYPE.UINT8 }],
  [56, { key: 'manual', type: PDO_TYPE.UINT8 }],
  [49, { key: 'operating', type: PDO_TYPE.UINT8 }],
  [66, { key: 'bypassMode', type: PDO_TYPE.UINT8 }],
  [227, { key: 'bypassOpen', type: PDO_TYPE.UINT8 }],
  [192, { key: 'filterDays', type: PDO_TYPE.UINT16 }],
  [276, { key: 'tempOutdoor', type: PDO_TYPE.INT16 }],
  [274, { key: 'tempExtract', type: PDO_TYPE.INT16 }],
  [221, { key: 'tempSupply', type: PDO_TYPE.INT16 }],
  [275, { key: 'tempExhaust', type: PDO_TYPE.INT16 }],
  [292, { key: 'humOutdoor', type: PDO_TYPE.UINT8 }],
  [290, { key: 'humExtract', type: PDO_TYPE.UINT8 }],
  [294, { key: 'humSupply', type: PDO_TYPE.UINT8 }],
  [291, { key: 'humExhaust', type: PDO_TYPE.UINT8 }],
  [120, { key: 'flowSupply', type: PDO_TYPE.UINT16 }],
  [119, { key: 'flowExhaust', type: PDO_TYPE.UINT16 }],
]);

/** RMI units and subunits (aiocomfoconnect const.py). */
export const UNIT = Object.freeze({ NODE: 0x01, SCHEDULE: 0x15 });
export const SUBUNIT = Object.freeze({ S01: 0x01, S08: 0x08 });

/**
 * RMI messages, byte for byte as aiocomfoconnect sends them
 * (comfoconnect.py get_speed, set_speed, get_mode, set_mode,
 * get_single_property).
 */
export const RMI = Object.freeze({
  /** NODE 01, property 04: serial number (string). */
  serial: () => Buffer.from([0x01, UNIT.NODE, SUBUNIT.S01, 0x10, 0x04]),
  /** NODE 01, property 08: model (string). */
  model: () => Buffer.from([0x01, UNIT.NODE, SUBUNIT.S01, 0x10, 0x08]),
  getSpeed: () => Buffer.from([0x83, UNIT.SCHEDULE, SUBUNIT.S01, 0x01]),
  setSpeed: (speed) =>
    Buffer.from([
      0x84,
      UNIT.SCHEDULE,
      SUBUNIT.S01,
      0x01,
      0x00,
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      speed,
    ]),
  getMode: () => Buffer.from([0x83, UNIT.SCHEDULE, SUBUNIT.S08, 0x01]),
  /** Auto: the manual mode and the temporary speed override are both cancelled. */
  setAuto: () => [
    Buffer.from([0x85, UNIT.SCHEDULE, SUBUNIT.S08, 0x01]),
    Buffer.from([0x85, UNIT.SCHEDULE, SUBUNIT.S01, 0x01]),
  ],
  setManual: () => [
    Buffer.from([
      0x84,
      UNIT.SCHEDULE,
      SUBUNIT.S08,
      0x01,
      0x00,
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x01,
    ]),
  ],
});

/** Speeds of the select: 0 = away (the ventilation almost stops), 1 low, 2 medium, 3 high. */
export const SPEEDS = ['0', '1', '2', '3'];
export const AWAY_SPEED = '0';
export const MODES = ['auto', 'manual'];

/** PDO 49 (operating mode). */
export const OPERATING = new Map([
  [255, 'auto'],
  [1, 'manual_limited'],
  [5, 'manual'],
  [6, 'boost'],
  [11, 'away'],
]);

/** PDO 66 (bypass activation mode). */
export const BYPASS_MODES = new Map([
  [0, 'auto'],
  [1, 'open'],
  [2, 'closed'],
]);

/** Feature roles (the last part of the feature external ids): frozen forever. */
export const FEATURES = Object.freeze({
  SPEED: 'speed',
  MODE: 'mode',
  OPERATING: 'operating-mode',
  TEMP_OUTDOOR: 'temperature-outdoor',
  TEMP_EXTRACT: 'temperature-extract',
  TEMP_SUPPLY: 'temperature-supply',
  TEMP_EXHAUST: 'temperature-exhaust',
  HUM_OUTDOOR: 'humidity-outdoor',
  HUM_EXTRACT: 'humidity-extract',
  HUM_SUPPLY: 'humidity-supply',
  HUM_EXHAUST: 'humidity-exhaust',
  FLOW_SUPPLY: 'flow-supply',
  FLOW_EXHAUST: 'flow-exhaust',
  BYPASS: 'bypass-open',
  BYPASS_MODE: 'bypass-mode',
  FILTER: 'filter-days',
});

export const ACTIONS = Object.freeze({
  TEST_CONNECTION: 'test_connection',
  LIST_APPS: 'list_apps',
});

/** The name the integration registers under on the LAN C (max 32 bytes). */
export const DEVICE_NAME = 'Gladys';

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;

export const LIMITS = {
  /** Gladys: 300 states per minute per integration. */
  statesPerMinute: 300,
  /** Part of the minute budget kept for the selects and texts. */
  priorityStates: 30,
  /** A packet longer than this cuts the session (the longest real one is a list of apps). */
  maxPacket: 16 * 1024,
  /** A discovery answer longer than this is ignored. */
  maxDatagram: 512,
  /** Requests waiting for their answer at once. */
  maxPending: 64,
  /** Nested protobuf messages read at most. */
  maxDepth: 4,
  /** Longest text kept from the bridge (names, serial, model). */
  textLength: 64,
  /** Apps listed by the "list" button at most. */
  maxApps: 32,
};

export const TIMINGS = {
  /** TCP connection to the bridge. */
  connectTimeout: 10 * SECOND,
  /** Discovery answer (UDP), per try; 2 tries. */
  discoveryTimeout: 2 * SECOND,
  discoveryTries: 2,
  /** A request of the session (aiocomfoconnect TIMEOUT = 5 s). */
  requestTimeout: 5 * SECOND,
  /** The bridge announces the ventilation unit right after the session starts. */
  nodeWait: 5 * SECOND,
  /** A time request every 30 s keeps the session and checks it (aiocomfoconnect CLI). */
  keepAlive: 30 * SECOND,
  keepAliveTimeout: 10 * SECOND,
  /** Values held after a subscription: the bridge first sends zeros (aiocomfoconnect sensor_delay). */
  sensorHold: 5 * SECOND,
  /** Network failures: 10 s, 30 s, 1 min, 2 min, then 5 min. */
  backoff: [10 * SECOND, 30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** Another app holds the session: 1 min, 2 min, then 5 min. */
  otherSession: [MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** The session taken by another app: wait 5 minutes before asking again. */
  takenOver: 5 * MINUTE,
  /** The states are offered to the publisher every 5 min (for the heartbeats). */
  sweep: 5 * MINUTE,
  /** The publisher: unchanged states again every 30 min, spread over 5 min. */
  stateHeartbeat: 30 * MINUTE,
  heartbeatSpread: 5 * MINUTE,
  /**
   * Commands (Gladys waits 5 s for the ack): the fresh read and the command
   * must be written by 3.5 s after the request, or nothing is sent; the
   * answer of the unit is awaited until 4.5 s, after which the command is
   * "sent, without confirmation".
   */
  sendBy: 3_500,
  answerBy: 4_500,
  /** The fresh read before a command: 1.5 s at most, 0.3 s left to send after it. */
  readMax: 1_500,
  minSend: 300,
  /** Read back after a command sent without confirmation. */
  readBack: 2 * SECOND,
  /** "Test the connection" waits this long for the session. */
  testWait: 20 * SECOND,
};
