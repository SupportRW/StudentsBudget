import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Entry, WeekResult } from '../src/db/types';
import { LANGUAGE_STORAGE_KEY } from '../src/i18n/languages';
import { MESSAGES } from '../src/i18n/messages';
import { openApp, waitForApp } from './helpers/app';
import { putEntries, type EntrySeed } from './helpers/entries';
import { horizontalOverflow, widerThanThePage } from './helpers/layout';
import { heading } from './helpers/pages';
import { seedSetup } from './helpers/seed-setup';
import { readStore, SETUP_DAY, type SetupFixture } from './helpers/setup';

// The page's fixed words come from the app's own dictionary; the amounts and the week's lines, which are what these
// tests are about, are written out.
const t = MESSAGES.en;

/**
 * The Sunday of the fixture's setup week, Mon 12 – Sun 18 Oct 2026. Three Monday–Sunday weeks of October are left
 * from it (12–18, 19–25, 26–31), so the fixture's envelopes (Food €310, Eating out €124) give the week €103.33 and
 * €41.33, and €144.67 in total.
 */
const SUNDAY = new Date('2026-10-18T12:00:00');
/** The Monday after it: last week still waits to be recorded, until the Wednesday. */
const MONDAY_AFTER = new Date('2026-10-19T12:00:00');
/** A Sunday that starts a month mid-week: Mon 26 – Sat 31 Oct belong to October's budget, Sun 1 Nov to November's. */
const FIRST_OF_NOVEMBER = new Date('2026-11-01T12:00:00');

type Start = {
  /** The day the page is opened on. */
  day?: Date;
  /** The day the plan was set up, when it is not `day`. */
  setupDay?: Date;
  setup?: Partial<SetupFixture>;
  entries?: EntrySeed[];
};

/**
 * A plan, the entries, and the check-in opened on `day`: everything the page reads is written before it loads, so the
 * only thing a test does through the page is what it is about.
 */
async function openCheckIn(page: Page, { day = SUNDAY, setupDay = day, setup = {}, entries = [] }: Start = {}) {
  await page.clock.setFixedTime(setupDay);
  await seedSetup(page, setup, { open: false });
  await putEntries(page, entries);
  if (day !== setupDay) await page.clock.setFixedTime(day);
  await openApp(page, '/check-in');
  await expect(heading(page, t.shell.headings.checkIn)).toBeVisible();
}

/** An envelope's bar, by the name the page gives it: "Food & groceries this week". */
const bar = (page: Page, name: string) => page.getByRole('progressbar', { name, exact: true });

/** The envelope's card around that bar, with its line under it. */
const envelope = (page: Page, name: string) => page.getByRole('listitem').filter({ has: bar(page, name) });

/** The week card's bar. */
const weekBar = (page: Page) => bar(page, t.checkIn.week.bar);

/** What was logged in a part of the week: "This week", or "Earlier this week". */
const logged = (page: Page, name: string) => page.getByRole('list', { name, exact: true }).getByRole('listitem');

/** The card that adds what was forgotten. */
const addCard = (page: Page) => page.getByRole('region', { name: t.checkIn.add.heading, exact: true });

test.beforeEach(async ({ context }) => {
  // Nothing but this machine answers: a host no helper mocks is refused rather than reached.
  await context.route(
    (url) => !['localhost', '127.0.0.1'].includes(url.hostname),
    (route) => route.abort(),
  );
});

