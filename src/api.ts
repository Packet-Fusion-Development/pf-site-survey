/**
 * Survey API — everything under /api/*.
 *
 * The field app is online-first: it reads and writes here whenever it has a
 * connection, and only falls back to its on-device copy and outbox when a
 * request fails. That shapes two rules every write route follows:
 *
 *   - Writes are idempotent PUTs keyed by a client-generated UUID, so a queued
 *     write replayed after reconnecting (possibly twice) lands exactly once.
 *   - Conflicts resolve last-write-wins on the client's updated_at, so an edit
 *     made offline an hour ago does not overwrite a newer one made online.
 *     The response carries `applied: false` when the stored row was newer.
 *
 * "Delete" is a PUT with deleted_at set, which keeps it on the same
 * idempotent, conflict-checked path and lets deletions sync like edits.
 */

import type { Env } from "./index";

/** Used as created_by when Access is not enforcing (local dev). */
const LOCAL_USER = "local-dev@localhost";

/** Field photos are resized on the device; this only stops runaway uploads. */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const PHOTO_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const SURVEY_STATUSES = ["draft", "in_progress", "submitted", "approved"];
const MOUNTING_TYPES = ["ceiling", "wall", "rack", "desk", "floor", "pole", "other"];
const CONDITIONS = ["existing", "proposed", "replace", "remove"];
const TEST_RESULTS = ["working", "not_working", "not_tested"];
const DISCREPANCIES = ["wrong_location", "different_device", "not_found", "not_on_list", "damaged", "other"];

/** Inventory rows per import request; larger spreadsheets are sent in chunks by the client. */
const MAX_IMPORT_ROWS = 2000;
/** Statements per D1 batch — keeps each batch well inside D1's limits. */
const IMPORT_BATCH_SIZE = 100;

/** Allowed clock skew before a client timestamp is clamped to server time. */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type Json = Record<string, unknown>;

export async function handleApi(request: Request, env: Env, user: string | null): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const method = request.method;
  const who = user || LOCAL_USER;
  const admin = isAdmin(env, user);
  const requireAdmin = () => {
    if (!admin) throw new HttpError(403, "Only project administrators can change setup.");
  };

  try {
    const [a, b, c, d] = parts;
    const viewer = await resolveViewer(env, user);

    // Customers get the results of their own projects and nothing else —
    // not the survey app's data, not setup, not other customers.
    if (!viewer.internal) {
      const own = method === "GET" && ((a === "me" && !b) || (a === "results" && (!b || viewer.projects?.has(b))));
      if (!own) throw new HttpError(403, "This account can only view its project results.");
    }

    if (method === "GET" && a === "me" && !b) {
      return json({ email: who, is_admin: admin, internal: viewer.internal, projects: viewer.projects ? [...viewer.projects] : null });
    }

    if (method === "GET" && a === "results" && !b) return json(await resultsProjects(env, viewer));
    if (method === "GET" && a === "results" && b && !c) {
      return json(await resultsSummary(env, b, viewer, url.searchParams.get("view") === "customer"));
    }
    if (method === "GET" && a === "results" && b && c === "export.csv") {
      return await resultsCsv(env, b, viewer, url.searchParams.get("view") === "customer");
    }
    if (method === "GET" && a === "results" && b && c === "floors" && d) {
      return json(await resultsFloor(env, b, d, viewer, url.searchParams.get("view") === "customer"));
    }
    if (method === "GET" && a === "results" && b && c === "plans" && d) return await resultsPlan(env, b, d);

    if (method === "GET" && a === "projects" && b && c === "access" && !d) {
      requireAdmin();
      return json(await listAccess(env, b));
    }
    if (method === "POST" && a === "projects" && b && c === "access" && !d) {
      requireAdmin();
      return json(await addAccess(env, b, await body(request), who));
    }
    if (method === "DELETE" && a === "projects" && b && c === "access" && d) {
      requireAdmin();
      return json(await removeAccess(env, b, d));
    }

    if (method === "GET" && a === "projects" && !b) return json(await listProjects(env));
    if (method === "POST" && a === "projects" && !b) {
      requireAdmin();
      return json(await createProject(env, await body(request)), 201);
    }
    if (method === "GET" && a === "projects" && b && !c) return json(await projectOverview(env, b));
    if (method === "GET" && a === "projects" && b && c === "tree") return json(await projectTree(env, b));
    if (method === "GET" && a === "projects" && b && c === "surveys") return json(await listSurveys(env, b));
    if (method === "GET" && a === "projects" && b && c === "devices.csv") return await exportDevicesCsv(env, b);
    if (method === "PUT" && a === "projects" && b && c === "settings") {
      requireAdmin();
      return json(await putSettings(env, b, await body(request)));
    }
    if (method === "POST" && a === "projects" && b && c === "inventory" && d === "import") {
      requireAdmin();
      return json(await importInventory(env, b, await body(request)));
    }

    if (method === "GET" && a === "sites" && b && !c) return json(await siteDetail(env, b));
    if (method === "GET" && a === "sites" && b && c === "inventory") return json(await siteInventory(env, b));
    if (method === "PUT" && a === "sites" && b && c === "briefing") {
      requireAdmin();
      return json(await putBriefing(env, b, await body(request)));
    }

    if (method === "GET" && a === "floors" && b && !c) return json(await floorDetail(env, b));

    if (method === "PUT" && a === "surveys" && b && !c) return json(await upsertSurvey(env, b, await body(request), who));
    if (method === "GET" && a === "devices" && b && !c) return json(await deviceDetail(env, b));
    if (method === "PUT" && a === "devices" && b && !c) return json(await upsertDevice(env, b, await body(request), who));
    if (method === "PUT" && a === "rooms" && b && !c) return json(await upsertRoom(env, b, await body(request), who));

    if (method === "PUT" && a === "photos" && b && !c) return json(await putPhoto(env, b, request, url, who));
    if (method === "GET" && a === "photos" && b && !c) return await getPhoto(env, b);
    if (method === "DELETE" && a === "photos" && b && !c) return json(await deletePhoto(env, b));

    throw new HttpError(404, "Not found.");
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    // D1 rejects CHECK and FOREIGN KEY violations at write time; those are bad
    // input, not server faults, and the client must not retry them forever.
    const message = err instanceof Error ? err.message : String(err);
    const constraint = /(CHECK|FOREIGN KEY|UNIQUE|NOT NULL) constraint failed:?\s*([^:]*)/i.exec(message);
    if (constraint) {
      const detail = constraint[2].trim();
      return json({ error: `Rejected by ${constraint[1].toUpperCase()} rule${detail ? `: ${detail}` : ""}.` }, 400);
    }
    console.error("api error", url.pathname, message);
    return json({ error: "Internal error." }, 500);
  }
}

// ---- Who is asking ---------------------------------------------------------

/**
 * Packet Fusion staff are "internal" and see everything. Anyone else is a
 * customer, limited to the projects listed for their address or domain in
 * project_access. With no Access identity (local dev) the caller is internal.
 */
export interface Viewer {
  email: string | null;
  internal: boolean;
  /** Project codes a customer may see; null for internal (all projects). */
  projects: Set<string> | null;
}

export async function resolveViewer(env: Env, user: string | null): Promise<Viewer> {
  if (!user) return { email: null, internal: true, projects: null };
  const email = user.toLowerCase();
  const domain = email.slice(email.lastIndexOf("@") + 1);
  const internalDomains = (env.INTERNAL_DOMAINS || "packetfusion.com").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (internalDomains.includes(domain) || isAdmin(env, user)) return { email, internal: true, projects: null };

  const { results } = await env.DB.prepare(
    `SELECT DISTINCT p.code FROM project_access a JOIN projects p ON p.id = a.project_id
      WHERE a.principal IN (?, ?) AND p.status != 'archived'`,
  ).bind(email, `@${domain}`).all<{ code: string }>();
  return { email, internal: false, projects: new Set(results.map(r => r.code)) };
}

