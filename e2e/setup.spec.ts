import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Account, Entry, Plan } from '../src/db/types';
import { categoryNameIn } from '../src/i18n/category-name';
import { LANGUAGE_STORAGE_KEY, LANGUAGES } from '../src/i18n/languages';
import { MESSAGES, type Messages } from '../src/i18n/messages';
import { openApp, waitForHome } from './helpers/app';
import { acceptPrivacyNotes } from './helpers/privacy';
import { seedSetup } from './helpers/seed-setup';
import { budgetField, ensureClock, mockFrankfurter, putAccounts, readStore } from './helpers/setup';

// The setup wizard (/setup) as a new student meets it: Accounts, Income, Fixed costs with rent, Envelopes, then Save
// plan. The words come from the app's own dictionaries; the amounts, which are what the tests are about, are written
// out. The wizard holds its draft in memory, so a test that is about a later step walks the earlier ones with their
// defaults (blank is €0, which every step accepts).

const en = MESSAGES.en;

/** The step's title, the wizard's level-3 heading. */
const stepTitle = (page: Page, name: string) => page.getByRole('heading', { level: 3, name, exact: true });

/**
 * The wizard's problem list. Scoped to the page's main region: Next's route announcer is an alert too (CLAUDE.md).
 */
const problems = (page: Page) => page.getByRole('main').getByRole('alert');

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

/** An account's card on the Accounts step: "Account 1", "Account 2", … */
const accountCard = (page: Page, t: Messages, n: number) =>
  page.getByRole('group', { name: t.setup.accounts.account(n), exact: true });

/** Opens a new setup on the setup day, with the exchange rates mocked; the rates note is accepted unless said not. */
async function openSetup(page: Page, { ratesNote = false }: { ratesNote?: boolean } = {}) {
  await mockFrankfurter(page);
  if (!ratesNote) await acceptPrivacyNotes(page, ['rates']);
  await ensureClock(page);
  await openApp(page, '/setup');
}

/** Goes on with Next and waits for the next step's title. */
async function next(page: Page, t: Messages, title: string) {
  await button(page, t.setup.next).click();
  await expect(stepTitle(page, title)).toBeVisible();
}

/** Walks to the Envelopes step with the first three steps as they open (both accounts at €0, no income or rent). */
async function toEnvelopes(page: Page) {
  await openSetup(page);
  await expect(stepTitle(page, en.setup.titles.accounts)).toBeVisible();
  await next(page, en, en.setup.titles.income);
  await next(page, en, en.setup.titles.fixed);
  await next(page, en, en.setup.titles.envelopes);
}

// The whole walk, once per offered language the tests name (C1): English, the default, and German, the region's.
for (const { lang, locale } of [
  { lang: 'en', locale: 'en-GB' },
  { lang: 'de', locale: 'de-DE' },
] as const) {
  test.describe(`setup wizard · ${lang}`, () => {
    test.use({ locale });

    test('a new student walks the four steps and saves the plan', async ({ page }) => {
      const t = MESSAGES[lang];
      const text = t.setup;
      // The language the app stored, set apart from the browser's (C3): the phone's choice wins.
      await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [LANGUAGE_STORAGE_KEY, lang]);
      await openSetup(page);

      await expect(stepTitle(page, text.titles.accounts)).toBeVisible();
      await expect(page.getByText(text.stepOf(1, 4), { exact: true })).toBeVisible();
      // A new setup starts with a bank and cash in euros, in the phone's language.
      await expect(accountCard(page, t, 1).getByRole('textbox', { name: text.accounts.name })).toHaveValue(
        text.accounts.prefilled.localBank,
      );
      await expect(accountCard(page, t, 2).getByRole('textbox', { name: text.accounts.name })).toHaveValue(
        text.accounts.prefilled.cash,
      );
      await accountCard(page, t, 1).getByRole('textbox', { name: text.accounts.opening }).fill('1000');
      await accountCard(page, t, 2).getByRole('textbox', { name: text.accounts.opening }).fill('50');

      await next(page, t, text.titles.income);
      await expect(page.getByText(text.stepOf(2, 4), { exact: true })).toBeVisible();
      await page.getByRole('textbox', { name: categoryNameIn(t, 'income-parents'), exact: true }).fill('900');

      await next(page, t, text.titles.fixed);
      await page.getByRole('textbox', { name: text.fixed.rentLabel, exact: true }).fill('400');

      await next(page, t, text.titles.envelopes);
      await expect(page.getByText(text.stepOf(4, 4), { exact: true })).toBeVisible();
      await page.getByRole('textbox', { name: categoryNameIn(t, 'food'), exact: true }).fill('310');
      await page.getByRole('textbox', { name: categoryNameIn(t, 'eating-out'), exact: true }).fill('124');
      await button(page, text.save).click();

      await waitForHome(page, t.entries.quickAdd.label);
      await expect(
        page.getByRole('region', { name: t.home.leftThisMonth.heading, exact: true }),
      ).toBeVisible();

      const accounts = await readStore<Account>(page, 'accounts');
      expect(accounts.map((a) => [a.name, a.currency, a.openingMinor]).sort()).toEqual(
        [
          [text.accounts.prefilled.cash, 'EUR', 5000],
          [text.accounts.prefilled.localBank, 'EUR', 100000],
        ].sort(),
      );
      const [plan] = await readStore<Plan>(page, 'plan');
      expect(plan.fixed.find((l) => l.categoryId === 'rent')?.monthlyMinor).toBe(40000);
      expect(plan.incomes.find((l) => l.categoryId === 'income-parents')?.monthlyMinor).toBe(90000);
      expect(plan.envelopes.filter((e) => e.monthlyMinor > 0)).toEqual([
        { categoryId: 'food', monthlyMinor: 31000 },
        { categoryId: 'eating-out', monthlyMinor: 12400 },
      ]);
      // "Add this month too" is ticked for a new income by default (review P1): the 1st has passed on the setup day,
      // so Save adds October's income at once.
      const incomes = (await readStore<Entry>(page, 'entries')).filter((e) => e.type === 'income');
      expect(incomes.map((e) => [e.date, e.amountMinor])).toEqual([['2026-10-01', 90000]]);
    });
  });
}