test.describe('the week on the page', () => {
  test('shows the week in one number, each envelope against its share, and what was logged', async ({ page }) => {
    await openCheckIn(page, {
      entries: [
        { date: '2026-10-13', categoryId: 'food', amountMinor: 95000, eurMinor: 1000, note: 'Spices', account: 'Home bank' },
        { date: '2026-10-14', categoryId: 'food', amountMinor: 2000, note: 'Groceries' },
        { date: '2026-10-15', categoryId: 'eating-out', amountMinor: 5000, note: 'Döner' },
        // Income is listed, and never counts against the week.
        { type: 'income', date: '2026-10-16', categoryId: 'income-job', amountMinor: 40000, note: 'Pay' },
      ],
    });

    await expect(page.getByText('Mon 12 – Sun 18 Oct', { exact: true })).toBeVisible();

    // €144.67 for the week, €80 of it spent.
    await expect(page.getByText('€65 safe to spend', { exact: true })).toBeVisible();
    await expect(weekBar(page)).toHaveAttribute('aria-valuetext', '€80 spent so far');
    await expect(weekBar(page)).toHaveAttribute('aria-valuenow', '55');

    // The rupee expense counts with its euro value.
    await expect(envelope(page, 'Food & groceries this week')).toContainText('€30 of €103 · €73 under');
    await expect(bar(page, 'Food & groceries this week')).toHaveAttribute('aria-valuenow', '29');
    await expect(envelope(page, 'Eating out this week')).toContainText('€50 of €41 · €9 over');
    await expect(bar(page, 'Eating out this week')).toHaveAttribute('aria-valuenow', '100');
    // An envelope at €0 with nothing spent on it is not listed.
    await expect(bar(page, 'Going out this week')).toHaveCount(0);

    // Newest day first, each amount in its account's own currency.
    await expect(logged(page, t.checkIn.thisWeek.logged)).toHaveText([
      /Pay.*Job · Fri 16.*\+€400\.00/,
      /Döner.*Eating out · Thu 15.*€50\.00/,
      /Groceries.*Food & groceries · Wed 14.*€20\.00/,
      /Spices.*Food & groceries · Tue 13.*₹950\.00/,
    ]);
  });

  test('offers a swap only for the envelope that is over its week, with where its prices come from', async ({ page }) => {
    await openCheckIn(page, {
      entries: [
        { date: '2026-10-14', categoryId: 'food', amountMinor: 2000 },
        { date: '2026-10-15', categoryId: 'eating-out', amountMinor: 5000 },
      ],
    });

    const swap = envelope(page, 'Eating out this week').getByRole('button', { name: /^Try this: / });
    await expect(swap).toHaveAttribute('aria-expanded', 'false');
    await expect(envelope(page, 'Food & groceries this week').getByRole('button')).toHaveCount(0);

    await swap.click();
    await expect(swap).toHaveAttribute('aria-expanded', 'true');
    // The swap's own words are city data; what the page owes is that every price in them names its source.
    const details = envelope(page, 'Eating out this week').getByRole('group', { name: / details$/ });
    await expect(details.getByText(/^Source/).first()).toBeVisible();
    await expect(details.getByRole('link').first()).toHaveAttribute('href', /^https:\/\//);
  });

  test('says on plan, keeps the cents that decide a line, and says when a month has nothing left', async ({ page }) => {
    await openCheckIn(page, {
      // A week's share of each: Food €103.33, Eating out €41.33, Going out €20, Shopping €10.
      setup: {
        envelopes: { food: '310', 'eating-out': '124', 'going-out': '60', transport: '0', shopping: '30', other: '0' },
      },
      entries: [
        // Spent before the week: Eating out and Shopping have nothing left of their month.
        { date: '2026-10-05', categoryId: 'shopping', amountMinor: 4500 },
        { date: '2026-10-06', categoryId: 'eating-out', amountMinor: 13000 },
        { date: '2026-10-13', categoryId: 'food', amountMinor: 10300 },
        { date: '2026-10-13', categoryId: 'going-out', amountMinor: 2000 },
        { date: '2026-10-14', categoryId: 'transport', amountMinor: 500 },
        { date: '2026-10-15', categoryId: 'eating-out', amountMinor: 600 },
      ],
    });

    // 33 cents under would read "€103 of €103 · €0 under": the cents show instead.
    await expect(envelope(page, 'Food & groceries this week')).toContainText('€103.00 of €103.33 · €0.33 under');
    await expect(envelope(page, 'Going out this week')).toContainText('€20 of €20 · on plan');
    await expect(envelope(page, 'Shopping this week')).toContainText('Nothing left this month · €0 spent');
    await expect(bar(page, 'Shopping this week')).toHaveAttribute('aria-valuenow', '100');
    await expect(envelope(page, 'Eating out this week')).toContainText('Nothing left this month · €6 spent · €6 over');
    // No envelope, but spending this week: listed against €0.
    await expect(envelope(page, 'Transport this week')).toContainText('€5 of €0 · €5 over');
    await expect(bar(page, 'Other this week')).toHaveCount(0);

    // (€524 planned − €175 gone before the week) ÷ 3 weeks = €116.33 for this one, and €134 spent in it. Calm words,
    // and the bar stops at full.
    await expect(page.getByText('€18 over this week', { exact: true })).toBeVisible();
    await expect(weekBar(page)).toHaveAttribute('aria-valuetext', '€134 spent so far');
    await expect(weekBar(page)).toHaveAttribute('aria-valuenow', '100');
  });

  test('a plan without envelope amounts has no number for the week', async ({ page }) => {
    await openCheckIn(page, {
      setup: {
        envelopes: { food: '0', 'eating-out': '0', 'going-out': '0', transport: '0', shopping: '0', other: '0' },
      },
    });

    await expect(page.getByText(t.checkIn.noEnvelopes, { exact: true })).toBeVisible();
    await expect(weekBar(page)).toHaveCount(0);
    await expect(page.getByText(t.checkIn.thisWeek.empty, { exact: true })).toBeVisible();
  });

  test('without a plan it points to setup', async ({ page }) => {
    await page.clock.setFixedTime(SUNDAY);
    await openApp(page, '/check-in');

    await expect(page.getByText(t.checkIn.noPlan, { exact: true })).toBeVisible();
    await expect(weekBar(page)).toHaveCount(0);

    await page.getByRole('link', { name: t.common.toSetup, exact: true }).click();
    await expect(page).toHaveURL('/setup');
    await expect(page.getByRole('heading', { level: 3, name: 'Accounts', exact: true })).toBeVisible();
  });
});

test.describe('a week across two months', () => {
  test('on the Sunday a month starts, last month’s days are reviewed against last month', async ({ page }) => {
    await openCheckIn(page, {
      setupDay: SETUP_DAY,
      day: FIRST_OF_NOVEMBER,
      entries: [
        { date: '2026-10-28', categoryId: 'food', amountMinor: 3000, note: 'Market' },
        { date: '2026-11-01', categoryId: 'eating-out', amountMinor: 800, note: 'Coffee' },
      ],
    });

    // October's last week is its only one left, so it is measured against the whole of what October had.
    await expect(page.getByRole('heading', { level: 3, name: t.checkIn.earlierThisWeek.envelopes, exact: true })).toBeVisible();
    await expect(page.getByText('Mon 26 – Sat 31 Oct', { exact: true })).toBeVisible();
    await expect(envelope(page, 'Food & groceries earlier this week')).toContainText('€30 of €310 · €280 under');
    await expect(envelope(page, 'Eating out earlier this week')).toContainText('€0 of €124 · €124 under');
    await expect(logged(page, t.checkIn.earlierThisWeek.logged)).toHaveText([/Market.*Food & groceries · Wed 28.*€30\.00/]);

    // November's first week is its one day, a sixth of the month.
    await expect(page.getByText('Sun 1 Nov', { exact: true })).toBeVisible();
    await expect(page.getByText('€64 safe to spend', { exact: true })).toBeVisible();
    await expect(envelope(page, 'Food & groceries this week')).toContainText('€0 of €52 · €52 under');
    await expect(envelope(page, 'Eating out this week')).toContainText('€8 of €21 · €13 under');
    await expect(logged(page, t.checkIn.thisWeek.logged)).toHaveText([/Coffee.*Eating out · Sun 1.*€8\.00/]);
  });

  test('days of a month before the plan existed are left out', async ({ page }) => {
    await openCheckIn(page, { day: FIRST_OF_NOVEMBER });

    await expect(page.getByText('€72 safe to spend', { exact: true })).toBeVisible();
    await expect(page.getByText('Sun 1 Nov', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: t.checkIn.earlierThisWeek.envelopes, exact: true })).toHaveCount(0);
  });
});

