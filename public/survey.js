/**
 * PF Site Survey — field app.
 *
 * One app for any multi-building environment: a university campus, a city's
 * facilities, a company's offices. It is always "Packet Fusion Site Survey"
 * with the Packet Fusion logo; each project only names its locations
 * ("Campus", "Facility", "Office"), lists what is being surveyed, and which
 * extra fields each category asks for.
 *
 * Screens (hash routes, so the installed app can deep-link and reload):
 *   #/                                          welcome: what the app does; Results, Project setup, Start
 *   #/projects?next=start|results|setup         choose your project, then go on to that screen
 *   #/new                                       admin: new project from the blank template
 *   #/p/<code>                                  project welcome (deep links)
 *   #/p/<code>/sites                            choose your site
 *   #/p/<code>/site/<site>                      site briefing, Get Support, categories
 *   #/p/<code>/site/<site>/maps                 maps: site documents and floor plans
 *   #/p/<code>/site/<site>/f/<floor>            floor plan with recorded pins
 *   #/p/<code>/site/<site>/c/<cat>              list: search, Not started / All, sort
 *   #/p/<code>/site/<site>/c/<cat>/r/<key>      record form (key: item-<id> | dev-<id> | new)
 *   #/p/<code>/site/<site>/c/<cat>/r/<key>/pin  mark the location on the floor plan
 *   #/p/<code>/setup                            admin: branding, fields, briefings, import
 *
 * All data goes through ./js/net.js: online-first, with the device copy and
 * outbox used only when the connection is gone, and automatic resync.
 */

import {
  apiGet, apiWrite, apiDirect, patchCache, pendingItems, failedItems, discardFailed, retryFailed,
  onStatus, onSyncEvent, getStatus, startSync, ApiError,
} from './js/net.js';

const DEFAULT_CATEGORIES = [
  { key: 'phone', label: 'Phones', fields: [] },
  { key: 'analog', label: 'Analog devices', fields: [] },
  { key: 'pots', label: 'POTS lines', fields: [] },
  { key: 'emergency', label: 'Emergency phones', fields: [] },
];
const MOUNTING_TYPES = ['ceiling', 'wall', 'rack', 'desk', 'floor', 'pole', 'other'];
const CONDITIONS = ['existing', 'proposed', 'replace', 'remove'];
const TEST_RESULTS = [['working', 'Working'], ['not_working', 'Not working'], ['not_tested', "Can't test"]];
const DISCREPANCIES = [
  ['not_on_list', 'New device not on list'],
  ['wrong_location', 'Not at the listed location'],
  ['different_device', 'Different device or number than listed'],
  ['not_found', "Couldn't find it"],
  ['damaged', 'Damaged'],
  ['other', 'Something else'],
];
/** Discrepancies that are self-explanatory; the rest need a note. */
const NOTE_OPTIONAL = new Set(['not_on_list', 'not_found']);
const SORTS = [['ext', 'extension'], ['name', 'name'], ['building', 'building']];

const PDFJS_BASE = '/vendor/pdfjs-3.11.174/';
const XLSX_SRC = '/vendor/xlsx-0.20.3/xlsx.full.min.js';
/** Long edge of a rendered plan, in canvas pixels. Big enough to read room labels when zoomed. */
const PLAN_RENDER_PX = 2400;
/** Field photos are resized to this long edge before upload: ~300 KB instead of ~4 MB. */
const PHOTO_MAX_PX = 1600;
const ZOOMS = [1, 1.5, 2, 3, 4];
/** Rows per import request (the server accepts up to 2000). */
const IMPORT_CHUNK = 500;

const ICONS = {
  back: '<circle cx="12" cy="12" r="10"/><path d="M13.5 8l-4 4 4 4"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>',
  sort: '<path d="M8 4v16M8 4L4.5 7.5M8 4l3.5 3.5M16 20V4M16 20l-3.5-3.5M16 20l3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  clip: '<path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10.5 18a2 2 0 0 1-3-3L15 7.5"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14"/>',
};
const icon = name => `<svg class="sv-icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const view = document.getElementById('view');

// ---- Small helpers -----------------------------------------------------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const nowIso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const label = s => String(s ?? '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
const fmtTime = ms => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const pdfUrl = key => '/pdfs/' + String(key).split('/').map(encodeURIComponent).join('/');
const thumbUrl = path => '/' + String(path).split('/').map(encodeURIComponent).join('/');
const enc = encodeURIComponent;
const tel = n => String(n).replace(/[^\d+]/g, '');
const joinOr = list => list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')}, or ${list[list.length - 1]}`;

function options(values, selected, { blank, labels } = {}) {
  const head = blank !== undefined ? `<option value="">${esc(blank)}</option>` : '';
  return head + values.map(v => {
    const [value, text] = Array.isArray(v) ? v : [v, labels ? label(v) : v];
    return `<option value="${esc(value)}" ${String(value) === String(selected ?? '') ? 'selected' : ''}>${esc(text)}</option>`;
  }).join('');
}

/** A dropdown in the mockup style (solid chevron block on the right). */
function select(name, opts, { disabled = false, id = '' } = {}) {
  return `<span class="sv-select ${disabled ? 'is-disabled' : ''}"><select name="${esc(name)}" ${id ? `id="${esc(id)}"` : ''} ${disabled ? 'disabled' : ''}>${opts}</select></span>`;
}

function cacheNote(...results) {
  const cached = results.filter(r => r?.fromCache);
  if (!cached.length) return '';
  const oldest = Math.min(...cached.map(r => r.savedAt));
  return `<p class="sv-cache-note">Offline — showing the copy saved on this device ${esc(fmtTime(oldest))}</p>`;
}

function upsertById(list, row) {
  const i = list.findIndex(x => x.id === row.id);
  if (row.deleted_at) {
    if (i >= 0) list.splice(i, 1);
  } else if (i >= 0) {
    list[i] = { ...list[i], ...row };
  } else {
    list.push(row);
  }
}

function localGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function localSet(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } }

/** Screen app bar: leading icon, title, trailing action icons. */
function appBar({ title, lead, actions = [] }) {
  const btn = a => a.href
    ? `<a class="sv-iconbtn ${a.ring ? 'is-ring' : ''}" href="${a.href}" aria-label="${esc(a.label)}" title="${esc(a.label)}" ${a.id ? `id="${a.id}"` : ''}>${icon(a.icon)}</a>`
    : `<button class="sv-iconbtn ${a.ring ? 'is-ring' : ''}" type="button" aria-label="${esc(a.label)}" title="${esc(a.label)}" ${a.id ? `id="${a.id}"` : ''}>${icon(a.icon)}</button>`;
  return `<header class="sv-appbar">
    ${lead ? btn(lead) : ''}
    <h1 class="sv-appbar-title">${esc(title)}</h1>
    ${actions.map(btn).join('')}
  </header>`;
}

function render(html, { wide = false } = {}) {
  view.classList.toggle('is-wide', wide);
  view.innerHTML = html;
  renderStatus(getStatus());
}

function showError(err) {
  render(`<div class="sv-page"><div class="sv-body"><div class="sv-empty">${esc(err.message || err)}</div>
    <p style="text-align:center"><a class="sv-btn is-secondary" href="#/">Back to start</a></p></div></div>`);
}

function itemTitle(item) {
  const num = item.extension || item.phone_number || '';
  const name = item.name || item.building_name || '';
  return `${num} ${name}`.trim() || 'Unnamed item';
}
function itemSub(item) {
  return [
    item.listed_location && `Loc# ${item.listed_location}`,
    item.name && item.building_name,
    item.floor_name,
  ].filter(Boolean).join(' · ');
}
/** Details under an item's title (which already shows its number and name). */
function itemFull(item) {
  return [
    item.extension && item.phone_number,
    [item.building_name, item.floor_name].filter(Boolean).join(' · '),
    item.listed_location && `Loc# ${item.listed_location}`,
  ].filter(Boolean).join(' · ');
}

/** "Cable drop status" → "CableDropStatus", the field-label style of the mockups. */
const pascal = s => String(s).split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('');

/** Site name for a crowded phone app bar: the short code when the name is long. */
function siteShort(site) {
  return site.name.length > 20 && site.code && window.innerWidth < 640 ? site.code : site.name;
}

// ---- Project settings & branding ---------------------------------------

const APP_TITLE = 'Packet Fusion Site Survey';

function cfg(project) {
  const s = project?.settings ?? {};
  const support = s.support || {};
  return {
    site1: s.site_label?.singular || 'Site',
    siteN: s.site_label?.plural || 'Sites',
    subject: s.subject || 'equipment',
    // label = briefing button ("User List"); title = item name on list and
    // form screens ("Phones"), as in the field-survey mockups.
    categories: (Array.isArray(s.categories) && s.categories.length ? s.categories : DEFAULT_CATEGORIES)
      .map(x => ({ ...x, title: x.title || x.label, fields: Array.isArray(x.fields) ? x.fields : [] })),
    intro: s.welcome_intro || '',
    support: { ...support, label: support.label || 'Packet Fusion Support' },
  };
}

function category(c, key) {
  return c.categories.find(x => x.key === key) ?? { key, label: label(key), title: label(key), fields: [] };
}

/** "Emergency Phones" → "emergency phones"; acronyms such as "POTS" keep their case. */
const inSentence = s => String(s).split(/\s+/).map(w => /^[A-Z0-9]{2,}$/.test(w) ? w : w.toLowerCase()).join(' ');
/** "Phones" → "phone", "POTS Lines" → "POTS line" — for "New phone not on list". */
const singular = s => inSentence(s).replace(/(?<!s)s$/, '');

let mePromise = null;
function getMe() {
  if (!mePromise) mePromise = apiGet('/api/me').then(r => r.data).catch(() => ({ email: null, is_admin: false }));
  return mePromise;
}

// ---- Connection status -------------------------------------------------

function renderStatus(s) {
  const changes = n => `${n} change${n === 1 ? '' : 's'}`;
  let cls = '', text = 'Online';
  if (s.mode === 'auth') { cls = 'is-auth'; text = 'Signed out'; }
  else if (s.mode === 'offline') { cls = 'is-offline'; text = s.pending ? `Offline · ${s.pending}` : 'Offline'; }
  else if (s.syncing || s.pending) { cls = 'is-syncing'; text = `Syncing ${s.pending}`; }
  document.querySelectorAll('[data-status]').forEach(el => {
    el.className = `sv-status ${cls}`;
    el.textContent = text;
    el.title = text;
    el.setAttribute('aria-label', text);
  });

  const banner = document.getElementById('statusBanner');
  let html = '';
  banner.className = 'sv-banner';
  if (s.mode === 'auth') {
    banner.classList.add('is-auth');
    html = `Your sign-in has expired. ${s.pending ? `${changes(s.pending)} are saved on this device and will sync after you sign in. ` : ''}<a href="${esc(location.pathname + location.hash)}" id="reauth">Sign in again</a>`;
  } else if (s.mode === 'offline') {
    html = `You're offline. Keep working: ${s.pending ? `${changes(s.pending)} are saved on this device` : 'changes are saved on this device'} and sync automatically when the connection is back.`;
  }
  if (s.failed) {
    html += `${html ? '<br>' : ''}${changes(s.failed)} could not be saved by the server. <button type="button" id="reviewFailed">Review</button>`;
  }
  banner.innerHTML = html;
  banner.hidden = !html;
  document.getElementById('reviewFailed')?.addEventListener('click', openFailedSheet);
  // A full navigation (not fetch) is what lets Access run its login redirect.
  document.getElementById('reauth')?.addEventListener('click', e => { e.preventDefault(); location.reload(); });
}

// ---- Router ------------------------------------------------------------

let routeToken = 0;

