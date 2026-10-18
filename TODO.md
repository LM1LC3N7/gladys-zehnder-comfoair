# TODO - Zehnder ComfoAir Q v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/fr.md`, `docs/en.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: lot 8 was
  claimed in /t/10385 (post #275); the main session posts one recap per wave.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 - core** (2026-10-18): own protobuf codec, packet reader,
      TCP client, UDP discovery and session ported from aiocomfoconnect
      0.3.4; registration once (UUID in `/data`, PIN in a secret field);
      speed, mode, operating mode, temperatures and humidities of the four
      airs, flows, bypass, filter days; speed and mode commands opt-in, speed
      0 behind its own option, decided on a fresh RMI read; "Test the
      connection", "List the registered apps"; fr/en docs. Tested against an
      in-memory LAN C only (packets checked byte for byte against the
      examples of aiocomfoconnect's `docs/PROTOCOL.md`).
- [ ] **Milestone 2 - real unit**: run against a LAN C and a ComfoAir Q;
      capture real packets (anonymised) as fixtures; fix what differs (see
      below).
- [ ] **Milestone 3 - more**: alarms and errors of the unit (CnAlarmNotification,
      filter warning as a binary sensor), timed boost (scene action), bypass
      command, temperature profile, power consumption (PDO 128, with the
      lessons on energy indexes), ComfoCool / ComfoClime, removing another
      registered app from Gladys (with a confirmation), a ComfoConnect PRO.
- [ ] **Milestone 4 - first release**: Docker image check, Release workflow,
      topic, GHCR package public.

## To check on a real unit

- That `StartSession` of an unknown UUID answers `NOT_ALLOWED` (the
  registration is triggered by it only), and what a LAN C answers to a
  `RegisterApp` of a UUID already registered.
- How many apps a LAN C accepts, and that a full one answers `NO_RESOURCES`.
- The answer to `StartSession` when the Zehnder app holds the session
  (`OTHER_SESSION` with its name), and whether the Zehnder app takes the
  session of Gladys over (a `CloseSessionRequest` to Gladys).
- That the zeros sent right after a subscription stop within 5 s, and that a
  real zero (bypass closed, speed 0) is published at the end of the hold.
- The effect of `set_speed` in automatic mode (aiocomfoconnect sends a
  timeout field of `01 00 00 00`): does the unit switch to manual, or come
  back to its schedule?
- PDO 56 and 49 values in each mode (255 / 1 for the manual flag; 255, 1, 5,
  6, 11 for the operating mode).
- Whether the bridge pads the PDO data to 8 bytes (the values are read at
  their exact size either way).
- That the UDP discovery answers a unicast request, from a Docker bridge
  network.
- That the keep-alive (a time request every 30 s) is enough to keep the
  session (aiocomfoconnect 0.4.x also sends `KeepAlive` when idle).
- The model and serial strings (RMI NODE 01 property 08 and 04).

## Decisions

- **Reference version 0.3.4**: the brief names aiocomfoconnect 0.3.4 (tag
  `v0.3.4`, commit `7359f81`, MIT); the repository has moved to 0.4.x since
  (tests, docs, a heartbeat when idle), the protocol parts used here are the
  same. Cloned read only in `_ref/aiocomfoconnect`, credited in
  `THIRD_PARTY_NOTICES.md` (copied into the image with `LICENSE`).
- **Protobuf: an own minimal codec, no runtime dependency.** The integration
  reads and writes 15 small proto2 messages made of varints, bytes, strings
  and one repeated nested message: a codec of ~200 lines covers them, and is
  pinned byte for byte against the examples of aiocomfoconnect's
  `docs/PROTOCOL.md`. protobufjs (well maintained, but BSD-3-Clause, not the
  MIT or Apache-2.0 asked) was the alternative: it would add a large package
  and a code generation step or a runtime `.proto` parser to the image, for
  features not used here, and its history
  of prototype pollution advisories (CVE-2022-25878, CVE-2023-36665) is the
  very class of bug this integration must avoid; the own decoder only ever
  writes the field names of its schemas, bounds every length, reads varints
  of 10 bytes at most and nested messages to a depth of 4. Runtime
  dependency: the SDK only.
- **Version 0.1.0, set by hand once**: the template ships 1.0.0; the sibling
  modules start at 0.1.x, so `package.json`, `package-lock.json`, the
  manifest `version` and the `docker_image` tag were set together to 0.1.0 in
  milestone 1, before any release. Every later version comes from Actions ->
  Release (the first patch release gives 0.1.1).
- **Registration once**: the app UUID (32 hex digits) is created at the first
  start, saved to `/data/comfoair-state.json` and read back; if it cannot be
  kept, nothing is registered (a new UUID at each restart would take a new
  place each time) and the status says so. The registration (`RegisterApp`
  with the PIN, device name "Gladys") is sent only when the bridge refuses
  the session (`NOT_ALLOWED`) to a UUID never registered on this bridge
  (`registered` in `/data`). A PIN refused (`NOT_ALLOWED`), a full bridge
  (`NO_RESOURCES`) or a session refused after a registration ("removed")
  stop the link, persisted with the address; lifted by a new address or PIN
  or by "Test the connection" (after "removed", it allows exactly one new
  registration). A ComfoConnect PRO is registered before the session, as
  aiocomfoconnect does. The PIN is never saved nor logged.
- **The app UUID is a key**: the bridge authenticates a session by the
  source UUID alone (zehnder.proto), so the UUID is never logged; it is kept
  in `/data` (mode 0600). The "list the registered apps" button shows every
  UUID in full to the Gladys administrator, because removing an app (to free
  a place) needs it; the docs say not to share them.
- **Never `takeover`**: aiocomfoconnect always takes the session over, which
  would close the Zehnder app of the user at every reconnection, and fight
  with it. Here: `OTHER_SESSION` -> retry in 1, 2, then 5 minutes; a
  `CloseSessionRequest` from the bridge (another app took the session) ->
  retry in 5 minutes; the session is closed politely when the integration
  stops.
- **Bridge UUID**: asked by UDP unicast to the configured address (a
  broadcast does not leave a Docker bridge network), 2 tries of 2 s, only an
  answer from that address counts; remembered in `/data` and used when the
  discovery gets no answer.
- **An answer belongs to its request**: the reference (never 0, never one
  in use) AND the confirm type of that request (an RMI request is answered
  only by an RMI response), addressed to our UUID. An answer with a waiting
  reference but another type is dropped, never taken; malformed packets are
  dropped and counted (one warning per minute).
- **Bounded reader**: 4-byte length, between 34 bytes and 16 KB, else the
  session is cut (the stream cannot be resynchronised); chunks kept in a list
  and joined once per packet (linear; test: 20 000 packets in 7-byte chunks).
- **Model in the stream order**: every sensor value changes the model when
  the link emits it; Gladys gets the result once per event loop turn.
- **Sensor hold**: as aiocomfoconnect, zeros right after a subscription are
  held for 5 s, released by the first non-zero value; the last value (a real
  zero included) is emitted at the end of the hold. Values are read at their
  exact size (1, 2 or 4 bytes, little-endian, signed or not), never the whole
  data field, which the bridge may pad to 8 bytes (a padded negative INT16
  would otherwise read positive).
- **Commands**: `text/select`, never a switch (lot 6 lesson). Speed `0`..`3`
  (strings; the integers 0..3 are accepted, nothing else: `null`, `''`,
  `'1.0'`, `' 1'` are refused), mode `auto` / `manual`. Off by default
  (`allow_commands`); speed 0 also needs `allow_away` (off): "away" almost
  stops the air renewal (humidity, CO2), documented. Each command: the
  options checked on arrival; a fresh RMI read (`83 15 01 01` speed, `83 15
08 01` mode) within 1.5 s and 0.3 s before the send deadline; already at
  the value -> nothing sent; read failed -> refused "nothing was sent"; the
  options checked again, then once more right before the socket write
  (`check` of the client request). Written by 3.5 s after the request or
  refused unsent; the RMI answer awaited until 4.5 s; no answer -> "sent,
  without confirmation" and a read back 2 s later; an error answer -> "sent,
  refused by the unit". Mode auto is two RMI messages (as aiocomfoconnect):
  once the first is written, any failure is "sent, without confirmation".
  One command at a time. The ack never waits for the publication (test: a
  publication that never ends).
- **No guard after a command**: unlike a cloud state, the fresh read is the
  unit's own answer to a request written after the click, so "already so" is
  decided on the real state; no toggle command exists.
- **Device**: `ext:<selector>:comfoair:<serial>`, the serial of the unit (RMI
  NODE 01 property 04, letters and digits, lower-cased), never the IP nor the
  bridge. Name = the model the unit gives. A device published again keeps
  the features of the created one (`gladys.devices`).
- **Units**: celsius (`temperature-sensor`), percent (`humidity-sensor`),
  days (`duration`); the flows (m³/h) and the bypass opening (%) are plain
  `unknown` / `integer` sensors without a unit (no core category takes
  them), the unit in their name. The duty of the fans (%) is not published
  (a `fan` feature could be offered to the voice assistants).
- **Gladys reconnection** (`connected` again): the status, the Discovery, the
  badges and the states are sent again (caches emptied); a stop is kept.
- **Publisher**: the one of gladys-velbus (300 states per minute, the
  selects and texts first, heartbeats every 30 min spread over 5 min).
- **Not checked**: Docker is not installed on this PC, so no image build and
  no end-to-end test in a container; never run against a real LAN C.