test.describe('setup wizard · accounts step', () => {
  test('an unnamed account and an opening balance that is no amount keep the step open', async ({ page }) => {
    const text = en.setup;
    await openSetup(page);
    await expect(stepTitle(page, text.titles.accounts)).toBeVisible();

    await accountCard(page, en, 1).getByRole('textbox', { name: text.accounts.name }).fill('   ');
    await accountCard(page, en, 2).getByRole('textbox', { name: text.accounts.opening }).fill('fifty');
    await button(page, text.next).click();

    await expect(problems(page)).toContainText(text.problems.nameAccounts);
    await expect(problems(page)).toContainText(text.problems.checkOpening(text.accounts.prefilled.cash, 2));
    await expect(stepTitle(page, text.titles.accounts)).toBeVisible();
    await expect(page.getByText(text.stepOf(1, 4), { exact: true })).toBeVisible();

    // Fixed, the messages go and Next moves on.
    await accountCard(page, en, 1).getByRole('textbox', { name: text.accounts.name }).fill('TEST-Bank');
    await accountCard(page, en, 2).getByRole('textbox', { name: text.accounts.opening }).fill('50');
    await expect(problems(page)).toHaveCount(0);
    await next(page, en, text.titles.income);
  });

  test('with every account removed, it asks for one', async ({ page }) => {
    const text = en.setup;
    await openSetup(page);
    await expect(stepTitle(page, text.titles.accounts)).toBeVisible();

    await button(page, text.accounts.remove(text.accounts.prefilled.localBank, 1)).click();
    await button(page, text.accounts.remove(text.accounts.prefilled.cash, 1)).click();
    await expect(accountCard(page, en, 1)).toHaveCount(0);
    await button(page, text.next).click();

    await expect(problems(page)).toHaveText(text.problems.addAccount);
    await expect(stepTitle(page, text.titles.accounts)).toBeVisible();
  });

  test('an account in another currency waits for the exchange-rate note', async ({ page }) => {
    const text = en.setup;
    const privacy = en.common.privacy;
    await openSetup(page, { ratesNote: true });
    await expect(stepTitle(page, text.titles.accounts)).toBeVisible();

    await accountCard(page, en, 2).getByRole('combobox', { name: text.accounts.currency }).selectOption('INR');
    await button(page, text.next).click();
    const note = page.getByRole('group', { name: privacy.label, exact: true });
    await expect(note).toBeVisible();

    // Cancel sends nothing and stays on the step.
    await note.getByRole('button', { name: privacy.cancel, exact: true }).click();
    await expect(note).toHaveCount(0);
    await expect(stepTitle(page, text.titles.accounts)).toBeVisible();

    await button(page, text.next).click();
    await note.getByRole('button', { name: privacy.continue, exact: true }).click();
    await expect(stepTitle(page, text.titles.income)).toBeVisible();
  });
});

test.describe('setup wizard · fixed costs step', () => {
  test('rent that is no amount keeps the step open, and Back drops it', async ({ page }) => {
    const text = en.setup;
    const rentName = categoryNameIn(en, 'rent');
    await openSetup(page);
    await expect(stepTitle(page, text.titles.accounts)).toBeVisible();
    await next(page, en, text.titles.income);
    await page.getByRole('textbox', { name: categoryNameIn(en, 'income-parents'), exact: true }).fill('500');
    await next(page, en, text.titles.fixed);

    const rent = page.getByRole('textbox', { name: text.fixed.rentLabel, exact: true });
    await rent.fill('four hundred');
    await button(page, text.next).click();
    await expect(problems(page)).toContainText(text.problems.checkAmount(rentName));
    await expect(stepTitle(page, text.titles.fixed)).toBeVisible();

    // Back keeps what parsed (the income) and forgets what didn't (the rent's text), so the step can go on.
    await button(page, text.back).click();
    await expect(stepTitle(page, text.titles.income)).toBeVisible();
    await expect(page.getByRole('textbox', { name: categoryNameIn(en, 'income-parents'), exact: true })).toHaveValue(
      '500',
    );
    await next(page, en, text.titles.fixed);
    await expect(rent).toHaveValue('');
    await next(page, en, text.titles.envelopes);
  });
});