test.describe('adding what was forgotten', () => {
  test('a quick-add line lands in the week at once, and Undo takes it out again', async ({ page }) => {
    await openCheckIn(page);
    await expect(page.getByText('€145 safe to spend', { exact: true })).toBeVisible();

    await addCard(page).getByRole('textbox', { name: t.entries.quickAdd.label, exact: true }).fill('döner 6');
    await addCard(page).getByRole('button', { name: t.entries.quickAdd.add, exact: true }).click();

    await expect(addCard(page).getByRole('status')).toHaveText('Saved €6.00 · döner · Eating out');
    await expect(envelope(page, 'Eating out this week')).toContainText('€6 of €41 · €35 under');
    await expect(page.getByText('€139 safe to spend', { exact: true })).toBeVisible();
    await expect(logged(page, t.checkIn.thisWeek.logged)).toHaveText([/döner.*Eating out · Sun 18.*€6\.00/]);

    await addCard(page).getByRole('button', { name: t.entries.quickAdd.undo, exact: true }).click();

    await expect(page.getByText(t.checkIn.thisWeek.empty, { exact: true })).toBeVisible();
    await expect(page.getByText('€145 safe to spend', { exact: true })).toBeVisible();
    expect(await readStore<Entry>(page, 'entries')).toEqual([]);
  });

  test('a line without an amount says so and saves nothing', async ({ page }) => {
    await openCheckIn(page);

    await addCard(page).getByRole('textbox', { name: t.entries.quickAdd.label, exact: true }).fill('döner');
    await addCard(page).getByRole('button', { name: t.entries.quickAdd.add, exact: true }).click();

    await expect(addCard(page).getByRole('alert')).toHaveText(t.entries.quickAdd.noAmount);
    await expect(addCard(page).getByRole('textbox', { name: t.entries.quickAdd.label, exact: true })).toHaveValue('döner');
    await expect(page.getByText(t.checkIn.thisWeek.empty, { exact: true })).toBeVisible();
    expect(await readStore<Entry>(page, 'entries')).toEqual([]);
  });

  test('an entry for an earlier day is saved in the form, which comes back to the check-in', async ({ page }) => {
    await openCheckIn(page);

    await page.getByRole('link', { name: t.checkIn.add.earlier, exact: true }).click();
    await expect(page).toHaveURL('/entries/new?from=check-in');
    await expect(heading(page, t.shell.headings.newEntry)).toBeVisible();

    await page.getByRole('textbox', { name: t.entries.form.amount, exact: true }).fill('12');
    await page.getByRole('radio', { name: 'Food & groceries', exact: true }).check();
    await page.getByRole('button', { name: t.common.dateField.yesterday, exact: true }).click();
    await page.getByRole('textbox', { name: t.entries.form.note, exact: true }).fill('Bread');
    await page.getByRole('button', { name: t.entries.form.saveExpense, exact: true }).click();

    await expect(page).toHaveURL('/check-in');
    await expect(envelope(page, 'Food & groceries this week')).toContainText('€12 of €103 · €91 under');
    await expect(logged(page, t.checkIn.thisWeek.logged)).toHaveText([/Bread.*Food & groceries · Sat 17.*€12\.00/]);
  });
});

