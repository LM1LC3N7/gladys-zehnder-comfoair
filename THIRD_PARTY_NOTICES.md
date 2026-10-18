# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic and data ported to JavaScript from the project below. The
ported code was rewritten, not copied; the changes are described below.

## aiocomfoconnect

<https://github.com/michaelarnauts/aiocomfoconnect> (package
`aiocomfoconnect`, version 0.3.4, tag `v0.3.4`, commit `7359f81`), by
Michaël Arnauts and its contributors, the library of the Home Assistant
ComfoConnect integration. Licence: MIT License, from its `LICENSE` file:

```
The MIT License (MIT)

Copyright (c) 2022 Michaël Arnauts
https://github.com/michaelarnauts/aiocomfoconnect

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

Ported:

- `protobuf/zehnder.proto`, in `src/protocol/messages.js`: the field numbers
  and types of the messages used (GatewayOperation, RegisterApp,
  StartSession, ListRegisteredApps, CnNode, CnRmi, CnRpdo, CnTime,
  DiscoveryOperation), the operation types and the result codes, written as
  schemas for a small protobuf codec of this integration
  (`src/protocol/protobuf.js`, no code of the protobuf runtime).
- `bridge.py` (`Message.encode`, `Message.decode`, `Bridge._send`, `_read`,
  `_process_message`, `register`, `_process_node_notification`,
  `ventilation_node_id`), in `src/protocol/messages.js`,
  `src/protocol/client.js` and `src/protocol/link.js`: the packet layout
  (length, source and destination UUIDs, operation length, operation,
  message), the references of the requests, the session, the registration
  with the PIN, the node notifications and the choice of the ventilation
  unit node (product 1 or 8, lowest node id).
- `discovery.py`, in `src/protocol/discovery.js`: the UDP discovery request
  `0a 00` on port 56747 and its answer.
- `comfoconnect.py` (`_reconnect_loop`, `_hold_sensor`, `_sensor_callback`,
  `get_single_property`, `get_speed`, `set_speed`, `get_mode`, `set_mode`),
  in `src/protocol/link.js`, `src/constants.js` and `src/app.js`: the RMI
  messages read and sent, byte for byte, and the hold of the zero values
  sent right after a subscription.
- `sensors.py`, `const.py`, `docs/PROTOCOL.md`, `docs/PROTOCOL-PDO.md`,
  `docs/PROTOCOL-RMI.md`, in `src/constants.js` and `src/devices.js`: the
  sensor ids, their types and scales, the meaning of the operating mode and
  bypass values, the product ids, the RMI units of the serial number and
  model.

Changed: the session of another app is never taken over (aiocomfoconnect
always asks for `takeover`); the registration is done once, only when the
bridge refuses the session to a UUID never registered on it, and a refused
PIN, a full bridge or a registration removed later stop the link instead of
a retry; the UUID is created once and kept in `/data`, and nothing is
registered when it cannot be kept; an answer must carry the reference AND
the confirm type of its request, and be addressed to our UUID; the stream is
cut by a bounded, linear reader; a request is never written after its
deadline nor when its option was switched off; the sensor values are read at
their exact size (the data may be padded to 8 bytes); a keep-alive (time
request) every 30 s must be answered within 10 s; the commands are decided
on a fresh RMI read of the unit.