// ---- Results ---------------------------------------------------------------

async function resultsProjects(env: Env, viewer: Viewer) {
  const all = await listProjects(env);
  return all
    .filter(p => viewer.internal || viewer.projects?.has(String(p.code)))
    .map(p => ({ code: p.code, name: p.name, customer_name: p.customer_name }));
}

/** Status of one list item, for the results page. */
type ItemStatus = "remaining" | "working" | "not_working" | "not_tested" | "not_found" | "done";

function statusOf(row: Json): ItemStatus {
  if (!row.device_id) return "remaining";
  if (row.discrepancy === "not_found") return "not_found";
  if (row.test_result === "working" || row.test_result === "not_working" || row.test_result === "not_tested") return row.test_result;
  return "done";
}

async function loadResults(env: Env, code: string) {
  const project = await projectByCode(env, code);
  const [sites, buildings, floors, items, extras, photos] = await env.DB.batch([
    env.DB.prepare(`SELECT id, code, name FROM sites WHERE project_id = ? ORDER BY name`).bind(project.id),
    env.DB.prepare(
      `SELECT b.id, b.site_id, b.name FROM buildings b JOIN sites s ON s.id = b.site_id
        WHERE s.project_id = ? ORDER BY b.name`,
    ).bind(project.id),
    env.DB.prepare(
      `SELECT f.id, f.building_id, f.name FROM floors f JOIN buildings b ON b.id = f.building_id
         JOIN sites s ON s.id = b.site_id WHERE s.project_id = ? ORDER BY f.name`,
    ).bind(project.id),
    // Each list item with its latest record, if any.
    env.DB.prepare(
      `SELECT i.id, i.site_id, i.building_id, i.floor_id, i.category, i.name, i.extension, i.phone_number,
              i.listed_location, d.id AS device_id, d.test_result, d.discrepancy, d.discrepancy_note,
              d.location_note, d.notes, d.updated_at, d.created_by, d.survey_id
         FROM inventory_items i
         LEFT JOIN devices d ON d.id = (
           SELECT d2.id FROM devices d2 WHERE d2.inventory_item_id = i.id AND d2.deleted_at IS NULL
            ORDER BY d2.updated_at DESC LIMIT 1)
        WHERE i.project_id = ? AND i.deleted_at IS NULL`,
    ).bind(project.id),
    // Devices found that are not on the list.
    env.DB.prepare(
      `SELECT d.id AS device_id, sv.site_id, COALESCE(d.building_id, f.building_id) AS building_id, d.floor_id,
              d.category, d.test_result, d.discrepancy, d.discrepancy_note, d.location_note, d.notes,
              d.updated_at, d.created_by, d.attributes
         FROM devices d JOIN surveys sv ON sv.id = d.survey_id LEFT JOIN floors f ON f.id = d.floor_id
        WHERE sv.project_id = ? AND sv.deleted_at IS NULL AND d.deleted_at IS NULL AND d.inventory_item_id IS NULL`,
    ).bind(project.id),
    env.DB.prepare(
      `SELECT count(*) AS n FROM photos p JOIN surveys sv ON sv.id = p.survey_id
        WHERE sv.project_id = ? AND p.deleted_at IS NULL`,
    ).bind(project.id),
  ]);
  return {
    project,
    sites: sites.results as Json[],
    buildings: buildings.results as Json[],
    floors: floors.results as Json[],
    items: items.results as Json[],
    extras: extras.results as Json[],
    photoCount: Number((photos.results as Json[])[0]?.n ?? 0),
  };
}

/**
 * Everything the results page needs, compact enough to filter in the browser.
 *
 * rows: one per list item and per device found off-list, as
 *   [siteIdx, buildingIdx, floorIdx, categoryIdx, status, flagged, onList]
 * where status is one of ItemStatus and -1 marks an unknown building/floor.
 * exceptions: the records a reader needs to act on — not working, couldn't
 * find, any discrepancy, and devices found off the list.
 *
 * The customer view leaves out who surveyed each record and engineers' notes.
 */
async function resultsSummary(env: Env, code: string, viewer: Viewer, preview: boolean) {
  const data = await loadResults(env, code);
  const customerView = !viewer.internal || preview;
  const settings = data.project.settings;
  const categories = ((Array.isArray(settings.categories) ? settings.categories : DEFAULT_CATEGORIES) as Json[])
    .map(c => ({ key: String(c.key), label: String(c.label), title: String(c.title ?? c.label) }));

  const siteIdx = new Map(data.sites.map((s, i) => [s.id, i]));
  const buildingIdx = new Map(data.buildings.map((b, i) => [b.id, i]));
  const floorIdx = new Map(data.floors.map((f, i) => [f.id, i]));
  const catIdx = new Map(categories.map((c, i) => [c.key, i]));
  const catOf = (key: unknown) => {
    const k = String(key ?? "");
    if (!catIdx.has(k)) {
      catIdx.set(k, categories.length);
      categories.push({ key: k, label: k || "Other", title: k || "Other" });
    }
    return catIdx.get(k)!;
  };
  const idx = (map: Map<unknown, number>, id: unknown) => map.get(id) ?? -1;

  const rows: Array<[number, number, number, number, ItemStatus, 0 | 1, 0 | 1]> = [];
  const exceptions: Json[] = [];
  const exception = (r: Json, status: ItemStatus, onList: boolean) => {
    const e: Json = {
      site: idx(siteIdx, r.site_id), building: idx(buildingIdx, r.building_id), floor: idx(floorIdx, r.floor_id),
      category: catOf(r.category), status, on_list: onList,
      name: r.name ?? null, extension: r.extension ?? null, phone_number: r.phone_number ?? null,
      listed_location: r.listed_location ?? null, location_note: r.location_note ?? null,
      discrepancy: r.discrepancy ?? null, discrepancy_note: r.discrepancy_note ?? null,
      updated_at: r.updated_at ?? null,
    };
    if (!customerView) Object.assign(e, { device_id: r.device_id, surveyed_by: r.created_by ?? null, notes: r.notes ?? null });
    exceptions.push(e);
  };

  for (const r of data.items) {
    const status = statusOf(r);
    const flagged = r.discrepancy && r.discrepancy !== "not_found" ? 1 : 0;
    rows.push([idx(siteIdx, r.site_id), idx(buildingIdx, r.building_id), idx(floorIdx, r.floor_id), catOf(r.category), status, flagged, 1]);
    if (status === "not_working" || status === "not_found" || flagged) exception(r, status, true);
  }
  for (const r of data.extras) {
    const status = statusOf(r);
    rows.push([idx(siteIdx, r.site_id), idx(buildingIdx, r.building_id), idx(floorIdx, r.floor_id), catOf(r.category), status, 1, 0]);
    exception(r, status, false);
  }

  return {
    project: { code: data.project.code, name: data.project.name, customer_name: data.project.customer_name, site_label: settings.site_label ?? null },
    view: customerView ? "customer" : "internal",
    can_preview: viewer.internal,
    generated_at: new Date().toISOString(),
    categories,
    sites: data.sites.map(s => ({ code: s.code, name: s.name, ...(customerView ? {} : { id: s.id }) })),
    buildings: data.buildings.map(b => ({ site: idx(siteIdx, b.site_id), name: b.name })),
    floors: data.floors.map(f => ({ id: f.id, building: idx(buildingIdx, f.building_id), name: f.name })),
    rows,
    exceptions,
    photos: data.photoCount,
  };
}

