# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.2] - 2026-10-23

## [0.1.1] - 2026-10-18

### Added

- Zehnder ComfoAir Q (Q350, Q450, Q600) over the local ComfoConnect LAN C,
  protocol ported from aiocomfoconnect 0.3.4 (MIT): UDP discovery of the
  bridge UUID, TCP session, registration once with the PIN, sensor
  subscriptions, keep-alive.
- One device per unit: speed and mode selects, operating mode, temperatures
  and humidities of the four airs, supply and exhaust flows, bypass opening
  and setting, days before the filter change.
- Speed and mode commands, off by default; speed 0 (away) behind its own
  option; decided on a fresh read of the unit.
- "Test the connection" and "List the apps registered on the LAN C" buttons.
- French and English documentation. Never tested with a real unit.

[Unreleased]: https://github.com/LM1LC3N7/gladys-zehnder-comfoair/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LM1LC3N7/gladys-zehnder-comfoair/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-zehnder-comfoair/releases/tag/v0.1.1
