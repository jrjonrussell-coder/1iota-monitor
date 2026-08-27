// 1iota taping-availability watcher. Three shows, one sweep.
//
// PRIMARY PATH - JSON API
// The 1iota front end consumes https://prod-tickets.1iota.com/api/project/<id>.
// Confirmed to return complete event data for projects 1248, 461 and 353 on
// 2026-08-26. Event fields used:
//     eventId, startDateUtc ("2026-09-21T20:30:00", no suffix, is UTC),
//     localStartDay ("Mon, Sep 21"), when ("4:30 PM"), isSoldOut,
//     isMaxRequestMet, buttonLabel ("REQUEST TICKETS" | "JOIN WAITLIST")
//
// FALLBACK PATH - DOM scrape
// If the API returns anything other than usable JSON, each show is re-read with
// Playwright using the selectors verified against project 1248 on 2026-08-26:
//     ul.tabList > li.tabWidth      one per taping date
//     li.tabWidth.soldout           sold out
//     #dayDivCalendar               expand control, stable id
// Those selectors are UNVERIFIED for projects 461 and 353. They are the same
// platform and very likely identical, but that is an assumption, not a fact.
// If the fallback also yields nothing, the sweep throws, which fires the
// workflow's failure email. Silence must never be readable as "no tickets".
//
// TWO SIGNALS, because the shows behave differently. The Daily Show sells
// through REQUEST TICKETS. Fallon and Meyers label every date JOIN WAITLIST,
// so there the actionable moment is the date appearing at all.
//     appeared   a date inside the target window is listed for the first time
//     bookable   that date carries REQUEST TICKETS and is not sold out
// Each fires once per date. Churn outside the window is recorded, never alerted.

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';

// Trip: lands JFK 15:55 Fri 16 Oct; Washington DC 17 to 18 Oct;
// departs JFK 18:20 Sat 24 Oct. Usable taping days are Mon 19 to Fri 23 only.
const WINDOW = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];
const WINDOW_LABEL = '19 to 23 October 2026';

const SHOWS = [
  { id: 1248, name: 'The Daily Show',              url: 'https://1iota.com/show/1248/the-daily-show' },
  { id: 461,  name: 'Late Night with Seth Meyers', url: 'https://1iota.com/show/461/late-night-with-seth-meyers' },
  { id: 353,  name: 'The Tonight Show (Fallon)',   url: 'https://fallon.1iota.com/show/353/the-tonight-show' },
];

// IOTA_API_BASE exists so the sweep logic can be exercised against a local
// fixture server in tests. Unset in production.
const API_BASE = process.env.IOTA_API_BASE || 'https://prod-tickets.1iota.com/api/project';
const API = (id) => `${API_BASE}/${id}`;
const BOOKABLE = /request\s*tickets/i;
const STATE_DIR = 'state';
const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

const nyDate = (utcNoZone) => {
  const d = new Date(/[Zz]|[+-]\d\d:?\d\d$/.test(utcNoZone) ? utcNoZone : `${utcNoZone}Z`);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
};

// ---------------------------------------------------------------- primary

