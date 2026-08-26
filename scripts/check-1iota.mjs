// Hourly 1iota watcher for The Daily Show, show 1248.
//
// DOM facts verified directly against the live page on 2026-08-26:
//   ul.tabList > li.tabWidth        one per taping date
//   li.tabWidth.soldout             that date is SOLD OUT
//   li.tabWidth.active              currently selected date
//   #dayDivCalendar                 icon-only expand control, stable id
//   detail CTA button text is one of:
//       "REQUEST TICKETS"       bookable
//       "REGISTRATION CLOSED"   listed but not bookable
//   Tiles carry a weekday label (WED, THU) that does NOT indicate
//   availability. Sep 09 renders "WED" yet its CTA is REGISTRATION CLOSED.
//   Availability must be read from the CTA of the selected date.
//
// Clicking a tile collapses the list to that date alone, so the expand
// control must be re-clicked before each subsequent tile is selected.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

const SHOW_URL = 'https://1iota.com/show/1248/the-daily-show';
const STATE_PATH = 'state/1iota-state.json';
const WINDOW_START = new Date('2026-10-01T00:00:00Z');
const WINDOW_END = new Date('2026-10-01T23:59:59Z');
const BOOKABLE = /request\s*tickets/i;

const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

const prior = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8') || '{}') : {};
const priorNotified = prior.alreadyNotified === true;

const browser = await chromium.launch();
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  locale: 'en-US',
  timezoneId: 'America/New_York',
  viewport: { width: 1440, height: 1000 },
});
const page = await ctx.newPage();

const apiHits = [];
page.on('response', (res) => {
  const u = res.url(), ct = res.headers()['content-type'] || '';
  if (/1iota/.test(u) && /json/.test(ct)) apiHits.push(u);
});

await page.goto(SHOW_URL, { waitUntil: 'networkidle', timeout: 90000 });
await page.waitForTimeout(4000);

// Decline non-essential cookies if the consent banner is present.
for (const label of ['Reject', 'Reject All', 'Decline']) {
  const b = page.getByRole('button', { name: label, exact: false }).first();
  if (await b.count().catch(() => 0)) {
    await b.click({ timeout: 2500 }).catch(() => {});
    break;
  }
}
await page.waitForTimeout(1000);

const expand = async () => {
  const el = await page.$('#dayDivCalendar');
  if (!el) return false;
  await el.click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return true;
};

const readTiles = () => page.evaluate(() => {
  const ul = document.querySelector('ul.tabList');
  if (!ul) return [];
  return [...ul.querySelectorAll('li.tabWidth')]
    .filter((li) => !li.querySelector('#dayDivCalendar'))
    .map((li) => ({
      text: (li.innerText || '').replace(/\s+/g, ' ').trim(),
      soldout: li.classList.contains('soldout'),
      active: li.classList.contains('active'),
    }))
    .filter((t) => t.text);
});

const parseTile = (text) => {
  const m = text.match(/^([A-Za-z]{3})\s+(\d{1,2})/);
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  if (mon === undefined) return null;
  const now = new Date();
  let year = now.getUTCFullYear();
  if (mon < now.getUTCMonth() - 1) year += 1; // list runs forward only
  return new Date(Date.UTC(year, mon, Number(m[2])));
};

const expandedOk = await expand();
let tiles = await readTiles();

// Target dates present in the window and not already marked sold out.
const targets = tiles
  .map((t) => ({ ...t, date: parseTile(t.text) }))
  .filter((t) => t.date && t.date >= WINDOW_START && t.date <= WINDOW_END);

const inspected = [];
for (const t of targets) {
  if (t.soldout) { inspected.push({ ...t, cta: 'SOLD OUT', bookable: false }); continue; }
  await expand(); // list collapses after each selection
  const handle = page.locator('ul.tabList li.tabWidth', { hasText: t.text.split(' ').slice(0, 2).join(' ') }).first();
  await handle.click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(1800);
  const cta = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button, a')]
      .map((e) => (e.innerText || '').trim())
      .find((s) => /request\s*tickets|registration\s*closed|sold\s*out|waitlist/i.test(s));
    return b || null;
  });
  inspected.push({ ...t, cta, bookable: !!cta && BOOKABLE.test(cta) });
}

await page.screenshot({ path: 'page.png', fullPage: true }).catch(() => {});
await browser.close();

const bookable = inspected.filter((t) => t.bookable);
const availability = bookable.length > 0;
const shouldNotify = availability && !priorNotified;

const allTiles = tiles.map((t) => `${t.text}${t.soldout ? ' [SOLD OUT]' : ''}`);
const changes = [];
const cmp = (f, a, b) => {
  const A = JSON.stringify(a ?? null), B = JSON.stringify(b ?? null);
  if (A !== B) changes.push(`${f}\n  was: ${A}\n  now: ${B}`);
};
cmp('tiles', prior.allTiles, allTiles);
cmp('windowTiles', prior.inspected, inspected);

const next = {
  checkedAtUtc: new Date().toISOString(),
  showUrl: SHOW_URL,
  expandControlFound: expandedOk,
  tileCount: tiles.length,
  allTiles,
  lastListedDate: allTiles.length ? allTiles[allTiles.length - 1] : null,
  inspected,
  availability,
  alreadyNotified: availability ? true : false,
  apiHits: [...new Set(apiHits)],
};
writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));

const summary = [
  `Sweep: ${next.checkedAtUtc}`,
  `Expand control (#dayDivCalendar) found: ${expandedOk}`,
  `Dates listed (${tiles.length}): ${allTiles.join(', ') || 'none'}`,
  `Furthest date listed: ${next.lastListedDate || 'none'}`,
  '',
  `Dates in 19 to 25 October 2026: ${inspected.length ? inspected.map((t) => `${t.text} -> ${t.cta}`).join('\n  ') : 'none listed yet'}`,
  `Bookable (REQUEST TICKETS): ${bookable.length ? bookable.map((t) => t.text).join(', ') : 'none'}`,
  `Notification fired this sweep: ${shouldNotify}`,
  `JSON endpoints observed: ${next.apiHits.join(', ') || 'none'}`,
  '',
  changes.length ? `Changes since last sweep:\n${changes.join('\n')}` : 'No changes since last sweep.',
  '',
  SHOW_URL,
].join('\n');
writeFileSync('summary.txt', summary);

const out = process.env.GITHUB_OUTPUT;
if (out) {
  appendFileSync(out, `notify=${shouldNotify}\n`);
  appendFileSync(out, `changed=${changes.length > 0}\n`);
}
console.log(summary);
