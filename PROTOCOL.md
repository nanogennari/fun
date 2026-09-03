# Ninja ProChef WP100 — BLE protocol

Reverse-engineered for interoperability. The hardware is owned outright; the
official app is geo-restricted to the US, which makes it unusable in Brazil.
Everything below was obtained passively, by observing advertisements from the
probe with standard Linux Bluetooth tooling. No firmware was extracted and no
protection was circumvented.

This is the specification [F.U.Ninja](README.md) implements. `public/js/protocol.js`
is the executable form of §3 and §4; if the two ever disagree, this document is
wrong and should be corrected.

**Status: temperatures fully decoded.** Both temperatures are readable without
connecting, pairing, or bonding.

Two corrections from a session with two units powered at once:

- **Battery level is not in the advertisement at all** (§3.2). Byte 1 was
  documented as a battery percentage; it reads `0x64` on a near-empty unit and
  a near-full one alike, across all 70 telemetry frames captured.
- **The 6-byte "probe id" is a BLE address** (§3.4), little-endian, in
  SharkNinja's own OUI — and the unit *advertising* a reading is not
  necessarily the probe the reading is *about* (§1.1).

Control (setting target temperatures / alarms) would require GATT and is not
yet solved.

---

## 1. Device identity

There are **two different advertised names**, from two different OUIs:

| | `Ninja-WP100-R` | `Ninja-WP100-P` |
|---|---|---|
| Example addresses | `48:31:B7:C5:D8:9A`, `48:31:B7:C6:05:2E` | `6C:B3:4D:02:EB:30` |
| Address OUI | `48:31:B7` → **Espressif Inc.** | `6C:B3:4D` → **SharkNinja Operating LLC** |
| Frame type | `0x06`, 14-byte payload | `0x0F`, 19-byte payload |
| Service UUIDs | four (see §1.2) | **only** `0xFEF5` (SUOTA) |
| Carries temperatures | yes | not in any frame seen |

Both use manufacturer company ID `0x0C4F` → **SharkNinja Operating LLC**
(SIG-assigned). Model: WP100.

F.U.Ninja only parses the `0x06` frame; it ignores everything else.

Every `-R` unit advertises exactly `Ninja-WP100-R`, so the name cannot tell two
units apart — key on the probe id (§3.4) instead.

### 1.1 `-R` is a reporter, not necessarily the probe

The 6-byte id inside the telemetry frame identifies **which probe the reading is
for**, and it is not a property of the advertising address. One `-R` address was
observed reporting three different ids in sequence:

```
16:06:40  48:31:B7:C5:D8:9A   id=5ce1024db36c   no reading
16:07:11  48:31:B7:C5:D8:9A   id=000000000000   no reading
16:07:26  48:31:B7:C5:D8:9A   id=30eb024db36c   77.0 F / 62.7 F
```

That last id had, minutes earlier, been reported exclusively by the *other* `-R`
address. So a reading migrated between reporters while keying on the same probe.

The mapping is fully crossed: a later scan showed the *other* reporter,
`48:31:B7:C6:05:2E`, carrying id `5ce1024db36c` — the id the first reporter had
been broadcasting. Each of the two reporter addresses has now been observed
carrying each of the two probe ids, at different times. Address and probe are
independent.

**Key probes on the id, never on the address.** F.U.Ninja already does — Web
Bluetooth hides the MAC, so the id was the only option — but the reason is
stronger than "the browser makes us": the address genuinely is not a probe
identity.

What `R` and `P` stand for is not established; "receiver / probe" is the obvious
guess. See §10.

### 1.2 Advertised service UUIDs

Carried in the **scan response**, AD type `0x03` (Complete List of 16-bit
Service Class UUIDs). Raw payload bytes:

```
ff e0   ff f0   aa a0   f5 fe
```

Decoded little-endian, as the spec requires, that is:

| Value | Assigned? |
|---|---|
| `0xE0FF` | no |
| `0xF0FF` | no |
| `0xA0AA` | no |
| `0xFEF5` | **yes** — Dialog Semiconductor SUOTA (OTA firmware update) |

