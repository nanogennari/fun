# F.U.Ninja

A mobile web app that reads a **Ninja ProChef WP100** wireless meat thermometer
directly in the browser, over Web Bluetooth. No vendor app, no account, no
region lock.

The official Ninja app is geo-restricted to the US, which makes perfectly good
hardware unusable elsewhere. This reads the probe's own Bluetooth broadcasts
instead.

📄 **[PROTOCOL.md](PROTOCOL.md)** — the full reverse-engineered BLE protocol:
payload layout, temperature scale, evidence, and what is still unknown.

---

## ⚠ It needs an experimental Chrome flag

F.U.Ninja reads **BLE advertisements**, because that is where the ProChef puts its
telemetry: both temperatures are broadcast continuously, with no connection
required ([PROTOCOL.md §2](PROTOCOL.md)). Battery level is *not* — see the
caveat below.

The browser API for that is `navigator.bluetooth.requestLEScan()`, and it is
**behind a flag** in Chrome and Edge. Without it the method does not exist.

```
chrome://flags/#enable-experimental-web-platform-features   →   Enabled
```

Relaunch the browser afterwards. Chrome refuses to follow links to `chrome://`
pages, so it has to be pasted into the address bar by hand — the app shows a
copy button for exactly this.

**There is no way around this, and it is worth understanding why:**

- The ordinary `requestDevice()` + GATT flow **cannot see advertisement data at
  all.** It connects to a device and reads characteristics; the broadcast
  payload is simply not exposed to it.
- Connecting to the probe over GATT currently fails
  (`le-connection-abort-by-local`), and its characteristic layout has not been
  reverse-engineered ([PROTOCOL.md §7](PROTOCOL.md)).

So advertisement scanning is not a shortcut taken for convenience — it is the
only route that works today. It also happens to be the better one: no pairing,
no bonding, no connection limit, and any number of probes at once.

**Browser support**

| Browser | Works? |
|---|---|
| Chrome / Edge on **Android** | ✅ with the flag — the primary target |
| Chrome / Edge on desktop | ✅ with the flag |
| Safari (any platform) | ❌ no Web Bluetooth |
| Firefox | ❌ no Web Bluetooth |
| Chrome on **iOS** | ❌ uses the WebKit engine, so no Web Bluetooth |

There is no polyfill possible — this needs OS-level radio access.

---

## First run: the disclaimer

Before the app is reachable at all, a **separate full-page view** presents the
terms. It is not an overlay — none of the interface is visible or reachable
until the terms are accepted, and nothing runs: no scanning, no timers, no
probe state rendered.

It covers what this is (unofficial, reverse-engineered, not affiliated with
SharkNinja), that it is provided as is with all responsibility on the user, and
that **safety features may be missing** — there is no over-temperature warning,
and the real product may have alarms, limits or calibration behaviour that was
never observed on the air and therefore could not be implemented. It also names
the specific limitations that matter: that the delivered update rate depends on
the browser's Bluetooth stack rather than the probe, the alarm needing the page
open, the single-point temperature check, and that nothing here is validated for
food safety.

The accept button is **disabled for a 10-second countdown**, so it cannot be
clicked through before the text has been read. Acceptance is recorded, and
returning users go straight to the app.

Declining is a real choice rather than a dead end: it parks on a declined view
that explains nothing was saved, with a button to review the terms again — which
re-runs the gate from the start, countdown included, so decline-then-review is
not a way to skip the wait.

The gate **fails closed**. A missing, unparseable, or older-version acceptance
record all mean "show the terms again". The one exception is storage being
unavailable (private mode, full quota): there, acceptance cannot be recorded, so
the user is let through rather than trapped behind a gate that can never be
satisfied — they will simply see it again next time. Bump `DISCLAIMER_VERSION`
in `public/js/disclaimer.js` to re-prompt everyone when the terms change
substantively.

## What it does

