# Power Dialer (localhost)

Drop in a CSV → every column is shown on one page → hit **Call** → log an outcome → auto-advance.
Rows without a dialable number are pulled out and listed with the reason.

## Run it

```
node server.mjs
```

→ http://localhost:8000 → pick a CSV (`sample-leads.csv` is included).

No install, no build step, no dependencies. Node 20.11+ (needs `import.meta.dirname`).
The server binds to `127.0.0.1` only — nothing on your network can reach your lead list.

```
node test.mjs      # checks the CSV parser + phone normalizer
```

## About "Google Voice API"

**There isn't one.** Google has never shipped a public API for placing Google Voice calls —
no REST endpoint, no OAuth scope. Anything claiming otherwise is scraping an
unofficial endpoint and will break and/or get the account banned.

So the **Mode** dropdown gives you three real options:

| Mode | What happens | Setup |
|---|---|---|
| **Google Voice (web)** (default) | Opens a small window at `voice.google.com` with the number already loaded — one click to connect | Be signed into Google Voice. Nothing else. |
| **tel: handoff** | Fires a `tel:` link, which your OS/browser hands to whatever handles calls (GV Chrome extension, desktop softphone, paired phone) | Install the *Google Voice for Chrome* extension, or set a default `tel:` handler |
| **Twilio (in browser)** | A real WebRTC call, in the page, mic and all — no tab switching, no popups | See below |

If you want true one-keypress dialing with no popups, use Twilio. It's the only mode that
dials from inside the page.

### Twilio setup (~10 min, optional)

1. `npm install twilio @twilio/voice-sdk`
   Both are needed — Twilio stopped publishing the Voice 2.x SDK to their CDN, so the page
   loads it from `node_modules` instead.
2. In the Twilio console: buy a number, create an **API Key** (SID + Secret), and create a
   **TwiML App**.
3. Expose this server so Twilio can reach `/voice`:
   `npx untun@latest tunnel http://localhost:8000` (or ngrok). Set the TwiML App's
   **Voice Request URL** to `https://<your-tunnel>/voice` (HTTP POST).
   Through the tunnel **only `/voice` is served** — the page, your CSVs, and `/token` all
   return 404 to anything that isn't localhost. `/token` is the one that matters: it mints a
   credential that can place calls billed to you. Shut the tunnel down when you're done.
4. Set env vars and restart:

```powershell
$env:TWILIO_ACCOUNT_SID="AC..."
$env:TWILIO_API_KEY="SK..."
$env:TWILIO_API_SECRET="..."
$env:TWILIO_TWIML_APP_SID="AP..."
$env:TWILIO_CALLER_ID="+1..."   # a number you own on Twilio
node server.mjs
```

Cost: ~$0.014/min for the outbound US leg plus ~$0.004/min for the browser leg (≈$0.018/min
all in), and ~$1.15/mo to rent the number. Trial accounts can only call verified numbers.

## What the page does with your CSV

- **Column detection** — finds phone / name / business type / address / website / email / lat-lng
  under whatever names your export used (`Phone Number`, `phone`, `Business Type`, `category`, …).
  Every other column is still displayed verbatim on the card; nothing is dropped.
- **Number repair** — `(212) 555-0199 x44` → `+12125550199`. Handles extensions, dots, dashes,
  `+44`/`00` international, and cells holding two numbers (takes the first).
- **Recovery** — if the phone column is blank, it scans the row's other columns for a number
  and tells you where it found it.
- **Skips** — anything still not dialable goes to the **N skipped** list at the top, with the CSV
  row number, the business name, and why (`too short (7 digits)`, `invalid US area/exchange code`,
  `no phone value`, …).
- **Map** — Google Maps embedded on the same card, from the address or lat/lng. No API key needed.
- **Outcomes + notes** — saved to `localStorage`, survive a refresh. **Export** writes your original
  CSV back out with `dialed_number`, `call_status`, `call_notes`, `called_at` appended, skipped
  rows included and marked.

Layout: a tri-fold — **left** the numbers, **middle** the dial (Call / Prev / Next / outcomes /
notes), **right** the business (details, hours, map, reviews).

Keys: `space` dial · `←` prev · `→` next · `1`–`5` outcome (which also advances) ·
`r` load reviews · `esc` leave the notes box.

## Google reviews (needs your own API key)

The map is an `<iframe>` from google.com, so nothing on the page can read inside it, and scraping
maps.google.com directly is against Google's terms and gets blocked. The supported route is the
**Places API (New)**, which is what the **Load** button in the reviews box calls:

1. [Google Cloud console](https://console.cloud.google.com/) → new project → **APIs & Services** →
   enable **Places API (New)** (billing must be on; there's a monthly free allowance).
2. **Credentials** → **Create credentials** → **API key**. Restrict it to the Places API.
3. Start the server with the key set — it stays server-side, never reaching the page:

```powershell
$env:GOOGLE_MAPS_API_KEY="AIza..."; node server.mjs
```

Limits worth knowing: the API returns **at most 5 reviews** per place and there is no page 2 —
full review history is not available from any official Google endpoint. Each **Load** is one billed
Text Search call (results are cached per business for the life of the server process), so it's on a
button rather than firing on every arrow-key press.

## Files

| File | |
|---|---|
| `index.html` | the whole UI |
| `dialer.js` | CSV parsing, column detection, phone normalizing — pure functions |
| `server.mjs` | static server + optional Twilio `/token` and `/voice` |
| `test.mjs` | self-check for the parsing logic |

## Language / stack recommendation

**Plain JavaScript, no framework** — which is what this is. Reasoning:

- The whole app is one page holding one array in memory. React/Next would add a build step,
  a `node_modules`, and a dev server to manage, and buy you nothing here.
- CSV parsing is browser-native (`FileReader`), so the file never leaves your machine.
- WebRTC calling (Twilio, or Vonage/Telnyx) is browser-only anyway — the language question is
  settled for you.
- Node for the server because the client is already JS; one language, one runtime, zero deps.

Use Python (FastAPI) instead only if this grows a database, CRM sync, or scheduled campaigns —
the dialing still has to happen in the browser either way.

Skipped: multi-user, call recording, CRM sync, auto-advance-on-hangup. Add when one machine
and one caller stop being enough.
