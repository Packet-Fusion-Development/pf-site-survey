# Packet Fusion Site Survey

Packet Fusion's field survey platform. Engineers work through a customer's
device list on site, from a phone or tablet: they find each phone or line,
mark where it is on the floor plan, test it, flag anything that doesn't match,
and add a photo when something is unusual. Everything lands in one central
database that serves every customer project.

It is always branded **Packet Fusion Site Survey**. It is generic: a
university campus, a city's facilities, or a company's offices.

**Cloudflare account:** `itcontact@packetfusion.com` (`521c322a89a17bb69f91f1e65177606e`)

| | Address | Worker |
|---|---|---|
| Test copy | https://survey-test.packetfusion.com/survey | `pf-site-survey-test` |
| Production (not yet deployed) | https://survey.packetfusion.com | `pf-site-survey` |

## Projects

Each customer engagement is a project. A project names its locations (Campus,
Facility, Office), lists its survey categories, and sets its support contacts.

| Project | Code | What it is |
|---|---|---|
| LACCD District Technology Survey | `laccd-dts` | 10 LACCD campuses, 719 real floor plans. See [LACCD project](#laccd-project). |
| Packet Fusion - Site Survey Template | `pfu-demo` | Fictitious campus for demos and testers, and the outline of the new-project template. See [Demo project](#demo-project-packet-fusion-site-survey). |

New projects are created from **Project setup → + New project**, starting from
the Packet Fusion Site Survey template, then configured in the app's **Project
setup** screen. Device lists come
from a CSV or Excel import, and floor plans are stored in R2 under
`<project_code>/plans/…`.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Vanilla HTML/CSS/JS, no build step. The survey app is an installable PWA at `/survey`. |
| API | One Cloudflare Worker ([src/index.ts](src/index.ts), [src/api.ts](src/api.ts)) under `/api/*` |
| Data | D1 (SQLite). Schema in [migrations/](migrations/). |
| Files | R2: survey photos and project floor plans in the media bucket; LACCD's drawings in `laccd-floorplans` |
| Sign-in | Cloudflare Access with Microsoft Entra ID SSO, re-verified in the Worker |
| Deploys | Wrangler CLI, or Workers Builds from GitHub |

## Layout

```
src/index.ts             Worker entry: / → /survey, /api/* → api.ts, /pdfs/* → R2, else static assets
src/api.ts               Survey API
src/access.ts            Cloudflare Access JWT verification
migrations/              D1 schema
public/
  survey.html/.css/.js   The field app (PWA)
  js/net.js, js/idb.js   Online-first data access, offline outbox
  sw.js                  Service worker (offline app shell, plans, photos)
  brand/                 Packet Fusion logo
  vendor/                pdf.js (plans) and SheetJS (Excel import), pinned
  laccd/                 LACCD floor-plan library page (served at /laccd/)
  thumbs/<CAMPUS>/       LACCD plan thumbnails
scripts/
  build-demo.mjs         Generates the Packet Fusion Site Survey demo (pfu-demo)
  test-access.mjs        Tests for the Access JWT gate (npm test)
  laccd/                 LACCD project scripts (catalog build, seed, drawing upload/verify)
data/
  laccd/                 LACCD catalog (source of truth) and the original spreadsheet export
```

## Survey data model

D1 binding `DB`:

```
customer → project → site → building → floor → floor_plan (drawing sheet)
                                            → room
project  → inventory_item (the customer's list) ← device (what was found)
project  → survey → device (pinned on a floor_plan) → photo
```

- **Ids are UUIDs**, so field devices can create records offline and sync later
  without collisions.
- **Field-synced rows** (rooms, surveys, devices, photos) carry `updated_at`
  and `deleted_at`, so offline edits and deletions can be reconciled.
- **Device pins** are stored as `pin_x` / `pin_y` fractions (0–1) of the sheet,
  so they stay in place at any zoom or render size.
- **Category fields** (e.g. Cable drop status) and other per-device extras live
  in the `attributes` JSON column, so a new field needs no migration.
- **Project settings** (location wording, categories, support contacts) are a
  JSON column on `projects`.

## Field survey app

The engineer flow follows the welcome screen:

1. **Start** → choose a site.
2. **Site briefing:** contact, parking, WiFi, access hours, maps, and
   **Contact Packet Fusion Support**.
3. Choose a category (e.g. User List, Analog Stations, POTS Survey,
   Emergency Phones).
4. Search the list by name, extension or number.
5. **Mark on floor plan** (or describe the location if no plan exists).
6. Required fields: **TestResult** (Working / Not working / Can't test) and
   any required category fields.
7. A photo only if something is unusual.
8. The **Discrepancy** flag if something doesn't match the list.

Saved items drop off the list. Each engineer gets one survey per site,
created automatically. The layout follows the field-survey mockups: solid
blue buttons, a blue app bar on list and form screens, and the Packet Fusion
navy bar on every screen. On phones, screens fill the display; on tablets
and iPad they become a centred card.

**Project setup** (`#/p/<code>/setup`, for the emails in `ADMIN_EMAILS`):

- Location wording and survey categories, each with its own extra fields.
  Write fields one per line, e.g. `Cable drop status: Present, Not Present`;
  end a line with `*` to make the field required.
- Support contacts and site briefings.
- **Device-list import from CSV or Excel.** Columns are mapped automatically
  and can be adjusted. Missing buildings and floors are created, and
  re-importing updates rows instead of duplicating them.
- Results download (`/api/projects/<code>/devices.csv`).

**Online-first, offline as a fallback.** With a connection, every screen loads
live and every save goes straight to D1. Only when a request fails (no signal,
or no answer within 8 s) does the app use the copy kept on the device and
queue changes. The queue syncs by itself, in order, when the connection
returns.

| Piece | Where | Behaviour |
|---|---|---|
| Screens and data | [public/js/net.js](public/js/net.js) | Network first. Offline: device copy (IndexedDB) plus queued changes, marked "Not synced". |
| Writes | [src/api.ts](src/api.ts) | Idempotent `PUT`s keyed by a device-generated UUID, so a replayed queue lands once. Last write wins on the client's `updated_at`, clamped so a fast clock cannot win forever. |
| Room added offline twice | `PUT /api/rooms/:id` | Merged into the existing room (`merged_into`); queued devices are repointed. |
| App shell, plans, photos | [public/sw.js](public/sw.js) | Network first, cached copy only on failure. Plans and photos are kept once viewed. |
| Expired sign-in | `net.js` | Treated like offline (nothing is lost), with a "Sign in again" prompt. |
| Server rejected a change | `net.js` | Moved to a review list instead of blocking the queue. |

Floor plans render from the PDF with pdf.js, which is vendored so it works
offline. If a PDF can't load, the plan falls back to its thumbnail.

When changing a file listed in `SHELL` in `public/sw.js`, bump `VERSION` so
installed apps refresh their offline copy.

## Results page

`/results/<project>` shows live totals for a project, styled like the LACCD
catalog. The page is [public/results/](public/results/); the data comes from
`GET /api/results/<project>`, calculated from D1 on every request, so it is
always current. The page also refreshes itself every minute.

- **Totals:** surveyed vs. remaining, Working / Not working / Can't test /
  Couldn't find, discrepancies, devices found that aren't on the list, photos.
- **A card per site** with a status bar and per-category progress.
  "Buildings and floors" opens a card per building with a bar per floor.
- **View plan** on a floor shows its drawing with a pin per recorded device,
  coloured and iconed by status (✓ ✕ – ?) with a ! for discrepancies. Tap a
  pin for details. Plans are served by `GET /api/results/<project>/plans/<id>`,
  which only returns plans in that project, so customers see their own drawings
  and nothing else. pdf.js is exposed at `/results/pdfjs/`.
- **Needs attention:** not working, couldn't find, discrepancies, not on the list.
- **Export CSV** (`/api/results/<project>/export.csv`): one row per item.

**Two audiences, one page.** The API decides which version to return:

| | Internal (Packet Fusion staff) | Customer |
|---|---|---|
| Who | Emails in `INTERNAL_DOMAINS` (default `packetfusion.com`) or `ADMIN_EMAILS` | Addresses or `@domains` listed in `project_access` for that project |
| Sees | Every project; who surveyed each record, engineers' notes, links into the survey app, a "Preview customer view" switch | Only their projects' results, without staff names, notes or record ids |
| Can reach | Everything | **Only** `GET /api/me` and `/api/results/<their project>`. The Worker returns 403 for every other API route and for `/pdfs/*`. |

Admins give customers access in **Project setup → Results and customer access**.

**Cloudflare Access for customers (one-time setup).** Customers aren't on
Packet Fusion's Entra login, so they need their own way to sign in:

1. In Zero Trust → Access controls → Applications, create a self-hosted
   application with two destinations, `<host>/results` and `<host>/api/results`,
   on the survey hostname (and on `survey-test` to try it). Path-specific
   applications take precedence over the hostname-wide one, so this app
   decides who reaches the results pages.
2. Login methods: **One-time PIN** (customers get an emailed code). Keep
   Microsoft Entra ID as well, so staff can still open the pages.
3. Policy: Allow, Include **Emails ending in** each customer's domain (or
   specific emails), plus `@packetfusion.com`.

Everything a results page loads lives under `/results/` (its own CSS, script
and logo copy), so customers never need access to anything else. The Worker
enforces the per-project limit regardless of how Access is set up.

**Local testing as a customer:** with Access off (`.dev.vars`), send the
header `x-dev-user: someone@customer.edu`. The Worker ignores this header
whenever Access is configured.

## Develop

```bash
npm install
cp .dev.vars.example .dev.vars   # turns the Access check off for localhost only
npm run db:migrate:local
npm run laccd:seed:local         # optional: the LACCD project
npm run demo:build               # optional: the demo project (then load it, below)
npm run dev                      # http://localhost:8787/survey
```

`npm run dev` runs fully locally. Its R2 stub starts empty, so plans fall back
to thumbnails until you upload some. `npm run dev:remote` reads the real
buckets.

## Test copy

`npm run deploy:test` deploys `pf-site-survey-test` to
https://survey-test.packetfusion.com/survey. It has its own D1 database
(`pf-site-survey-test`) and photo bucket (`pf-site-survey-media-test`), and
reads LACCD's drawings from `laccd-floorplans`. The hostname is a public
hostname on the shared Packet Fusion Access application, whose
"Packet Fusion Entra SSO" policy admits any `@packetfusion.com` account.

## Demo project: Packet Fusion Site Survey

A fictitious campus (code `pfu-demo`) for showing the app without customer
data, built by [scripts/build-demo.mjs](scripts/build-demo.mjs). Its settings
are the outline of the template new projects start from (`BLANK_TEMPLATE` in
[src/api.ts](src/api.ts)).

- 5 sites. Sites 1–3 have 2 buildings × 3 floors; sites 4–5 have
  5 buildings × 2 floors.
- 500 users (100 per site) on five-digit extensions laid out as
  site · building · floor · station. For example, `41203` is Site 4,
  Building 1, 2nd floor, station 03, and Site N uses the N0000s.
- 38 generated floor-plan PDFs, all marked "DEMO — FICTITIOUS".
- Briefings, plus a few completed records at Site 1.

```bash
npm run demo:build      # → data/demo/ (gitignored)
npx wrangler d1 execute DB --env test --remote --file data/demo/pfu-demo.sql
# upload each data/demo/plans/<key> to the media bucket under the same <key>:
npx wrangler r2 object put "pf-site-survey-media-test/<key>" --file "data/demo/plans/<key>" --remote
```

## LACCD project

The LACCD District Technology Survey: 719 floor plans and telecom as-built
drawings across the ten Los Angeles Community College District campuses.

| Piece | Where |
|---|---|
| Catalog (source of truth) | [data/laccd/catalog.json](data/laccd/catalog.json), derived from `data/laccd/Floorplan_Data_Export_Claude.xlsx` |
| Floor-plan library page | `/laccd/` ([public/laccd/index.html](public/laccd/index.html), [public/app.js](public/app.js)) reading `public/catalog.json` |
| Thumbnails | `public/thumbs/<CAMPUS>/*.jpg` |
| Drawings (~380 MB) | R2 bucket `laccd-floorplans`, keys `<CAMPUS>/<file>.pdf`, served at `/pdfs/…` |
| Survey project | `laccd-dts`, loaded from the catalog by `npm run laccd:seed:*` |
| Live floor-plan site | https://laccd-floorplan-app.packetfusion.com: the earlier `laccd-floorplan-app` Worker, deployed from `main` until the production cutover |

`npm run build` validates the catalog and writes `public/catalog.json`. It is
a tripwire: it fails on rows with missing fields, duplicate paths, or
thumbnails that are not on disk.

The seed derives every id from its natural key, so it can be re-run after a
catalog edit without duplicating rows. Room names in the LACCD export do not
pair with room numbers, so the seed creates one room per distinct number and
keeps the names as search text (`floor_plans.room_names_raw`).

**Drawings.** Credentials for uploading come from `.env` (`cp .env.example .env`,
or `op inject -i .env.tpl -o .env` from 1Password).

```bash
npm run laccd:upload-pdfs -- --dry-run   # what it would push from ./pdfs/<CAMPUS>/
npm run laccd:upload-pdfs                # idempotent; --force to overwrite
npm run laccd:verify-r2                  # every catalog row has a real R2 object
```

To add a drawing: put the PDF in `pdfs/<CAMPUS>/`, the thumbnail in
`public/thumbs/<CAMPUS>/`, and a row in `data/laccd/catalog.json`, then run
`npm run laccd:upload-pdfs` and deploy.

> **Do not bulk-upload LACCD drawings with `wrangler r2 object put`.** It
> truncates keys at the first `#`, so `LASC/Parking Structure #8.pdf` lands
> under `LASC/Parking Structure ` and can never be found. `wrangler r2 object
> get` truncates the same way, so a round-trip looks fine. Two files in this
> set are affected. `laccd:upload-pdfs` uses the S3 API and stores keys
> verbatim.

## Access control

Every hostname is gated by **Cloudflare Access with Microsoft Entra ID SSO**.

- **Access cannot protect `*.workers.dev`**, so the app only runs on custom
  domains and `workers_dev` is `false`.
- **Add a hostname to Access before its first deploy.** Deploying creates the
  DNS record, and static assets (the app shell, catalog, thumbnails) are
  protected by Access at the edge only.
- **The Worker re-verifies** the `Cf-Access-Jwt-Assertion` JWT on every
  `/api/*` and `/pdfs/*` request (signature, `aud`, `iss`, expiry), so data
  and drawings stay protected even if something reaches the Worker directly.
  `npm test` covers that gate, including tampered payloads, `alg: none`,
  expired tokens and wrong-audience tokens.
- `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `wrangler.jsonc` turn that check
  on. Leaving them empty turns it off, which is only for local dev via
  `.dev.vars`.
- **Entra needs no per-application change.** The OAuth callback is the Zero
  Trust team domain (`https://packetfusion.cloudflareaccess.com/cdn-cgi/access/callback`),
  shared by every Access application in the org. It is registered on
  Packet Fusion's Entra app registration (`7660c7e3-5a2f-4abb-be55-caa1ab0d367a`).
  An `AADSTS50011` redirect-URI error means that registration is missing it.

When Access is enforcing, PDFs are returned `Cache-Control: private`.

## Production cutover

`main` still deploys the original `laccd-floorplan-app` Worker. Do these in
order before this work merges to `main`:

1. **GitHub** (repo admin): Settings → General → rename the repo to
   `pf-site-survey`. GitHub redirects the old URL. Reconnect Workers Builds if
   it is linked, and run `git remote set-url origin https://github.com/Packet-Fusion-Development/pf-site-survey.git`
   in local clones.
2. **D1 and R2**: `npx wrangler d1 create pf-site-survey`, put the id in
   `wrangler.jsonc` in place of the placeholder, then `npm run db:migrate:remote`
   and `npm run laccd:seed:remote`. Create the photo bucket with
   `npx wrangler r2 bucket create pf-site-survey-media`.
3. **Access**: add `survey.packetfusion.com` as a public hostname on the
   Packet Fusion Access application (or a new one, then update `ACCESS_AUD`)
   **before** deploying.
4. **Deploy** `pf-site-survey` with `npm run deploy` and confirm it serves.
5. **LACCD site**: decide whether `laccd-floorplan-app.packetfusion.com` keeps
   running as its own Worker or redirects to `survey.packetfusion.com/laccd/`.