test.describe('a week away', () => {
  test('“I was away this week” is kept over a reload, and can be taken back', async ({ page }) => {
    await openCheckIn(page);
    const away = page.getByRole('switch', { name: t.checkIn.away.thisWeek, exact: true });
    await expect(away).toBeChecked({ checked: false });
    // Only on the Monday and the Tuesday is last week still open.
    await expect(page.getByRole('switch', { name: t.checkIn.away.lastWeek, exact: true })).toHaveCount(0);

    await away.click();
    await expect(away).toBeChecked();

    await page.reload();
    await waitForApp(page);
    await expect(away).toBeChecked();
    expect(await readStore<WeekResult>(page, 'weekResults')).toMatchObject([{ weekStart: '2026-10-12', paused: true }]);

    await away.click();
    await expect(away).toBeChecked({ checked: false });
    expect(await readStore<WeekResult>(page, 'weekResults')).toEqual([]);
  });

  test('on the Monday after, last week can still be marked, apart from this one', async ({ page }) => {
    await openCheckIn(page, { setupDay: SETUP_DAY, day: MONDAY_AFTER });
    const lastWeek = page.getByRole('switch', { name: t.checkIn.away.lastWeek, exact: true });
    const thisWeek = page.getByRole('switch', { name: t.checkIn.away.thisWeek, exact: true });

    await lastWeek.click();

    await expect(lastWeek).toBeChecked();
    await expect(thisWeek).toBeChecked({ checked: false });
    expect(await readStore<WeekResult>(page, 'weekResults')).toMatchObject([{ weekStart: '2026-10-12', paused: true }]);
  });
});