async function route() {
  const token = ++routeToken;
  const stale = () => token !== routeToken;
  const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
  const p = path.split('/').filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(query || '');
  closeSheet();

  try {
    if (p[0] === 'projects') return await viewProjects(q.get('next'), stale);
    if (p[0] === 'new') return await viewNewProject(stale);
    if (p[0] !== 'p' || !p[1]) return await viewIntro(stale);
    const code = p[1];
    if (p[2] === 'setup') return await viewSetup(code, stale);
    if (p[2] === 'sites') return await viewSites(code, stale);
    if (p[2] === 'site' && p[3]) {
      const site = p[3];
      if (p[4] === 'maps') return await viewMaps(code, site, stale);
      if (p[4] === 'f' && p[5]) return await viewFloor(code, site, p[5], stale);
      if (p[4] === 'c' && p[5]) {
        const cat = p[5];
        if (p[6] === 'r' && p[7]) {
          const args = { code, site, cat, key: p[7], query: q };
          return p[8] === 'pin' ? await viewPin(args, stale) : await viewRecord(args, stale);
        }
        return await viewList({ code, site, cat }, stale);
      }
      return await viewBriefing(code, site, stale);
    }
    return await viewWelcome(code, stale);
  } catch (err) {
    if (!stale()) showError(err);
  }
}

// ---- Loaders -----------------------------------------------------------

async function loadProject(code) {
  return apiGet(`/api/projects/${enc(code)}`);
}

async function loadSurveys(code) {
  const res = await apiGet(`/api/projects/${enc(code)}/surveys`);
  const list = [...res.data];
  for (const item of await pendingItems()) {
    if (item.kind !== 'survey' || item.meta.projectCode !== code) continue;
    upsertById(list, { ...JSON.parse(item.body), ...item.meta.display, id: item.meta.id, _pending: true });
  }
  return { ...res, data: list };
}

/** The site's list, with items completed while offline already ticked off. */
async function loadInventory(siteId) {
  const res = await apiGet(`/api/sites/${enc(siteId)}/inventory`);
  const items = res.data.map(i => ({ ...i }));
  for (const q of await pendingItems()) {
    if (q.kind !== 'device') continue;
    const body = JSON.parse(q.body);
    if (!body.inventory_item_id) continue;
    const item = items.find(i => i.id === body.inventory_item_id);
    if (item) {
      item.device_id = body.deleted_at ? null : q.meta.id;
      item.device_floor_id = body.floor_id;
      item.discrepancy = body.discrepancy;
      item._pending = !body.deleted_at;
    }
  }
  return { ...res, data: items };
}

/** Floor detail with queued device, room and photo changes for this floor merged in. */
async function loadFloor(floorId) {
  const res = await apiGet(`/api/floors/${enc(floorId)}`);
  const data = structuredClone(res.data);
  for (const item of await pendingItems()) {
    if (item.kind === 'device') {
      const body = JSON.parse(item.body);
      const here = body.floor_id === floorId;
      const row = { ...body, id: item.meta.id, survey_title: item.meta.surveyTitle, _pending: true };
      // A queued move to another floor must also remove it from this one.
      upsertById(data.devices, here ? row : { id: item.meta.id, deleted_at: 'moved' });
    } else if (item.meta?.floorId === floorId && item.kind === 'room') {
      upsertById(data.rooms, { ...JSON.parse(item.body), id: item.meta.id, _pending: true });
    } else if (item.kind === 'photo') {
      upsertById(data.photos, { id: item.meta.id, device_id: item.meta.deviceId, _blob: item.body, _pending: true });
    }
  }
  return { ...res, data };
}

/** One record, from the server or — if it was created offline — from the outbox. */
async function loadDevice(id) {
  let device = null, photos = [];
  try {
    const res = await apiGet(`/api/devices/${enc(id)}`);
    device = res.data.device;
    photos = res.data.photos;
  } catch (err) {
    if (!(err instanceof ApiError) && !/offline/i.test(err.message)) throw err;
  }
  for (const q of await pendingItems()) {
    if (q.kind === 'device' && q.meta.id === id) device = { ...(device ?? {}), ...JSON.parse(q.body), id, _pending: true };
    if (q.kind === 'photo' && q.meta.deviceId === id) photos.push({ id: q.meta.id, device_id: id, _blob: q.body, _pending: true });
  }
  if (!device || device.deleted_at) throw new Error('This record was not found. It may have been deleted.');
  return { device, photos };
}

/**
 * Each engineer gets one open survey per site, created on first use (offline
 * too). Engineers never manage surveys by hand; they just work the list.
 */
async function ensureSurvey(code, project, site) {
  const me = await getMe();
  const key = `pfss:survey:${code}:${site.id}:${me.email}`;
  const surveys = (await loadSurveys(code)).data;
  const open = s => s.site_id === site.id && ['draft', 'in_progress'].includes(s.status);
  const survey = surveys.find(s => s.id === localGet(key) && open(s)) ?? surveys.find(s => open(s) && s.created_by === me.email);
  if (survey) {
    localSet(key, survey.id);
    return survey;
  }

  const id = uuid();
  const body = {
    project_id: project.id, site_id: site.id, building_id: null,
    title: `${site.name} — ${me.email || 'field survey'}`,
    status: 'in_progress', started_at: nowIso(), updated_at: nowIso(),
  };
  const display = { site_code: site.code, site_name: site.name, device_count: 0, created_by: me.email };
  const out = await apiWrite({
    method: 'PUT', path: `/api/surveys/${id}`, body: JSON.stringify(body), contentType: 'application/json',
    kind: 'survey', meta: { id, projectCode: code, display },
  });
  await patchCache(`/api/projects/${enc(code)}/surveys`, list => upsertById(list, { ...(out.result?.row ?? body), ...display, id }));
  localSet(key, id);
  return { ...body, ...display, id };
}

// ---- Projects ----------------------------------------------------------

/** Where each welcome button leads once a project is chosen. */
const NEXT = {
  start: { lead: 'to start surveying', href: code => `#/p/${enc(code)}/sites` },
  results: { lead: 'to view its results', href: code => `/results/${enc(code)}` },
  setup: { lead: 'to set it up', href: code => `#/p/${enc(code)}/setup` },
};

async function viewProjects(next, stale) {
  const to = NEXT[next] || NEXT.start;
  const [res, me] = await Promise.all([apiGet('/api/projects'), getMe()]);
  if (stale()) return;
  // Setup always stops here, so an admin can reach "New project".
  const canCreate = to === NEXT.setup && me.is_admin;
  if (res.data.length === 1 && !canCreate) {
    location.replace(to.href(res.data[0].code));
    return;
  }
  render(`<div class="sv-page"><div class="sv-body">
    <h1 class="sv-heading">Choose your project</h1>
    <p class="sv-hint" style="margin-bottom:14px">Pick the customer project ${esc(to.lead)}${canCreate ? ', or start a new one' : ''}.</p>
    ${cacheNote(res)}
    ${canCreate ? '<a class="sv-btn is-secondary" href="#/new" id="newProjectBtn" style="margin-bottom:14px">+ New project</a>' : ''}
    <div class="sv-stack">
      ${res.data.map(p => `<a class="sv-big-btn" href="${esc(to.href(p.code))}">${esc(p.name)}</a>`).join('')
        || '<div class="sv-empty">No active projects.</div>'}
    </div>
    <p style="margin-top:18px"><a class="sv-link" href="#/">‹ Back to welcome</a></p>
  </div></div>`);
}

// ---- Welcome (first screen) ----------------------------------------------

async function viewIntro(stale) {
  const me = await getMe();
  if (stale()) return;

  render(`<div class="sv-page"><div class="sv-body">
    <h1 class="sv-welcome-title">${esc(APP_TITLE)}</h1>
    <div class="sv-welcome-body">
      <p>Welcome. This app guides you through surveying every device at a customer's sites: confirm what's on their list, mark where each one is on the floor plan, and flag anything that doesn't match. Everything you enter goes straight to the central database, so results update as you work.</p>
      <h2>Getting started</h2>
      <ol>
        <li>Tap Start and choose your project.</li>
        <li>Choose your site and review its briefing: your site contact, parking, access hours, WiFi, and maps.</li>
        <li>Choose what you're surveying.</li>
      </ol>
      <h2>At each location</h2>
      <ol start="4">
        <li>Search by the name, extension, or number shown on the device.</li>
        <li>Mark the location on your building floor plan.</li>
        <li>Complete the required fields, then save. Completed items drop off your list.</li>
        <li>Test each device where you can, and record whether it's working.</li>
        <li>Add a photo only if something is unusual (damaged, hidden, or not where expected).</li>
        <li>If something doesn't match the list, use the discrepancy flag.</li>
      </ol>
      <h2>Results and setup</h2>
      <p><strong>Results</strong> shows live totals by site, building, and floor, floor plans with status pins, and anything flagged for attention, with a CSV download. <strong>Project setup</strong> is where an administrator imports the device list, sets the categories and site briefings, and gives the customer access to their results.</p>
      <p>No signal? Keep going. Your entries are saved on this device and sync automatically when you're back online.</p>
    </div>
    <div class="sv-welcome-foot">
      <span class="sv-actions" style="gap:16px">
        ${me.internal !== false ? '<a class="sv-link" href="#/projects?next=results">Results</a>' : ''}
        ${me.is_admin ? '<a class="sv-link" href="#/projects?next=setup">Project setup</a>' : ''}
      </span>
      <a class="sv-big-btn" href="#/projects?next=start" id="startBtn">Start</a>
    </div>
  </div></div>`);
}

// ---- Welcome -----------------------------------------------------------

async function viewWelcome(code, stale) {
  const [res, me] = await Promise.all([loadProject(code), getMe()]);
  if (stale()) return;
  const c = cfg(res.data.project);
  const site = c.site1.toLowerCase();
  const surveying = joinOr(c.categories.map(x => inSentence(x.title)));

  render(`<div class="sv-page"><div class="sv-body">
    <h1 class="sv-welcome-title">${esc(APP_TITLE)}</h1>
    ${cacheNote(res)}
    <div class="sv-welcome-body">
      <p>Welcome. ${esc(c.intro || `This app guides you through surveying ${c.subject} at your assigned ${site}.`)}</p>
      <h2>Getting started</h2>
      <ol>
        <li>Tap Start and choose your ${esc(site)}.</li>
        <li>Review the ${esc(site)} briefing: your site contact, parking, access hours, and maps.</li>
        <li>Choose what you're surveying: ${esc(surveying)}.</li>
      </ol>
      <h2>At each location</h2>
      <ol start="4">
        <li>Search by the name, extension, or number shown on the device.</li>
        <li>Mark the location on your building floor plan and enter that number in the app.</li>
        <li>Complete the required fields, then save. Completed items drop off your list.</li>
        <li>Test each device where you can, and record whether it's working.</li>
        <li>Add a photo only if something is unusual (damaged, hidden, or not where expected).</li>
        <li>If something doesn't match the list, use the discrepancy flag.</li>
      </ol>
      <p>Need help? Tap <strong>Contact ${esc(c.support.label)}</strong> on the ${esc(site)} screen to call or text the team.</p>
      <p>Your progress saves as you go.</p>
    </div>
    <div class="sv-welcome-foot">
      <span class="sv-actions" style="gap:16px">
        ${me.internal !== false ? `<a class="sv-link" href="/results/${enc(code)}">Results</a>` : ''}
        ${me.is_admin ? `<a class="sv-link" href="#/p/${enc(code)}/setup">Project setup</a>` : ''}
      </span>
      <a class="sv-big-btn" href="#/p/${enc(code)}/sites" id="startBtn">Start</a>
    </div>
  </div></div>`);
}

// ---- Choose a site -----------------------------------------------------

async function viewSites(code, stale) {
  const res = await loadProject(code);
  if (stale()) return;
  const { sites, project } = res.data;
  const c = cfg(project);

  render(`<div class="sv-page"><div class="sv-body">
    <h1 class="sv-heading">Choose your ${esc(c.site1.toLowerCase())}</h1>
    ${cacheNote(res)}
    ${sites.length > 10 ? `<div class="sv-searchbar" style="margin:0 0 12px">${icon('search')}<input id="siteSearch" type="search" placeholder="Search ${esc(c.siteN.toLowerCase())}" autocomplete="off"></div>` : ''}
    <div class="sv-stack" id="siteList">
      ${sites.map(s => `
        <a class="sv-big-btn" href="#/p/${enc(code)}/site/${enc(s.id)}" data-search="${esc(`${s.code} ${s.name}`.toLowerCase())}">
          ${esc(s.name)}${s.item_count ? `<span class="sv-count">${s.done_count}/${s.item_count}</span>` : ''}
        </a>`).join('') || `<div class="sv-empty">No ${esc(c.siteN.toLowerCase())} set up for this project yet.</div>`}
    </div>
    <p style="margin-top:18px"><a class="sv-link" href="#/">‹ Back to welcome</a></p>
  </div></div>`);

  document.getElementById('siteSearch')?.addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('#siteList .sv-big-btn').forEach(r => { r.hidden = Boolean(q) && !r.dataset.search.includes(q); });
  });
}

