// -----------------------------------------------------------------------------
// The ventilation unit -> one Gladys device and its states (pure).
//
// `ext:<selector>:comfoair:<serial>`: keyed by the serial number of the
// ComfoAir unit (read from the unit itself), never by the IP address nor the
// bridge (a LAN C can be replaced). The feature roles (the last part of their
// external ids) are published forever: never rename them.
//
// No switch, no writable binary: a "turn everything off" (Google Home, Alexa,
// HomeKit, MCP, `switch.*` scenes) must never reach the ventilation. The two
// commands are `text/select` features (speed 0 to 3, mode auto / manual),
// refused unless the configuration allows them (src/app.js).
//
// Units are those the core lists for the category
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): celsius on `temperature-sensor`,
// percent on `humidity-sensor`, days on `duration`. The core has no category
// for an air flow in m³/h nor for a bypass opening: they are plain sensors
// (`unknown` / `integer`, no unit), the unit in their name.
//
// A device published again never loses a feature: those of the device
// already created in Gladys are kept as they are (the core would mark it
// `structure_changed`, and "Update" would delete the missing feature and its
// history).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as TY,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { BYPASS_MODES, FEATURES, MODES, OPERATING, SPEEDS } from './constants.js';
import {
  BYPASS_TEXTS,
  DEVICE_NAME,
  FEATURE_NAMES,
  MODE_LABELS,
  OPERATING_TEXTS,
  SPEED_LABELS,
  fill,
  word,
} from './i18n.js';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const text = sensor({ category: C.TEXT, type: TY.TEXT.TEXT, min: 0, max: 0, keep_history: false });
const select = {
  category: C.TEXT,
  type: TY.TEXT.SELECT,
  min: 0,
  max: 0,
  read_only: false,
  has_feedback: true,
  keep_history: false,
};
const temperature = sensor({
  category: C.TEMPERATURE_SENSOR,
  type: TY.SENSOR.DECIMAL,
  unit: U.CELSIUS,
  min: -50,
  max: 80,
});
const humidity = sensor({
  category: C.HUMIDITY_SENSOR,
  type: TY.SENSOR.INTEGER,
  unit: U.PERCENT,
  min: 0,
  max: 100,
});
const plain = (max) => sensor({ category: C.UNKNOWN, type: TY.SENSOR.INTEGER, min: 0, max });

/** The features, by role, in display order. */
export const DEFINITIONS = {
  [FEATURES.SPEED]: select,
  [FEATURES.MODE]: select,
  [FEATURES.OPERATING]: text,
  [FEATURES.TEMP_OUTDOOR]: temperature,
  [FEATURES.TEMP_EXTRACT]: temperature,
  [FEATURES.TEMP_SUPPLY]: temperature,
  [FEATURES.TEMP_EXHAUST]: temperature,
  [FEATURES.HUM_OUTDOOR]: humidity,
  [FEATURES.HUM_EXTRACT]: humidity,
  [FEATURES.HUM_SUPPLY]: humidity,
  [FEATURES.HUM_EXHAUST]: humidity,
  [FEATURES.FLOW_SUPPLY]: plain(2000),
  [FEATURES.FLOW_EXHAUST]: plain(2000),
  [FEATURES.BYPASS]: plain(100),
  [FEATURES.BYPASS_MODE]: text,
  [FEATURES.FILTER]: sensor({
    category: C.DURATION,
    type: TY.DURATION.INTEGER,
    unit: U.DAYS,
    min: 0,
    max: 3650,
  }),
};

export const ROLES = Object.keys(DEFINITIONS);
export const COMMAND_ROLES = [FEATURES.SPEED, FEATURES.MODE];

/** The fields of a feature Gladys stores (what is kept of a created feature). */
const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'supported_options',
];

export const unitKey = (serial) => serial.toLowerCase();
export const unitIds = (gladys, serial) => gladys.externalIds('comfoair', unitKey(serial));

