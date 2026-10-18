# Zehnder ComfoAir Q for Gladys Assistant

External integration for [Gladys Assistant](https://gladysassistant.com):
**Zehnder ComfoAir Q** heat recovery ventilation units (Q350, Q450, Q600),
**locally** through the **ComfoConnect LAN C**.

> **Never tested with a real ventilation unit.** Unofficial, not affiliated
> with Zehnder.

- Read: ventilation speed, mode, operating mode, temperatures and humidities
  of the outdoor, extract, supply and exhaust air, supply and exhaust flows,
  bypass opening and setting, days before the filter change.
- Commands: speed (a select, 0 to 3) and mode (auto, manual), never a
  switch; **off by default**; speed 0 ("away", the ventilation almost stops)
  needs its own option; decided on the state read from the unit just before.
- Registers **once** on the LAN C (a few places only) under a UUID kept in
  `/data`, with the PIN of a secret field; never takes the session of the
  Zehnder app; a button lists the registered apps.

User guides: [français](docs/fr.md), [English](docs/en.md).

## Development

```bash
npm install
npm test               # node --test (Node 22 and 24), against an in-memory LAN C
npm run lint
npm run format:check
npm run audit          # npm audit --omit=dev
npx github:GladysAssistant/integration-store .
```

Layout: `src/protocol/` (protobuf codec, packets, bounded reader, TCP client,
UDP discovery, session), `src/app.js` (lifecycle, model, states, commands),
`src/devices.js`, `src/publisher.js` (rate limits),
`test/helpers/fakeBridge.js` (the simulated LAN C and a virtual clock). See
`CLAUDE.md` and `TODO.md`.

## Credits and licence

Apache-2.0 (`LICENSE`). The protocol is ported from
[aiocomfoconnect](https://github.com/michaelarnauts/aiocomfoconnect) 0.3.4 by
Michaël Arnauts (MIT): see `THIRD_PARTY_NOTICES.md`.