// ---- Site briefing -----------------------------------------------------

async function viewBriefing(code, siteId, stale) {
  const [proj, siteRes] = await Promise.all([loadProject(code), apiGet(`/api/sites/${enc(siteId)}`)]);
  if (stale()) return;
  const c = cfg(proj.data.project);
  const { site, progress } = siteRes.data;
  const counts = new Map(progress.map(r => [r.category, r]));
  const line = (k, v) => v ? `<p>${esc(k)}: ${v}</p>` : '';

  const groups = [
    [line('Site contact', esc(site.contact_name)),
      line('Phone', site.contact_phone && `<a href="tel:${esc(tel(site.contact_phone))}">${esc(site.contact_phone)}</a>`),
      line('Email', site.contact_email && `<a href="mailto:${esc(site.contact_email)}">${esc(site.contact_email)}</a>`)],
    [line('Address', esc(site.address)), line('Parking', esc(site.parking_info))],
    [line('WiFi', esc(site.wifi_ssid)), line('Username', esc(site.wifi_username)),
      site.wifi_password ? `<p>Password: <span id="wifiPw">••••••••</span><button class="sv-reveal" type="button" id="wifiReveal">Show</button></p>` : ''],
    [line('Access hours', esc(site.access_hours)), line('Notes', esc(site.briefing_notes))],
  ].map(g => g.join('')).filter(Boolean);

  render(`<div class="sv-page"><div class="sv-body">
    <p style="margin:0 0 6px"><a class="sv-link" href="#/p/${enc(code)}/sites">‹ ${esc(c.siteN)}</a></p>
    <h1 class="sv-heading is-bold">${esc(site.name)} Briefing</h1>
    ${cacheNote(proj, siteRes)}
    <div class="sv-brief">
      ${groups.join('<div class="gap"></div>') || `<p class="sv-hint">No briefing has been entered for this ${esc(c.site1.toLowerCase())} yet.</p>`}
    </div>
    <div class="sv-stack">
      <button class="sv-big-btn is-alert" type="button" id="supportBtn">Contact ${esc(c.support.label)}</button>
      <a class="sv-big-btn" href="#/p/${enc(code)}/site/${enc(site.id)}/maps">View/Download Maps</a>
      ${c.categories.map(cat => {
        const n = counts.get(cat.key);
        const left = n ? n.total - n.done : null;
        return `<a class="sv-big-btn" href="#/p/${enc(code)}/site/${enc(site.id)}/c/${enc(cat.key)}">${esc(cat.label)}${left !== null ? `<span class="sv-count">${left ? `${left} left` : 'Done'}</span>` : ''}</a>`;
      }).join('')}
    </div>
  </div></div>`);

  document.getElementById('supportBtn').addEventListener('click', () => openSupportSheet(c));
  document.getElementById('wifiReveal')?.addEventListener('click', e => {
    const pw = document.getElementById('wifiPw');
    const showing = e.target.textContent === 'Hide';
    pw.textContent = showing ? '••••••••' : site.wifi_password;
    e.target.textContent = showing ? 'Show' : 'Hide';
  });
}

function openSupportSheet(c) {
  const s = c.support;
  openSheet(`<h2 id="sheetTitle">Contact ${esc(s.label)}</h2>
    ${s.phone || s.sms || s.email ? `<div class="sv-stack" style="margin-top:12px">
      ${s.phone ? `<a class="sv-big-btn" href="tel:${esc(tel(s.phone))}">Call ${esc(s.phone)}</a>` : ''}
      ${s.sms ? `<a class="sv-big-btn" href="sms:${esc(tel(s.sms))}">Text ${esc(s.sms)}</a>` : ''}
      ${s.email ? `<a class="sv-big-btn" href="mailto:${esc(s.email)}">Email ${esc(s.email)}</a>` : ''}
    </div>` : '<p class="sv-hint">Support contacts have not been set up for this project yet. Ask your project lead.</p>'}`);
}

// ---- Maps --------------------------------------------------------------

async function viewMaps(code, siteId, stale) {
  const [proj, siteRes] = await Promise.all([loadProject(code), apiGet(`/api/sites/${enc(siteId)}`)]);
  if (stale()) return;
  const { site, buildings, maps } = siteRes.data;
  const base = `#/p/${enc(code)}/site/${enc(siteId)}`;

  render(`<div class="sv-page">
    ${appBar({ title: `${site.name} — Maps`, lead: { icon: 'back', label: 'Back', href: base, ring: true } })}
    ${cacheNote(proj, siteRes) ? `<div class="sv-body" style="padding-bottom:0">${cacheNote(proj, siteRes)}</div>` : ''}
    ${maps.length ? `<div class="sv-section" style="padding:0 16px">Site maps</div>
      <div class="sv-flatlist">${maps.map(m => `
        <a class="sv-flatrow" href="${esc(pdfUrl(m.r2_key))}" target="_blank" rel="noopener" download>
          <span class="sv-flatrow-main"><span class="sv-flatrow-title">${esc(m.filename.replace(/\.pdf$/i, ''))}</span>
          <span class="sv-flatrow-sub">${esc(m.building_name)}</span></span>${icon('download')}</a>`).join('')}</div>` : ''}
    ${buildings.map(b => `<div class="sv-section" style="padding:0 16px">${esc(b.name)}</div>
      <div class="sv-flatlist">${b.floors.map(f => `
        <a class="sv-flatrow" href="${base}/f/${enc(f.id)}">
          <span class="sv-flatrow-main"><span class="sv-flatrow-title">${esc(f.name)}</span>
          <span class="sv-flatrow-sub">${f.plan_count ? `${f.plan_count} floor plan${f.plan_count === 1 ? '' : 's'}` : 'No floor plan on file'}</span></span>${icon('chevron')}</a>`).join('')
        || '<p class="sv-hint" style="padding:8px 16px">No floors on file.</p>'}</div>`).join('')
      || '<div class="sv-empty">No buildings on file.</div>'}
  </div>`);
}

// ---- List (mockup: "Site A — Phones") ----------------------------------

const listUi = new Map();

async function viewList({ code, site: siteId, cat }, stale) {
  const [proj, siteRes, inv] = await Promise.all([loadProject(code), apiGet(`/api/sites/${enc(siteId)}`), loadInventory(siteId)]);
  if (stale()) return;
  const c = cfg(proj.data.project);
  const { site } = siteRes.data;
  const items = inv.data.filter(i => i.category === cat);
  const ui = listUi.get(`${siteId}:${cat}`) ?? { q: '', filter: 'open', sort: 0 };
  listUi.set(`${siteId}:${cat}`, ui);
  const base = `#/p/${enc(code)}/site/${enc(siteId)}/c/${enc(cat)}`;
  const doneCount = items.filter(i => i.device_id).length;

  render(`<div class="sv-page">
    ${appBar({
      title: `${siteShort(site)} — ${category(c, cat).title}`,
      lead: { icon: 'back', label: 'Back to briefing', href: `#/p/${enc(code)}/site/${enc(siteId)}`, ring: true },
      actions: [
        { icon: 'refresh', label: 'Refresh', id: 'refreshBtn' },
        { icon: 'sort', label: 'Sort', id: 'sortBtn' },
        { icon: 'plus', label: 'Add a device not on the list', href: `${base}/r/new` },
      ],
    })}
    ${cacheNote(proj, siteRes, inv) ? `<div style="padding:10px 12px 0">${cacheNote(proj, siteRes, inv)}</div>` : ''}
    <div class="sv-searchbar">${icon('search')}<input id="q" type="search" inputmode="search" placeholder="Search items" value="${esc(ui.q)}" autocomplete="off" aria-label="Search by name, extension, or number"></div>
    <div class="sv-filter" role="radiogroup" aria-label="Show">
      <label><input type="radio" name="flt" value="open" ${ui.filter === 'open' ? 'checked' : ''}> Not started</label>
      <label><input type="radio" name="flt" value="all" ${ui.filter === 'all' ? 'checked' : ''}> All</label>
    </div>
    <div class="sv-listmeta"><span id="listCount"></span><span id="sortLabel"></span></div>
    <div class="sv-flatlist" id="items"></div>
  </div>`);

  const listEl = document.getElementById('items');
  const draw = () => {
    const q = ui.q.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    const [sortKey, sortName] = SORTS[ui.sort];
    const keyOf = i => sortKey === 'ext' ? (i.extension || i.phone_number || '~')
      : sortKey === 'name' ? (i.name || '~') : `${i.building_name || '~'} ${i.floor_name || ''}`;
    const shown = items.filter(i => {
      if (ui.filter === 'open' && i.device_id) return false;
      if (!q) return true;
      const hay = `${i.name || ''} ${i.extension || ''} ${i.phone_number || ''} ${i.listed_location || ''} ${i.building_name || ''} ${i.device_model || ''}`.toLowerCase();
      // Numbers match on digits alone, so "(213) 555-0101" finds 2135550101.
      return hay.includes(q) || (digits.length >= 3 && `${i.extension || ''} ${i.phone_number || ''}`.replace(/\D/g, '').includes(digits));
    }).sort((a, b) => keyOf(a).localeCompare(keyOf(b), undefined, { numeric: true }));

    document.getElementById('listCount').textContent = `${items.length - doneCount} not started · ${doneCount} done`;
    document.getElementById('sortLabel').textContent = `Sorted by ${sortName}`;
    listEl.innerHTML = shown.slice(0, 300).map(i => `
      <a class="sv-flatrow" href="${base}/r/${i.device_id ? `dev-${enc(i.device_id)}` : `item-${enc(i.id)}`}">
        <span class="sv-flatrow-main">
          <span class="sv-flatrow-title">${esc(itemTitle(i))}</span>
          <span class="sv-flatrow-sub">${esc(itemSub(i))}</span>
        </span>
        ${i._pending ? '<span class="sv-badge is-pending">Not synced</span>' : ''}
        ${i.device_id && i.discrepancy ? '<span class="sv-badge is-flag">Flagged</span>' : ''}
        ${i.device_id ? '<span class="sv-badge is-done">Done</span>' : ''}
        ${icon('chevron')}
      </a>`).join('')
      + (shown.length > 300 ? `<p class="sv-hint" style="padding:10px 16px">Showing 300 of ${shown.length}. Search to narrow the list.</p>` : '')
      || `<div class="sv-empty">${items.length
        ? (q ? 'No match. Check the number, or tap + to record it as not on the list.' : 'Everything here is done. Switch to All to review.')
        : 'No list has been imported for this category. Tap + to record devices you find.'}</div>`;
  };
  draw();
  document.getElementById('q').addEventListener('input', e => { ui.q = e.target.value; draw(); });
  document.querySelectorAll('input[name="flt"]').forEach(r => r.addEventListener('change', e => { ui.filter = e.target.value; draw(); }));
  document.getElementById('sortBtn').addEventListener('click', () => { ui.sort = (ui.sort + 1) % SORTS.length; draw(); });
  document.getElementById('refreshBtn').addEventListener('click', () => route());
}

// ---- Record form (mockup: "Phones - Site A") ---------------------------

/** Unsaved form state, kept while the engineer hops to the plan to place a pin. */
const drafts = new Map();

const DEVICE_FIELDS = [
  'survey_id', 'building_id', 'floor_id', 'room_id', 'floor_plan_id', 'pin_x', 'pin_y', 'location_note', 'category',
  'manufacturer', 'model', 'serial_number', 'mac_address', 'ip_address', 'asset_tag', 'mounting_type',
  'mounting_height_ft', 'condition', 'notes', 'attributes', 'inventory_item_id', 'test_result',
  'discrepancy', 'discrepancy_note', 'deleted_at',
];

async function buildDraft({ key, cat, query }, inv, buildings) {
  const floorOf = id => buildings.flatMap(b => b.floors).find(f => f.id === id);
  const fresh = (extra = {}) => ({
    id: uuid(), condition: 'existing', attributes: {}, category: cat === 'all' ? '' : cat, ...extra,
  });

  if (key === 'new') {
    const floorId = query.get('floor');
    return {
      isNew: true, item: null, photos: [], newPhotos: [],
      device: fresh({
        floor_id: floorId || null,
        building_id: floorId ? floorOf(floorId)?.building_id ?? null : null,
        discrepancy: 'not_on_list',
      }),
    };
  }
  if (key.startsWith('item-')) {
    const item = inv.find(i => i.id === key.slice(5));
    if (!item) throw new Error('This item is no longer on the list.');
    if (item.device_id) return buildDraft({ key: `dev-${item.device_id}`, cat, query }, inv, buildings);
    return {
      isNew: true, item, photos: [], newPhotos: [],
      device: fresh({
        category: item.category, inventory_item_id: item.id,
        building_id: item.building_id, floor_id: item.floor_id,
        model: item.device_model ?? '', mac_address: item.mac_address ?? '',
      }),
    };
  }
  if (key.startsWith('dev-')) {
    const { device, photos } = await loadDevice(key.slice(4));
    const item = device.inventory_item_id ? inv.find(i => i.id === device.inventory_item_id) ?? null : null;
    return { isNew: false, item, photos, newPhotos: [], device: { ...device, attributes: { ...(device.attributes ?? {}) } } };
  }
  throw new Error('Unknown record.');
}

function recordUrl({ code, site, cat, key }) {
  return `#/p/${enc(code)}/site/${enc(site)}/c/${enc(cat)}/r/${enc(key)}`;
}

