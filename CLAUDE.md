# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "speed"   # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/handlers.js                   the SDK handlers, shared with the tests
src/app.js                        ComfoAirApp: lifecycle, /data, model, device, states, commands, buttons
src/protocol/protobuf.js          minimal protobuf codec (bounded, schema names only)
src/protocol/messages.js          message schemas (zehnder.proto) + packet encode / decode
src/protocol/reader.js            bounded, linear packet reader (length prefix)
src/protocol/client.js            one TCP connection: requests by reference AND confirm type
src/protocol/discovery.js         UDP discovery of the bridge UUID (unicast)
src/protocol/link.js              the session: registration once, nodes, sensors, keep-alive, retries
src/devices.js                    unit -> Gladys device and states (pure)
src/publisher.js                  states under the Gladys rate limit
src/store.js                      /data: app UUID, bridges, registrations, unit, stop
src/config.js                     DEFAULTS (mirror the manifest defaults) + normalization
src/constants.js, src/i18n.js     protocol constants, keys, timings, limits; French and English texts
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, the SDK's fake Gladys + test/helpers/fakeBridge.js
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

Safety rules of this integration (see TODO.md "Decisions"): no switch, the
commands are selects, off by default, speed 0 (away) behind its own option;
decided on a fresh RMI read of the unit, the options checked again right
before the socket write; a command that may have left is never reported "not
sent"; the ack never waits for the publication; an answer is taken only from
a packet with its reference AND its confirm type, sent to our UUID; the
values change the model in the order of the stream; registration once, never
in a loop, never without the UUID kept in /data; never `takeover`; the PIN is
never logged nor saved; Maps and schema names only for what the wire names
(no prototype pollution).

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
