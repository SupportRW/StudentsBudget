import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Entry } from '../src/db/types';
import { MESSAGES } from '../src/i18n/messages';
import { openApp } from './helpers/app';
import { putEntries, type EntrySeed } from './helpers/entries';
import { heading } from './helpers/pages';
import { seedSetup } from './helpers/seed-setup';
import { readStore } from './helpers/setup';

// The page's fixed words come from the app's own dictionary; the amounts, dates and notes, which are what these tests
// are about, are written out.
const t = MESSAGES.en;

/** An expense or an income, as these tests save only those: the rows that carry a category. */
type MoneyEntry = Exclude<Entry, { type: 'transfer' }>;

/** Tuesday 20 Oct 2026: the day every test opens the app on, so "this month" is October. */
const DAY = new Date('2026-10-20T12:00:00');

/** The fixture's default account (seedSetup's Local bank, in euros), as each row names it. */
const BANK = 'Local bank';

/** A plan and the entries, written before the page under test loads; the page is then opened on `DAY`. */
async function openWith(page: Page, path: string, entries: EntrySeed[] = []) {
  await page.clock.setFixedTime(DAY);
  await seedSetup(page, {}, { open: false });
  await putEntries(page, entries);
  await openApp(page, path);
}

/** The month's list, with its month switch and its rows. */
const list = (page: Page) => page.getByRole('region', { name: t.entries.list.label, exact: true });

/** The month the list shows, between Previous and Next: "Oct 2026". */
const shownMonth = (page: Page) => list(page).getByRole('navigation', { name: t.entries.list.monthNav }).getByRole('paragraph');

/** An entry's row: a button named by its title, its category and account, and its amount. */
const row = (page: Page, name: string) => list(page).getByRole('button', { name, exact: true });

/** The form opened in place of a row. */
const editPanel = (page: Page) => list(page).getByRole('region', { name: t.entries.edit.heading, exact: true });

/** The new-entry form's panel for the chosen type. */
const typePanel = (page: Page, type: 'Expense' | 'Income') => page.getByRole('tabpanel', { name: type, exact: true });