async function viaApi(show) {
  const res = await fetch(API(show.id), {
    headers: {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      origin: 'https://1iota.com',
      referer: 'https://1iota.com/',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json.events) || json.events.length === 0) throw new Error('no events array');
  return json.events.map((e) => ({
    eventId: e.eventId ?? null,
    date: nyDate(e.startDateUtc),
    localStartDay: e.localStartDay ?? null,
    when: e.when ?? null,
    isSoldOut: e.isSoldOut === true,
    isMaxRequestMet: e.isMaxRequestMet === true,
    buttonLabel: (e.buttonLabel ?? '').trim() || null,
  })).filter((e) => e.date);
}

// --------------------------------------------------------------- fallback

// The DOM fallback is opt-in per run. The workflow makes a cheap API-only pass
// first and only installs Playwright if that pass fails, so ordinary sweeps
// never pay for a browser download.
const ALLOW_DOM = process.env.IOTA_ALLOW_DOM === '1';

let browserPromise = null;
const getBrowser = async () => {
  if (!browserPromise) {
    const { chromium } = await import('playwright');
    browserPromise = chromium.launch();
  }
  return browserPromise;
};

const parseTile = (text) => {
  const m = text.match(/^([A-Za-z]{3})\s+(\d{1,2})/);
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  if (mon === undefined) return null;
  const now = new Date();
  let year = now.getUTCFullYear();
  if (mon < now.getUTCMonth() - 1) year += 1; // the list runs forward only
  const d = new Date(Date.UTC(year, mon, Number(m[2])));
  return d.toISOString().slice(0, 10);
};

async function viaDom(show) {
  if (!ALLOW_DOM) throw new Error('dom fallback disabled for this pass');
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'en-US', timezoneId: 'America/New_York', viewport: { width: 1440, height: 1000 },
  });
  const page = await ctx.newPage();
  try {
    await page.goto(show.url, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForTimeout(4000);
    for (const label of ['Reject', 'Reject All', 'Decline']) {
      const b = page.getByRole('button', { name: label, exact: false }).first();
      if (await b.count().catch(() => 0)) { await b.click({ timeout: 2500 }).catch(() => {}); break; }
    }
    const el = await page.$('#dayDivCalendar');
    if (el) { await el.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(1500); }
    const tiles = await page.evaluate(() => {
      const ul = document.querySelector('ul.tabList');
      if (!ul) return [];
      return [...ul.querySelectorAll('li.tabWidth')]
        .filter((li) => !li.querySelector('#dayDivCalendar'))
        .map((li) => ({
          text: (li.innerText || '').replace(/\s+/g, ' ').trim(),
          soldout: li.classList.contains('soldout'),
        }))
        .filter((t) => t.text);
    });
    if (tiles.length === 0) throw new Error('no date tiles found');
    return tiles.map((t) => ({
      eventId: null,
      date: parseTile(t.text),
      localStartDay: t.text,
      when: null,
      isSoldOut: t.soldout,
      isMaxRequestMet: false,
      // The tile carries no call to action, so the fallback can report presence
      // and sold-out state but never bookability.
      buttonLabel: null,
    })).filter((e) => e.date);
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ------------------------------------------------------------------- sweep

mkdirSync(STATE_DIR, { recursive: true });

const sections = [];
const alerts = [];
const failures = [];
let anyChange = false;

for (const show of SHOWS) {
  let events = null, source = 'api', apiError = null;
  try {
    events = await viaApi(show);
  } catch (err) {
    apiError = err.message;
    try { events = await viaDom(show); source = 'dom-fallback'; }
    catch (err2) { failures.push(`${show.name}: api ${apiError}; dom ${err2.message}`); continue; }
  }

  const statePath = `${STATE_DIR}/${show.id}.json`;
  const prior = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8') || '{}') : {};
  const priorSeen = new Set(prior.notifiedAppeared || []);
  const priorBooked = new Set(prior.notifiedBookable || []);

  const inWindow = events.filter((e) => WINDOW.includes(e.date));
  const furthest = events.map((e) => e.date).sort().pop() || null;

  const appeared = inWindow.filter((e) => !priorSeen.has(e.date));
  const bookable = inWindow.filter((e) => !e.isSoldOut && e.buttonLabel && BOOKABLE.test(e.buttonLabel));
  const newlyBookable = bookable.filter((e) => !priorBooked.has(e.date));

  if (appeared.length) {
    alerts.push(`${show.name}: date(s) now listed in the window - ` +
      appeared.map((e) => `${e.localStartDay}${e.when ? ' ' + e.when : ''} [${e.buttonLabel || 'no label'}]`).join(', ') +
      `\n    ${show.url}`);
  }
  if (newlyBookable.length) {
    alerts.push(`${show.name}: REQUEST TICKETS live for ` +
      newlyBookable.map((e) => `${e.localStartDay}${e.when ? ' ' + e.when : ''}`).join(', ') +
      `\n    ${show.url}`);
  }

  const allDates = events.map((e) => `${e.date}${e.isSoldOut ? ' [SOLD OUT]' : ''}`);
  if (JSON.stringify(prior.allDates ?? null) !== JSON.stringify(allDates)) anyChange = true;

  writeFileSync(statePath, JSON.stringify({
    checkedAtUtc: new Date().toISOString(),
    projectId: show.id,
    name: show.name,
    showUrl: show.url,
    source,
    apiError,
    eventCount: events.length,
    furthestDateListed: furthest,
    allDates,
    inWindow,
    notifiedAppeared: [...new Set([...priorSeen, ...appeared.map((e) => e.date)])].sort(),
    notifiedBookable: [...new Set([...priorBooked, ...bookable.map((e) => e.date)])].sort(),
  }, null, 2));

  sections.push([
    `--- ${show.name} (project ${show.id}) via ${source}${apiError ? ` (api said: ${apiError})` : ''}`,
    `    dates listed: ${events.length}, furthest ${furthest || 'none'}`,
    `    in ${WINDOW_LABEL}: ${inWindow.length
      ? inWindow.map((e) => `${e.localStartDay}${e.when ? ' ' + e.when : ''} -> ${e.buttonLabel || 'no label'}${e.isSoldOut ? ' SOLD OUT' : ''}`).join('\n                        ')
      : 'none listed yet'}`,
    `    ${show.url}`,
  ].join('\n'));
}

if (browserPromise) {
  try { await (await browserPromise).close(); } catch { /* launch itself failed */ }
}

const notify = alerts.length > 0;
const summary = [
  `Sweep: ${new Date().toISOString()}`,
  `Target window: ${WINDOW_LABEL} (New York local)`,
  '',
  notify ? `ALERTS\n  ${alerts.join('\n  ')}` : 'No alert conditions this sweep.',
  '',
  ...sections,
  failures.length ? `\nSHOWS THAT COULD NOT BE READ:\n  ${failures.join('\n  ')}` : '',
].join('\n');
writeFileSync('summary.txt', summary);

const out = process.env.GITHUB_OUTPUT;
if (out) {
  appendFileSync(out, `notify=${notify}\n`);
  appendFileSync(out, `changed=${anyChange}\n`);
}
console.log(summary);

// A show that could be read by neither route is a broken monitor, not an
// absence of tickets. Fail the job so the failure email fires.
if (failures.length) process.exit(1);
