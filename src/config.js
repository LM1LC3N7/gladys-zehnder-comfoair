// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

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

/** `192.168.1.20` or a host name; a port, a scheme or a path is not taken. */
export function parseHost(raw) {
  const text = String(raw ?? '').trim();
  if (text.length > 253) return '';
  if (/^[0-9a-z.-]+$/i.test(text) && !text.startsWith('-')) return text.toLowerCase();
  return '';
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