async function noSeriousAxeFindings(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test.beforeEach(async ({ context }) => {
  // Nothing but this machine answers: a host no helper mocks is refused rather than reached.
  await context.route(
    (url) => !['localhost', '127.0.0.1'].includes(url.hostname),
    (route) => route.abort(),
  );
});

test.describe('adding an entry', () => {
  test('an expense is saved and listed under its day, in the month it is dated', async ({ page }) => {
    await openWith(page, '/entries/new');
    await expect(heading(page, t.shell.headings.newEntry)).toBeVisible();
    const form = typePanel(page, 'Expense');
    await expect(form.getByRole('textbox', { name: t.entries.form.amount })).toBeVisible();
    await noSeriousAxeFindings(page);

    await form.getByRole('textbox', { name: t.entries.form.amount }).fill('12.50');
    await form.getByRole('radio', { name: 'Eating out', exact: true }).check();
    await form.getByRole('textbox', { name: t.entries.form.note }).fill('TEST-Döner');
    await form.getByRole('button', { name: t.entries.form.saveExpense, exact: true }).click();

    await expect(page).toHaveURL('/entries?month=2026-10');
    await expect(list(page).getByRole('heading', { level: 3 })).toHaveText(['Tuesday, 20 October']);
    await expect(row(page, `TEST-Döner Eating out · ${BANK} €12.50`)).toBeVisible();

    const saved = await readStore<MoneyEntry>(page, 'entries');
    expect(saved.map(({ type, date, categoryId, amountMinor, eurMinor, note }) => ({ type, date, categoryId, amountMinor, eurMinor, note }))).toEqual([
      { type: 'expense', date: '2026-10-20', categoryId: 'eating-out', amountMinor: 1250, eurMinor: 1250, note: 'TEST-Döner' },
    ]);
  });

  test('an income dated last month opens that month, with a plus before its amount', async ({ page }) => {
    await openWith(page, '/entries/new');
    await page.getByRole('tab', { name: t.entries.form.income, exact: true }).click();
    const form = typePanel(page, 'Income');
    await form.getByRole('textbox', { name: t.entries.form.amount }).fill('200');
    await form.getByRole('radio', { name: 'Parents', exact: true }).check();
    await form.getByRole('textbox', { name: 'Date', exact: true }).fill('05.09.2026');
    await form.getByRole('textbox', { name: 'Date', exact: true }).press('Tab');
    await form.getByRole('textbox', { name: t.entries.form.note }).fill('TEST-Pocket money');
    await form.getByRole('button', { name: t.entries.form.saveIncome, exact: true }).click();

    await expect(page).toHaveURL('/entries?month=2026-09');
    await expect(shownMonth(page)).toHaveText('Sept 2026'); // en-IE's short September
    await expect(row(page, `TEST-Pocket money Parents · ${BANK} +€200.00`)).toBeVisible();
  });

  test('"Save and add another" keeps the form open for the next one', async ({ page }) => {
    await openWith(page, '/entries/new');
    const form = typePanel(page, 'Expense');
    const amount = form.getByRole('textbox', { name: t.entries.form.amount });
    await amount.fill('3.20');
    await form.getByRole('textbox', { name: t.entries.form.note }).fill('TEST-Coffee');
    await form.getByRole('button', { name: t.entries.form.saveAnother, exact: true }).click();

    await expect(form.getByRole('status')).toHaveText(t.entries.form.savedAnother);
    await expect(page).toHaveURL('/entries/new');
    await expect(amount).toHaveValue('');
    await expect(amount).toBeFocused();
    expect((await readStore<Entry>(page, 'entries')).map((e) => e.amountMinor)).toEqual([320]);
  });

  test('no amount, a zero or text is refused and nothing is saved; a cent is enough', async ({ page }) => {
    await openWith(page, '/entries/new');
    const form = typePanel(page, 'Expense');
    const amount = form.getByRole('textbox', { name: t.entries.form.amount });
    const save = form.getByRole('button', { name: t.entries.form.saveExpense, exact: true });

    for (const typed of ['', '   ', '0', 'twelve']) {
      await amount.fill(typed);
      await save.click();
      await expect(form.getByRole('alert')).toHaveText(t.entries.errors.enterAmount);
      await expect(amount).toHaveAttribute('aria-invalid', 'true');
      await expect(page).toHaveURL('/entries/new');
    }
    expect(await readStore<Entry>(page, 'entries')).toEqual([]);

    // The other side of the "more than zero" rule.
    await amount.fill('0.01');
    await save.click();
    await expect(page).toHaveURL('/entries?month=2026-10');
    await expect(row(page, `Food & groceries ${BANK} €0.01`)).toBeVisible();
  });

  test('a cleared date asks for one and saves nothing', async ({ page }) => {
    await openWith(page, '/entries/new');
    const form = typePanel(page, 'Expense');
    await form.getByRole('textbox', { name: t.entries.form.amount }).fill('5');
    await form.getByRole('textbox', { name: 'Date', exact: true }).fill('');
    await form.getByRole('textbox', { name: 'Date', exact: true }).press('Tab');
    await form.getByRole('button', { name: t.entries.form.saveExpense, exact: true }).click();

    await expect(form.getByRole('alert')).toHaveText(t.entries.form.pickDate);
    await expect(page).toHaveURL('/entries/new');
    expect(await readStore<Entry>(page, 'entries')).toEqual([]);
  });
});

test.describe('editing an entry', () => {
  const groceries: EntrySeed = { date: '2026-10-14', categoryId: 'food', amountMinor: 2000, note: 'TEST-Groceries' };

  test('a changed amount and category show on the row once saved', async ({ page }) => {
    await openWith(page, '/entries', [groceries]);
    await row(page, `TEST-Groceries Food & groceries · ${BANK} €20.00`).click();

    const panel = editPanel(page);
    await expect(panel.getByRole('textbox', { name: t.entries.form.amount })).toHaveValue('20');
    await panel.getByRole('textbox', { name: t.entries.form.amount }).fill('25.40');
    await panel.getByRole('radio', { name: 'Eating out', exact: true }).check();
    await panel.getByRole('button', { name: t.entries.form.saveChanges, exact: true }).click();

    await expect(panel).toBeHidden();
    await expect(row(page, `TEST-Groceries Eating out · ${BANK} €25.40`)).toBeVisible();
    const [saved] = await readStore<MoneyEntry>(page, 'entries');
    expect({ id: saved.id, categoryId: saved.categoryId, amountMinor: saved.amountMinor, eurMinor: saved.eurMinor }).toEqual({
      id: 'e2e-entry-1',
      categoryId: 'eating-out',
      amountMinor: 2540,
      eurMinor: 2540,
    });
  });

  test('an emptied amount is refused, and Cancel leaves the entry as it was', async ({ page }) => {
    await openWith(page, '/entries', [groceries]);
    await row(page, `TEST-Groceries Food & groceries · ${BANK} €20.00`).click();

    const panel = editPanel(page);
    await panel.getByRole('textbox', { name: t.entries.form.amount }).fill('');
    await panel.getByRole('button', { name: t.entries.form.saveChanges, exact: true }).click();
    await expect(panel.getByRole('alert')).toHaveText(t.entries.errors.enterAmount);
    await expect(panel).toBeVisible();

    await panel.getByRole('button', { name: t.entries.edit.cancel, exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(row(page, `TEST-Groceries Food & groceries · ${BANK} €20.00`)).toBeVisible();
    expect((await readStore<Entry>(page, 'entries')).map((e) => e.amountMinor)).toEqual([2000]);
  });
});

test.describe('deleting an entry', () => {
  const entries: EntrySeed[] = [
    { date: '2026-10-14', categoryId: 'food', amountMinor: 2000, note: 'TEST-Groceries' },
    { date: '2026-10-15', categoryId: 'eating-out', amountMinor: 650, note: 'TEST-Döner' },
  ];

  test('Delete asks first, and Cancel keeps the entry', async ({ page }) => {
    await openWith(page, '/entries', entries);
    await row(page, `TEST-Groceries Food & groceries · ${BANK} €20.00`).click();
    const panel = editPanel(page);
    await panel.getByRole('button', { name: t.entries.edit.delete, exact: true }).click();

    const question = panel.getByRole('group', { name: t.entries.edit.deleteQuestion, exact: true });
    await expect(question).toBeVisible();
    await question.getByRole('button', { name: t.entries.edit.cancel, exact: true }).click();

    await expect(question).toBeHidden();
    await expect(panel.getByRole('button', { name: t.entries.edit.delete, exact: true })).toBeVisible();
    expect((await readStore<Entry>(page, 'entries')).length).toBe(2);
  });

  test('Yes removes the entry, and the last one leaves the month empty', async ({ page }) => {
    await openWith(page, '/entries', entries);

    for (const name of [`TEST-Groceries Food & groceries · ${BANK} €20.00`, `TEST-Döner Eating out · ${BANK} €6.50`]) {
      await row(page, name).click();
      const panel = editPanel(page);
      await panel.getByRole('button', { name: t.entries.edit.delete, exact: true }).click();
      await panel.getByRole('button', { name: t.entries.edit.yes, exact: true }).click();
      await expect(panel).toBeHidden();
      await expect(row(page, name)).toBeHidden();
    }

    await expect(list(page).getByText(t.entries.list.nothingYet, { exact: true })).toBeVisible();
    expect(await readStore<Entry>(page, 'entries')).toEqual([]);
  });
});

test.describe('the list and its filters', () => {
  const entries: EntrySeed[] = [
    { date: '2026-09-10', categoryId: 'eating-out', amountMinor: 900, note: 'TEST-September pizza' },
    { date: '2026-10-14', categoryId: 'food', amountMinor: 2000, note: 'TEST-Groceries' },
    { date: '2026-10-15', categoryId: 'eating-out', amountMinor: 650, note: 'TEST-Döner' },
    { type: 'income', date: '2026-10-15', categoryId: 'income-parents', amountMinor: 50000, note: 'TEST-Pocket money' },
  ];
  const groceries = `TEST-Groceries Food & groceries · ${BANK} €20.00`;
  const doner = `TEST-Döner Eating out · ${BANK} €6.50`;
  const pocketMoney = `TEST-Pocket money Parents · ${BANK} +€500.00`;
  const pizza = `TEST-September pizza Eating out · ${BANK} €9.00`;

  test('shows this month newest day first, and Previous and This month move between months', async ({ page }) => {
    await openWith(page, '/entries', entries);
    await expect(shownMonth(page)).toHaveText('Oct 2026');
    await expect(list(page).getByRole('heading', { level: 3 })).toHaveText(['Thursday, 15 October', 'Wednesday, 14 October']);
    // Within a day, the entry saved last comes first.
    await expect(list(page).getByRole('button')).toHaveText([/^TEST-Pocket money/, /^TEST-Döner/, /^TEST-Groceries/]);
    await expect(list(page).getByRole('link', { name: t.entries.list.thisMonth })).toHaveCount(0);
    await noSeriousAxeFindings(page);

    await list(page).getByRole('link', { name: t.entries.list.previous, exact: true }).click();
    await expect(page).toHaveURL('/entries?month=2026-09');
    await expect(shownMonth(page)).toHaveText('Sept 2026'); // en-IE's short September
    await expect(row(page, pizza)).toBeVisible();
    await expect(row(page, groceries)).toBeHidden();

    await list(page).getByRole('link', { name: t.entries.list.thisMonth }).click();
    await expect(page).toHaveURL('/entries');
    await expect(shownMonth(page)).toHaveText('Oct 2026');
    await expect(row(page, groceries)).toBeVisible();
  });

  test('a category keeps only its entries, and its chip shows them all again', async ({ page }) => {
    await openWith(page, '/entries?category=eating-out', entries);
    await expect(row(page, doner)).toBeVisible();
    await expect(list(page).getByRole('button')).toHaveCount(1);
    // The month switch keeps the category.
    await expect(list(page).getByRole('link', { name: t.entries.list.previous, exact: true })).toHaveAttribute(
      'href',
      '/entries?month=2026-09&category=eating-out',
    );

    await list(page).getByRole('link', { name: t.entries.list.showAllCategories('Eating out'), exact: true }).click();
    await expect(page).toHaveURL('/entries');
    await expect(row(page, groceries)).toBeVisible();
    await expect(row(page, doner)).toBeVisible();
    await expect(row(page, pocketMoney)).toBeVisible();
  });

  test('in another month, This month keeps the category and the chip keeps the month', async ({ page }) => {
    await openWith(page, '/entries?month=2026-09&category=eating-out', entries);
    await expect(row(page, pizza)).toBeVisible();
    await expect(list(page).getByRole('link', { name: t.entries.list.showAllCategories('Eating out'), exact: true })).toHaveAttribute(
      'href',
      '/entries?month=2026-09',
    );

    await list(page).getByRole('link', { name: t.entries.list.thisMonth }).click();
    await expect(page).toHaveURL('/entries?category=eating-out');
    await expect(shownMonth(page)).toHaveText('Oct 2026');
    await expect(row(page, doner)).toBeVisible();
    await expect(list(page).getByRole('button')).toHaveCount(1);
  });

  test('a month or category the app does not know shows this month with every category', async ({ page }) => {
    await openWith(page, '/entries?month=2026-13&category=TEST-nope', entries);
    await expect(shownMonth(page)).toHaveText('Oct 2026');
    await expect(list(page).getByRole('button')).toHaveCount(3);
    await expect(list(page).getByRole('link', { name: /show all categories$/ })).toHaveCount(0);
    await expect(list(page).getByRole('link', { name: t.entries.list.thisMonth })).toHaveCount(0);
  });
});