const STATUS_LABELS: Record<ItemStatus, string> = {
  remaining: "Remaining", working: "Working", not_working: "Not working",
  not_tested: "Can't test", not_found: "Couldn't find", done: "Done",
};

async function resultsCsv(env: Env, code: string, viewer: Viewer, preview: boolean) {
  const data = await loadResults(env, code);
  const customerView = !viewer.internal || preview;
  const byId = (list: Json[]) => new Map(list.map(x => [x.id, x]));
  const sites = byId(data.sites), buildings = byId(data.buildings), floors = byId(data.floors);
  const header = ["site", "building", "floor", "category", "on_list", "name", "extension", "phone_number", "listed_location",
    "status", "discrepancy", "discrepancy_note", "location_detail", "updated_at", ...(customerView ? [] : ["surveyed_by", "notes"])];
  const line = (r: Json, onList: boolean) => [
    sites.get(r.site_id)?.name, buildings.get(r.building_id)?.name, floors.get(r.floor_id)?.name, r.category,
    onList ? "yes" : "no", r.name, r.extension, r.phone_number, r.listed_location,
    STATUS_LABELS[statusOf(r)], r.discrepancy, r.discrepancy_note, r.location_note, r.updated_at,
    ...(customerView ? [] : [r.created_by, r.notes]),
  ].map(csvCell).join(",");
  const lines = [header.join(","), ...data.items.map(r => line(r, true)), ...data.extras.map(r => line(r, false))];
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${data.project.code}-results.csv"`,
      "cache-control": "no-store",
    },
  });
}

/**
 * One floor for the results page: its plan sheets and every device recorded
 * on it, with pin positions. The floor must belong to the project in the URL,
 * which is what limits a customer to their own drawings.
 */
async function resultsFloor(env: Env, code: string, floorId: string, viewer: Viewer, preview: boolean) {
  const project = await projectByCode(env, code);
  const customerView = !viewer.internal || preview;
  const floor = await env.DB.prepare(
    `SELECT f.id, f.name, b.name AS building_name, s.name AS site_name, s.id AS site_id
       FROM floors f JOIN buildings b ON b.id = f.building_id JOIN sites s ON s.id = b.site_id
      WHERE f.id = ? AND s.project_id = ?`,
  ).bind(floorId, project.id).first<Json>();
  if (!floor) throw new HttpError(404, "Floor not found in this project.");

  const [plans, devices] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, filename, wing_section FROM floor_plans
        WHERE floor_id = ? AND is_supporting_document = 0 ORDER BY filename`,
    ).bind(floorId),
    env.DB.prepare(
      `SELECT d.id AS device_id, d.floor_plan_id, d.pin_x, d.pin_y, d.category, d.test_result, d.discrepancy,
              d.discrepancy_note, d.location_note, d.notes, d.updated_at, d.created_by,
              d.inventory_item_id, i.name, i.extension, i.phone_number, i.listed_location
         FROM devices d JOIN surveys sv ON sv.id = d.survey_id
         LEFT JOIN inventory_items i ON i.id = d.inventory_item_id
        WHERE d.floor_id = ? AND d.deleted_at IS NULL AND sv.project_id = ? AND sv.deleted_at IS NULL
        ORDER BY d.updated_at`,
    ).bind(floorId, project.id),
  ]);

  return {
    floor: { id: floor.id, name: floor.name, building_name: floor.building_name, site_name: floor.site_name },
    plans: (plans.results as Json[]).map(p => ({
      id: p.id,
      label: String(p.wing_section || String(p.filename).replace(/\.pdf$/i, "")),
    })),
    records: (devices.results as Json[]).map(d => ({
      plan: d.floor_plan_id ?? null,
      x: d.pin_x ?? null,
      y: d.pin_y ?? null,
      status: statusOf(d),
      on_list: Boolean(d.inventory_item_id),
      category: d.category,
      name: d.name ?? null, extension: d.extension ?? null, phone_number: d.phone_number ?? null,
      listed_location: d.listed_location ?? null, location_note: d.location_note ?? null,
      discrepancy: d.discrepancy ?? null, discrepancy_note: d.discrepancy_note ?? null,
      updated_at: d.updated_at ?? null,
      ...(customerView ? {} : { device_id: d.device_id, site_id: floor.site_id, surveyed_by: d.created_by ?? null, notes: d.notes ?? null }),
    })),
  };
}

/** A plan's PDF, for the results page. Only plans in this project are served. */
async function resultsPlan(env: Env, code: string, planId: string) {
  const project = await projectByCode(env, code);
  const plan = await env.DB.prepare(
    `SELECT fp.r2_key FROM floor_plans fp JOIN floors f ON f.id = fp.floor_id
       JOIN buildings b ON b.id = f.building_id JOIN sites s ON s.id = b.site_id
      WHERE fp.id = ? AND s.project_id = ?`,
  ).bind(planId, project.id).first<{ r2_key: string }>();
  if (!plan) throw new HttpError(404, "Plan not found in this project.");
  // Same split as /pdfs: LACCD drawings in their own bucket, everyone else's in MEDIA.
  const bucket = plan.r2_key.includes("/plans/") ? env.MEDIA : env.PDFS;
  const object = await bucket.get(plan.r2_key);
  if (!object) throw new HttpError(404, "Plan file missing.");
  return new Response(object.body, {
    headers: {
      "content-type": "application/pdf",
      "content-length": String(object.size),
      // Authenticated drawings: never in a shared cache.
      "cache-control": "private, max-age=3600",
    },
  });
}

// ---- Customer access (admin) -----------------------------------------------

async function listAccess(env: Env, code: string) {
  const project = await projectByCode(env, code);
  const { results } = await env.DB.prepare(
    `SELECT id, principal, created_by, created_at FROM project_access WHERE project_id = ? ORDER BY principal`,
  ).bind(project.id).all();
  return results;
}

async function addAccess(env: Env, code: string, input: Json, who: string) {
  const project = await projectByCode(env, code);
  const principal = reqStr(input, "principal", 200).toLowerCase();
  // "jane@customer.edu" or "@customer.edu"
  if (!/^[^@\s]*@[a-z0-9.-]+\.[a-z]{2,}$/.test(principal)) {
    throw new HttpError(400, "Enter an email address (jane@customer.edu) or a domain starting with @ (@customer.edu).");
  }
  const internal = (env.INTERNAL_DOMAINS || "packetfusion.com").split(",").map(s => s.trim().toLowerCase());
  if (internal.includes(principal.slice(principal.indexOf("@") + 1))) {
    throw new HttpError(400, "Packet Fusion accounts already see every project; add customer addresses here.");
  }
  await env.DB.prepare(
    `INSERT INTO project_access (id, project_id, principal, created_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id, principal) DO NOTHING`,
  ).bind(crypto.randomUUID(), project.id, principal, who).run();
  return listAccess(env, code);
}

async function removeAccess(env: Env, code: string, id: string) {
  const project = await projectByCode(env, code);
  await env.DB.prepare(`DELETE FROM project_access WHERE id = ? AND project_id = ?`).bind(id, project.id).run();
  return listAccess(env, code);
}

// ---- Reads -----------------------------------------------------------------

async function listProjects(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.code, p.name, p.status, p.settings, c.name AS customer_name
       FROM projects p JOIN customers c ON c.id = p.customer_id
      WHERE p.status != 'archived'
      ORDER BY c.name, p.name`,
  ).all<Json>();
  return results.map(withSettings);
}