Note the asymmetry: `0xFEF5` decodes to a real assigned UUID, while the other
three decode to unassigned values whose byte-swaps (`0xFFE0`, `0xFFF0`,
`0xAAA0`) are the conventional vendor-service range. The likely explanation is
a partial endianness bug in the firmware's advertisement builder. **This is an
inference, not an established fact** — the vendor may simply have picked
`0xE0FF`/`0xF0FF`/`0xA0AA`. Only a successful GATT service discovery settles
it, and since all telemetry comes from the advertisement, it does not currently
matter.

The SoC is Espressif, not Dialog, so the SUOTA UUID is most likely inherited
from a reference design or a SUOTA-compatible updater rather than indicating a
Dialog part.

---

## 2. Advertisement structure

The probe emits a **connectable undirected** advertisement (`ADV_IND`) and a
separate **scan response** (`SCAN_RSP`). The two carry different payloads, and
this split is the single most important detail in the whole protocol:

### `ADV_IND` — 24 bytes

| AD type | Field | Value |
|---|---|---|
| `0x01` | Flags | `0x06` — BR/EDR Not Supported, LE General Discoverable |
| `0x09` | Complete Local Name | `Ninja-WP100-R` |
| `0x12` | Peripheral Connection Interval Range | 7.5 ms – 20 ms |

### `SCAN_RSP` — 31 bytes

| AD type | Field | Value |
|---|---|---|
| `0x01` | Flags | `0x06` |
| `0xFF` | Manufacturer Specific Data | company `0x0C4F` + 14 payload bytes |
| `0x03` | 16-bit Service Class UUIDs | see §1.2 |

> ### ⚠ The temperatures are in the SCAN RESPONSE
>
> A **passive** scan sees only the name and will never observe a temperature.
> The scanner must use **active** scanning, so the controller transmits
> `SCAN_REQ` and collects the `SCAN_RSP`.
>
> - BlueZ / `bluetoothctl`: active by default.
> - **bleak**: `BleakScanner(scanning_mode="active")`.
> - **MicroPython**: `BLE.gap_scan(dur, interval, window, active=True)` — the
>   `active` argument defaults to `False`, so it must be passed explicitly.
> - **Web Bluetooth**: `requestLEScan()` does not expose a passive/active
>   choice; Android's scanner is active in its default mode, so scan-response
>   data is merged into the result.
>
> This is the easiest thing to get wrong in a reimplementation, and it fails in
> a confusing way: the device shows up, but with no data.

---

## 3. Manufacturer-specific data

Company ID `0x0C4F` (SharkNinja). Payload is **14 bytes**, fixed length.

```
 offset  0    1    2  3    4  5    6  7  8  9    10 11   12 13
        06   64   01 01   5c e1   02 4d b3 6c   f9 02   d8 02
        │    │    │  │    └─┬─┘   └────┬────┘   └──┬─┘  └──┬─┘
        │    │    │  │      │          │           │       │
        │    │    │  │      │          │           │       └─ sensor B, int16 LE
        │    │    │  │      │          │           └───────── sensor A, int16 LE
        │    │    │  │      │          └─ 6c:b3:4d = SharkNinja OUI, reversed
        │    │    │  │      └─ probe BLE address, little-endian (see 3.4)
        │    │    │  └─ unknown, always 0x01
        │    │    └─ reading valid: 1 = temps are real, 0 = both 0xFFFF (see 3.3)
        │    └─ constant 0x64 -- NOT battery, see 3.2
        └─ frame type / protocol version (0x06)
```

| Offset | Size | Field | Confidence | Notes |
|---|---|---|---|---|
| 0 | 1 | Frame type | high | Always `0x06`. Used as the "is this telemetry" discriminator. |
| 1 | 1 | unknown constant | high | Always `0x64` (100). **Not a battery level** — see §3.2. |
| 2 | 1 | Reading valid | high | `1` = the temperatures are real, `0` = both are `0xFFFF`. Perfect correlation over 70 frames — see §3.3. |
| 3 | 1 | unknown | — | Always `0x01`, on every frame and both probes. Not a probe index: two simultaneous probes both send it. |
| 4–9 | 6 | Probe address | high | The probe's own BLE address, **little-endian** — see §3.4. Bytes 6–9 look constant only because reversed they are SharkNinja's OUI. |
| 10–11 | 2 | Sensor A | high | int16 little-endian, tenths of °F. |
| 12–13 | 2 | Sensor B | high | int16 little-endian, tenths of °F. |

Byte 2 turned out to be a **reading-valid flag**, not the °C/°F flag it was
guessed to be (§3.3). Byte 3 is still unknown and is now the only remaining
candidate for a unit flag — though nothing has ever been seen to move it.

