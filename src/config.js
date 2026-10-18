// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  allow_commands: false,
  allow_away: false,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

/** The PIN of a LAN C out of the box (zehnder.proto: "The default Pin-code is 0000"). */
export const DEFAULT_PIN = 0;

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

/**
 * An IPv4 address only (`192.168.1.20`): the discovery answer is accepted
 * only from that address, which a host name would not allow to check.
 */
export function parseHost(raw) {
  const text = String(raw ?? '').trim();
  return isIP(text) === 4 ? text : '';
}

/**
 * The PIN: empty -> the default 0000; 1 to 4 digits -> the number; anything
 * else -> undefined (invalid: no registration is tried with it).
 */
export function parsePin(raw) {
  if (raw === undefined || raw === null) return DEFAULT_PIN;
  const text = String(raw).trim();
  if (text === '') return DEFAULT_PIN;
  return /^\d{1,4}$/.test(text) ? Number(text) : undefined;
}

export function normalizeConfig(raw = {}) {
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  const typedHost = String(raw?.host ?? '').trim();
  const host = parseHost(typedHost);
  return {
    host,
    hostInvalid: typedHost !== '' && host === '',
    pin: parsePin(raw?.pin),
    allowCommands: bool(raw?.allow_commands, DEFAULTS.allow_commands),
    allowAway: bool(raw?.allow_away, DEFAULTS.allow_away),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}

/** What the session depends on: a change reconnects (and lifts a stop). */
export const sessionKey = (config) => JSON.stringify([config.host, config.pin ?? null]);