type Project = { id: string; code: string; name: string; customer_name: string; settings: Json };

async function projectByCode(env: Env, code: string): Promise<Project> {
  const project = await env.DB.prepare(
    `SELECT p.id, p.code, p.name, p.status, p.settings, c.name AS customer_name
       FROM projects p JOIN customers c ON c.id = p.customer_id WHERE p.code = ?`,
  ).bind(code).first<Json>();
  if (!project) throw new HttpError(404, "Project not found.");
  return withSettings(project) as unknown as Project;
}

function withSettings(row: Json): Json {
  return { ...row, settings: parseJson<Json>(row.settings, {}) };
}

/** Welcome screen + site picker: project, settings, and per-site progress. */
async function projectOverview(env: Env, code: string) {
  const project = await projectByCode(env, code);
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.code, s.name,
            (SELECT count(*) FROM inventory_items i WHERE i.site_id = s.id AND i.deleted_at IS NULL) AS item_count,
            (SELECT count(*) FROM inventory_items i WHERE i.site_id = s.id AND i.deleted_at IS NULL
                AND EXISTS (SELECT 1 FROM devices d WHERE d.inventory_item_id = i.id AND d.deleted_at IS NULL)) AS done_count,
            (SELECT count(*) FROM buildings b WHERE b.site_id = s.id) AS building_count
       FROM sites s WHERE s.project_id = ? ORDER BY s.name`,
  ).bind(project.id).all();
  return { project, sites: results };
}

/** Sites → buildings → floors for one project, with live device counts per floor. */
async function projectTree(env: Env, code: string) {
  const project = await projectByCode(env, code);

  const [sites, buildings, floors, counts] = await env.DB.batch([
    env.DB.prepare(`SELECT id, code, name FROM sites WHERE project_id = ? ORDER BY code`).bind(project.id),
    env.DB.prepare(
      `SELECT b.id, b.site_id, b.name FROM buildings b JOIN sites s ON s.id = b.site_id
        WHERE s.project_id = ? ORDER BY b.name`,
    ).bind(project.id),
    env.DB.prepare(
      `SELECT f.id, f.building_id, f.name,
              (SELECT count(*) FROM floor_plans fp WHERE fp.floor_id = f.id) AS plan_count
         FROM floors f JOIN buildings b ON b.id = f.building_id JOIN sites s ON s.id = b.site_id
        WHERE s.project_id = ? ORDER BY f.name`,
    ).bind(project.id),
    env.DB.prepare(
      `SELECT d.floor_id, count(*) AS n FROM devices d JOIN surveys sv ON sv.id = d.survey_id
        WHERE sv.project_id = ? AND d.deleted_at IS NULL AND d.floor_id IS NOT NULL
        GROUP BY d.floor_id`,
    ).bind(project.id),
  ]);

  const deviceCount = new Map((counts.results as Json[]).map(r => [r.floor_id, r.n]));
  const floorsByBuilding = groupBy(floors.results as Json[], "building_id");
  const buildingsBySite = groupBy(buildings.results as Json[], "site_id");

  return {
    project,
    sites: (sites.results as Json[]).map(s => ({
      ...s,
      buildings: (buildingsBySite.get(s.id) ?? []).map(b => ({
        id: b.id,
        name: b.name,
        floors: (floorsByBuilding.get(b.id) ?? []).map(f => ({
          id: f.id,
          name: f.name,
          plan_count: f.plan_count,
          device_count: deviceCount.get(f.id) ?? 0,
        })),
      })),
    })),
  };
}

async function listSurveys(env: Env, code: string) {
  const project = await projectByCode(env, code);
  const { results } = await env.DB.prepare(
    `SELECT sv.*, s.code AS site_code, s.name AS site_name, b.name AS building_name,
            (SELECT count(*) FROM devices d WHERE d.survey_id = sv.id AND d.deleted_at IS NULL) AS device_count
       FROM surveys sv
       JOIN sites s ON s.id = sv.site_id
       LEFT JOIN buildings b ON b.id = sv.building_id
      WHERE sv.project_id = ? AND sv.deleted_at IS NULL
      ORDER BY sv.updated_at DESC`,
  ).bind(project.id).all();
  return results;
}

/**
 * Site briefing screen: contact, parking, access hours, maps (floor plans and
 * supporting documents), buildings and floors, and progress per category.
 */
async function siteDetail(env: Env, siteId: string) {
  const site = await env.DB.prepare(
    `SELECT s.id, s.code, s.name, s.address, s.contact_name, s.contact_phone, s.contact_email,
            s.parking_info, s.access_hours, s.briefing_notes, s.wifi_ssid, s.wifi_username, s.wifi_password,
            p.code AS project_code
       FROM sites s JOIN projects p ON p.id = s.project_id WHERE s.id = ?`,
  ).bind(siteId).first();
  if (!site) throw new HttpError(404, "Site not found.");

  const [buildings, floors, maps, progress] = await env.DB.batch([
    env.DB.prepare(`SELECT id, name FROM buildings WHERE site_id = ? ORDER BY name`).bind(siteId),
    env.DB.prepare(
      `SELECT f.id, f.building_id, f.name,
              (SELECT count(*) FROM floor_plans fp WHERE fp.floor_id = f.id AND fp.is_supporting_document = 0) AS plan_count
         FROM floors f JOIN buildings b ON b.id = f.building_id WHERE b.site_id = ? ORDER BY f.name`,
    ).bind(siteId),
    // Site-wide documents (campus maps, title sheets) the engineer may want on arrival.
    env.DB.prepare(
      `SELECT fp.id, fp.r2_key, fp.filename, b.name AS building_name
         FROM floor_plans fp JOIN floors f ON f.id = fp.floor_id JOIN buildings b ON b.id = f.building_id
        WHERE b.site_id = ? AND (fp.is_supporting_document = 1 OR lower(fp.filename) LIKE '%map%')
        ORDER BY fp.filename`,
    ).bind(siteId),
    env.DB.prepare(
      `SELECT i.category, count(*) AS total,
              sum(CASE WHEN EXISTS (SELECT 1 FROM devices d WHERE d.inventory_item_id = i.id AND d.deleted_at IS NULL) THEN 1 ELSE 0 END) AS done
         FROM inventory_items i WHERE i.site_id = ? AND i.deleted_at IS NULL GROUP BY i.category`,
    ).bind(siteId),
  ]);

  const floorsByBuilding = groupBy(floors.results as Json[], "building_id");
  return {
    site,
    buildings: (buildings.results as Json[]).map(b => ({ ...b, floors: floorsByBuilding.get(b.id) ?? [] })),
    maps: maps.results,
    progress: progress.results,
  };
}

/** The site's pre-loaded list, each item marked done once a device row claims it. */
async function siteInventory(env: Env, siteId: string) {
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.category, i.name, i.extension, i.phone_number, i.device_model, i.mac_address,
            i.listed_location, i.building_id, i.floor_id, b.name AS building_name, f.name AS floor_name,
            (SELECT d.id FROM devices d WHERE d.inventory_item_id = i.id AND d.deleted_at IS NULL LIMIT 1) AS device_id,
            (SELECT d.floor_id FROM devices d WHERE d.inventory_item_id = i.id AND d.deleted_at IS NULL LIMIT 1) AS device_floor_id
       FROM inventory_items i
       LEFT JOIN buildings b ON b.id = i.building_id
       LEFT JOIN floors f ON f.id = i.floor_id
      WHERE i.site_id = ? AND i.deleted_at IS NULL
      ORDER BY b.name, i.name, i.extension`,
  ).bind(siteId).all();
  return results;
}