### 3.1 The power-on placeholder frame

A probe that has just been switched on emits a frame that is structurally valid
but carries no data:

```
06 64 01 01 00 00 00 00 00 00 ff ff ff ff
│  │  │  │  └──── id all zeros ────┘  └── both sensors 0xFFFF ──┘
│  │  └──┴─ 01 01, as normal
│  └─ 0x64, the usual constant
└─ 0x06, the normal telemetry frame type
```

Bytes 0–3 are indistinguishable from a real frame, so a parser that only checks
the frame type will accept it. Observed consequence: a phantom device keyed on probe id
`000000000000` appears alongside the real one and never goes away, showing `--`
for both temperatures.

**Treat an all-zero (or all-`0xFF`) probe id as "not populated" and discard the
frame.** The probe id is the only durable device identity — the advertising
address belongs to whichever radio relayed the reading rather than to the probe
(§1.1), Web Bluetooth hides it anyway, and the advertised name is identical on
every unit (§1) — so a frame without an id cannot be attributed to a probe.

Note this is *not* the same as a sensor sentinel. A frame from an identified
probe with one sensor reading `0xFFFF` is real and should be shown with that
sensor blank; only the missing **id** makes a frame unusable.

### 3.2 Battery level is not broadcast

Byte 1 was originally documented as a battery percentage, on the strength of a
single probe reading `0x64` = 100 while fully charged. That was a coincidence.

**The experiment.** Two probes were switched on simultaneously and observed for
100 s — 20 advertisements, 10 per probe:

- `48:31:B7:C5:D8:9A` — in service for some time, near full charge
- `48:31:B7:C6:05:2E` — unpacked from the box that day, running on the partial
  factory shipping charge, out of the dock and on its own cell

Every packet from both carried byte 1 = `0x64`. Two cells at substantially
different states of charge cannot both be 100 %, so **byte 1 is a constant, not
a measurement.**

**Nor is it hiding elsewhere in the advertisement.** Both PDUs are full:
`ADV_IND` is 24 bytes of flags + name + connection-interval range, and
`SCAN_RSP` is 31 bytes — the legacy maximum — of flags + manufacturer data +
service UUIDs. No service data, no TX power, no extended advertising. Across
the two probes the only bytes that vary at all are the serial (4–5) and the
temperatures (10–13).

**Consequence for this app.** `protocol.js` still exposes byte 1 as
`batteryPct` and the probe card still renders it as a percentage. That reading
is not trustworthy: it will say 100 % on a probe that is about to die. The real
value would need GATT (§7) — the standard Battery Service (`0x180F` /
`0x2A19`) is the obvious first thing to try once a connection holds.

The one hypothesis this does not fully exclude is that byte 1 is a coarse level
that only decrements below some low threshold, since the low probe still had
usable charge. A drain-to-shutoff log settles it — see §10.

### 3.3 Byte 2 is a reading-valid flag

Byte 2 was long guessed to be a °C/°F flag. It is not — it tracks whether the
temperatures in the same frame are populated:

| byte 2 | Temperature bytes | Frames observed |
|---|---|---|
| `0x01` | a real reading | 61 |
| `0x00` | `ff ff ff ff` | 9 |

Correlation is perfect over all 70 telemetry frames captured. **So `0xFFFF` is
the "no reading" sentinel** — previously an open question. A unit with no
current data for a probe still advertises at the usual cadence, with
`byte2 = 0` and both sensors at `0xFFFF`.

Prefer the `byte2` check; it is explicit, and it agrees with the sentinel on
every frame seen.

> The power-on placeholder in §3.1 is transcribed with `byte2 = 1` alongside
> `0xFFFF` temperatures, which contradicts the table above. The equivalent
> frame in the current captures reads `06 64 00 01 ...`. The older
> transcription is probably wrong, but it has not been re-observed — so
> discard an all-zero-id frame regardless of `byte2`, as §3.1 says.

### 3.4 The probe id is a BLE address

Bytes 4–9 are the probe's own BLE address, stored **little-endian**, exactly as
an address appears on the wire. Reverse the field and it becomes a MAC:

```
payload bytes 4-9 :  30 eb 02 4d b3 6c
reversed          :  6c b3 4d 02 eb 30   ->  6C:B3:4D:02:EB:30
```