async function viewRecord(args, stale) {
  const { code, site: siteId, cat, key, query } = args;
  const [proj, siteRes, inv] = await Promise.all([loadProject(code), apiGet(`/api/sites/${enc(siteId)}`), loadInventory(siteId)]);
  if (stale()) return;
  const c = cfg(proj.data.project);
  const { site, buildings } = siteRes.data;
  const draftKey = `${siteId}|${cat}|${key}`;
  let draft = drafts.get(draftKey);
  if (!draft) {
    draft = await buildDraft(args, inv.data, buildings);
    draft.back = query.get('back') || `#/p/${enc(code)}/site/${enc(siteId)}/c/${enc(cat)}`;
    drafts.set(draftKey, draft);
  }
  if (stale()) return;
  const d = draft.device;
  const { item } = draft;
  const catDef = category(c, d.category || cat);
  const typeLabel = d.category ? category(c, d.category).title : cat === 'all' ? 'New record' : category(c, cat).title;
  // "New phone not on list", as in the mockup, worded for this category.
  const discOptions = DISCREPANCIES.map(([v, t]) => v === 'not_on_list' && (d.category || cat !== 'all')
    ? [v, `New ${singular(category(c, d.category || cat).title)} not on list`] : [v, t]);
  const recordTitle = `${typeLabel} - ${siteShort(site)}`;

  // Rooms and plans for the chosen floor (works offline if the floor was opened before).
  let floorData = null;
  if (d.floor_id) {
    try { floorData = (await loadFloor(d.floor_id)).data; } catch { floorData = null; }
  }
  if (stale()) return;
  const plans = floorData?.plans?.filter(p => !p.is_supporting_document) ?? [];
  const building = buildings.find(b => b.id === d.building_id);
  const floors = building?.floors ?? [];
  const pinPlan = plans.find(p => p.id === d.floor_plan_id);

  const photoSrc = p => {
    if (p._blob) return URL.createObjectURL(p._blob);
    return `/api/photos/${enc(p.id)}`;
  };
  const allPhotos = [...draft.photos.map(p => ({ src: photoSrc(p), pending: p._pending })), ...draft.newPhotos.map(p => ({ src: p.url, pending: false, isNew: true }))];

  render(`<div class="sv-page">
    ${appBar({
      title: recordTitle,
      lead: { icon: 'close', label: 'Cancel', id: 'cancelBtn' },
      actions: [{ icon: 'check', label: 'Save', id: 'saveTop' }],
    })}
    <div class="sv-body">
      ${cacheNote(proj, siteRes, inv)}
      ${item ? `<div class="sv-item-card" style="margin-bottom:16px"><strong>${esc(itemTitle(item))}</strong><span>${esc(itemFull(item))}</span></div>` : ''}
      <form class="sv-form" id="recForm" novalidate>
        ${item ? '' : `<label class="sv-field"><span class="lbl"><b class="req">*</b>Type</span>
          ${select('category', options(c.categories.map(x => [x.key, x.title]), d.category, { blank: 'Choose…' }))}</label>`}

        <label class="sv-field"><span class="lbl"><b class="req">*</b>Site</span>
          ${select('site', `<option>${esc(site.name)}</option>`, { disabled: true })}</label>

        <div class="sv-form-2col">
          <label class="sv-field"><span class="lbl"><b class="req">*</b>BuildingName</span>
            ${select('building_id', options(buildings.map(b => [b.id, b.name]), d.building_id, { blank: 'Choose…' }))}</label>
          <label class="sv-field"><span class="lbl">${floors.length ? '<b class="req">*</b>' : ''}Floor</span>
            ${select('floor_id', floors.length ? options(floors.map(f => [f.id, f.name]), d.floor_id, { blank: 'Choose…' }) : '<option value="">No floors on file</option>', { disabled: !floors.length })}</label>
        </div>

        ${plans.length ? `<div class="sv-field"><span class="lbl">FloorPlanLocation</span>
          <div class="sv-pinfield ${d.pin_x != null ? 'is-set' : ''}">
            <span>${d.pin_x != null ? `Marked${pinPlan && plans.length > 1 ? ` on ${esc(pinPlan.wing_section || pinPlan.filename.replace(/\.pdf$/i, ''))}` : ''}` : 'Not marked yet'}</span>
            <span class="sv-actions">
              ${d.pin_x != null ? '<button class="sv-btn is-small is-secondary" type="button" id="clearPin">Clear</button>' : ''}
              <a class="sv-btn is-small" href="${recordUrl(args)}/pin" id="markPin">${d.pin_x != null ? 'Move' : 'Mark on floor plan'}</a>
            </span>
          </div></div>` : ''}

        ${floorData ? `<label class="sv-field"><span class="lbl">Room</span>
          ${select('room_id', options(floorData.rooms.map(r => [r.id, [r.number, r.name].filter(Boolean).join(' · ')]), d.room_id, { blank: 'Not in a listed room' }) + '<option value="__new">+ Add a room…</option>')}</label>
        <div class="sv-inline-form" id="newRoom" hidden>
          <div class="sv-form-2col">
            <label class="sv-field"><span class="lbl">Room number</span><input name="new_room_number" maxlength="40" autocomplete="off"></label>
            <label class="sv-field"><span class="lbl">Room name</span><input name="new_room_name" maxlength="200" placeholder="e.g. IDF closet" autocomplete="off"></label>
          </div>
          <div class="sv-actions"><button class="sv-btn is-small" type="button" id="saveRoom">Add room</button></div>
        </div>` : ''}

        <label class="sv-field"><span class="lbl">LocationDetail</span>
          <input name="location_note" maxlength="500" value="${esc(d.location_note)}" placeholder="e.g. wall by east door"></label>

        <fieldset class="sv-field" style="border:0;padding:0;margin:0" id="testField">
          <span class="lbl"><b class="req">*</b>TestResult</span>
          <div class="sv-segmented" role="radiogroup">
            ${TEST_RESULTS.map(([v, t]) => `<label><input type="radio" name="test_result" value="${v}" ${d.test_result === v ? 'checked' : ''}><span>${esc(t)}</span></label>`).join('')}
          </div>
        </fieldset>

        <label class="sv-field"><span class="lbl">NumberOnDevice</span>
          <input name="observed_number" inputmode="tel" autocomplete="off" value="${esc(d.attributes?.observed_number ?? '')}" placeholder="${esc(item?.extension || item?.phone_number || 'Extension or number shown')}"></label>

        ${catDef.fields.map(f => `<label class="sv-field"><span class="lbl">${f.required ? '<b class="req">*</b>' : ''}${esc(pascal(f.label))}</span>
          ${f.options?.length
            ? select(`cf_${f.key}`, options(f.options, d.attributes?.[f.key], { blank: 'Choose…' }))
            : `<input name="cf_${esc(f.key)}" maxlength="200" value="${esc(d.attributes?.[f.key] ?? '')}">`}</label>`).join('')}

        <label class="sv-field"><span class="lbl">Discrepancy</span>
          ${select('discrepancy', options(discOptions, d.discrepancy, { blank: 'None — matches the list' }))}</label>
        <label class="sv-field" id="discNoteField"><span class="lbl">DiscrepancyNote</span>
          <input name="discrepancy_note" maxlength="1000" value="${esc(d.discrepancy_note)}"></label>

        <div class="sv-field"><span class="lbl">Attachments</span>
          <div class="sv-attach">
            ${allPhotos.length
              ? `<div class="sv-photos">${allPhotos.map(p => `<div class="sv-photo"><img src="${esc(p.src)}" alt="Attached photo">${p.pending ? '<span class="sv-badge is-pending">Not synced</span>' : p.isNew ? '<span class="sv-badge">New</span>' : ''}</div>`).join('')}</div>`
              : '<div class="sv-attach-empty">There is nothing attached.</div>'}
            <label class="sv-attach-add">${icon('clip')} Attach file<input type="file" accept="image/*" capture="environment" multiple id="photoInput"></label>
          </div>
          <span class="sv-hint">Only if something is unusual: damaged, hidden, or not where expected.</span>
        </div>

        <details class="sv-details">
          <summary>More details (optional)</summary>
          <div class="sv-form">
            <div class="sv-form-2col">
              <label class="sv-field"><span class="lbl">Condition</span>${select('condition', options(CONDITIONS, d.condition, { labels: true }))}</label>
              <label class="sv-field"><span class="lbl">Mounting</span>${select('mounting_type', options(MOUNTING_TYPES, d.mounting_type, { blank: 'Not recorded', labels: true }))}</label>
              <label class="sv-field"><span class="lbl">Mounting height (ft)</span><input name="mounting_height_ft" type="number" inputmode="decimal" step="0.5" min="0" max="200" value="${esc(d.mounting_height_ft)}"></label>
              <label class="sv-field"><span class="lbl">Manufacturer</span><input name="manufacturer" maxlength="120" value="${esc(d.manufacturer)}" autocomplete="off"></label>
              <label class="sv-field"><span class="lbl">Model</span><input name="model" maxlength="120" value="${esc(d.model)}" autocomplete="off"></label>
              <label class="sv-field"><span class="lbl">Serial number</span><input name="serial_number" maxlength="120" value="${esc(d.serial_number)}" autocomplete="off" autocapitalize="characters"></label>
              <label class="sv-field"><span class="lbl">MAC address</span><input name="mac_address" maxlength="40" value="${esc(d.mac_address)}" autocomplete="off" autocapitalize="characters" placeholder="AA:BB:CC:DD:EE:FF"></label>
              <label class="sv-field"><span class="lbl">IP address</span><input name="ip_address" maxlength="64" value="${esc(d.ip_address)}" inputmode="decimal" autocomplete="off"></label>
              <label class="sv-field"><span class="lbl">Asset tag</span><input name="asset_tag" maxlength="120" value="${esc(d.asset_tag)}" autocomplete="off"></label>
            </div>
            <label class="sv-field"><span class="lbl">Notes</span><textarea name="notes" maxlength="4000">${esc(d.notes)}</textarea></label>
          </div>
        </details>

        <div class="sv-error" id="recError" hidden></div>
        <div class="sv-actions">
          <button class="sv-btn" type="submit" id="saveBottom" style="flex:1">Save</button>
          ${draft.isNew ? '' : '<button class="sv-btn is-danger" type="button" id="deleteRec">Delete</button>'}
        </div>
      </form>
    </div>
  </div>`);

  const form = document.getElementById('recForm');
  const f = form.elements;
  const errorBox = document.getElementById('recError');
  const fail = msg => { errorBox.textContent = msg; errorBox.hidden = false; errorBox.scrollIntoView({ block: 'center', behavior: 'smooth' }); };

  // Keep the draft current with every edit, so hopping to the plan and back loses nothing.
  const capture = () => {
    if (f.category) d.category = f.category.value;
    d.location_note = f.location_note.value;
    d.test_result = form.querySelector('input[name="test_result"]:checked')?.value ?? null;
    d.discrepancy = f.discrepancy.value || null;
    d.discrepancy_note = f.discrepancy_note.value;
    if (f.room_id && f.room_id.value !== '__new') d.room_id = f.room_id.value || null;
    for (const k of ['condition', 'mounting_type', 'manufacturer', 'model', 'serial_number', 'mac_address', 'ip_address', 'asset_tag', 'notes']) d[k] = f[k].value || null;
    d.mounting_height_ft = f.mounting_height_ft.value === '' ? null : Number(f.mounting_height_ft.value);
    const attrs = { ...(d.attributes ?? {}) };
    const observed = f.observed_number.value.trim();
    if (observed) attrs.observed_number = observed; else delete attrs.observed_number;
    for (const fd of catDef.fields) {
      const v = f[`cf_${fd.key}`]?.value?.trim();
      if (v) attrs[fd.key] = v; else delete attrs[fd.key];
    }
    d.attributes = attrs;
    draft.dirty = true;
  };
  form.addEventListener('input', capture);
  form.addEventListener('change', capture);

  const syncDiscrepancy = () => {
    document.getElementById('discNoteField').hidden = !f.discrepancy.value;
    document.getElementById('testField').hidden = f.discrepancy.value === 'not_found';
  };
  f.discrepancy.addEventListener('change', syncDiscrepancy);
  syncDiscrepancy();

  // Changing type, building or floor re-renders: fields, floors and rooms depend on them.
  f.category?.addEventListener('change', () => { capture(); route(); });
  f.building_id.addEventListener('change', () => {
    capture();
    d.building_id = f.building_id.value || null;
    Object.assign(d, { floor_id: null, room_id: null, floor_plan_id: null, pin_x: null, pin_y: null });
    route();
  });
  f.floor_id.addEventListener('change', () => {
    capture();
    Object.assign(d, { floor_id: f.floor_id.value || null, room_id: null, floor_plan_id: null, pin_x: null, pin_y: null });
    route();
  });
  document.getElementById('clearPin')?.addEventListener('click', () => {
    Object.assign(d, { floor_plan_id: null, pin_x: null, pin_y: null });
    route();
  });
  document.getElementById('markPin')?.addEventListener('click', capture);

  // Inline "add room": rooms found in the field that are not on the drawings.
  const roomSel = f.room_id;
  if (roomSel) {
    let lastRoom = roomSel.value;
    roomSel.addEventListener('change', () => {
      if (roomSel.value === '__new') {
        document.getElementById('newRoom').hidden = false;
        roomSel.value = lastRoom;
        f.new_room_number.focus();
      } else {
        lastRoom = roomSel.value;
      }
    });
    document.getElementById('saveRoom').addEventListener('click', async () => {
      const number = f.new_room_number.value.trim();
      const name = f.new_room_name.value.trim();
      if (!number && !name) return fail('Enter a room number or name.');
      try {
        const room = await saveRoom(d.floor_id, { id: uuid(), number: number || null, name: name || null });
        d.room_id = room.id;
        route();
      } catch (err) {
        fail(err.message);
      }
    });
  }

  document.getElementById('photoInput').addEventListener('change', async e => {
    for (const file of e.target.files) {
      try {
        const blob = await compressImage(file);
        draft.newPhotos.push({ id: uuid(), blob, url: URL.createObjectURL(blob), takenAt: new Date(file.lastModified || Date.now()).toISOString() });
      } catch (err) {
        return fail(err.message);
      }
    }
    capture();
    route();
  });

  const leave = () => {
    draft.newPhotos.forEach(p => URL.revokeObjectURL(p.url));
    drafts.delete(draftKey);
    location.hash = draft.back;
  };
  document.getElementById('cancelBtn').addEventListener('click', () => {
    if (draft.dirty && !confirm('Discard your changes?')) return;
    leave();
  });

  const save = async () => {
    capture();
    errorBox.hidden = true;
    const notFound = d.discrepancy === 'not_found';
    if (!d.category) return fail('Choose the type.');
    if (!notFound) {
      if (buildings.length && !d.building_id) return fail('Choose the building.');
      if (floors.length && !d.floor_id) return fail('Choose the floor.');
      if (!d.test_result) return fail("Record the test result: working, not working, or can't test.");
      const missing = catDef.fields.find(fd => fd.required && !d.attributes?.[fd.key]);
      if (missing) return fail(`${missing.label} is required.`);
      if (plans.length && d.pin_x == null && !d.room_id && !d.location_note?.trim()) {
        return fail('Mark it on the floor plan, choose a room, or describe where it is.');
      }
    }
    if (d.discrepancy && !NOTE_OPTIONAL.has(d.discrepancy) && !d.discrepancy_note?.trim()) {
      return fail("Describe what doesn't match in DiscrepancyNote.");
    }
    if (notFound) Object.assign(d, { test_result: null });

    const buttons = [document.getElementById('saveTop'), document.getElementById('saveBottom')];
    buttons.forEach(b => { b.disabled = true; });
    try {
      const survey = d.survey_id ? { id: d.survey_id, title: d.survey_title } : await ensureSurvey(code, proj.data.project, site);
      d.survey_id = survey.id;
      await saveDevice({ siteId, surveyTitle: survey.title }, d);
      for (const p of draft.newPhotos) await savePhoto(d, p);
      leave();
    } catch (err) {
      fail(err.message);
      buttons.forEach(b => { b.disabled = false; });
    }
  };
  form.addEventListener('submit', e => { e.preventDefault(); save(); });
  document.getElementById('saveTop').addEventListener('click', save);

  document.getElementById('deleteRec')?.addEventListener('click', async () => {
    if (!confirm(item ? 'Delete this record? The item goes back on the list.' : 'Delete this record?')) return;
    try {
      await saveDevice({ siteId, surveyTitle: d.survey_title }, { ...d, deleted_at: nowIso() });
      leave();
    } catch (err) {
      fail(err.message);
    }
  });
}