/** The serial and the role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') return undefined;
  const match = /:comfoair:([a-z0-9]{4,40}):([a-z-]+)$/.exec(externalId);
  if (!match || !ROLES.includes(match[2])) return undefined;
  return { key: match[1], role: match[2] };
}

export function optionsOf(role, language) {
  if (role === FEATURES.SPEED) {
    return SPEEDS.map((value, index) => ({
      value,
      label: word(SPEED_LABELS[value], language),
      sort_order: index,
    }));
  }
  return MODES.map((value, index) => ({
    value,
    label: word(MODE_LABELS[value], language),
    sort_order: index,
  }));
}

/** The name of the device: the model the unit gives, else a default. */
export function deviceName(unit, language) {
  return unit.model ? unit.model.slice(0, 60) : word(DEVICE_NAME, language);
}

/**
 * The Gladys device of the unit. `created`: the device already created in
 * Gladys, whose features are kept when the new build lacks them.
 */
export function buildDevice(gladys, unit, { language, created }) {
  const ids = unitIds(gladys, unit.serial);
  const built = {
    name: deviceName(unit, language),
    external_id: ids.device,
    model: unit.model ? unit.model.slice(0, 60) : 'Zehnder ComfoAir',
    should_poll: false,
    features: ROLES.map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...DEFINITIONS[role],
      ...(COMMAND_ROLES.includes(role) ? { supported_options: optionsOf(role, language) } : {}),
    })),
    params: [{ name: 'serial', value: unit.serial }],
  };
  return keepCreatedFeatures(built, created);
}

/** The features of the created device that the new build lacks, kept as they are. */
export function keepCreatedFeatures(built, created) {
  if (!created) return built;
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => typeof f?.external_id === 'string' && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  return { ...built, features: [...built.features, ...kept] };
}

const textOf = (map, texts, value, language) => {
  if (value === undefined) return undefined;
  const key = map.get(value);
  return key ? word(texts[key], language) : word(fill(texts.unknown, value), language);
};

/**
 * The states of the unit from the values read (`values`: key -> raw number).
 * A value outside the bounds of its feature is left out (Gladys keeps the
 * last one).
 */
export function buildStates(ids, values, language) {
  const states = [];
  const add = (role, state) => {
    const { min, max } = DEFINITIONS[role];
    if (state !== undefined && Number.isFinite(state) && state >= min && state <= max) {
      states.push({ device_feature_external_id: ids.feature(role), state });
    }
  };
  const addText = (role, value) => {
    if (typeof value === 'string' && value !== '') {
      states.push({ device_feature_external_id: ids.feature(role), text: value });
    }
  };
  const v = values;
  if (v.speed !== undefined && SPEEDS.includes(String(v.speed))) {
    addText(FEATURES.SPEED, String(v.speed));
  }
  if (v.manual === 255) addText(FEATURES.MODE, 'auto');
  else if (v.manual === 1) addText(FEATURES.MODE, 'manual');
  addText(FEATURES.OPERATING, textOf(OPERATING, OPERATING_TEXTS, v.operating, language));
  const tenth = (raw) => (raw === undefined ? undefined : Math.round(raw) / 10);
  add(FEATURES.TEMP_OUTDOOR, tenth(v.tempOutdoor));
  add(FEATURES.TEMP_EXTRACT, tenth(v.tempExtract));
  add(FEATURES.TEMP_SUPPLY, tenth(v.tempSupply));
  add(FEATURES.TEMP_EXHAUST, tenth(v.tempExhaust));
  add(FEATURES.HUM_OUTDOOR, v.humOutdoor);
  add(FEATURES.HUM_EXTRACT, v.humExtract);
  add(FEATURES.HUM_SUPPLY, v.humSupply);
  add(FEATURES.HUM_EXHAUST, v.humExhaust);
  add(FEATURES.FLOW_SUPPLY, v.flowSupply);
  add(FEATURES.FLOW_EXHAUST, v.flowExhaust);
  add(FEATURES.BYPASS, v.bypassOpen);
  addText(FEATURES.BYPASS_MODE, textOf(BYPASS_MODES, BYPASS_TEXTS, v.bypassMode, language));
  add(FEATURES.FILTER, v.filterDays);
  return states;
}