That address is not a guess — it was observed advertising, as the
`Ninja-WP100-P` device in §1.

`6C:B3:4D` is an IEEE OUI registered to **SharkNinja Operating LLC**, which
explains the constant `02 4d b3 6c` tail that once looked like a model code: it
is the OUI plus one byte, byte-reversed. Only the low two bytes vary between
units, so the field carries roughly 16 bits of per-unit entropy despite being
six bytes wide — still ample for keying a handful of probes, but worth knowing
if you ever hash it.

### 3.5 Signedness

Read as **signed** int16. Tenths of °F puts 0 °F at raw `0`, so any reading
below 0 °F (a freezer check, ≈ −18 °C = −0.4 °F = raw `−4`) needs a signed
read. The entire cooking range is positive and far below `0x7FFF`, so the two
interpretations agree in normal use.

**The "no reading" sentinel is `0xFFFF`**, now directly observed (§3.3): both
sensor fields go to `ff ff` together, and byte 2 drops to `0x00` in the same
frame. Whether a *single* sensor can drop out alone has not been observed —
they have always moved together — so handle that case anyway, and treat
`0x7FFF` / `0x8000` as "no reading" defensively too.

---

## 4. Temperature scale

```
°F = raw / 10
°C = (raw / 10 − 32) × 5/9
```

### Evidence

Sensor A read raw `761` at a moment when an independent reference thermometer
beside the probe read **24.2 °C**. Raw 761 → 76.1 °F → **24.5 °C**: agreement
within 0.3 °C, comfortably inside the combined error of two consumer
thermometers a short distance apart.

Raw-tenths-of-°C is ruled out outright — it would put a probe resting on a desk
at 76 °C.

### The step-of-2 artefact

Sensor A moved `770 → 766 → 761 → 759 → 757`, i.e. **always in steps of 2 raw
counts**, never 1. This is consistent with a sensor whose native resolution is
about 0.1 °C: one 0.1 °C step is 0.18 °F ≈ 2 tenths-of-°F. So the wire format
is tenths of °F, while the underlying precision is roughly 0.1 °C. Do not
present the tenths digit as if it were meaningful to ±0.1 °F.

### Remaining uncertainty

The corroboration above is a **single point near 24 °C**, which cannot detect a
gain error. A two-point check would settle it (see §7, experiment 1):

| Reference | Expected raw |
|---|---|
| Ice water, 0.0 °C | ≈ `320` |
| Boiling water, 100 °C at sea level | ≈ `2120` |

Boiling point is altitude-dependent — subtract roughly 1 °C per 285 m. Ice
water is the reliable fixed point.

All conversion lives in one place in each implementation so a correction is a
one-line change (`raw_to_f` / `raw_to_c`).

---

## 5. The two sensors

The probe has two sensors: one for the **food interior** (tip) and one for the
**surroundings** (ambient / grill air).

Mapping A and B to those two roles rests on one physical observation: over a
90 s capture with the probe resting in free air after being switched on, sensor
A drifted steadily downward (770 → 757, i.e. 25.0 → 24.3 °C) while sensor B sat
essentially constant at 728 (22.7 °C). A cooling probe tip behaves exactly like
A; an ambient sensor already at room temperature behaves exactly like B.

**So: A = tip, B = ambient.** Originally inferred from the drift above, and
since **confirmed by the owner in normal use** — with the probe in food the two
values behave as labelled. That is field confirmation rather than a controlled
isolation test, but combined with the drift evidence it is enough to treat the
mapping as settled.

Implementations should still expose the raw A/B values alongside the named ones,
so anything built on top survives a future correction.

The steady ~4 °F offset between A and B while both sat in the same room is
unexplained. Possibilities: genuine sensor calibration offset, self-heating, or
different thermal mass and placement along the probe body.

---

## 6. Timing and radio behaviour

Measured over a 90 s capture, probe not connected to anything:

| Property | Value |
|---|---|
| Advertisements observed | 10 in 90 s |
| Interval, median | **~10.7 s** |
| Interval, min / max | 4.1 s / 14.0 s |
| RSSI at ~1 m | −52 to −64 dBm |

~10 s is slow for a live display but entirely adequate for cooking, where
thermal time constants are minutes. It has not been tested whether the probe
increases its advertising rate while the official app is connected, or whether
a faster telemetry stream exists over GATT.