// ---- Mark location on the floor plan -----------------------------------

const floorUi = new Map();

async function viewPin(args, stale) {
  const { code, site: siteId, cat, key } = args;
  const draft = drafts.get(`${siteId}|${cat}|${key}`);
  if (!draft?.device.floor_id) { location.replace(recordUrl(args)); return; }
  const d = draft.device;
  const [proj, floorRes] = await Promise.all([loadProject(code), loadFloor(d.floor_id)]);
  if (stale()) return;
  const { floor, devices } = floorRes.data;
  const plans = floorRes.data.plans.filter(p => !p.is_supporting_document);
  const ui = floorUi.get(floor.id) ?? { planIdx: 0, zoom: 0 };
  floorUi.set(floor.id, ui);
  const pinnedIdx = plans.findIndex(p => p.id === d.floor_plan_id);
  if (pinnedIdx >= 0 && ui.lastFor !== d.id) { ui.planIdx = pinnedIdx; ui.lastFor = d.id; }
  if (ui.planIdx >= plans.length) ui.planIdx = 0;
  const plan = plans[ui.planIdx];
  if (!plan) { location.replace(recordUrl(args)); return; }

  const others = devices.filter(x => x.id !== d.id && x.floor_plan_id === plan.id && x.pin_x != null);
  const showDraft = d.floor_plan_id === plan.id && d.pin_x != null;

  render(`<div class="sv-page">
    ${appBar({ title: 'Mark location', lead: { icon: 'close', label: 'Back to the form', href: recordUrl(args) } })}
    <div class="sv-body">
      ${cacheNote(proj, floorRes)}
      ${plans.length > 1 ? `<div class="sv-sheets">${plans.map((p, i) => `<button type="button" class="sv-btn is-small ${i === ui.planIdx ? 'is-active' : 'is-secondary'}" data-plan="${i}">${esc(p.wing_section || p.filename.replace(/\.pdf$/i, ''))}</button>`).join('')}</div>` : ''}
      <div class="sv-placing-hint">${esc(floor.building_name)} — ${esc(floor.name)}: tap the plan where it is mounted. Use + / − to zoom.</div>
      <div class="sv-plan-toolbar">
        <span class="sv-zoom">
          <button class="sv-btn is-secondary is-small" type="button" id="zoomOut" aria-label="Zoom out">−</button>
          <button class="sv-btn is-secondary is-small" type="button" id="zoomIn" aria-label="Zoom in">+</button>
        </span>
      </div>
      <div class="sv-plan-wrap" id="planWrap">
        <div class="sv-plan-stage is-placing" id="planStage" style="width:${ZOOMS[ui.zoom] * 100}%">
          <div class="sv-loading" id="planLoading">Loading floor plan…</div>
          ${others.map(x => `<span class="sv-pin is-other cond-${esc(x.condition || 'existing')}" style="left:${x.pin_x * 100}%;top:${x.pin_y * 100}%"></span>`).join('')}
          ${showDraft ? `<span class="sv-pin is-draft" style="left:${d.pin_x * 100}%;top:${d.pin_y * 100}%"></span>` : ''}
        </div>
      </div>
      <p class="sv-plan-note" id="planNote"></p>
    </div>
  </div>`, { wide: true });

  view.querySelectorAll('[data-plan]').forEach(btn => btn.addEventListener('click', () => { ui.planIdx = Number(btn.dataset.plan); route(); }));
  document.getElementById('zoomIn').addEventListener('click', () => setZoom(ui, +1));
  document.getElementById('zoomOut').addEventListener('click', () => setZoom(ui, -1));
  const stage = document.getElementById('planStage');
  stage.addEventListener('click', e => {
    const rect = stage.getBoundingClientRect();
    Object.assign(d, {
      floor_plan_id: plan.id,
      pin_x: clamp01((e.clientX - rect.left) / rect.width),
      pin_y: clamp01((e.clientY - rect.top) / rect.height),
    });
    draft.dirty = true;
    location.replace(recordUrl(args));
  });
  mountPlan(plan, stage);
}

// ---- Floor plan with recorded pins (from Maps) -------------------------