- **Guided setup, shown once.** A readiness checklist on first load, which
  *verifies* what it can — browser support, secure context, whether the
  experimental flag is actually on, whether an adapter is present — and marks
  the one thing it cannot check (Android's "Nearby devices" permission) as
  exactly that, rather than guessing. Dismissing it, or finding a probe, retires
  it **permanently**; it is always reachable again from the **?** button. The
  one exception: if something later genuinely blocks scanning it reappears,
  because otherwise the scan button would sit disabled with no explanation.
- **Target temperature with an alarm.** Set a food target per probe; when it is
  reached the card alarms with sound, vibration and a banner until you stop it.
- **History chart** in each probe's Details panel, with a scrub-to-read
  crosshair, a values table, and tappable legend entries to drop a series and
  rescale the axis.
- **Live readings from both sensors** — the probe has a food-interior sensor and
  an ambient/grill-air sensor, and both are shown side by side.
- **Several probes at once**, each with its own card, history and nickname.
- **Records history from the first reading**, so a cook is already logged before
  you think to ask for it. Exportable as CSV.
- **Freshness is always visible.** The probe broadcasts about three times a
  second, but how much of that a browser delivers is stack-dependent, so a
  number on screen can be seconds old. Cards age `live → stale → offline`
  rather than pretending a stale value is current.
- **Screen wake lock**, because a cook lasts hours and nobody wants to keep
  poking the screen.
- **Installable** to the home screen, and remembers probes and nicknames across
  reloads.

---

## Multiple probes

Supported from the start, and essentially free.

Because the app reads *broadcasts* rather than opening connections, watching
five probes costs exactly what watching one costs. There is no pairing, no
central-device connection limit, and no per-probe link to keep alive. A single
scan surfaces everything in range.

Probes are identified by the **6-byte probe id carried inside the payload**, not
by the browser's device handle. That matters: Web Bluetooth deliberately hides
MAC addresses and mints a *per-origin* device id, so the payload id is the only
identity that survives a reload or a different browser. Nicknames
(`brisket`, `pork shoulder`, …) and history stay attached to the right physical
probe.

---

## Running locally

`localhost` counts as a secure context, so plain HTTP is fine for development.
There is **no build step** — the app is plain ES modules.

```bash
npm run serve       # python3 http.server on :8788, zero dependencies
```

or, closer to production:

```bash
npm install
npm run dev         # wrangler pages dev
```

Then open <http://localhost:8788>.

### Testing on a phone

This is the step that catches people out: **`http://<your-laptop-ip>:8788` will
not work.** It is not a secure context, so Web Bluetooth is unavailable there
regardless of the flag. You need real HTTPS:

```bash
cloudflared tunnel --url http://localhost:8788
```

…or just deploy it (below) and test the live URL.

---

## Deploying to Cloudflare

Deployed as an **assets-only Worker** using [Workers Static
Assets](https://developers.cloudflare.com/workers/static-assets/). There is no
build step and no Worker script — `public/` ships as-is, over HTTPS, which is
what Web Bluetooth requires.

```toml
# wrangler.toml
name = "fun"
compatibility_date = "2026-09-03"

[assets]
directory = "./public"
```

Note there is deliberately no `main` entry point: Cloudflare serves the
directory directly. Adding `main` would mean writing a `fetch` handler.

**From the CLI:**

```bash
npx wrangler login
npm run deploy          # wrangler deploy
```

**Or connect the Git repo** (Workers → your Worker → Settings → Builds). The
defaults already match this project:

| Setting | Value |
|---|---|
| Build command | *(empty)* |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |
| Production branch | `main` |

### If you would rather use Cloudflare Pages

Pages also works, but it is a different product with a different deploy
command, and the two configs are mutually exclusive. Swap `[assets]` in
`wrangler.toml` for:

```toml
pages_build_output_dir = "public"
```

…and set the deploy command to `npx wrangler pages deploy public`. Cloudflare
now steers new static projects toward Workers Static Assets, which is why this
repo defaults to it.

### Headers

`public/_headers` applies a strict CSP (`default-src 'self'`, no inline script
or style) along with:

```
Permissions-Policy: bluetooth=(self)
```

Web Bluetooth is gated by that permission policy. Workers Static Assets parses
`_headers` rather than serving it, and applies the rules to asset responses —
but **only because the file sits inside the assets directory**, so do not move
it out of `public/`. If you put this behind a proxy or embed it in an iframe,
that header has to survive or scanning will be blocked.

## Tests

```bash
npm test        # node --test, no dependencies
```

- `test/protocol.test.js` runs the parser against **byte-for-byte payloads
  captured off the air** ([PROTOCOL.md §9](PROTOCOL.md)) — not hand-written
  examples. It covers the `DataView` shapes Chrome actually hands over,
  including a non-zero `byteOffset`, negative temperatures, and malformed input.
- `test/store.test.js` covers the multi-probe registry, persistence, duplicate
  suppression, staleness, and the alarm state machine (latching, acknowledge,
  re-arm hysteresis, and the disconnected-sensor sentinel that would otherwise
  trip every target).
- `test/disclaimer.test.js` covers the gate: that it fails closed on corrupt or
  outdated records, that a disabled or programmatic click cannot skip the read
  delay, that declining records nothing, that re-running restarts the countdown
  rather than resuming it, and that listeners do not stack across runs.
- `test/chart.test.js` covers the chart's pure geometry: tick selection,
  downsampling that preserves spikes, axis rescaling when a series is hidden,
  and the flat-trace and single-sample edge cases.
- `test/wiring.test.js` is the "page loads but nothing works" guard — see below.

`dev/` holds two harnesses that render the real components against synthetic
cook data, for screenshotting in headless Chromium:

```bash
npm run serve
chromium --headless=new --screenshot=out.png --window-size=390,1500 \
  --virtual-time-budget=5000 http://localhost:8788/../dev/chart-preview.html
```

---

## Layout

```
.
├── public/                    # deployed as-is
│   ├── index.html
│   ├── styles.css             # mobile-first, dark by default
│   ├── manifest.webmanifest   # add-to-homescreen
│   ├── icon.svg
│   ├── _headers               # CSP + Permissions-Policy
│   └── js/
│       ├── protocol.js        # payload parser -- the executable form of PROTOCOL.md
│       ├── ble.js             # requestLEScan wrapper, capability detection, wake lock
│       ├── store.js           # multi-probe registry, history, targets, alarm state
│       ├── chart.js           # history chart: pure geometry + canvas renderer
│       ├── alarm.js           # Web Audio beeper + vibration
│       ├── disclaimer.js      # first-run terms gate, countdown, acceptance record
│       └── app.js             # UI controller
├── dev/                       # screenshot harnesses; NOT deployed
├── test/
├── PROTOCOL.md                # the reverse-engineered protocol
├── wrangler.toml
└── package.json
```

---

## Design notes

- **Dark by default.** This gets used at a grill, or in a kitchen at night.
- **Big numbers**, `clamp()`-sized so they read at arm's length on a phone, and
  `tabular-nums` so digits do not jitter as values change.
- **48 px touch targets** and safe-area insets, so it survives notches and the
  Android gesture bar. Pinch-zoom is left enabled deliberately — this gets used
  with greasy hands in bad light.
- **Warm colour for the food sensor, cool for ambient**, reinforced by label and
  position so it never depends on colour perception alone.
- **Chart marks use their own validated steps.** The bright UI colours sit
  outside the dark-mode lightness band, so the chart uses the documented dark
  steps of the same two hues — checked for the lightness band, chroma floor,
  colourblind separation (worst-pair ΔE 26.8 under protanopia) and 3:1 contrast.
  Both traces share **one** y axis: they are the same measure, and a second
  scale would invent a correlation. To see detail in the food trace when the pit
  is 100° hotter, tap the legend to drop the pit trace and let the axis rescale.
- **History stores raw sensor counts, not converted degrees.** If the
  temperature scale is ever corrected, old recordings reinterpret correctly
  instead of having today's conversion baked in.
- **Cards mutate in place** rather than re-rendering, so an open details panel
  does not collapse and a rename does not lose focus when an advertisement
  arrives mid-interaction.

---

## Known caveats

Worth reading before filing a bug.

- **The alarm only sounds while the page is open.** This is not a shortcut:
  closing the page stops the BLE scan, so there would be no temperature to
  alarm on. Use the wake lock (the ☀ button) to keep the page alive through a
  cook. A background push notification would need both a service worker and a
  server that knew the temperature, and neither exists here.
- **The delivered update rate is a property of the browser, not the probe.**
  Measured on a raw ESP32 scan, the probe sends a payload every ~300 ms and
  changes value every ~2.4 s ([PROTOCOL.md §6](PROTOCOL.md)). BlueZ coalesces
  that to ~10 s; Chrome's behaviour has not been measured. Treat the displayed
  reading age as authoritative.
- **Sound needs one tap first.** Browsers only unlock audio inside a user
  gesture, so audio is primed when you press *Set* on a target. If it was
  somehow blocked, the alarm banner says so instead of failing silently — the
  vibration and banner still fire.
- **The temperature scale is corroborated at a single point** — raw 761 against
  a reference thermometer reading 24.2 °C. That cannot detect a gain error. An
  ice-water check (0 °C should read raw ≈ 320) would settle it.
- **Sensor resolution is really ~0.1 °C**, not the 0.1 °F the wire format
  implies: values move in steps of 2 raw counts. Don't over-trust the last digit.
- **A reading's BLE address is not the probe's identity.** The `Ninja-WP100-R`
  unit that broadcasts a reading is a *reporter*; the 6-byte probe id inside
  the frame says which probe the reading is about, and one address was seen
  reporting three different ids in a row. F.U.Ninja keys on the id, which is
  correct — but if you port this, do the same. See
  [PROTOCOL.md §1.1](PROTOCOL.md).
- **The battery percentage is not real.** Payload byte 1 was assumed to be a
  battery level; two probes observed at once — one nearly full, one running on
  the charge it shipped from the factory with — both reported `0x64` = 100 in
  every packet. The byte is a constant, and the app's battery display will read
  100 % on a probe that is about to die. A real reading would need GATT, which
  is not solved. See [PROTOCOL.md §3.2](PROTOCOL.md).
- **Whether Chrome's `requestLEScan` reliably surfaces *scan-response*
  manufacturer data is not yet verified on real hardware.** The payload we need
  lives in the `SCAN_RSP`, not the primary advertisement. Android's scanner is
  active in its default mode so it should be merged in — but if probes appear
  with no temperature, this is the cause, not your setup.

---

## Troubleshooting

### "Could not start scanning: Bluetooth adapter not available"

Despite the wording, this is almost never a hardware or Bluetooth-off problem.
On Android, BLE scanning needs the `BLUETOOTH_SCAN` runtime permission, which
the system presents as **"Nearby devices"**. Chrome does not prompt for it, and
nothing in the browser hints that it is missing — you just get an error about
the adapter.

```
Settings → Apps → Chrome → Permissions → Nearby devices → Allow
```

Then **force-close Chrome** — swipe it away in Recents. Backgrounding it is not
enough for the new permission to take effect.

If it still fails, also grant Chrome **Location** and switch **system Location**
on. Android historically gated BLE scanning behind location access (a scan can
be used to infer position), and while Android 12+ separated the two with
`BLUETOOTH_SCAN`, some vendor builds still want location enabled.

The app diagnoses this case and shows the steps inline, rather than passing
Chrome's raw message through. It is also listed in the in-app setup checklist
(the **?** button) as a step that cannot be verified from the browser — because
there is no API to query it.

### A probe appears but both temperatures show `--`

The payload is in the scan response, not the primary advertisement
([PROTOCOL.md §2](PROTOCOL.md)). If the device is discovered but carries no
manufacturer data, the scanner is not picking up `SCAN_RSP`. Open the card's
**Details** panel: if *Raw counts* also shows `--`, no payload arrived at all.

### A probe stops updating, or a duplicate appears

Both were real bugs, fixed:

- **A phantom probe with ID `000000000000`** and raw counts `A -1 / B -1` came
  from the placeholder frame a probe broadcasts while powering on
  ([PROTOCOL.md §3.1](PROTOCOL.md)). Frames without a probe id are now
  discarded, and any phantom already saved is purged on load.
- **One probe going quiet when another was switched off** was Chrome stopping
  the LE scan entirely. The scanner now watches `BluetoothLEScan.active` and
  restarts itself, showing "Scan dropped by the browser — resuming…" while it
  does. If the browser demands a fresh tap, the button changes to *Resume
  scanning* rather than leaving you looking at stale numbers.

### Nothing appears for 10–15 seconds

Expected. The advertising interval is around 10 s ([PROTOCOL.md
§6](PROTOCOL.md)), so an empty list immediately after tapping *Start scanning*
is normal. Make sure the probe is switched on and out of its dock.

### The scan button does nothing / "Scanning API missing"

The experimental flag is off, or the browser was not fully relaunched after
enabling it. See the top of this README.

---

## Roadmap

1. ~~Plot temperature over time.~~ Done — see each probe's Details panel.
2. ~~Target temperature and alarm.~~ Done, in-page. Making the *probe itself*
   beep would need GATT ([PROTOCOL.md §7](PROTOCOL.md)).
3. **Area under the curve** — time-at-temperature, to estimate doneness and
   pasteurization rather than judging by instantaneous temperature alone. The
   data is already recorded in raw counts, so this is purely a matter of doing
   the integral over `samples`.
4. Multiple targets per probe (e.g. warn at 60 °C, alarm at 68 °C).

---

## Legal

Reverse-engineered for **interoperability** with hardware owned outright. The
protocol was derived entirely from passive observation of the device's own
public Bluetooth broadcasts, using standard tooling. No firmware was extracted,
and no technical protection measure was circumvented.

Not affiliated with, endorsed by, or connected to SharkNinja Operating LLC.
"Ninja" and "ProChef" are trademarks of their respective owners, used here only
to identify the hardware this software interoperates with.

## License

[MIT](LICENSE) © 2026 Nano Gennari