// ---- Setup (admin) -----------------------------------------------------

/**
 * Settings keys an admin may set, with their validators. Unknown keys are
 * rejected. Branding is deliberately not a setting: every project is
 * "Packet Fusion Site Survey" with the Packet Fusion logo.
 */
async function putSettings(env: Env, code: string, input: Json) {
  const project = await projectByCode(env, code);
  const stored = await env.DB.prepare(`SELECT settings FROM projects WHERE id = ?`).bind(project.id).first<{ settings: string }>();
  const current = parseJson<Json>(stored?.settings, {});

  const next: Json = { ...current };
  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case "subject": case "welcome_intro":
        next[key] = optStr(input, key, key === "welcome_intro" ? 2000 : 120);
        break;
      case "site_label": {
        const v = isObject(value) ? value : {};
        next.site_label = { singular: optStr(v, "singular", 40) || "Site", plural: optStr(v, "plural", 40) || "Sites" };
        break;
      }
      case "categories": {
        if (!Array.isArray(value) || value.length === 0 || value.length > 30) throw new HttpError(400, "categories must be a list of 1–30 items.");
        const seen = new Set<string>();
        next.categories = value.map(item => {
          const c = isObject(item) ? item : {};
          const label = reqStr(c, "label", 60);
          const key = slug(optStr(c, "key", 40) || label);
          if (!key || seen.has(key)) throw new HttpError(400, `Duplicate or empty category "${label}".`);
          seen.add(key);
          // label is the button ("User List"); title names the items on list and
          // form screens ("Phones"). Without a title the label is used for both.
          return { key, label, title: optStr(c, "title", 60) || label, fields: categoryFields(c.fields, label) };
        });
        break;
      }
      case "support": {
        const v = isObject(value) ? value : {};
        next.support = {
          label: optStr(v, "label", 80), phone: optStr(v, "phone", 40),
          sms: optStr(v, "sms", 40), email: optStr(v, "email", 200),
        };
        // An admin may set only some keys; keep the others as they were.
        for (const k of Object.keys(next.support as Json)) {
          if (!(k in v)) (next.support as Json)[k] = (isObject(current.support) ? current.support[k] : null) ?? null;
        }
        break;
      }
      default:
        throw new HttpError(400, `Unknown setting "${key}".`);
    }
  }

  await env.DB.prepare(`UPDATE projects SET settings = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .bind(JSON.stringify(next), project.id).run();
  return withSettings({ ...project, settings: JSON.stringify(next) });
}

/**
 * The "Packet Fusion Site Survey" template every new project starts from. Its
 * outline is the pfu-demo project: the four categories from the field
 * mockups, CableDropStatus on the user list, and Packet Fusion Support, with
 * none of that customer's sites, lists, plans or contact numbers.
 */
const BLANK_TEMPLATE = {
  subject: "voice equipment",
  categories: [
    {
      key: "phone", label: "User List", title: "Phones",
      fields: [{ key: "cable_drop_status", label: "Cable drop status", type: "select", options: ["Present", "Not Present"], required: false }],
    },
    { key: "analog", label: "Analog Stations", title: "Analog Stations", fields: [] },
    { key: "pots", label: "POTS Survey", title: "POTS Lines", fields: [] },
    { key: "emergency", label: "Emergency Phones", title: "Emergency Phones", fields: [] },
  ],
  support: { label: "Packet Fusion Support", phone: null, sms: null, email: null },
};

const PROJECT_CODE_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

/** New project from the blank template, under a new or existing customer, with optional sites. */
async function createProject(env: Env, input: Json) {
  const customerName = reqStr(input, "customer_name", 120);
  const name = reqStr(input, "name", 120);
  const code = (optStr(input, "code", 40) || customerName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!PROJECT_CODE_RE.test(code)) throw new HttpError(400, "The project code must be 2–40 letters, numbers or dashes.");
  if (await env.DB.prepare(`SELECT 1 FROM projects WHERE code = ?`).bind(code).first()) {
    throw new HttpError(409, `A project with the code "${code}" already exists. Choose another code.`);
  }

  const singular = optStr(input, "site_singular", 40) || "Site";
  const plural = optStr(input, "site_plural", 40)
    || (/[^aeiou]y$/i.test(singular) ? `${singular.slice(0, -1)}ies` : /(s|x|z|ch|sh)$/i.test(singular) ? `${singular}es` : `${singular}s`);
  const siteNames = [...new Set((Array.isArray(input.sites) ? input.sites : [])
    .map(s => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean))];
  if (siteNames.length > 200) throw new HttpError(400, "Add at most 200 sites at a time.");
  if (siteNames.some(s => s.length > 120)) throw new HttpError(400, "Site names must be 120 characters or fewer.");

  const settings = { ...structuredClone(BLANK_TEMPLATE), site_label: { singular, plural } };
  const existing = await env.DB.prepare(`SELECT id FROM customers WHERE lower(name) = lower(?)`).bind(customerName).first<{ id: string }>();
  const customerId = existing?.id ?? crypto.randomUUID();
  const projectId = crypto.randomUUID();

  await env.DB.batch([
    ...(existing ? [] : [env.DB.prepare(`INSERT INTO customers (id, name) VALUES (?, ?)`).bind(customerId, customerName)]),
    env.DB.prepare(`INSERT INTO projects (id, customer_id, code, name, status, settings) VALUES (?, ?, ?, ?, 'active', ?)`)
      .bind(projectId, customerId, code, name, JSON.stringify(settings)),
    ...siteNames.map((siteName, i) => env.DB.prepare(`INSERT INTO sites (id, project_id, code, name) VALUES (?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), projectId, `S${i + 1}`, siteName)),
  ]);
  return projectByCode(env, code);
}

async function putBriefing(env: Env, siteId: string, input: Json) {
  const result = await env.DB.prepare(
    `UPDATE sites SET contact_name = ?, contact_phone = ?, contact_email = ?, parking_info = ?,
            access_hours = ?, briefing_notes = ?, address = ?, wifi_ssid = ?, wifi_username = ?, wifi_password = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?`,
  ).bind(
    optStr(input, "contact_name", 120), optStr(input, "contact_phone", 40), optStr(input, "contact_email", 200),
    optStr(input, "parking_info", 2000), optStr(input, "access_hours", 500), optStr(input, "briefing_notes", 4000),
    optStr(input, "address", 300), optStr(input, "wifi_ssid", 120), optStr(input, "wifi_username", 120),
    optStr(input, "wifi_password", 200), siteId,
  ).run();
  if (!result.meta.changes) throw new HttpError(404, "Site not found.");
  return siteDetail(env, siteId);
}

/**
 * Load a spreadsheet's rows into inventory_items. The client parses the
 * file (CSV or Excel) and maps its columns; this resolves sites, buildings
 * and floors by name — creating buildings and floors that do not exist yet,
 * since most environments have no drawings on file — and upserts by
 * external_id, so importing the same export twice updates instead of
 * duplicating. Rows without an external id get one derived from their
 * identifying fields for the same reason.
 */