async function viewFloor(code, siteId, floorId, stale) {
  const [proj, floorRes, inv] = await Promise.all([loadProject(code), loadFloor(floorId), loadInventory(siteId)]);
  if (stale()) return;
  const c = cfg(proj.data.project);
  const { floor, devices, photos } = floorRes.data;
  const plans = floorRes.data.plans.filter(p => !p.is_supporting_document);
  const ui = floorUi.get(floorId) ?? { planIdx: 0, zoom: 0 };
  floorUi.set(floorId, ui);
  if (ui.planIdx >= plans.length) ui.planIdx = 0;
  const plan = plans[ui.planIdx] ?? null;
  const here = location.hash;
  const itemsById = new Map(inv.data.map(i => [i.id, i]));

  devices.sort((a, b) => String(a.created_at ?? '9').localeCompare(String(b.created_at ?? '9')));
  const numberOf = new Map(devices.map((x, i) => [x.id, i + 1]));
  const pinned = plan ? devices.filter(x => x.floor_plan_id === plan.id && x.pin_x != null) : [];
  const nameOf = x => {
    const i = x.inventory_item_id && itemsById.get(x.inventory_item_id);
    return i ? itemTitle(i) : `${category(c, x.category).title}${x.model ? ' · ' + x.model : ''}`;
  };
  const openUrl = x => `#/p/${enc(code)}/site/${enc(siteId)}/c/${enc(x.category || 'all')}/r/dev-${enc(x.id)}?back=${enc(here)}`;

  render(`<div class="sv-page">
    ${appBar({
      title: `${floor.building_name} — ${floor.name}`,
      lead: { icon: 'back', label: 'Back to maps', href: `#/p/${enc(code)}/site/${enc(siteId)}/maps`, ring: true },
      actions: [{ icon: 'plus', label: 'Record a device on this floor', href: `#/p/${enc(code)}/site/${enc(siteId)}/c/all/r/new?floor=${enc(floorId)}&back=${enc(here)}` }],
    })}
    <div class="sv-body">
      ${cacheNote(proj, floorRes, inv)}
      ${plans.length > 1 ? `<div class="sv-sheets">${plans.map((p, i) => `<button type="button" class="sv-btn is-small ${i === ui.planIdx ? 'is-active' : 'is-secondary'}" data-plan="${i}">${esc(p.wing_section || p.filename.replace(/\.pdf$/i, ''))}</button>`).join('')}</div>` : ''}
      ${plan ? `
        <div class="sv-plan-toolbar">
          <a class="sv-btn is-small is-outline" href="${esc(pdfUrl(plan.r2_key))}" target="_blank" rel="noopener" download>${icon('download')} Download PDF</a>
          <span class="sv-zoom">
            <button class="sv-btn is-secondary is-small" type="button" id="zoomOut" aria-label="Zoom out">−</button>
            <button class="sv-btn is-secondary is-small" type="button" id="zoomIn" aria-label="Zoom in">+</button>
          </span>
        </div>
        <div class="sv-plan-wrap" id="planWrap">
          <div class="sv-plan-stage" id="planStage" style="width:${ZOOMS[ui.zoom] * 100}%">
            <div class="sv-loading" id="planLoading">Loading floor plan…</div>
            ${pinned.map(x => `<a class="sv-pin cond-${esc(x.condition || 'existing')} ${x._pending ? 'is-pending' : ''} ${x.discrepancy ? 'is-flagged' : ''}"
              style="left:${x.pin_x * 100}%;top:${x.pin_y * 100}%" href="${openUrl(x)}" aria-label="${numberOf.get(x.id)}: ${esc(nameOf(x))}">${numberOf.get(x.id)}</a>`).join('')}
          </div>
        </div>
        <p class="sv-plan-note" id="planNote"></p>` : '<div class="sv-empty">No floor plan on file for this floor.</div>'}
    </div>
    <div class="sv-section" style="padding:0 16px">Recorded on this floor (${devices.length})</div>
    <div class="sv-flatlist">
      ${devices.map(x => `<a class="sv-flatrow" href="${openUrl(x)}">
        <span class="sv-flatrow-main"><span class="sv-flatrow-title">${numberOf.get(x.id)}. ${esc(nameOf(x))}</span>
        <span class="sv-flatrow-sub">${esc([x.test_result && TEST_RESULTS.find(t => t[0] === x.test_result)?.[1], x.location_note, photos.some(p => p.device_id === x.id) && 'photo'].filter(Boolean).join(' · ') || category(c, x.category).title)}</span></span>
        ${x._pending ? '<span class="sv-badge is-pending">Not synced</span>' : ''}${x.discrepancy ? '<span class="sv-badge is-flag">Flagged</span>' : ''}${icon('chevron')}</a>`).join('')
        || '<div class="sv-empty">Nothing recorded on this floor yet.</div>'}
    </div>
  </div>`, { wide: true });

  view.querySelectorAll('[data-plan]').forEach(btn => btn.addEventListener('click', () => { ui.planIdx = Number(btn.dataset.plan); route(); }));
  document.getElementById('zoomIn')?.addEventListener('click', () => setZoom(ui, +1));
  document.getElementById('zoomOut')?.addEventListener('click', () => setZoom(ui, -1));
  if (plan) mountPlan(plan, document.getElementById('planStage'));
}

function clamp01(n) { return Math.min(1, Math.max(0, n)); }

function setZoom(ui, step) {
  const wrap = document.getElementById('planWrap');
  const stage = document.getElementById('planStage');
  if (!wrap || !stage) return;
  // Keep the point at the centre of the view in the centre after zooming.
  const cx = (wrap.scrollLeft + wrap.clientWidth / 2) / stage.offsetWidth;
  const cy = (wrap.scrollTop + wrap.clientHeight / 2) / stage.offsetHeight;
  ui.zoom = Math.min(ZOOMS.length - 1, Math.max(0, ui.zoom + step));
  stage.style.width = `${ZOOMS[ui.zoom] * 100}%`;
  wrap.scrollLeft = cx * stage.offsetWidth - wrap.clientWidth / 2;
  wrap.scrollTop = cy * stage.offsetHeight - wrap.clientHeight / 2;
}

// ---- Plan rendering ----------------------------------------------------

function loadScript(src, globalName) {
  return new Promise((resolve, reject) => {
    if (window[globalName]) return resolve(window[globalName]);
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve(window[globalName]);
    s.onerror = () => { s.remove(); reject(new Error(`Could not load ${src}`)); };
    document.head.appendChild(s);
  });
}

let pdfjsPromise = null;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = loadScript(PDFJS_BASE + 'pdf.min.js', 'pdfjsLib').then(lib => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.js';
      return lib;
    }).catch(err => { pdfjsPromise = null; throw err; });
  }
  return pdfjsPromise;
}

/** Rendered plans, newest last. Each is a few MB of canvas, so only a handful are kept. */
const planImages = new Map();
const PLAN_CACHE_SIZE = 4;

async function planImage(plan) {
  if (planImages.has(plan.id)) return planImages.get(plan.id);
  const promise = renderPdfPlan(plan).catch(() => thumbnailPlan(plan));
  planImages.set(plan.id, promise);
  if (planImages.size > PLAN_CACHE_SIZE) planImages.delete(planImages.keys().next().value);
  return promise;
}

async function renderPdfPlan(plan) {
  const pdfjs = await loadPdfJs();
  // Whole-file fetches (no range requests) so the service worker can keep the
  // plan for offline use; range responses (206) are not cacheable.
  const doc = await pdfjs.getDocument({ url: pdfUrl(plan.r2_key), disableRange: true, disableStream: true }).promise;
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const scale = PLAN_RENDER_PX / Math.max(base.width, base.height);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  doc.destroy();
  return { el: canvas, note: '' };
}

function thumbnailPlan(plan) {
  return new Promise((resolve, reject) => {
    if (!plan.thumb_path) return reject(new Error('No preview'));
    const img = new Image();
    img.className = 'sv-plan-img';
    img.alt = `Floor plan preview: ${plan.filename}`;
    img.onload = () => resolve({ el: img, note: 'Showing the low-resolution preview — the full drawing could not be loaded.' });
    img.onerror = () => reject(new Error('No preview'));
    img.src = thumbUrl(plan.thumb_path);
  });
}

async function mountPlan(plan, stage) {
  const loading = document.getElementById('planLoading');
  try {
    const { el, note } = await planImage(plan);
    if (!stage.isConnected) return;
    // A canvas can only live in one place; re-renders re-mount the same one.
    stage.prepend(el);
    loading?.remove();
    const noteEl = document.getElementById('planNote');
    if (noteEl) noteEl.textContent = note;
  } catch {
    planImages.delete(plan.id);
    if (loading) loading.textContent = 'This floor plan is not available offline yet. Open it once while connected to keep a copy.';
  }
}

// ---- Writes ------------------------------------------------------------

async function saveDevice({ siteId, surveyTitle }, device) {
  const body = Object.fromEntries(DEVICE_FIELDS.map(k => [k, device[k] ?? null]));
  body.attributes = device.attributes ?? {};
  body.updated_at = nowIso();
  const out = await apiWrite({
    method: 'PUT', path: `/api/devices/${device.id}`, body: JSON.stringify(body), contentType: 'application/json',
    kind: 'device', meta: { id: device.id, floorId: device.floor_id, surveyTitle },
  });
  // Keep the device copies current, so they are right if we go offline next.
  const row = { ...(out.result?.row ?? body), id: device.id, survey_title: surveyTitle };
  if (device.floor_id) await patchCache(`/api/floors/${enc(device.floor_id)}`, data => upsertById(data.devices, row));
  await patchCache(`/api/devices/${enc(device.id)}`, data => { data.device = { ...data.device, ...row }; });
  if (body.inventory_item_id) {
    await patchCache(`/api/sites/${enc(siteId)}/inventory`, list => {
      const i = list.find(x => x.id === body.inventory_item_id);
      if (i) Object.assign(i, { device_id: body.deleted_at ? null : device.id, device_floor_id: body.floor_id, discrepancy: body.discrepancy });
    });
  }
  return out;
}

async function saveRoom(floorId, room) {
  const body = { floor_id: floorId, number: room.number, name: room.name, updated_at: nowIso() };
  const out = await apiWrite({
    method: 'PUT', path: `/api/rooms/${room.id}`, body: JSON.stringify(body), contentType: 'application/json',
    kind: 'room', meta: { id: room.id, floorId },
  });
  // Online, the server may answer with an existing room of the same number.
  const saved = out.result?.row ? { ...out.result.row } : { ...body, id: room.id };
  await patchCache(`/api/floors/${enc(floorId)}`, data => upsertById(data.rooms, saved));
  return saved;
}

async function savePhoto(device, photo) {
  const q = new URLSearchParams({ survey: device.survey_id, device: device.id, taken_at: photo.takenAt });
  const out = await apiWrite({
    method: 'PUT', path: `/api/photos/${photo.id}?${q}`, body: photo.blob, contentType: photo.blob.type,
    kind: 'photo', meta: { id: photo.id, deviceId: device.id, floorId: device.floor_id },
  });
  if (!out.queued && out.result?.row) {
    if (device.floor_id) await patchCache(`/api/floors/${enc(device.floor_id)}`, data => upsertById(data.photos, out.result.row));
    await patchCache(`/api/devices/${enc(device.id)}`, data => upsertById(data.photos, out.result.row));
  }
}

async function compressImage(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, PHOTO_MAX_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (blob) return blob;
  } catch {
    // Fall through: some formats (HEIC in non-Safari browsers) cannot be decoded here.
  }
  if (['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return file;
  throw new Error('This photo format is not supported. Take the photo with the camera, or export it as JPEG.');
}

// ---- Sheets ------------------------------------------------------------

const overlay = document.getElementById('sheetOverlay');
const sheet = document.getElementById('sheetContent');

function openSheet(html) {
  sheet.innerHTML = html;
  overlay.hidden = false;
}
function closeSheet() {
  overlay.hidden = true;
  sheet.innerHTML = '';
}
document.getElementById('sheetClose').addEventListener('click', closeSheet);
overlay.addEventListener('click', e => { if (e.target === overlay) closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !overlay.hidden) closeSheet(); });

async function openFailedSheet() {
  const items = await failedItems();
  openSheet(`
    <h2 id="sheetTitle">Changes the server rejected</h2>
    <p class="sv-hint">These were saved on this device but the server refused them, usually because a required detail was missing or invalid. Retry after fixing the cause, or discard them.</p>
    <div class="sv-stack" style="margin-top:12px">
      ${items.map(it => `
        <div class="sv-item-card">
          <strong>${esc(label(it.kind))}</strong>
          <span>${esc(it.error)} (HTTP ${esc(it.status)}) · ${esc(fmtTime(it.failedAt))}</span>
          <div class="sv-actions" style="margin-top:8px">
            <button class="sv-btn is-small is-secondary" type="button" data-retry="${it.seq}">Retry</button>
            <button class="sv-btn is-small is-danger" type="button" data-discard="${it.seq}">Discard</button>
          </div>
        </div>`).join('') || '<div class="sv-empty">Nothing to review.</div>'}
    </div>`);
  sheet.querySelectorAll('[data-retry]').forEach(b => b.addEventListener('click', async () => { await retryFailed(Number(b.dataset.retry)); openFailedSheet(); }));
  sheet.querySelectorAll('[data-discard]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Discard this change? It will be lost.')) return;
    await discardFailed(Number(b.dataset.discard));
    openFailedSheet();
  }));
}

// ---- Setup (admins) ----------------------------------------------------

/** Spreadsheet columns the importer understands, with header words that suggest them. */
const IMPORT_FIELDS = [
  { key: 'name', label: 'Name', hints: ['name', 'display name', 'user', 'description', 'label', 'assigned to'] },
  { key: 'extension', label: 'Extension', hints: ['extension', 'ext', 'ext.'] },
  { key: 'phone_number', label: 'Phone number', hints: ['phone number', 'number', 'did', 'direct number', 'phone', 'line', 'tn'] },
  { key: 'category', label: 'Category / type', hints: ['category', 'type', 'device type', 'line type'] },
  { key: 'site', label: 'Site', hints: ['site', 'campus', 'facility', 'office', 'branch', 'location code'] },
  { key: 'building', label: 'Building', hints: ['building', 'bldg'] },
  { key: 'floor', label: 'Floor', hints: ['floor', 'level'] },
  { key: 'listed_location', label: 'Location / room', hints: ['location', 'loc#', 'loc', 'room', 'desk', 'area'] },
  { key: 'device_model', label: 'Device model', hints: ['model', 'device model', 'device'] },
  { key: 'mac_address', label: 'MAC address', hints: ['mac', 'mac address'] },
  { key: 'external_id', label: 'Unique ID', hints: ['id', 'external id', 'asset id', 'unique id'] },
];

function guessMapping(headers) {
  const used = new Set();
  const norm = h => String(h).trim().toLowerCase().replace(/[_\s]+/g, ' ');
  const mapping = {};
  // Exact header matches first, then headers that contain a hint word.
  for (const pass of ['exact', 'contains']) {
    for (const field of IMPORT_FIELDS) {
      if (mapping[field.key] !== undefined) continue;
      const idx = headers.findIndex((h, i) => !used.has(i) && field.hints.some(hint =>
        pass === 'exact' ? norm(h) === hint : norm(h).includes(hint)));
      if (idx >= 0) { mapping[field.key] = idx; used.add(idx); }
    }
  }
  return mapping;
}

/** RFC 4180-ish CSV: quoted fields, doubled quotes, commas and newlines inside quotes, BOM. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => String(cell).trim()));
}

async function readSpreadsheet(file) {
  if (/\.(xlsx|xls|xlsm)$/i.test(file.name)) {
    const XLSX = await loadScript(XLSX_SRC, 'XLSX');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }).filter(r => r.some(cell => String(cell).trim()));
  }
  return parseCsv(await file.text());
}

/** "Cable drop status: Present, Not present *" ⇄ { label, options, required } */
function fieldsToText(fields) {
  return fields.map(f => `${f.label}${f.options?.length ? `: ${f.options.join(', ')}` : ''}${f.required ? ' *' : ''}`).join('\n');
}
function textToFields(text, existing) {
  return text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const required = /\*\s*$/.test(l);
    const [lbl, opts] = l.replace(/\s*\*\s*$/, '').split(/:(.*)/s);
    const prior = existing.find(f => f.label.toLowerCase() === lbl.trim().toLowerCase());
    return {
      key: prior?.key, label: lbl.trim(), required,
      options: opts ? opts.split(',').map(o => o.trim()).filter(Boolean) : [],
    };
  });
}

/** Project codes go in links (/results/<code>), so keep them short and plain. */
const projectCode = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
/** Campus → Campuses, Facility → Facilities, Site → Sites. */
const plural = s => (/[^aeiou]y$/i.test(s) ? `${s.slice(0, -1)}ies` : /(s|x|z|ch|sh)$/i.test(s) ? `${s}es` : `${s}s`);

async function viewNewProject(stale) {
  const me = await getMe();
  if (stale()) return;
  if (!me.is_admin) throw new Error('Only project administrators can create projects.');

  render(`<div class="sv-page">
    ${appBar({ title: 'New project', lead: { icon: 'back', label: 'Back', href: '#/projects?next=setup', ring: true } })}
    <div class="sv-body">
    <form class="sv-form" id="newProjectForm">
      <div class="sv-section">Customer and project</div>
      <div class="sv-form-2col">
        <label class="sv-field"><span class="lbl">Customer name *</span><input name="customer_name" maxlength="120" required placeholder="City of Springfield"></label>
        <label class="sv-field"><span class="lbl">Project name *</span><input name="name" maxlength="120" required placeholder="Phone system survey"></label>
      </div>
      <label class="sv-field"><span class="lbl">Project code (used in links such as /results/<i>code</i>)</span><input name="code" maxlength="40" required pattern="[a-z0-9][a-z0-9\\-]{1,39}" placeholder="city-of-springfield" autocapitalize="none"></label>

      <div class="sv-section">Template</div>
      <div class="sv-inline-form">
        <strong>Packet Fusion Site Survey</strong>
        <p class="sv-hint">The standard setup every new project starts from. Change any of it in Project setup afterwards.</p>
        <ul class="sv-hint" style="margin:6px 0 0;padding-left:20px;line-height:1.7">
          <li>Categories: User List (items called Phones), Analog Stations, POTS Survey, Emergency Phones</li>
          <li>User List asks for Cable drop status: Present / Not Present</li>
          <li>Support button: Contact Packet Fusion Support (add the numbers in setup)</li>
        </ul>
      </div>

      <div class="sv-section">Locations</div>
      <div class="sv-form-2col">
        <label class="sv-field"><span class="lbl">A location is called</span><input name="site_singular" maxlength="40" value="Site" placeholder="Campus, Facility, Office…"></label>
        <label class="sv-field"><span class="lbl">…and in plural</span><input name="site_plural" maxlength="40" value="Sites"></label>
      </div>
      <label class="sv-field"><span class="lbl">Sites, one per line (optional; buildings and floors come from the device list import)</span>
        <textarea name="sites" rows="5" placeholder="Site 1 - City Hall&#10;Site 2 - Public Works Yard"></textarea></label>

      <button class="sv-btn" type="submit">Create project</button>
      <div id="newProjectMsg" hidden></div>
    </form>
    </div>
  </div>`);

  const form = document.getElementById('newProjectForm');
  const f = form.elements;
  // The code follows the customer name until someone edits it by hand.
  let codeTouched = false;
  f.code.addEventListener('input', () => { codeTouched = true; });
  f.customer_name.addEventListener('input', () => { if (!codeTouched) f.code.value = projectCode(f.customer_name.value); });
  f.site_singular.addEventListener('input', () => { f.site_plural.value = f.site_singular.value.trim() ? plural(f.site_singular.value.trim()) : ''; });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const out = document.getElementById('newProjectMsg');
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const project = await apiDirect('POST', '/api/projects', JSON.stringify({
        customer_name: f.customer_name.value, name: f.name.value, code: f.code.value,
        site_singular: f.site_singular.value, site_plural: f.site_plural.value,
        sites: f.sites.value.split('\n'),
      }), 'application/json');
      location.hash = `#/p/${enc(project.code)}/setup`;
    } catch (err) {
      out.className = 'sv-error';
      out.textContent = err.message;
      out.hidden = false;
      btn.disabled = false;
    }
  });
}