test.describe('setup wizard · envelopes step', () => {
  test('the budget line follows the envelopes, and the suggestions fill only those not set', async ({ page }) => {
    const text = en.setup;
    await toEnvelopes(page);
    const food = page.getByRole('textbox', { name: categoryNameIn(en, 'food'), exact: true });
    const main = page.getByRole('main');

    await food.fill('310');
    await budgetField(page).fill('600');
    await expect(main.getByText(text.lines.ofBudget('€310', '€600'), { exact: true })).toBeVisible();

    await button(page, text.envelopes.useSuggested).click();
    await expect(food).toHaveValue('310');
    // The suggestions share out the rest of the budget in €5 steps: exactly the budget, which still reads "of".
    await expect(main.getByText(text.lines.ofBudget('€600', '€600'), { exact: true })).toBeVisible();
    await expect(button(page, text.envelopes.useSuggested)).toHaveCount(0);

    // €5 more than the budget reads as over it.
    await food.fill('315');
    await expect(main.getByText(text.lines.overBudget('€5', '€600'), { exact: true })).toBeVisible();

    await button(page, text.save).click();
    await waitForHome(page);
    const [plan] = await readStore<Plan>(page, 'plan');
    expect(plan.spendingBudgetMinor).toBe(60000);
    expect(plan.envelopes.reduce((total, e) => total + e.monthlyMinor, 0)).toBe(60500);
  });

  test('an envelope that is no amount stops Save, and nothing is saved', async ({ page }) => {
    const text = en.setup;
    await toEnvelopes(page);

    await page.getByRole('textbox', { name: categoryNameIn(en, 'food'), exact: true }).fill('lots');
    await button(page, text.save).click();

    await expect(problems(page)).toContainText(text.problems.checkAmount(categoryNameIn(en, 'food')));
    await expect(stepTitle(page, text.titles.envelopes)).toBeVisible();
    await expect(page).toHaveURL('/setup');
    expect(await readStore<Plan>(page, 'plan')).toEqual([]);
    expect(await readStore<Account>(page, 'accounts')).toEqual([]);
  });
});

test.describe('setup wizard · where it starts', () => {
  test('accounts saved in Settings first: three steps, and the accounts are kept', async ({ page }) => {
    const text = en.setup;
    await mockFrankfurter(page);
    await ensureClock(page);
    // Tips reads nothing from the database, so the write can't race a redirect (seed-setup.ts).
    await openApp(page, '/tips');
    const saved: Account = {
      id: 'e2e-account-1',
      name: 'TEST-Girokonto',
      kind: 'bank',
      currency: 'EUR',
      openingMinor: 25000,
      createdAt: '2026-10-16T10:00:00.000Z',
    };
    await putAccounts(page, [saved]);
    await openApp(page, '/setup');

    await expect(stepTitle(page, text.titles.income)).toBeVisible();
    await expect(page.getByText(text.stepOf(1, 3), { exact: true })).toBeVisible();
    await expect(page.getByText(text.accountsInSettings, { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: en.shell.headings.accounts, exact: true })).toBeVisible();

    await next(page, en, text.titles.fixed);
    await next(page, en, text.titles.envelopes);
    await expect(page.getByText(text.stepOf(3, 3), { exact: true })).toBeVisible();
    await button(page, text.save).click();
    await waitForHome(page);

    expect(await readStore<Account>(page, 'accounts')).toEqual([saved]);
  });

  test('with a plan saved, /setup goes to Home instead of setting up twice', async ({ page }) => {
    await seedSetup(page);
    await openApp(page, '/setup');
    await expect(page).toHaveURL('/');
    await waitForHome(page);
    await expect(button(page, en.setup.save)).toHaveCount(0);
  });

  test('Edit plan without a plan opens a new setup', async ({ page }) => {
    await openSetup(page);
    await openApp(page, '/setup?edit=1');
    await expect(page).toHaveURL('/setup');
    await expect(page.getByRole('heading', { level: 2, name: en.setup.headingNew, exact: true })).toBeVisible();
    await expect(stepTitle(page, en.setup.titles.accounts)).toBeVisible();
  });
});

test.describe('setup wizard · language and accessibility', () => {
  test('the globe switches the wizard to German', async ({ page }) => {
    const de = MESSAGES.de;
    await openSetup(page);
    await expect(stepTitle(page, en.setup.titles.accounts)).toBeVisible();

    await button(page, en.language.label).click();
    await page.getByRole('menuitemradio', { name: LANGUAGES.de.name, exact: true }).click();

    await expect(stepTitle(page, de.setup.titles.accounts)).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: de.setup.headingNew, exact: true })).toBeVisible();
    await expect(button(page, de.setup.next)).toBeVisible();
    await expect(page.getByText(de.setup.stepOf(1, 4), { exact: true })).toBeVisible();
  });

  test('the first step has no serious accessibility findings', async ({ page }) => {
    await openSetup(page);
    await expect(stepTitle(page, en.setup.titles.accounts)).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});