async function importInventory(env: Env, code: string, input: Json) {
  const project = await projectByCode(env, code);
  const rows = Array.isArray(input.rows) ? input.rows : null;
  if (!rows || rows.length === 0) throw new HttpError(400, "rows must be a non-empty list.");
  if (rows.length > MAX_IMPORT_ROWS) throw new HttpError(413, `Send at most ${MAX_IMPORT_ROWS} rows per request.`);

  const categories = (Array.isArray(project.settings.categories) ? project.settings.categories : DEFAULT_CATEGORIES) as Array<{ key: string; label: string; title?: string }>;
  // Spreadsheets say "Phone", "POTS line", "Emergency phone"; categories say
  // "Phones", "POTS lines", "Emergency (blue) phones". Compare without
  // brackets, punctuation, or a trailing plural "s".
  const simplify = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim().replace(/s$/, "");
  const categoryKey = (raw: unknown): string | null => {
    const s = simplify(String(raw ?? ""));
    if (!s) return null;
    // Exact match on key, button label or list title first; then a row whose
    // type starts with the key word ("Analog device" → analog, "POTS line" → pots).
    const hit = categories.find(c => [c.key, c.label, c.title ?? ""].some(v => v && simplify(v) === s))
      ?? categories.find(c => s.startsWith(`${simplify(c.key)} `));
    return hit?.key ?? null;
  };
  const defaultSite = optStr(input, "default_site_id");
  const defaultCategory = categoryKey(input.default_category);
  const batch = optStr(input, "batch", 80) ?? new Date().toISOString();

  const [sitesRes, buildingsRes, floorsRes] = await env.DB.batch([
    env.DB.prepare(`SELECT id, code, name FROM sites WHERE project_id = ?`).bind(project.id),
    env.DB.prepare(`SELECT b.id, b.site_id, b.name FROM buildings b JOIN sites s ON s.id = b.site_id WHERE s.project_id = ?`).bind(project.id),
    env.DB.prepare(
      `SELECT f.id, f.building_id, f.name FROM floors f JOIN buildings b ON b.id = f.building_id
         JOIN sites s ON s.id = b.site_id WHERE s.project_id = ?`,
    ).bind(project.id),
  ]);
  const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
  const sites = sitesRes.results as Json[];
  const buildingIds = new Map((buildingsRes.results as Json[]).map(b => [`${b.site_id}|${norm(b.name)}`, String(b.id)]));
  const floorIds = new Map((floorsRes.results as Json[]).map(f => [`${f.building_id}|${norm(f.name)}`, String(f.id)]));

  const statements: D1PreparedStatement[] = [];
  const errors: Array<{ row: number; error: string }> = [];
  let createdBuildings = 0;
  let createdFloors = 0;

  for (const [index, raw] of rows.entries()) {
    const rowNo = index + 1;
    if (!isObject(raw)) { errors.push({ row: rowNo, error: "Not an object." }); continue; }
    try {
      const siteRef = norm(raw.site);
      const site = siteRef
        ? sites.find(s => norm(s.code) === siteRef || norm(s.name) === siteRef)
        : sites.find(s => s.id === defaultSite);
      if (!site) throw new HttpError(400, siteRef ? `Unknown site "${raw.site}".` : "No site given and no default site chosen.");

      const category = categoryKey(raw.category) ?? defaultCategory;
      if (!category) throw new HttpError(400, raw.category ? `Unknown category "${raw.category}".` : "No category given and no default chosen.");

      const name = optStr(raw, "name", 200);
      const extension = optStr(raw, "extension", 40);
      const phone = optStr(raw, "phone_number", 40);
      if (!name && !extension && !phone) throw new HttpError(400, "Needs a name, extension, or number.");

      let buildingId: string | null = null;
      const buildingName = optStr(raw, "building", 200);
      if (buildingName) {
        const key = `${site.id}|${norm(buildingName)}`;
        buildingId = buildingIds.get(key) ?? null;
        if (!buildingId) {
          buildingId = crypto.randomUUID();
          buildingIds.set(key, buildingId);
          statements.push(env.DB.prepare(`INSERT INTO buildings (id, site_id, name) VALUES (?, ?, ?)`).bind(buildingId, site.id, buildingName));
          createdBuildings++;
        }
      }

      let floorId: string | null = null;
      const floorName = optStr(raw, "floor", 120);
      if (floorName && buildingId) {
        const key = `${buildingId}|${norm(floorName)}`;
        floorId = floorIds.get(key) ?? null;
        if (!floorId) {
          floorId = crypto.randomUUID();
          floorIds.set(key, floorId);
          statements.push(env.DB.prepare(`INSERT INTO floors (id, building_id, name) VALUES (?, ?, ?)`).bind(floorId, buildingId, floorName));
          createdFloors++;
        }
      }

      const externalId = optStr(raw, "external_id", 200)
        ?? `auto:${await sha1(`${site.id}|${category}|${norm(name)}|${norm(extension)}|${norm(phone)}`)}`;

      statements.push(env.DB.prepare(
        `INSERT INTO inventory_items (id, project_id, site_id, building_id, floor_id, category, name, extension, phone_number,
                                      device_model, mac_address, listed_location, external_id, import_batch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
           site_id = excluded.site_id, building_id = excluded.building_id, floor_id = excluded.floor_id,
           category = excluded.category, name = excluded.name, extension = excluded.extension,
           phone_number = excluded.phone_number, device_model = excluded.device_model,
           mac_address = excluded.mac_address, listed_location = excluded.listed_location,
           import_batch = excluded.import_batch, deleted_at = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ).bind(
        crypto.randomUUID(), project.id, site.id, buildingId, floorId, category, name, extension, phone,
        optStr(raw, "device_model", 120), normaliseMac(optStr(raw, "mac_address", 40)), optStr(raw, "listed_location", 300),
        externalId, batch,
      ));
    } catch (err) {
      errors.push({ row: rowNo, error: err instanceof Error ? err.message : String(err) });
    }
  }

  for (let i = 0; i < statements.length; i += IMPORT_BATCH_SIZE) {
    await env.DB.batch(statements.slice(i, i + IMPORT_BATCH_SIZE));
  }

  return {
    imported: rows.length - errors.length,
    skipped: errors.length,
    created_buildings: createdBuildings,
    created_floors: createdFloors,
    errors: errors.slice(0, 100),
  };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/**
 * Extra fields a category asks for (e.g. "Cable drop status" for phones).
 * Values are stored in devices.attributes under the field key, so adding a
 * field never needs a migration.
 */
function categoryFields(value: unknown, categoryLabel: string) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) throw new HttpError(400, `Fields for "${categoryLabel}" must be a list of up to 20.`);
  const seen = new Set<string>();
  return value.map(item => {
    const f = isObject(item) ? item : {};
    const label = reqStr(f, "label", 60);
    const key = slug(optStr(f, "key", 40) || label);
    if (!key || seen.has(key) || ["observed_number"].includes(key)) throw new HttpError(400, `Duplicate or reserved field "${label}".`);
    seen.add(key);
    const options = Array.isArray(f.options)
      ? f.options.map(o => String(o).trim().slice(0, 80)).filter(Boolean).slice(0, 30)
      : [];
    return { key, label, type: options.length ? "select" : "text", options, required: f.required === true };
  });
}

/** One device with its photos — the record form opens records directly. */
async function deviceDetail(env: Env, id: string) {
  const [device, photos] = await env.DB.batch([
    env.DB.prepare(
      `SELECT d.*, sv.title AS survey_title, sv.site_id, f.building_id AS floor_building_id
         FROM devices d JOIN surveys sv ON sv.id = d.survey_id LEFT JOIN floors f ON f.id = d.floor_id
        WHERE d.id = ?`,
    ).bind(id),
    env.DB.prepare(
      `SELECT id, survey_id, device_id, room_id, caption, taken_at, content_type, created_at
         FROM photos WHERE device_id = ? AND deleted_at IS NULL ORDER BY created_at`,
    ).bind(id),
  ]);
  const row = (device.results as Json[])[0];
  if (!row || row.deleted_at) throw new HttpError(404, "Record not found.");
  const { floor_building_id, ...rest } = row;
  return {
    device: { ...rest, building_id: rest.building_id ?? floor_building_id ?? null, attributes: parseJson(row.attributes, {}) },
    photos: photos.results,
  };
}

/** What a project surveys when an admin has not configured categories yet. */
const DEFAULT_CATEGORIES = [
  { key: "phone", label: "Phones" },
  { key: "analog", label: "Analog devices" },
  { key: "pots", label: "POTS lines" },
  { key: "emergency", label: "Emergency phones" },
];

async function sha1(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

function isAdmin(env: Env, user: string | null): boolean {
  // No Access identity means local dev, where everything is open anyway.
  if (!user) return true;
  const admins = (env.ADMIN_EMAILS ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  return admins.includes(user.toLowerCase());
}

/** Everything the floor screen needs in one round trip, so it is one cache entry offline. */
async function floorDetail(env: Env, floorId: string) {
  const floor = await env.DB.prepare(
    `SELECT f.id, f.name, b.id AS building_id, b.name AS building_name,
            s.id AS site_id, s.code AS site_code, s.name AS site_name, p.code AS project_code
       FROM floors f
       JOIN buildings b ON b.id = f.building_id
       JOIN sites s ON s.id = b.site_id
       JOIN projects p ON p.id = s.project_id
      WHERE f.id = ?`,
  ).bind(floorId).first();
  if (!floor) throw new HttpError(404, "Floor not found.");

  const [plans, rooms, devices, photos] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, r2_key, thumb_path, filename, is_supporting_document, wing_section, sheet_numbers, room_names_raw
         FROM floor_plans WHERE floor_id = ? ORDER BY is_supporting_document, filename`,
    ).bind(floorId),
    env.DB.prepare(
      `SELECT id, floor_id, number, name, room_type, notes, updated_at
         FROM rooms WHERE floor_id = ? AND deleted_at IS NULL ORDER BY number, name`,
    ).bind(floorId),
    env.DB.prepare(
      `SELECT d.*, sv.title AS survey_title FROM devices d JOIN surveys sv ON sv.id = d.survey_id
        WHERE d.floor_id = ? AND d.deleted_at IS NULL ORDER BY d.created_at`,
    ).bind(floorId),
    env.DB.prepare(
      `SELECT id, survey_id, device_id, room_id, caption, taken_at, content_type, created_at
         FROM photos
        WHERE deleted_at IS NULL AND device_id IN (SELECT id FROM devices WHERE floor_id = ?)
        ORDER BY created_at`,
    ).bind(floorId),
  ]);

  return {
    floor,
    plans: (plans.results as Json[]).map(p => ({
      ...p,
      sheet_numbers: parseJson(p.sheet_numbers, []),
      room_names_raw: parseJson(p.room_names_raw, []),
    })),
    rooms: rooms.results,
    devices: (devices.results as Json[]).map(d => ({ ...d, attributes: parseJson(d.attributes, {}) })),
    photos: photos.results,
  };
}

// ---- Writes ----------------------------------------------------------------

async function upsertSurvey(env: Env, id: string, input: Json, who: string) {
  requireUuid(id);
  const row = {
    project_id: reqStr(input, "project_id"),
    site_id: reqStr(input, "site_id"),
    building_id: optStr(input, "building_id"),
    title: reqStr(input, "title", 200),
    status: optEnum(input, "status", SURVEY_STATUSES) ?? "draft",
    assigned_to: optStr(input, "assigned_to", 200),
    notes: optStr(input, "notes", 4000),
    started_at: optStr(input, "started_at", 40),
    submitted_at: optStr(input, "submitted_at", 40),
    updated_at: clampTimestamp(input.updated_at),
    deleted_at: optStr(input, "deleted_at", 40),
  };

  const site = await env.DB.prepare(`SELECT project_id FROM sites WHERE id = ?`).bind(row.site_id).first<{ project_id: string }>();
  if (!site || site.project_id !== row.project_id) throw new HttpError(400, "site_id does not belong to project_id.");

  return upsertLww(env, "surveys", id, row, who);
}

async function upsertDevice(env: Env, id: string, input: Json, who: string) {
  requireUuid(id);
  const pinX = optNum(input, "pin_x");
  const pinY = optNum(input, "pin_y");
  const row = {
    survey_id: reqStr(input, "survey_id"),
    building_id: optStr(input, "building_id"),
    floor_id: optStr(input, "floor_id"),
    room_id: optStr(input, "room_id"),
    floor_plan_id: optStr(input, "floor_plan_id"),
    pin_x: pinX,
    pin_y: pinY,
    location_note: optStr(input, "location_note", 500),
    category: reqStr(input, "category", 80),
    manufacturer: optStr(input, "manufacturer", 120),
    model: optStr(input, "model", 120),
    serial_number: optStr(input, "serial_number", 120),
    mac_address: normaliseMac(optStr(input, "mac_address", 40)),
    ip_address: optStr(input, "ip_address", 64),
    asset_tag: optStr(input, "asset_tag", 120),
    mounting_type: optEnum(input, "mounting_type", MOUNTING_TYPES),
    mounting_height_ft: optNum(input, "mounting_height_ft"),
    condition: optEnum(input, "condition", CONDITIONS),
    notes: optStr(input, "notes", 4000),
    attributes: JSON.stringify(isObject(input.attributes) ? input.attributes : {}),
    inventory_item_id: optStr(input, "inventory_item_id"),
    test_result: optEnum(input, "test_result", TEST_RESULTS),
    discrepancy: optEnum(input, "discrepancy", DISCREPANCIES),
    discrepancy_note: optStr(input, "discrepancy_note", 1000),
    updated_at: clampTimestamp(input.updated_at),
    deleted_at: optStr(input, "deleted_at", 40),
  };

  const result = await upsertLww(env, "devices", id, row, who);
  return { ...result, row: result.row && { ...result.row, attributes: parseJson(result.row.attributes, {}) } };
}

async function upsertRoom(env: Env, id: string, input: Json, who: string) {
  requireUuid(id);
  const row = {
    floor_id: reqStr(input, "floor_id"),
    number: optStr(input, "number", 40),
    name: optStr(input, "name", 200),
    room_type: optStr(input, "room_type", 80),
    notes: optStr(input, "notes", 4000),
    updated_at: clampTimestamp(input.updated_at),
    deleted_at: optStr(input, "deleted_at", 40),
  };
  if (!row.number && !row.name) throw new HttpError(400, "A room needs a number or a name.");

  // Two engineers offline can each add "Room 101" under different ids. Rather
  // than fail the second sync forever, point it at the room that already
  // exists; the client rewrites its queued references via merged_into.
  if (row.number) {
    const existing = await env.DB.prepare(
      `SELECT * FROM rooms WHERE floor_id = ? AND number = ? AND id != ?`,
    ).bind(row.floor_id, row.number, id).first<Json>();
    if (existing) return { applied: false, merged_into: existing.id, row: existing };
  }

  return upsertLww(env, "rooms", id, row, who);
}

/**
 * Insert, or update only when this write is newer than the stored row.
 * created_by / created_at are set on insert and never overwritten.
 */
async function upsertLww(env: Env, table: "surveys" | "devices" | "rooms", id: string, row: Record<string, unknown>, who: string) {
  const cols = Object.keys(row);
  const sql =
    `INSERT INTO ${table} (id, created_by, ${cols.join(", ")}) VALUES (?, ?, ${cols.map(() => "?").join(", ")})
     ON CONFLICT(id) DO UPDATE SET ${cols.map(c => `${c} = excluded.${c}`).join(", ")}
     WHERE excluded.updated_at > ${table}.updated_at`;
  await env.DB.prepare(sql).bind(id, who, ...cols.map(c => row[c] ?? null)).run();

  const stored = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<Json>();
  return { applied: stored?.updated_at === row.updated_at, row: stored };
}

/**
 * Photo bytes go in the request body; ownership travels in the query string
 * (?survey=…&device=…&room=…&caption=…&taken_at=…) so the body can be the raw
 * image, which is what the device's outbox stores.
 */
async function putPhoto(env: Env, id: string, request: Request, url: URL, who: string) {
  requireUuid(id);
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim();
  const ext = PHOTO_TYPES[contentType];
  if (!ext) throw new HttpError(415, "Photos must be JPEG, PNG, or WebP.");

  const surveyId = url.searchParams.get("survey");
  if (!surveyId) throw new HttpError(400, "survey is required.");
  const survey = await env.DB.prepare(
    `SELECT p.code AS project_code FROM surveys sv JOIN projects p ON p.id = sv.project_id WHERE sv.id = ?`,
  ).bind(surveyId).first<{ project_code: string }>();
  if (!survey) throw new HttpError(400, "Survey not found.");

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) throw new HttpError(400, "Empty photo.");
  if (bytes.byteLength > MAX_PHOTO_BYTES) throw new HttpError(413, "Photo is larger than 10 MB.");

  // Keyed by project so each customer's media is separable in the bucket.
  const key = `${survey.project_code}/surveys/${surveyId}/photos/${id}.${ext}`;
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType } });

  const deviceId = url.searchParams.get("device") || null;
  const roomId = url.searchParams.get("room") || null;
  const caption = (url.searchParams.get("caption") || "").slice(0, 500) || null;
  const takenAt = url.searchParams.get("taken_at") || null;

  await env.DB.prepare(
    `INSERT INTO photos (id, survey_id, device_id, room_id, r2_key, content_type, size_bytes, caption, taken_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET r2_key = excluded.r2_key, content_type = excluded.content_type,
       size_bytes = excluded.size_bytes, caption = excluded.caption,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).bind(id, surveyId, deviceId, roomId, key, contentType, bytes.byteLength, caption, takenAt, who).run();

  return { applied: true, row: await env.DB.prepare(`SELECT * FROM photos WHERE id = ?`).bind(id).first() };
}

async function getPhoto(env: Env, id: string) {
  const photo = await env.DB.prepare(`SELECT r2_key, content_type FROM photos WHERE id = ? AND deleted_at IS NULL`)
    .bind(id).first<{ r2_key: string; content_type: string }>();
  if (!photo) throw new HttpError(404, "Photo not found.");
  const object = await env.MEDIA.get(photo.r2_key);
  if (!object) throw new HttpError(404, "Photo file missing.");
  return new Response(object.body, {
    headers: {
      "content-type": photo.content_type,
      // A photo id never points at different bytes, so it can be cached hard —
      // but privately, since it is authenticated content.
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

async function deletePhoto(env: Env, id: string) {
  await env.DB.prepare(
    `UPDATE photos SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND deleted_at IS NULL`,
  ).bind(id).run();
  // The R2 object is kept: a soft delete stays recoverable.
  return { applied: true };
}

// ---- Export ----------------------------------------------------------------

async function exportDevicesCsv(env: Env, code: string) {
  const project = await projectByCode(env, code);
  const { results } = await env.DB.prepare(
    `SELECT s.code AS site, b.name AS building, f.name AS floor, r.number AS room_number, r.name AS room_name,
            d.category, i.name AS listed_name, i.extension, i.phone_number, i.listed_location,
            d.test_result, d.discrepancy, d.discrepancy_note, d.attributes AS custom_fields, d.manufacturer, d.model, d.serial_number, d.mac_address, d.ip_address, d.asset_tag,
            d.mounting_type, d.mounting_height_ft, d.condition, d.location_note, d.pin_x, d.pin_y,
            fp.filename AS floor_plan, d.notes,
            (SELECT count(*) FROM photos ph WHERE ph.device_id = d.id AND ph.deleted_at IS NULL) AS photo_count,
            sv.title AS survey, sv.status AS survey_status, d.created_by, d.created_at, d.updated_at, d.id AS device_id
       FROM devices d
       JOIN surveys sv ON sv.id = d.survey_id
       JOIN sites s ON s.id = sv.site_id
       LEFT JOIN floors f ON f.id = d.floor_id
       LEFT JOIN buildings b ON b.id = COALESCE(f.building_id, d.building_id)
       LEFT JOIN rooms r ON r.id = d.room_id
       LEFT JOIN floor_plans fp ON fp.id = d.floor_plan_id
       LEFT JOIN inventory_items i ON i.id = d.inventory_item_id
      WHERE sv.project_id = ? AND d.deleted_at IS NULL AND sv.deleted_at IS NULL
      ORDER BY s.code, b.name, f.name, r.number, d.category`,
  ).bind(project.id).all<Json>();

  const columns = results.length ? Object.keys(results[0]) : ["site", "building", "floor", "category"];
  const lines = [columns.join(","), ...results.map(r => columns.map(c => csvCell(r[c])).join(","))];

  return new Response(lines.join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${project.code}-devices.csv"`,
      "cache-control": "no-store",
    },
  });
}