async function viewSetup(code, stale) {
  const [res, me] = await Promise.all([loadProject(code), getMe()]);
  if (stale()) return;
  if (!me.is_admin) throw new Error('Project setup is only available to project administrators.');
  const { project, sites } = res.data;
  const c = cfg(project);
  const s = project.settings;
  const catBlock = (cat, i) => `<div class="sv-inline-form" data-cat="${i}">
    <input type="hidden" name="cat_key" value="${esc(cat.key ?? '')}">
    <div class="sv-form-2col">
      <label class="sv-field"><span class="lbl">Briefing button</span><input name="cat_label" maxlength="60" value="${esc(cat.label ?? '')}" placeholder="User List"></label>
      <label class="sv-field"><span class="lbl">Item name on list and form screens</span><input name="cat_title" maxlength="60" value="${esc(cat.title && cat.title !== cat.label ? cat.title : '')}" placeholder="Phones (blank = same as button)"></label>
    </div>
    <label class="sv-field"><span class="lbl">Extra fields — one per line. "Name: option, option" makes a dropdown; end with * to require it.</span>
      <textarea name="cat_fields" rows="3" placeholder="Cable drop status: Present, Not present">${esc(fieldsToText(cat.fields ?? []))}</textarea></label>
    <div class="sv-actions"><button class="sv-btn is-small is-danger" type="button" data-remove-cat>Remove category</button></div>
  </div>`;

  render(`<div class="sv-page">
    ${appBar({ title: 'Project setup', lead: { icon: 'back', label: 'Back', href: '#/', ring: true } })}
    <div class="sv-body">
    <p class="sv-hint" style="margin-bottom:12px">${esc(project.customer_name)} · ${esc(project.name)}</p>

    <div class="sv-section">Branding and wording</div>
    <form class="sv-form" id="settingsForm">
      <div class="sv-form-2col">
        <label class="sv-field"><span class="lbl">A location is called</span><input name="site1" maxlength="40" value="${esc(c.site1)}" placeholder="Campus, Facility, Office…"></label>
        <label class="sv-field"><span class="lbl">…and in plural</span><input name="siteN" maxlength="40" value="${esc(c.siteN)}"></label>
      </div>
      <label class="sv-field"><span class="lbl">What's being surveyed (welcome text)</span><input name="subject" maxlength="120" value="${esc(c.subject)}" placeholder="voice equipment"></label>
      <label class="sv-field"><span class="lbl">Welcome text (optional — replaces the first sentence)</span><textarea name="welcome_intro" rows="2" maxlength="2000">${esc(s.welcome_intro || '')}</textarea></label>
      <div class="sv-section">Survey categories</div>
      <div class="sv-stack" id="catList">${c.categories.map(catBlock).join('')}</div>
      <button class="sv-btn is-secondary" type="button" id="addCat">+ Add category</button>
      <div class="sv-section">Support</div>
      <div class="sv-form-2col">
        <label class="sv-field"><span class="lbl">Support team name (button reads "Contact …")</span><input name="support_label" maxlength="80" value="${esc(c.support.label)}"></label>
        <label class="sv-field"><span class="lbl">Phone (Call)</span><input name="support_phone" type="tel" maxlength="40" value="${esc(c.support.phone || '')}"></label>
        <label class="sv-field"><span class="lbl">Mobile (Text)</span><input name="support_sms" type="tel" maxlength="40" value="${esc(c.support.sms || '')}"></label>
        <label class="sv-field"><span class="lbl">Email</span><input name="support_email" type="email" maxlength="200" value="${esc(c.support.email || '')}"></label>
      </div>
      <button class="sv-btn" type="submit">Save settings</button>
      <div id="settingsMsg" hidden></div>
    </form>

    <div class="sv-section">${esc(c.site1)} briefings</div>
    <form class="sv-form" id="briefForm">
      <label class="sv-field"><span class="lbl">${esc(c.site1)}</span>${select('site_id', options(sites.map(x => [x.id, x.name]), '', { blank: 'Choose…' }))}</label>
      <div id="briefFields" hidden class="sv-form">
        <div class="sv-form-2col">
          <label class="sv-field"><span class="lbl">Site contact</span><input name="contact_name" maxlength="120"></label>
          <label class="sv-field"><span class="lbl">Phone</span><input name="contact_phone" type="tel" maxlength="40"></label>
          <label class="sv-field"><span class="lbl">Email</span><input name="contact_email" type="email" maxlength="200"></label>
          <label class="sv-field"><span class="lbl">Address</span><input name="address" maxlength="300"></label>
          <label class="sv-field"><span class="lbl">WiFi network</span><input name="wifi_ssid" maxlength="120"></label>
          <label class="sv-field"><span class="lbl">WiFi username</span><input name="wifi_username" maxlength="120" autocomplete="off"></label>
          <label class="sv-field"><span class="lbl">WiFi password</span><input name="wifi_password" maxlength="200" autocomplete="off"></label>
          <label class="sv-field"><span class="lbl">Access hours</span><input name="access_hours" maxlength="500"></label>
        </div>
        <label class="sv-field"><span class="lbl">Parking</span><textarea name="parking_info" rows="2" maxlength="2000"></textarea></label>
        <label class="sv-field"><span class="lbl">Other notes</span><textarea name="briefing_notes" rows="3" maxlength="4000"></textarea></label>
        <p class="sv-hint">Everyone working this project sees the briefing, including the WiFi password, and it is stored on their devices for offline use.</p>
        <button class="sv-btn" type="submit">Save briefing</button>
      </div>
      <div id="briefMsg" hidden></div>
    </form>

    <div class="sv-section">Import a device list</div>
    <div class="sv-form" id="importCard">
      <p class="sv-hint">Upload a CSV or Excel export (Zoom Phone admin, a PBX, or an asset list). One row per phone, line or device. Importing the same list again updates rows instead of duplicating them.</p>
      <label class="sv-field"><span class="lbl">Spreadsheet</span><input type="file" id="importFile" accept=".csv,.xlsx,.xls,.xlsm,text/csv"></label>
      <div id="importMap" hidden class="sv-form"></div>
      <div id="importMsg" hidden></div>
    </div>

    <div class="sv-section">Results and customer access</div>
    <div class="sv-form">
      <div class="sv-actions">
        <a class="sv-btn" href="/results/${enc(code)}">Open the results page</a>
        <a class="sv-btn is-outline" href="/api/projects/${enc(code)}/devices.csv" download>${icon('download')} Full survey data (CSV)</a>
      </div>
      <p class="sv-hint">Customers listed here can open the results page for this project only: totals, sites and the follow-up list, without staff names. They can't see the survey app or any other project. Add a person's email, or a whole domain such as <b>@customer.edu</b>.</p>
      <div class="sv-flatlist" id="accessList" style="border:1px solid var(--line);border-radius:6px"></div>
      <form class="sv-actions" id="accessForm">
        <label class="sv-field" style="flex:1;min-width:0"><span class="lbl" hidden>Customer email or domain</span>
          <input name="principal" id="accessInput" placeholder="jane@customer.edu or @customer.edu" autocomplete="off" aria-label="Customer email or domain"></label>
        <button class="sv-btn" type="submit">Give access</button>
      </form>
      <div id="accessMsg" hidden></div>
      <p class="sv-hint">Customer link: <b id="resultsLink"></b></p>
    </div>
    </div>
  </div>`);

  const msg = (id, ok, text) => {
    const el = document.getElementById(id);
    el.className = ok ? 'sv-ok' : 'sv-error';
    el.textContent = text;
    el.hidden = false;
  };

  // Customer access to the results page
  document.getElementById('resultsLink').textContent = `${location.origin}/results/${code}`;
  const drawAccess = list => {
    document.getElementById('accessList').innerHTML = list.map(a => `
      <div class="sv-flatrow" style="min-height:52px">
        <span class="sv-flatrow-main"><span class="sv-flatrow-title">${esc(a.principal)}</span>
        <span class="sv-flatrow-sub">${a.principal.startsWith('@') ? 'Everyone at this domain' : 'One person'} · added by ${esc(a.created_by || 'unknown')}</span></span>
        <button class="sv-btn is-small is-danger" type="button" data-remove-access="${esc(a.id)}">Remove</button>
      </div>`).join('') || '<p class="sv-hint" style="padding:12px 16px">No customers have access yet.</p>';
    document.querySelectorAll('[data-remove-access]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Remove this access? They will no longer be able to open the results.')) return;
      try {
        drawAccess(await apiDirect('DELETE', `/api/projects/${enc(code)}/access/${enc(b.dataset.removeAccess)}`));
      } catch (err) { msg('accessMsg', false, err.message); }
    }));
  };
  apiDirect('GET', `/api/projects/${enc(code)}/access`).then(drawAccess).catch(err => msg('accessMsg', false, err.message));
  document.getElementById('accessForm').addEventListener('submit', async e => {
    e.preventDefault();
    const input = document.getElementById('accessInput');
    try {
      drawAccess(await apiDirect('POST', `/api/projects/${enc(code)}/access`, JSON.stringify({ principal: input.value.trim() }), 'application/json'));
      input.value = '';
      msg('accessMsg', true, 'Access given. Send them the customer link below.');
    } catch (err) {
      msg('accessMsg', false, err.message);
    }
  });

  const catList = document.getElementById('catList');
  const bindRemove = () => catList.querySelectorAll('[data-remove-cat]').forEach(b => {
    b.onclick = () => { if (catList.children.length > 1) b.closest('[data-cat]').remove(); };
  });
  bindRemove();
  document.getElementById('addCat').addEventListener('click', () => {
    catList.insertAdjacentHTML('beforeend', catBlock({ key: '', label: '', fields: [] }, catList.children.length));
    bindRemove();
    catList.lastElementChild.querySelector('input[name="cat_label"]').focus();
  });

  document.getElementById('settingsForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target.elements;
    const categories = [...catList.querySelectorAll('[data-cat]')].map(block => {
      const key = block.querySelector('[name="cat_key"]').value || undefined;
      const existing = c.categories.find(x => x.key === key)?.fields ?? [];
      return {
        key,
        label: block.querySelector('[name="cat_label"]').value.trim(),
        title: block.querySelector('[name="cat_title"]').value.trim() || undefined,
        fields: textToFields(block.querySelector('[name="cat_fields"]').value, existing),
      };
    }).filter(x => x.label);
    try {
      await apiDirect('PUT', `/api/projects/${enc(code)}/settings`, JSON.stringify({
        subject: f.subject.value,
        site_label: { singular: f.site1.value, plural: f.siteN.value },
        categories, welcome_intro: f.welcome_intro.value,
        support: { label: f.support_label.value, phone: f.support_phone.value, sms: f.support_sms.value, email: f.support_email.value },
      }), 'application/json');
      msg('settingsMsg', true, 'Saved. Engineers see the change next time a screen loads.');
      loadProject(code);
    } catch (err) {
      msg('settingsMsg', false, err.message);
    }
  });

  const BRIEF_KEYS = ['contact_name', 'contact_phone', 'contact_email', 'address', 'wifi_ssid', 'wifi_username', 'wifi_password', 'access_hours', 'parking_info', 'briefing_notes'];
  const briefForm = document.getElementById('briefForm');
  const bf = briefForm.elements;
  bf.site_id.addEventListener('change', async () => {
    document.getElementById('briefFields').hidden = !bf.site_id.value;
    if (!bf.site_id.value) return;
    const { data } = await apiGet(`/api/sites/${enc(bf.site_id.value)}`);
    for (const k of BRIEF_KEYS) bf[k].value = data.site[k] ?? '';
  });
  briefForm.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await apiDirect('PUT', `/api/sites/${enc(bf.site_id.value)}/briefing`, JSON.stringify(Object.fromEntries(BRIEF_KEYS.map(k => [k, bf[k].value]))), 'application/json');
      msg('briefMsg', true, 'Briefing saved.');
    } catch (err) {
      msg('briefMsg', false, err.message);
    }
  });

  document.getElementById('importFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    document.getElementById('importMsg').hidden = true;
    if (!file) return;
    let rows;
    try {
      rows = await readSpreadsheet(file);
    } catch (err) {
      return msg('importMsg', false, `Could not read that file: ${err.message}`);
    }
    if (rows.length < 2) return msg('importMsg', false, 'The file needs a header row and at least one data row.');
    showImportMapping(code, c, sites, file.name, rows[0].map(String), rows.slice(1));
  });
}

