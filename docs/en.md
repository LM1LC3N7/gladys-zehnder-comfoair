# Zehnder ComfoAir Q for Gladys

This integration connects a **Zehnder ComfoAir Q** heat recovery
ventilation unit (Q350, Q450, Q600) to Gladys Assistant, **locally** on your
network, through the **ComfoConnect LAN C** box wired to the unit.

> **Never tested with a real ventilation unit.** The protocol comes from the
> [aiocomfoconnect](https://github.com/michaelarnauts/aiocomfoconnect)
> library (the one of Home Assistant's ComfoConnect integration), ported to
> JavaScript and checked only against a simulated LAN C. Make your first
> tries while at home and report what goes wrong.
>
> Unofficial integration, not affiliated with Zehnder.

## What you need

- A ComfoAir Q unit with a **ComfoConnect LAN C** on your network, reachable
  from the Gladys machine (port **56747**: UDP to ask for its identifier, TCP
  for the session).
- A **fixed IP address** for the LAN C (set in your router).
- The **PIN** of the LAN C: **0000** out of the box, unless you changed it.

A ComfoConnect PRO probably speaks the same protocol (aiocomfoconnect
supports it), but nothing was checked here.

## What you get

One "ventilation" device in the Discovery tab, named after the model the
unit gives (e.g. "ComfoAir Q450 B R RF ST Quality"), with:

- **Ventilation speed**: 0 (away), 1 (low), 2 (medium), 3 (high); a select,
  which can be changed if you allow it (see below).
- **Mode (auto or manual)**: a select, which can be changed if you allow it.
- **Operating mode** (text): automatic, manual, temporary manual, boost,
  away.
- **Temperatures** of the outdoor, extract, supply and exhaust air (°C).
- **Humidities** of these four airs (%).
- **Supply and exhaust flows** (m³/h; Gladys has no air flow unit: the unit
  is in the name).
- **Bypass**: its opening (%) and its setting (automatic, forced open or
  closed).
- **Days before the filter change**.

The values come when the unit sends them (the LAN C pushes every change),
without polling.

There is **no switch**: an "everything off" (Google Home, Alexa, the MCP,
HomeKit, a scene on the switches) can never stop the ventilation.

## Configuration

1. **IP address of the LAN C**.
2. **PIN of the LAN C**: 4 digits, used **only once**, to register Gladys on
   the LAN C. Empty: 0000. It is a secret field: kept by Gladys in its
   database, never shown again in the interface, sent only to the LAN C,
   never written in the logs, never copied to `/data`.
3. **Allow changing the speed and the mode from Gladys**: off by default.
4. **Also allow speed 0 (away)**: off by default (see below).
5. **Language of the names**: French or English.

The **Test the connection** button connects at once when no session is open
and tells how it went. It also lifts a stop (PIN refused, LAN C full,
registration removed): one new try follows.

The **List the apps registered on the LAN C** button (open session) shows
the name and identifier of every registered app; the one of Gladys is marked
"(this integration)".

## Registration and session

- The LAN C only accepts **a small number of registered apps** (each phone
  with the Zehnder app, Home Assistant, Gladys...). Gladys registers **only
  once**, under the name "Gladys", with an identifier created at the first
  start and kept in `/data/comfoair-state.json`. If that file cannot be
  written, Gladys **does not register** (every restart would take a new
  place) and the status says so.
- **PIN refused**: the registration stops and is **never retried in a
  loop**, even after a restart. Fix the PIN and save (one new try), or click
  "Test the connection".
- **LAN C full**: stopped the same way, until you free a place (see below)
  and click "Test the connection".
- **Registration removed** (by another app): Gladys does not register again
  by itself; "Test the connection" allows one new registration.
- The LAN C opens **one session at a time**. Gladys **never takes** the
  session of another app: while the Zehnder app is connected, Gladys waits
  and asks again (1 min, 2 min, then every 5 minutes). If the Zehnder app
  takes the session of Gladys over, Gladys asks again 5 minutes later.
  Meanwhile the values are not updated and the device is shown unreachable.
- When the integration stops, Gladys closes its session, so that the Zehnder
  app can take it at once.

## Freeing a place on the LAN C

1. Click **List the apps registered on the LAN C** (an open session is
   needed): you see the name and identifier (32 characters) of every app.
   The LAN C recognises an app by this identifier alone, without the PIN: it
   is a key, do not share it.
2. Remove those you no longer use (an old phone, a Home Assistant
   test...) **from an app already registered that can do it**, for example
   the command line tool of aiocomfoconnect on a computer of your network
   already registered:
   `python -m aiocomfoconnect deregister <identifier to remove> --host <address of the LAN C>`
   (see its documentation for the options). Gladys itself removes no app in
   this version.
3. To free **the place of Gladys**: remove its identifier (marked "this
   integration" in the list, also in `/data/comfoair-state.json`) from
   another app. **Removing the integration from Gladys does not free its
   place** on the LAN C.
4. As a last resort, a reset of the LAN C (see its manual) sets the PIN back
   to 0000; it probably clears the registrations too (not checked).

## Commands and the away speed

- Changing the speed or the mode is **off by default**. Once allowed,
  **every Gladys user, every scene and the Gladys app can change them**.
- **Speed 0 ("away")** brings the ventilation down to its **minimum**: it
  **almost stops** the air renewal. Left so while the house is occupied, the
  humidity rises (condensation, mould) and the air gets loaded (CO₂, smells,
  pollutants). It therefore needs **its own option**, off by default, and is
  meant for an absence only. Remember to set a normal speed when you are
  back (with a scene, for example).
- "Automatic" lets the unit follow its schedule and sensors (and cancels a
  speed chosen by hand); "Manual" keeps the chosen speed. The messages sent
  are exactly those of aiocomfoconnect; their precise effect in each mode was
  not checked on a real unit.
- Before each command, the integration **reads the speed or the mode from
  the unit** and decides on that reading, never on what it has in memory:
  already at the value, nothing is sent; not readable, nothing is sent. The
  options are read again right before sending: switched off during the
  reading, the command stops ("nothing was sent").
- A command is sent within 3.5 s of the request, or refused with "nothing
  was sent". The answer of the unit is awaited until 4.5 s; without it, the
  command is reported "sent, without confirmation" and the state is read
  again two seconds later: it is never reported "not sent". A command the
  unit refuses says so.
- One command at a time. Every command is written in the integration logs.

## Connection

- Gladys asks the LAN C for its identifier over UDP at its address; without
  an answer, it uses the one learnt before.
- After a cut, the new tries are spaced: 10 s, 30 s, 1 min, 2 min, then every
  5 minutes.
- Every 30 s, Gladys checks the session (a time request); without an answer
  within 10 s, the session is cut and opened again.
- Right after the session opens, the LAN C sends zeros for every value: they
  are ignored for 5 s, as aiocomfoconnect does.

## Known limits

- Never tested with a real ventilation unit (see above).
- The LAN C protocol travels in clear text: a device of your network can
  read what goes through. The PIN only goes over the network once, at the
  registration.
- The device is identified by the serial number of the unit: another unit
  gives a new device.
- Not supported yet: the alarms and errors of the unit, the timed boost, the
  bypass and the temperature profiles as commands, the ComfoCool and the
  ComfoClime, the power consumption.

## Privacy

Everything stays on your network: the integration only talks to the LAN C.

## Licence

Apache-2.0. Protocol logic ported from aiocomfoconnect (Michaël Arnauts,
MIT): see `THIRD_PARTY_NOTICES.md`.
