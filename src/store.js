// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), readable by the container user only (0600):
// - `uuid`: the UUID Gladys registers under on the LAN C, created once and
//   never changed (a new one would take a new place on the bridge);
// - `bridges`: the UUID of the bridge at each address (used when the
//   discovery gets no answer);
// - `registered`: the bridges this UUID was registered on (never registered
//   twice by itself);
// - `unit`: the serial and model of the ventilation unit last seen (the
//   device is shown, unreachable, before the bridge answers);
// - `stop`: a PIN refused, a full bridge, a registration removed: no new
//   try until the configuration changes or "Test the connection" is clicked.
// Never the PIN. Arrays and fixed names only: nothing read from the bridge or
// the file becomes an object key.
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { STOP_KINDS, isSerial } from './protocol/link.js';
import { GATEWAY_TYPE } from './constants.js';

export const STATE_FILE = '/data/comfoair-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** In-memory store, for the tests. */
export function memoryStore(initial = null, { failSaves = false } = {}) {
  let data = initial;
  return {
    failSaves,
    async load() {
      return data === null ? null : JSON.parse(JSON.stringify(data));
    },
    async save(next) {
      if (this.failSaves) throw new Error('read-only file system');
      data = JSON.parse(JSON.stringify(next));
    },
    get data() {
      return data;
    },
  };
}

const HEX32 = /^[0-9a-f]{32}$/;
const MAX_BRIDGES = 8;

/** A new app UUID: 32 lower-case hexadecimal digits. */
export const newUuid = () => randomUUID().replace(/-/g, '');

/** The persisted state, repaired. */
export function normalizeMemory(raw) {
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  const bridges = (Array.isArray(raw?.bridges) ? raw.bridges : [])
    .filter((b) => typeof b?.host === 'string' && b.host.length <= 253 && HEX32.test(b?.uuid))
    .slice(0, MAX_BRIDGES)
    .map((b) => ({
      host: b.host,
      uuid: b.uuid,
      type: Object.values(GATEWAY_TYPE).includes(b.type) ? b.type : GATEWAY_TYPE.LANC,
    }));
  const registered = (Array.isArray(raw?.registered) ? raw.registered : [])
    .filter((uuid) => HEX32.test(uuid))
    .slice(0, MAX_BRIDGES);
  const unit =
    typeof raw?.unit?.serial === 'string' && isSerial(raw.unit.serial)
      ? { serial: raw.unit.serial, model: text(raw.unit.model, 64) }
      : null;
  const stop =
    typeof raw?.stop?.place === 'string' &&
    raw.stop.place.length <= 253 &&
    STOP_KINDS.includes(raw.stop.kind)
      ? {
          place: raw.stop.place,
          kind: raw.stop.kind,
          at: Number.isFinite(raw.stop.at) ? raw.stop.at : 0,
        }
      : null;
  return {
    uuid: typeof raw?.uuid === 'string' && HEX32.test(raw.uuid) ? raw.uuid : null,
    bridges,
    registered,
    unit,
    stop,
  };
}