function showImportMapping(code, c, sites, fileName, headers, rows) {
  const box = document.getElementById('importMap');
  const mapping = guessMapping(headers);
  const colOptions = [['', '— not in file —'], ...headers.map((h, i) => [String(i), h || `Column ${i + 1}`])];

  box.innerHTML = `
    <p class="sv-hint"><strong>${esc(fileName)}</strong>: ${rows.length} row${rows.length === 1 ? '' : 's'}. Check which column holds each detail.</p>
    <div class="sv-form-2col">
      ${IMPORT_FIELDS.map(fd => `<label class="sv-field"><span class="lbl">${esc(fd.key === 'site' ? c.site1 : fd.label)}</span>
        <span class="sv-select"><select data-map="${fd.key}">${options(colOptions, mapping[fd.key] ?? '')}</select></span></label>`).join('')}
      <label class="sv-field"><span class="lbl">${esc(c.site1)} for rows without one</span>
        <span class="sv-select"><select id="defSite">${options(sites.map(s => [s.id, s.name]), '', { blank: 'None — every row names it' })}</select></span></label>
      <label class="sv-field"><span class="lbl">Category for rows without one</span>
        <span class="sv-select"><select id="defCat">${options(c.categories.map(x => [x.key, x.label]), '', { blank: 'None — every row names it' })}</select></span></label>
    </div>
    <div class="sv-table-wrap" style="overflow-x:auto;border:1px solid var(--line);border-radius:6px"><table class="sv-table" id="importPreview" style="border-collapse:collapse;font-size:12.5px;min-width:100%"></table></div>
    <button class="sv-btn" type="button" id="runImport">Import ${rows.length} row${rows.length === 1 ? '' : 's'}</button>`;
  box.hidden = false;

  const currentMapping = () => Object.fromEntries([...box.querySelectorAll('[data-map]')]
    .filter(s => s.value !== '').map(s => [s.dataset.map, Number(s.value)]));
  const toRecords = () => {
    const m = currentMapping();
    return rows.map(r => Object.fromEntries(Object.entries(m).map(([k, i]) => [k, String(r[i] ?? '').trim()])));
  };
  const preview = () => {
    const m = currentMapping();
    const keys = IMPORT_FIELDS.filter(fd => m[fd.key] !== undefined);
    const cell = 'style="padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap"';
    document.getElementById('importPreview').innerHTML =
      `<tr>${keys.map(fd => `<th ${cell}>${esc(fd.key === 'site' ? c.site1 : fd.label)}</th>`).join('')}</tr>` +
      toRecords().slice(0, 5).map(r => `<tr>${keys.map(fd => `<td ${cell}>${esc(r[fd.key])}</td>`).join('')}</tr>`).join('');
  };
  box.querySelectorAll('[data-map]').forEach(s => s.addEventListener('change', preview));
  preview();

  document.getElementById('runImport').addEventListener('click', async e => {
    const btn = e.target;
    const m = currentMapping();
    if (m.name === undefined && m.extension === undefined && m.phone_number === undefined) {
      return showMsg(false, 'Choose at least one of Name, Extension, or Phone number.');
    }
    btn.disabled = true;
    const records = toRecords();
    const batch = `${fileName} @ ${new Date().toISOString()}`;
    const totals = { imported: 0, skipped: 0, created_buildings: 0, created_floors: 0, errors: [] };
    try {
      for (let i = 0; i < records.length; i += IMPORT_CHUNK) {
        btn.textContent = `Importing ${Math.min(i + IMPORT_CHUNK, records.length)} of ${records.length}…`;
        const r = await apiDirect('POST', `/api/projects/${enc(code)}/inventory/import`, JSON.stringify({
          rows: records.slice(i, i + IMPORT_CHUNK),
          default_site_id: document.getElementById('defSite').value || null,
          default_category: document.getElementById('defCat').value || null,
          batch,
        }), 'application/json');
        totals.imported += r.imported;
        totals.skipped += r.skipped;
        totals.created_buildings += r.created_buildings;
        totals.created_floors += r.created_floors;
        totals.errors.push(...r.errors.map(x => ({ ...x, row: x.row + i + 1 })));
      }
      showMsg(totals.skipped === 0,
        `Imported ${totals.imported} row${totals.imported === 1 ? '' : 's'}` +
        (totals.created_buildings ? `, added ${totals.created_buildings} building${totals.created_buildings === 1 ? '' : 's'}` : '') +
        (totals.created_floors ? ` and ${totals.created_floors} floor${totals.created_floors === 1 ? '' : 's'}` : '') + '.' +
        (totals.skipped ? ` Skipped ${totals.skipped}: ` + totals.errors.slice(0, 5).map(x => `row ${x.row} — ${x.error}`).join('; ') + (totals.errors.length > 5 ? '…' : '') : ''));
    } catch (err) {
      showMsg(false, `Import stopped: ${err.message} (${totals.imported} rows were imported before this).`);
    } finally {
      btn.disabled = false;
      btn.textContent = `Import ${records.length} rows again`;
    }
  });

  function showMsg(ok, text) {
    const el = document.getElementById('importMsg');
    el.className = ok ? 'sv-ok' : 'sv-error';
    el.textContent = text;
    el.hidden = false;
  }
}

// ---- Boot --------------------------------------------------------------

onStatus(renderStatus);
onSyncEvent(e => {
  // Everything queued has reached the server: reload the screen from it so
  // the engineer sees the authoritative data. Never under an open form.
  if (e.type === 'drained' && overlay.hidden && !/\/r\//.test(location.hash)) route();
});
startSync();
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); route(); });
route();

// Exposed for debugging from the browser console.
window.pfSurvey = { status: getStatus, ApiError };
