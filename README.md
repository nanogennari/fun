# F.U.N.

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

F.U.N. reads **BLE advertisements**, because that is where the ProChef puts its
telemetry: battery level and both temperatures are broadcast continuously, with
no connection required ([PROTOCOL.md §2](PROTOCOL.md)).

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

## What it does

- **Live readings from both sensors** — the probe has a food-interior sensor and
  an ambient/grill-air sensor, and both are shown side by side.
- **Several probes at once**, each with its own card, history and nickname.
- **Records history from the first reading**, so a cook is already logged before
  you think to ask for it. Exportable as CSV.
- **Freshness is always visible.** Probes advertise only every ~10 s, so a
  number on screen can be 15 s old. Cards age `live → stale → offline` rather
  than pretending a stale value is current.
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

## Deploying to Cloudflare Pages

No build step; `public/` is served as-is, over HTTPS, which is what Web
Bluetooth requires.

**From the CLI:**

```bash
npx wrangler login
npm run deploy
```

**Or connect the GitHub repo** in the Cloudflare dashboard:

| Setting | Value |
|---|---|
| Framework preset | None |
| Build command | *(leave empty)* |
| Build output directory | `public` |

`wrangler.toml` already declares `pages_build_output_dir = "public"`.

### Headers

`public/_headers` applies a strict CSP (`default-src 'self'`, no inline script
or style) along with:

```
Permissions-Policy: bluetooth=(self)
```

Web Bluetooth is gated by that permission policy. If you put this behind a
proxy, embed it in an iframe, or serve it from somewhere other than Pages, that
header has to survive or scanning will be blocked.

---

## Tests

```bash
npm test        # node --test, no dependencies
```

- `test/protocol.test.js` runs the parser against **byte-for-byte payloads
  captured off the air** ([PROTOCOL.md §9](PROTOCOL.md)) — not hand-written
  examples. It covers the `DataView` shapes Chrome actually hands over,
  including a non-zero `byteOffset`, negative temperatures, and malformed input.
- `test/store.test.js` covers the multi-probe registry, persistence, duplicate
  suppression and staleness.

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
│       ├── store.js           # multi-probe registry, history, persistence
│       └── app.js             # UI controller
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
- **History stores raw sensor counts, not converted degrees.** If the
  temperature scale is ever corrected, old recordings reinterpret correctly
  instead of having today's conversion baked in.
- **Cards mutate in place** rather than re-rendering, so an open details panel
  does not collapse and a rename does not lose focus when an advertisement
  arrives mid-interaction.

---

## Known caveats

Worth reading before filing a bug.

- **"Food" vs "Ambient" is inferred, not confirmed.** The mapping comes from
  observing which sensor drifted while the probe cooled in free air
  ([PROTOCOL.md §5](PROTOCOL.md)). Each card's *Details* panel shows the raw
  counts, so you can always check. Confirming it properly is a five-second
  experiment: grip the tip and see which number moves.
- **The temperature scale is corroborated at a single point** — raw 761 against
  a reference thermometer reading 24.2 °C. That cannot detect a gain error. An
  ice-water check (0 °C should read raw ≈ 320) would settle it.
- **Sensor resolution is really ~0.1 °C**, not the 0.1 °F the wire format
  implies: values move in steps of 2 raw counts. Don't over-trust the last digit.
- **Battery percent has only ever been observed at 100%.** It reads like a
  percentage, but that is not proven.
- **Whether Chrome's `requestLEScan` reliably surfaces *scan-response*
  manufacturer data is not yet verified on real hardware.** The payload we need
  lives in the `SCAN_RSP`, not the primary advertisement. Android's scanner is
  active in its default mode so it should be merged in — but if probes appear
  with no temperature, this is the cause, not your setup.

---

## Roadmap

Recording already runs for every probe from its first reading, so the data is
waiting:

1. **Plot temperature over time**, per probe, both sensors.
2. **Area under the curve** — time-at-temperature, to estimate doneness and
   pasteurization rather than judging by instantaneous temperature alone.
3. **Target temperature and alarms.** In-page is straightforward; making the
   probe itself beep would need GATT ([PROTOCOL.md §7](PROTOCOL.md)).

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