test.describe('ways in and reminders', () => {
  test('on a Sunday, Home says it is time, shows the same number, and opens the check-in on its heading', async ({ page }) => {
    await page.clock.setFixedTime(SUNDAY);
    await seedSetup(page);
    await expect(page.getByText('This week: €145 safe to spend', { exact: true })).toBeVisible();

    const card = page.getByRole('link', { name: new RegExp(t.checkIn.card.sunday) });
    await expect(card).toBeVisible();
    await card.click();

    await expect(page).toHaveURL('/check-in');
    await expect(page.getByText('€145 safe to spend', { exact: true })).toBeVisible();
    await expect(page.getByText('Mon 12 – Sun 18 Oct', { exact: true })).toBeVisible();
    await expect(heading(page, t.shell.headings.checkIn)).toBeFocused();
  });

  test('on a weekday, Home’s quiet line still opens the week so far', async ({ page }) => {
    // seedSetup's own day, a Friday.
    await seedSetup(page);

    const line = page.getByRole('link', { name: new RegExp(t.checkIn.card.other) });
    await expect(line).toBeVisible();
    await line.click();

    await expect(page).toHaveURL('/check-in');
    await expect(page.getByText('€145 safe to spend', { exact: true })).toBeVisible();
    await expect(envelope(page, 'Food & groceries this week')).toContainText('€0 of €103 · €103 under');
  });

  test('offers the calendar file, and the way to the notification instead', async ({ page }) => {
    await openCheckIn(page);

    const calendar = page.getByRole('link', { name: t.checkIn.reminder, exact: true });
    await expect(calendar).toHaveAttribute('href', '/weekly-check-in.ics');
    // The file is there, and it is a calendar.
    const file = await page.request.get('/weekly-check-in.ics');
    expect(file.ok()).toBe(true);
    expect(await file.text()).toContain('BEGIN:VCALENDAR');

    await page.getByRole('link', { name: t.checkIn.reminderOrLink, exact: true }).click();
    await expect(page).toHaveURL('/settings/reminder');
    await expect(heading(page, t.shell.headings.reminder)).toBeVisible();
  });
});

test.describe('check-in · de-DE', () => {
  test.use({ locale: 'de-DE' });

  test('reads in German, with the amounts still in euros', async ({ page }) => {
    // The phone's own choice, not only the browser's language.
    await page.addInitScript(([key, code]) => localStorage.setItem(key, code), [LANGUAGE_STORAGE_KEY, 'de']);
    await page.clock.setFixedTime(SUNDAY);
    await seedSetup(page, {}, { open: false });
    await putEntries(page, [
      { date: '2026-10-14', categoryId: 'food', amountMinor: 2000 },
      { date: '2026-10-15', categoryId: 'eating-out', amountMinor: 5000 },
    ]);
    await openApp(page, '/check-in');
    const de = MESSAGES.de;

    await expect(heading(page, de.shell.headings.checkIn)).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    // \s: German puts a no-break space before the €.
    await expect(page.getByText(/^75\s€ frei zum Ausgeben$/)).toBeVisible();
    await expect(envelope(page, 'Lebensmittel diese Woche')).toContainText(/20\s€ von 103\s€ · 83\s€ unter Plan/);
    await expect(page.getByRole('link', { name: de.checkIn.reminder, exact: true })).toHaveAttribute(
      'href',
      '/weekly-check-in.de.ics',
    );
  });
});

test.describe('the page as a whole', () => {
  test('has no serious accessibility finding, and nothing scrolls sideways', async ({ page }) => {
    await openCheckIn(page, {
      entries: [
        { date: '2026-10-14', categoryId: 'food', amountMinor: 2000, note: 'Groceries' },
        { date: '2026-10-15', categoryId: 'eating-out', amountMinor: 5000, note: 'Döner' },
      ],
    });
    await expect(envelope(page, 'Eating out this week')).toContainText('€50 of €41 · €9 over');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);

    expect(await horizontalOverflow(page), await widerThanThePage(page)).toBe(0);
  });
});
