/**
 * Builds the "Packet Fusion Site Survey" demo project (code pfu-demo): a
 * fictitious campus for showing the field app to peers without exposing any
 * customer data. Its settings are also the outline of the Blank project
 * template (BLANK_TEMPLATE in src/api.ts).
 *
 *   5 sites  — sites 1–3 have 2 buildings × 3 floors, sites 4–5 have
 *              5 buildings × 2 floors (38 floors in all)
 *   500 users on the User List, 100 per site. Extensions are five digits:
 *              site · building · floor · station, so 41203 is Site 4,
 *              Building 1, 2nd floor, station 03 — site N uses the N0000s.
 *   38 generic floor-plan PDFs (one per floor), each marked DEMO — FICTITIOUS,
 *              with numbered rooms; every user is assigned to a room.
 *   Briefings, a few analog / POTS / emergency items per site, and some
 *              records already completed at Site 1 so progress, pins and
 *              flags are visible.
 *
 * Output (gitignored):
 *   data/demo/pfu-demo.sql           load with: wrangler d1 execute DB [--env test] --remote --file …
 *   data/demo/plans/pfu-demo/plans/… upload to the MEDIA bucket under the same key
 *
 * Every id is derived from a natural key, so re-running and re-loading is
 * idempotent. All names, numbers and plans are invented; phone numbers use
 * the reserved 555-01xx range.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(root, "data", "demo");
const PROJECT_CODE = "pfu-demo";
const DEMO_ENGINEER = "demo.engineer@packetfusion.com";

const SITES = [
  { n: 1, code: "S1", name: "Site 1 - North Campus", floors: 3, buildings: ["Administration Building", "Library"] },
  { n: 2, code: "S2", name: "Site 2 - South Campus", floors: 3, buildings: ["Science Hall", "Student Center"] },
  { n: 3, code: "S3", name: "Site 3 - Health Sciences", floors: 3, buildings: ["Health Sciences Building", "Campus Clinic"] },
  { n: 4, code: "S4", name: "Site 4 - Main Campus", floors: 2, buildings: ["Main Hall", "Engineering Building", "Fine Arts Center", "Gymnasium", "Facilities Building"] },
  { n: 5, code: "S5", name: "Site 5 - West Campus", floors: 2, buildings: ["Business School", "Lecture Hall", "Residence Hall", "Dining Commons", "Technology Center"] },
];
const USERS_PER_SITE = 100;
const FLOOR_NAMES = ["First Floor", "Second Floor", "Third Floor"];
const ROLES = ["Faculty Office", "Admin Office", "Reception", "Classroom", "Teaching Lab", "Conference Room", "Workroom", "Staff Lounge", "Help Desk", "Study Room"];
const PHONE_MODELS = ["Desk phone", "Desk phone", "Desk phone", "Executive desk phone", "Conference phone", "Wireless DECT handset"];

const SETTINGS = {
  site_label: { singular: "Site", plural: "Sites" },
  subject: "voice equipment",
  categories: [
    { key: "phone", label: "User List", title: "Phones", fields: [{ key: "cable_drop_status", label: "Cable drop status", type: "select", options: ["Present", "Not Present"], required: false }] },
    { key: "analog", label: "Analog Stations", title: "Analog Stations", fields: [] },
    { key: "pots", label: "POTS Survey", title: "POTS Lines", fields: [] },
    { key: "emergency", label: "Emergency Phones", title: "Emergency Phones", fields: [] },
  ],
  support: { label: "Packet Fusion Support", phone: "(555) 555-0100", sms: "(555) 555-0101", email: null },
};

// ---- helpers -----------------------------------------------------------

function stableId(key) {
  const h = createHash("sha1").update(`pf-site-survey-demo:${key}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** Small deterministic PRNG, so every build produces identical plans. */
