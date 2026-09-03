# Ninja ProChef WP100 — BLE protocol

Reverse-engineered for interoperability. The hardware is owned outright; the
official app is geo-restricted to the US, which makes it unusable in Brazil.
Everything below was obtained passively, by observing advertisements from the
probe with standard Linux Bluetooth tooling. No firmware was extracted and no
protection was circumvented.

This is the specification [F.U.Ninja](README.md) implements. `public/js/protocol.js`
is the executable form of §3 and §4; if the two ever disagree, this document is
wrong and should be corrected.

**Status: telemetry fully decoded.** Battery level and both temperatures are
readable without connecting, pairing, or bonding. Control (setting target
temperatures / alarms on the probe) would require GATT and is not yet solved.

---

## 1. Device identity

| Property | Value |
|---|---|
| Advertised name | `Ninja-WP100-R` |
| Example address | `48:31:B7:C5:D8:9A` (public, static) |
| Address OUI | `48:31:B7` → **Espressif Inc.** |
| SoC | **ESP32** (per the OUI) |
| Manufacturer company ID | `0x0C4F` → **SharkNinja Operating LLC** (SIG-assigned) |
| Model | WP100 |

The `-R` suffix is unexplained. Candidates: a hardware revision, or a unit
designator. Not yet tested against a second probe.

### 1.1 Advertised service UUIDs

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
| `0x03` | 16-bit Service Class UUIDs | see §1.1 |

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
 offset  0    1    2  3    4  5  6  7  8  9    10 11   12 13
        06   64   01 01   5c e1 02 4d b3 6c   f9 02   d8 02
        │    │    │  │    └──────┬──────┘     └──┬─┘  └──┬─┘
        │    │    │  │           │               │       │
        │    │    │  │           │               │       └─ sensor B, int16 LE
        │    │    │  │           │               └───────── sensor A, int16 LE
        │    │    │  │           └─ 6-byte per-probe id (static, not the MAC)
        │    │    │  └─ unknown, always 0x01 so far
        │    │    └─ unknown, always 0x01 so far
        │    └─ battery percent (0x64 = 100)
        └─ frame type / protocol version (0x06)
```

| Offset | Size | Field | Confidence | Notes |
|---|---|---|---|---|
| 0 | 1 | Frame type | high | Always `0x06`. Used as the "is this telemetry" discriminator. |
| 1 | 1 | Battery percent | medium | `0x64` = 100, consistent with a full charge. Not yet seen at any other level, so "percent" vs. some other 0–100 code is unconfirmed. |
| 2 | 1 | unknown | — | Always `0x01`. |
| 3 | 1 | unknown | — | Always `0x01`. |
| 4–9 | 6 | Probe id | medium | Static across the whole capture. Not equal to the BLE MAC. Likely a serial number or factory id. Per-device assumption untested — only one probe has been observed. |
| 10–11 | 2 | Sensor A | high | int16 little-endian, tenths of °F. |
| 12–13 | 2 | Sensor B | high | int16 little-endian, tenths of °F. |

Bytes 2 and 3 are the prime suspects for a **temperature-unit flag** (°C/°F) or
a probe index. If they encode the app's unit setting, a reimplementation must
read them rather than assume — see §7, experiment 2.

### 3.1 Signedness

Read as **signed** int16. Tenths of °F puts 0 °F at raw `0`, so any reading
below 0 °F (a freezer check, ≈ −18 °C = −0.4 °F = raw `−4`) needs a signed
read. The entire cooking range is positive and far below `0x7FFF`, so the two
interpretations agree in normal use.

No "sensor disconnected / out of range" sentinel has been observed, so its
value is unknown. Implementations should treat the extremes (`0x7FFF`,
`0x8000`, `0xFFFF`) as "no reading" defensively rather than reporting a
nonsense temperature.

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

**So: A = tip, B = ambient — inferred, not confirmed.** The decisive test is to
warm one sensor in isolation (grip the tip only) and see which value moves.
Implementations should expose the raw A/B values alongside the named ones so a
correction does not break callers.

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

---

## 10. Open questions

Ordered by value.

1. **Ice-water two-point check.** Confirms there is no gain error away from
   room temperature. Cheap, and the only remaining doubt about the scale.
2. **Toggle °C/°F in the official app.** Does byte 2 or 3 flip? If the probe
   re-encodes based on a user setting, every implementation must read that flag
   instead of assuming tenths of °F.
3. **Warm one sensor in isolation.** Confirms the A = tip / B = ambient
   mapping, which is currently inferred from drift alone.
4. **Power on a second probe.** Reveals which of bytes 4–9 are per-device, and
   whether the `-R` name suffix varies.
5. **Observe a partially discharged probe.** Confirms byte 1 is really a
   percentage and not a voltage code or a coarse level.
6. **Unplug / expose a sensor.** Finds the "no reading" sentinel value.
7. **GATT with explicit connection parameters.** Unlocks control, alarms and
   history.
8. **Does the advertising rate change while the app is connected?** Determines
   whether ~10 s is a floor or just an idle-mode rate.
