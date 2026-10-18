// -----------------------------------------------------------------------------
// A minimal protobuf (proto2) codec for the dozen ComfoConnect messages this
// integration uses: varints (uint32, bool, enum), length-delimited fields
// (bytes, string, nested messages), repeated fields. No runtime dependency
// (see TODO.md "Decisions": why not protobufjs).
//
// Decoding is one forward pass over a buffer whose length is already bounded
// by the packet reader; every length is checked against what is left; a
// varint has at most 10 bytes; nested messages are read to a fixed depth.
// The decoded object only ever gets the names of the schema (never a name or
// a key that came from the wire): no prototype pollution. Unknown fields are
// skipped, as protobuf requires.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';

export class ProtobufError extends Error {}

const WIRE = { VARINT: 0, FIXED64: 1, BYTES: 2, START_GROUP: 3, END_GROUP: 4, FIXED32: 5 };
const TWO_32 = 2 ** 32;

/**
 * A schema: an array of { n, name, type, of?, repeated? } with type one of
 * 'uint32', 'bool', 'enum', 'bytes', 'string', 'message' (`of`: its schema).
 */
export const field = (n, name, type, extra = {}) => Object.freeze({ n, name, type, ...extra });

function writeVarint(out, value) {
  let v = value;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
}

function writeTag(out, n, wire) {
  writeVarint(out, n * 8 + wire);
}

function uint32Of(value, name) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (!Number.isInteger(value) || value < 0 || value >= TWO_32) {
    throw new ProtobufError(`${name}: not a uint32`);
  }
  return value;
}

function writeBytes(out, n, bytes) {
  writeTag(out, n, WIRE.BYTES);
  writeVarint(out, bytes.length);
  for (const b of bytes) out.push(b);
}

/** values: a plain object; undefined fields are left out. */
export function encode(schema, values = {}) {
  const out = [];
  for (const spec of schema) {
    const raw = Object.hasOwn(values, spec.name) ? values[spec.name] : undefined;
    if (raw === undefined || raw === null) continue;
    const list = spec.repeated ? raw : [raw];
    for (const value of list) {
      switch (spec.type) {
        case 'uint32':
        case 'enum':
        case 'bool':
          writeTag(out, spec.n, WIRE.VARINT);
          writeVarint(out, uint32Of(value, spec.name));
          break;
        case 'bytes':
          if (!Buffer.isBuffer(value)) throw new ProtobufError(`${spec.name}: not bytes`);
          writeBytes(out, spec.n, value);
          break;
        case 'string':
          writeBytes(out, spec.n, Buffer.from(String(value), 'utf8'));
          break;
        case 'message':
          writeBytes(out, spec.n, encode(spec.of, value));
          break;
        default:
          throw new ProtobufError(`${spec.name}: unknown type`);
      }
    }
  }
  return Buffer.from(out);
}

class Cursor {
  constructor(buf, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }

  get done() {
    return this.pos >= this.end;
  }

  /** A varint as a Number: its low 35 bits at most are kept (enough for uint32). */
  varint() {
    let result = 0;
    let factor = 1;
    for (let i = 0; i < 10; i += 1) {
      if (this.pos >= this.end) throw new ProtobufError('truncated varint');
      const byte = this.buf[this.pos];
      this.pos += 1;
      if (i < 5) result += (byte & 0x7f) * factor;
      factor *= 0x80;
      if ((byte & 0x80) === 0) return result;
    }
    throw new ProtobufError('varint too long');
  }

  skip(length) {
    if (length < 0 || length > this.end - this.pos) throw new ProtobufError('truncated field');
    this.pos += length;
  }

  slice(length) {
    if (length > this.end - this.pos) throw new ProtobufError('truncated field');
    const start = this.pos;
    this.pos += length;
    return [start, this.pos];
  }
}

function decodeInto(schema, buf, start, end, depth) {
  if (depth > LIMITS.maxDepth) throw new ProtobufError('nested too deep');
  const byNumber = new Map(schema.map((spec) => [spec.n, spec]));
  const out = {};
  for (const spec of schema) if (spec.repeated) out[spec.name] = [];
  const cursor = new Cursor(buf, start, end);
  while (!cursor.done) {
    const tag = cursor.varint();
    const n = Math.floor(tag / 8);
    const wire = tag % 8;
    if (n === 0) throw new ProtobufError('field number 0');
    const spec = byNumber.get(n);
    let value;
    switch (wire) {
      case WIRE.VARINT: {
        const raw = cursor.varint();
        if (!spec) continue;
        if (spec.type === 'bool') value = raw !== 0;
        else if (spec.type === 'uint32' || spec.type === 'enum') value = raw % TWO_32;
        else throw new ProtobufError(`${spec.name}: wrong wire type`);
        break;
      }
      case WIRE.BYTES: {
        const length = cursor.varint();
        const [from, to] = cursor.slice(length);
        if (!spec) continue;
        if (spec.type === 'bytes') value = Buffer.from(buf.subarray(from, to));
        else if (spec.type === 'string') {
          value = buf.subarray(from, to).toString('utf8').slice(0, LIMITS.textLength);
        } else if (spec.type === 'message') value = decodeInto(spec.of, buf, from, to, depth + 1);
        else throw new ProtobufError(`${spec.name}: wrong wire type`);
        break;
      }
      case WIRE.FIXED64:
        cursor.skip(8);
        if (spec) throw new ProtobufError(`${spec.name}: wrong wire type`);
        continue;
      case WIRE.FIXED32:
        cursor.skip(4);
        if (spec) throw new ProtobufError(`${spec.name}: wrong wire type`);
        continue;
      default:
        // Groups (3, 4) and the reserved 6, 7: never in this protocol.
        throw new ProtobufError(`wire type ${wire} not supported`);
    }
    if (spec.repeated) {
      if (out[spec.name].length >= LIMITS.maxApps) continue;
      out[spec.name].push(value);
    } else {
      // proto2: the last one wins.
      out[spec.name] = value;
    }
  }
  return out;
}

/** Decodes `buf` with `schema`; throws ProtobufError on a malformed message. */
export function decode(schema, buf) {
  return decodeInto(schema, buf, 0, buf.length, 0);
}