function rng(seed) {
  let s = createHash("sha1").update(seed).digest().readUInt32BE(0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function sql(v) {
  if (v === null || v === undefined || v === "") return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
}
const out = [];
function insert(table, row) {
  const cols = Object.keys(row);
  out.push(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(c => sql(row[c])).join(", ")}) ON CONFLICT(id) DO NOTHING;`);
}

// ---- floor-plan PDF ----------------------------------------------------

const PAGE_W = 1224, PAGE_H = 792; // 17 × 11 in, landscape
// Top wall sits below the two header lines (y ≈ 730–748).
const BLD = { x: 60, y: 200, w: 840, h: 500 };
const CORRIDOR = { y: 440, h: 60 };

function pdfText(s) {
  return String(s).replace(/[\\()]/g, c => `\\${c}`);
}
function fit(text, size, width) {
  const max = Math.floor(width / (size * 0.52));
  return text.length <= max ? text : text.slice(0, Math.max(1, max - 1)) + ".";
}

/**
 * Lay out one floor: a row of rooms either side of a central corridor, with
 * stairs at both ends, an elevator, restrooms and an IT closet. Returns the
 * rooms (with centres in PDF points) so users and pins can be placed in them.
 */
function layoutFloor(seed, letter, floorNo, officeCount) {
  const rand = rng(seed);
  const topCount = Math.ceil(officeCount / 2);
  const bottomCount = officeCount - topCount;
  const roomNo = i => `${letter}-${floorNo}${String(i).padStart(2, "0")}`;
  let seq = 1;

  const row = (specials, count, y, h, specialsAtEnd) => {
    const items = [
      ...specials.start.map(s => ({ ...s, special: true })),
      ...Array.from({ length: count }, () => ({ special: false })),
      ...specialsAtEnd.map(s => ({ ...s, special: true })),
    ];
    const weights = items.map(it => it.special ? 0.7 : 0.75 + rand() * 0.7);
    const total = weights.reduce((a, b) => a + b, 0);
    let x = BLD.x;
    return items.map((it, i) => {
      const w = BLD.w * weights[i] / total;
      const room = {
        x, y, w, h,
        number: it.special ? it.number : roomNo(seq++),
        name: it.special ? it.name : null,
        special: it.special,
      };
      x += w;
      return room;
    });
  };

  const top = row({ start: [{ number: "STAIR 1", name: "Stair" }] }, topCount,
    CORRIDOR.y + CORRIDOR.h, BLD.y + BLD.h - (CORRIDOR.y + CORRIDOR.h), [{ number: `${letter}-${floorNo}90`, name: "Elevator" }]);
  const bottom = row({ start: [{ number: `${letter}-${floorNo}91`, name: "Men" }, { number: `${letter}-${floorNo}92`, name: "Women" }] }, bottomCount,
    BLD.y, CORRIDOR.y - BLD.y, [{ number: `${letter}-${floorNo}95`, name: "IT Closet" }, { number: "STAIR 2", name: "Stair" }]);
  return [...top, ...bottom];
}

function floorPlanPdf({ siteName, building, letter, floorName, floorNo, rooms, sheet }) {
  const c = [];
  const rect = (x, y, w, h, op = "S") => c.push(`${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re ${op}`);
  const text = (x, y, size, s, bold = false) => c.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td (${pdfText(s)}) Tj ET`);
  const line = (x1, y1, x2, y2) => c.push(`${x1} ${y1} m ${x2} ${y2} l S`);

  c.push("0 G 0 g");
  // Sheet border
  c.push("1 w"); rect(20, 20, PAGE_W - 40, PAGE_H - 40);
  // Header
  text(60, PAGE_H - 44, 14, "PACKET FUSION UNIVERSITY  -  DEMO FLOOR PLAN", true);
  text(60, PAGE_H - 62, 10, `${siteName}  |  ${building}  |  ${floorName}`);

  // Corridor
  c.push("0.95 g"); rect(BLD.x, CORRIDOR.y, BLD.w, CORRIDOR.h, "f"); c.push("0 g");
  text(BLD.x + BLD.w / 2 - 30, CORRIDOR.y + CORRIDOR.h / 2 - 4, 10, "CORRIDOR");

  // Rooms
  c.push("0.75 w");
  for (const r of rooms) {
    if (r.special) { c.push("0.9 g"); rect(r.x, r.y, r.w, r.h, "f"); c.push("0 g"); }
    rect(r.x, r.y, r.w, r.h);
    // Door: a gap marker on the corridor wall.
    const doorY = r.y >= CORRIDOR.y ? r.y : r.y + r.h;
    c.push("1 G 3 w"); line((r.x + r.w / 2 - 10).toFixed(1), doorY, (r.x + r.w / 2 + 10).toFixed(1), doorY); c.push("0 G 0.75 w");
    const cx = r.x + 6;
    const cy = r.y + r.h / 2;
    text(cx, cy + 6, 9, fit(r.number, 9, r.w - 10), true);
    if (r.name) text(cx, cy - 7, 7, fit(r.name, 7, r.w - 10));
  }

  // Building outline on top
  c.push("3 w"); rect(BLD.x, BLD.y, BLD.w, BLD.h); c.push("1 w");

  // North arrow
  c.push("0 g"); c.push(`1110 700 m 1100 670 l 1110 678 l 1120 670 l f`);
  text(1105, 708, 11, "N", true);

  // Title block
  rect(924, 40, 280, 210);
  line(924, 210, 1204, 210); line(924, 170, 1204, 170); line(924, 120, 1204, 120); line(924, 80, 1204, 80);
  text(934, 222, 12, "PACKET FUSION UNIVERSITY", true);
  text(934, 186, 9, siteName);
  text(934, 152, 9, `${building} (${letter})`);
  text(934, 136, 9, floorName);
  text(934, 96, 10, "DEMO - FICTITIOUS - NOT TO SCALE", true);
  text(934, 56, 9, `Sheet ${sheet}`);
  text(1080, 56, 9, "Site Survey demo");

  // Legend
  text(60, 170, 9, "Rooms shaded grey are shared spaces (stairs, elevator, restrooms, IT closet).");
  text(60, 154, 9, "Room numbers: building letter - floor - room (e.g. A-104).");

  return buildPdf(c.join("\n"));
}

function buildPdf(content) {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

// ---- data --------------------------------------------------------------

const customerId = stableId("customer");
const projectId = stableId("project");
insert("customers", { id: customerId, name: "Packet Fusion (demo)" });
insert("projects", { id: projectId, customer_id: customerId, code: PROJECT_CODE, name: "Packet Fusion Site Survey" });
out.push(`UPDATE projects SET settings = ${sql(JSON.stringify(SETTINGS))} WHERE id = ${sql(projectId)};`);

const surveyId = stableId("survey:site1:demo-engineer");
const plans = [];
let userCount = 0;
const demoDone = []; // Site 1 users pre-completed, with their room centres

for (const site of SITES) {
  const siteId = stableId(`site:${site.code}`);
  insert("sites", {
    id: siteId, project_id: projectId, code: site.code, name: site.name,
    address: `${100 * site.n} University Way (demo address)`,
    contact_name: `Demo Facilities Contact ${site.n}`,
    contact_phone: `(555) 555-01${String(10 + site.n).padStart(2, "0")}`,
    parking_info: `Visitor Lot ${String.fromCharCode(64 + site.n)} - free with a contractor pass from the front desk`,
    access_hours: "Mon-Fri, 7:00 AM-5:00 PM",
    wifi_ssid: "PFU-Guest",
    wifi_username: "survey-demo",
    wifi_password: "demo-only",
    briefing_notes: "Demo site - all names, numbers and plans are fictitious.",
  });

  const floorsAll = [];
  site.buildings.forEach((bName, bi) => {
    const letter = String.fromCharCode(65 + bi);
    const buildingId = stableId(`building:${site.code}:${letter}`);
    insert("buildings", { id: buildingId, site_id: siteId, name: `${bName} (${letter})` });
    for (let f = 1; f <= site.floors; f++) {
      floorsAll.push({ site, siteId, bi, letter, bName, buildingId, f, floorId: stableId(`floor:${site.code}:${letter}:${f}`) });
    }
  });

  // 100 users per site, spread evenly over its floors.
  const base = Math.floor(USERS_PER_SITE / floorsAll.length);
  const extra = USERS_PER_SITE % floorsAll.length;

  floorsAll.forEach((fl, idx) => {
    const users = base + (idx < extra ? 1 : 0);
    const floorName = FLOOR_NAMES[fl.f - 1];
    insert("floors", { id: fl.floorId, building_id: fl.buildingId, name: floorName });

    const rooms = layoutFloor(`${site.code}:${fl.letter}:${fl.f}`, fl.letter, fl.f, users + 2);
    const key = `${PROJECT_CODE}/plans/${site.code}/${fl.letter}-${fl.f}.pdf`;
    const sheet = `${site.code}-${fl.letter}${fl.f}`;
    plans.push({ key, pdf: floorPlanPdf({ siteName: site.name, building: `${fl.bName}`, letter: fl.letter, floorName, floorNo: fl.f, rooms, sheet }) });

    const planId = stableId(`plan:${key}`);
    insert("floor_plans", {
      id: planId, floor_id: fl.floorId, r2_key: key, thumb_path: null,
      filename: `${site.name} - ${fl.bName} (${fl.letter}) - ${floorName}.pdf`,
      size_kb: Math.ceil(plans[plans.length - 1].pdf.length / 1024),
      is_supporting_document: false, sheet_numbers: JSON.stringify([sheet]), room_names_raw: "[]",
    });

    const rand = rng(`users:${site.code}:${fl.letter}:${fl.f}`);
    const offices = rooms.filter(r => !r.special);
    offices.forEach((r, i) => { r.role = ROLES[Math.floor(rand() * ROLES.length)]; r.idx = i; });
    for (const r of rooms) {
      insert("rooms", {
        id: stableId(`room:${fl.floorId}:${r.number}`), floor_id: fl.floorId,
        number: r.number, name: r.special ? r.name : r.role, created_by: "seed:demo",
      });
    }

    for (let u = 1; u <= users; u++) {
      const room = offices[(u - 1) % offices.length];
      // Extension: site · building · floor · station (two digits).
      const ext = String(site.n * 10000 + (fl.bi + 1) * 1000 + fl.f * 100 + u);
      const itemId = stableId(`item:${ext}`);
      insert("inventory_items", {
        id: itemId, project_id: projectId, site_id: siteId, building_id: fl.buildingId, floor_id: fl.floorId,
        category: "phone", name: `${room.role} ${room.number}`, extension: ext,
        device_model: PHONE_MODELS[Math.floor(rand() * PHONE_MODELS.length)],
        listed_location: `Rm ${room.number}`, external_id: `${PROJECT_CODE}:user:${ext}`, import_batch: "demo",
      });
      userCount++;
      // Pre-complete the first floor of Site 1's Administration Building.
      if (site.n === 1 && fl.letter === "A" && fl.f === 1 && u <= 12) {
        demoDone.push({ itemId, ext, room, floorId: fl.floorId, buildingId: fl.buildingId, planId, u });
      }
    }
  });

  // A few non-user items per site so every briefing button has a list.
  const first = floorsAll[0];
  const extras = [
    ["analog", { name: "Fax - Main Office", extension: `${site.n}9001`, listed_location: "Main office workroom", device_model: "Analog fax (ATA port 1)" }],
    ["analog", { name: "Overhead Paging", extension: `${site.n}9002`, listed_location: "IT Closet", device_model: "Paging adapter" }],
    ["analog", { name: "Lobby Courtesy Phone", extension: `${site.n}9003`, listed_location: "Main lobby", device_model: "Analog phone" }],
    ["pots", { name: "Elevator Phone", phone_number: `(555) 555-01${String(20 + site.n * 2).padStart(2, "0")}`, listed_location: "Elevator cab", device_model: "Elevator emergency phone" }],
    ["pots", { name: "Fire Alarm Panel", phone_number: `(555) 555-01${String(21 + site.n * 2).padStart(2, "0")}`, listed_location: "IT Closet", device_model: "FACP dialer" }],
    ["emergency", { name: "Blue Light - Parking Lot", extension: `${site.n}9901`, listed_location: `Visitor Lot ${String.fromCharCode(64 + site.n)}`, device_model: "Blue light tower" }],
    ["emergency", { name: "Blue Light - Main Entrance", extension: `${site.n}9902`, listed_location: "Main entrance plaza", device_model: "Blue light tower" }],
  ];
  for (const [category, it] of extras) {
    const ref = it.extension || it.phone_number;
    insert("inventory_items", {
      id: stableId(`item:${site.code}:${category}:${ref}`), project_id: projectId, site_id: siteId,
      building_id: first.buildingId, floor_id: category === "emergency" ? null : first.floorId,
      category, ...it, external_id: `${PROJECT_CODE}:${category}:${ref}`, import_batch: "demo",
    });
  }
}

// Completed records at Site 1, so progress, pins and flags show up.
insert("surveys", {
  id: surveyId, project_id: projectId, site_id: stableId("site:S1"), title: `Site 1 - North Campus - ${DEMO_ENGINEER}`,
  status: "in_progress", created_by: DEMO_ENGINEER, started_at: "2026-10-19T15:00:00.000Z",
});
for (const d of demoDone) {
  const jitter = rng(`pin:${d.ext}`);
  const cx = d.room.x + d.room.w * (0.35 + jitter() * 0.3);
  const cy = d.room.y + d.room.h * (0.25 + jitter() * 0.3);
  const flags = {
    3: { test_result: "not_working", notes: "No dial tone" },
    7: { test_result: "working", discrepancy: "wrong_location", discrepancy_note: "Phone moved to the room across the hall" },
    9: { test_result: "not_tested", notes: "Room locked during visit" },
    11: { test_result: null, discrepancy: "not_found" },
  }[d.u] ?? { test_result: "working" };
  const notFound = flags.discrepancy === "not_found";
  insert("devices", {
    id: stableId(`device:${d.ext}`), survey_id: surveyId, inventory_item_id: d.itemId,
    building_id: d.buildingId, floor_id: d.floorId,
    floor_plan_id: notFound ? null : d.planId,
    pin_x: notFound ? null : +(cx / PAGE_W).toFixed(4),
    pin_y: notFound ? null : +(1 - cy / PAGE_H).toFixed(4),
    room_id: notFound ? null : stableId(`room:${d.floorId}:${d.room.number}`),
    category: "phone", condition: "existing",
    test_result: flags.test_result, discrepancy: flags.discrepancy ?? null, discrepancy_note: flags.discrepancy_note ?? null,
    notes: flags.notes ?? null,
    attributes: JSON.stringify(notFound ? {} : { observed_number: d.ext, cable_drop_status: d.u === 5 ? "Not Present" : "Present" }),
    created_by: DEMO_ENGINEER, updated_at: "2026-10-19T16:00:00.000Z",
  });
}
// One device found that is not on the list.
{
  const d = demoDone[0];
  insert("devices", {
    id: stableId("device:not-on-list:1"), survey_id: surveyId, inventory_item_id: null,
    building_id: d.buildingId, floor_id: d.floorId, floor_plan_id: d.planId,
    pin_x: 0.62, pin_y: 0.5, category: "phone", condition: "existing", test_result: "working",
    discrepancy: "not_on_list", location_note: "Corridor courtesy phone near the elevator",
    attributes: JSON.stringify({ observed_number: "11199", cable_drop_status: "Present" }),
    created_by: DEMO_ENGINEER, updated_at: "2026-10-19T16:05:00.000Z",
  });
}

// ---- write -------------------------------------------------------------

await mkdir(OUT_DIR, { recursive: true });
await writeFile(join(OUT_DIR, `${PROJECT_CODE}.sql`), `-- Generated by scripts/build-demo.mjs. Fictitious demo data. Do not edit.\n${out.join("\n")}\n`);
for (const p of plans) {
  const file = join(OUT_DIR, "plans", p.key);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, p.pdf);
}

console.log(`demo written to ${OUT_DIR}`);
console.log(`  ${SITES.length} sites, ${SITES.reduce((a, s) => a + s.buildings.length, 0)} buildings, ${plans.length} floor plans`);
console.log(`  ${userCount} users, ${demoDone.length + 1} pre-completed records, ${out.length} statements`);