Practical consequence: a scan window shorter than ~12 s can miss a probe
entirely. Use ≥ 12–15 s for discovery, and expect gaps of up to ~15 s between
live updates. UIs should show the age of the last reading rather than implying
the number is current.

---

## 7. GATT — not yet solved

`bluetoothctl connect` reaches `Connected: yes` and then immediately fails:

```
org.bluez.Error.Failed le-connection-abort-by-local
[SIGNAL] LE.Disconnected - org.bluez.Reason.Unknown, Unspecified
```

Service discovery never completes, so there is no characteristic list yet.

A plausible cause: the `ADV_IND` requests a Peripheral Connection Interval
Range of **7.5–20 ms**, which is unusually aggressive, and BlueZ's default
connection parameters sit outside that window. Retrying with explicit
connection parameters is the obvious next step. Pairing/bonding has not been
attempted.

This is **not currently a blocker** — all live telemetry is in the
advertisement, and passive observation is strictly better for a monitoring
tool: no connection, no pairing, no single-central limit, and multiple
receivers can watch the same probe at once.

GATT would only be needed to:

- set target temperatures or alarms **on** the probe,
- read back cook programs,
- pull logged history,
- update firmware (SUOTA).

The most efficient route to those would be an HCI snoop log from the Android
phone running the official app (`btsnoop_hci.log` via Developer Options →
Enable Bluetooth HCI snoop log), which captures the app's write/notify
handshake directly. Not required for read-only monitoring.

---

## 8. Reproducing the capture

The decoding was done on Linux with BlueZ. These commands need no custom
tooling and are the fastest way to confirm a probe on your own bench:

```bash
# Discover the probe and dump its advertised data. bluetoothctl scans actively
# by default, so the scan response -- and therefore the temperature -- is
# included. Allow ~15s: the advertising interval is about 10s.
bluetoothctl --timeout 20 scan on
bluetoothctl info 48:31:B7:C5:D8:9A

# Raw HCI capture, which is how the ADV_IND / SCAN_RSP split was found.
# btmon needs root for the HCI monitor channel.
sudo btmon -w probe.btsnoop

# Then inspect the two frame types separately:
tshark -r probe.btsnoop -V -Y 'bthci_evt.bd_addr == 48:31:b7:c5:d8:9a'
```

The `ManufacturerData.Value` line in `bluetoothctl info` output is the 14-byte
payload documented in §3. Run it twice a minute apart and watch bytes 10–13
move — that is exactly how the temperature fields were located.

A companion research project holds the Python client and the byte-diff logger
used to do the original decoding, along with the raw capture files. This repo
only needs the specification above.

## 9. Reference: captured frames

Real payloads, in capture order, from a 90 s capture of a probe resting in
free air after being switched on. These are used verbatim as the test fixtures
in `test/protocol.test.js`, so the parser is pinned to bytes that actually came
off the air rather than to hand-written examples.

| Manufacturer payload (hex) | A raw | A °F | B raw | B °F |
|---|---|---|---|---|
| `066401015ce1024db36c0203da02` | 770 | 77.0 | 730 | 73.0 |
| `066401015ce1024db36cfe02d802` | 766 | 76.6 | 728 | 72.8 |
| `066401015ce1024db36cf902d802` | 761 | 76.1 | 728 | 72.8 |
| `066401015ce1024db36cf702d802` | 759 | 75.9 | 728 | 72.8 |
| `066401015ce1024db36cf502d802` | 757 | 75.7 | 728 | 72.8 |

The decoded `ADV_IND` and `SCAN_RSP` frames for the same probe are reproduced
in §2.

### 9.1 Two probes, different charge states

The capture that disproved the battery field (§3.2), keyed on probe id rather
than reporting address since the address is not a stable probe identity (§1.1):

| Probe id | Charge state | Manufacturer payload (hex) |
|---|---|---|
| `5ce1024db36c` | near full | `066401015ce1024db36c0c03f902` |
| `30eb024db36c` | factory-fresh, low | `0664010130eb024db36c14031003` |

Byte-for-byte the two differ **only** at offsets 4–5 (the varying part of the
probe address) and 10–13 (temperatures). Byte 1 is `0x64` in all 20 packets of
that capture, and in all 70 telemetry frames captured to date.

### 9.2 No-reading frames and the `0x0F` frame