/** Quote for CSV, and neutralise leading = + - @ so Excel does not run it as a formula. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s) && typeof value !== "number") s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---- Helpers ---------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // The app keeps its own offline copy; no shared cache may hold survey data.
      "cache-control": "no-store",
    },
  });
}

async function body(request: Request): Promise<Json> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new HttpError(400, "Body must be JSON.");
  }
  if (!isObject(parsed)) throw new HttpError(400, "Body must be a JSON object.");
  return parsed;
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(id: string) {
  if (!UUID_RE.test(id)) throw new HttpError(400, "Id must be a UUID.");
}

function optStr(input: Json, key: string, max = 100): string | null {
  const v = input[key];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new HttpError(400, `${key} must be a string.`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, `${key} is longer than ${max} characters.`);
  return s || null;
}

function reqStr(input: Json, key: string, max = 100): string {
  const s = optStr(input, key, max);
  if (!s) throw new HttpError(400, `${key} is required.`);
  return s;
}

function optNum(input: Json, key: string): number | null {
  const v = input[key];
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `${key} must be a number.`);
  return n;
}

function optEnum(input: Json, key: string, allowed: string[]): string | null {
  const s = optStr(input, key, 40);
  if (s !== null && !allowed.includes(s)) throw new HttpError(400, `${key} must be one of: ${allowed.join(", ")}.`);
  return s;
}

/** Store MACs as AA:BB:CC:DD:EE:FF whatever separator the engineer typed. */
function normaliseMac(mac: string | null): string | null {
  if (!mac) return null;
  const hex = mac.replace(/[^0-9a-f]/gi, "");
  if (hex.length !== 12) return mac.toUpperCase();
  return hex.toUpperCase().match(/.{2}/g)!.join(":");
}

/**
 * The client stamps updated_at when the edit is made (possibly offline). A
 * device whose clock runs fast would otherwise win every conflict, so a
 * timestamp in the future is pulled back to now.
 */
function clampTimestamp(value: unknown): string {
  const now = Date.now();
  const t = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(t) || t > now + MAX_FUTURE_SKEW_MS) return new Date(now).toISOString();
  return new Date(Math.min(t, now)).toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function groupBy(rows: Json[], key: string): Map<unknown, Json[]> {
  const map = new Map<unknown, Json[]>();
  for (const row of rows) {
    const list = map.get(row[key]);
    if (list) list.push(row);
    else map.set(row[key], [row]);
  }
  return map;
}