| Payload (hex) | Meaning |
|---|---|
| `066400015ce1024db36cffffffff` | probe known, **no reading** (byte 2 = 0, §3.3) |
| `06640001000000000000ffffffff` | **no probe** — all-zero id, discard (§3.1) |
| `0f000000000000000030eb024db36cffffffff` | the 19-byte `0x0F` frame from a `-P` device |

The `0x0F` frame has only ever been seen with this exact payload. Its trailing
`ff ff ff ff` and the address at offset 9 mirror the `0x06` layout, but nothing
in it has been observed to change, so its structure is inference. F.U.Ninja
ignores every frame type but `0x06`.

---

## 10. Open questions

Ordered by value.

1. **Which physical unit is `-R` and which is `-P`?** The top question, because
   it decides what the data model means. `-R` advertises from an Espressif MAC
   and carries the temperatures; `-P` advertises from SharkNinja's own OUI with
   only a `0x0F` frame — and one `-R` address reported three different probe
   ids in sequence (§1.1), so `-R` is a *reporter*, not necessarily a probe.

   **The decisive test takes a minute:** with two units powered, switch one off
   and re-scan. Whichever addresses disappear belong to that unit. If a single
   unit owns both an `48:31:B7` and a `6C:B3:4D` address, the two names are two
   roles of one device; if not, one is relaying for the other.

2. **Ice-water two-point check.** Confirms there is no gain error away from
   room temperature. Cheap, and the only remaining doubt about the scale.
3. ~~Warm one sensor in isolation to confirm the A/B mapping.~~ Superseded:
   confirmed by the owner in normal use (§5).
4. ~~Power on a second probe.~~ Done (§1, §3.4, §9.1). The 6-byte "probe id" is
   a **BLE address stored little-endian**, in SharkNinja's own OUI `6C:B3:4D` —
   which is why bytes 6–9 looked like a constant. Only the low two bytes vary.
   The `-R` name suffix does not vary, but a second suffix `-P` exists on a
   different OUI entirely (§1).
5. ~~Observe a partially discharged probe.~~ Done (§3.2). Byte 1 is **not** a
   battery percentage — it reads `0x64` on a near-empty probe and a near-full
   one alike, across all 70 telemetry frames. Battery level is not broadcast.
6. ~~Find the "no reading" sentinel.~~ Done (§3.3). It is `0xFFFF` in both
   sensor fields, with byte 2 = `0x00` in the same frame. Still open: whether a
   *single* sensor can drop out alone — both have always moved together.
7. **GATT with explicit connection parameters.** The only route to a real
   battery level (§3.2), as well as to control, alarms and history. Try the
   standard Battery Service (`0x180F` / `0x2A19`) first. The `-P` device has
   never been connected to at all and is worth trying separately.
8. **Drain the low probe to shutoff while logging.** The one battery hypothesis
   §3.2 does not exclude is that byte 1 is a coarse level that only decrements
   below some threshold. If byte 1 is still `0x64` on the last packet before
   the unit powers off, the byte is a hard-coded constant.
9. **Toggle °C/°F in the official app.** Byte 2 turned out to be a
   reading-valid flag (§3.3), so byte 3 is the last candidate for a unit flag —
   and it has never been seen at anything but `0x01`.
10. **Catch a `0x0F` frame carrying real data** (§9.2), which would settle both
    its layout and what the `-P` device is for.
11. **Does the advertising rate change while the app is connected?** Determines
    whether ~10 s is a floor or just an idle-mode rate.

## 11. Radio behaviour observed from a browser

Notes specific to reading this device through Web Bluetooth, which are really
about Chrome rather than the probe, but bite anyone reimplementing this:

- **`requestLEScan` stops on its own.** Switching one probe off was observed to
  kill the whole scan, leaving a second probe apparently frozen. Backgrounding
  the page does the same. A scanner must poll `BluetoothLEScan.active` and
  restart, rather than assuming a started scan stays started.
- **`keepRepeatedDevices: true` is mandatory.** Without it the browser delivers
  one advertisement per device and then goes quiet, which looks exactly like a
  probe that has stopped broadcasting.
- **Android needs the `BLUETOOTH_SCAN` permission** ("Nearby devices"), which
  Chrome never prompts for. Without it `requestLEScan` fails with a message
  about the Bluetooth adapter being unavailable, which misdirects entirely.
