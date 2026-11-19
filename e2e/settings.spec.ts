import { expect, test, type Page } from '@playwright/test';
import { categoryNameIn } from '../src/i18n/category-name';
import { LANGUAGE_STORAGE_KEY, LANGUAGES } from '../src/i18n/languages';
import { MESSAGES, type Messages } from '../src/i18n/messages';
import { THEME_STORAGE_KEY } from '../src/theme/themes';
import { openApp, waitForApp, waitForHome } from './helpers/app';
import { noSeriousAxeFindings } from './helpers/axe';
import { horizontalOverflow, widerThanThePage } from './helpers/layout';
import { heading } from './helpers/pages';
import { seedSetup } from './helpers/seed-setup';
import { ensureClock, readStore } from './helpers/setup';
import type { Plan } from '../src/db/types';

// Settings (/settings) and the pages this spec is about: the list with its summaries, Appearance (the theme), the
// language globe in the header as Settings shows it, and Plan with Edit plan and the fixed costs' pause. The account
// and sign-in pages have their own spec. The words come from the app's own dictionaries; the amounts, which are what
// the tests are about, are written out.

const en = MESSAGES.en;
const de = MESSAGES.de;

/** A row of the Settings list: the link is named by its page's title, then its summary. */
const row = (page: Page, name: string) => page.getByRole('link', { name, exact: true });

/** A row of the Settings list by its title alone, when the summary isn't what the test is about. */
const rowTitled = (page: Page, title: string) => page.getByRole('link', { name: new RegExp(`^${title} `) });

/** The accent card on Settings → Plan, named by the page's heading. */
const planCard = (page: Page, t: Messages = en) => page.getByRole('region', { name: t.shell.headings.plan, exact: true });

/** The card's line of what comes in and goes on fixed costs each month: "€900 in · €400 fixed". */
const monthlyLine = (page: Page) => planCard(page).getByRole('paragraph').nth(1);

// The page's <html>, which carries the theme (`dark`) and the language (`lang`): it has no role to find it by.
const html = (page: Page) => page.locator('html');

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

/** The wizard's step title, its level-3 heading. */
const stepTitle = (page: Page, name: string) => page.getByRole('heading', { level: 3, name, exact: true });

/** Opens Settings → Plan with the fixture's plan: €900 coming in (parents 500, job 400) and €400 rent. */
async function openPlan(page: Page, options: Parameters<typeof seedSetup>[2] = {}) {
  await seedSetup(page, {}, { ...options, open: false });
  await openApp(page, '/settings/plan');
  await expect(heading(page, en.shell.headings.plan)).toBeVisible();
}

/** Chooses a language from the header's globe, as a student does. */
async function chooseFromGlobe(page: Page, label: string, languageName: string) {
  await button(page, label).click();
  await page.getByRole('menuitemradio', { name: languageName, exact: true }).click();
}

test.beforeEach(async ({ context }) => {
  // Nothing but this machine answers: a host no helper mocks is refused rather than reached.
  await context.route(
    (url) => !['localhost', '127.0.0.1'].includes(url.hostname),
    (route) => route.abort(),
  );
});

test.describe('the Settings list', () => {
  test('without a plan, its first row leads to setup and there is no Plan row', async ({ page }) => {
    await ensureClock(page);
    await openApp(page, '/settings');
    await expect(heading(page, en.shell.headings.settings)).toBeVisible();

    await expect(row(page, `${en.setup.setupRow.title} ${en.setup.setupRow.summary}`)).toBeVisible();
    await expect(row(page, `${en.shell.headings.accounts} ${en.accounts.summaryNone}`)).toBeVisible();
    await expect(rowTitled(page, en.shell.headings.plan)).toHaveCount(0);

    await row(page, `${en.setup.setupRow.title} ${en.setup.setupRow.summary}`).click();
    await expect(page).toHaveURL('/setup');
    await expect(heading(page, en.setup.headingNew)).toBeVisible();
  });

  test('with a plan, each row says what is set there, and a row opens its page and comes back', async ({ page }) => {
    await seedSetup(page, {}, { open: false });
    await openApp(page, '/settings');
    await expect(heading(page, en.shell.headings.settings)).toBeVisible();

    // Local bank €1,000 + Home bank ₹50,000 at 95 (€526.32) + Cash €50 = €1,576.32, shown whole as on Home.
    await expect(row(page, `${en.shell.headings.accounts} ${en.accounts.summary(3, '€1,576')}`)).toBeVisible();
    await expect(row(page, `${en.shell.headings.plan} ${en.setup.editPlan.summary}`)).toBeVisible();
    await expect(row(page, `${en.shell.headings.profile} ${en.profile.summaryNone}`)).toBeVisible();
    await expect(row(page, `${en.shell.headings.appearance} ${en.theme.choices.light}`)).toBeVisible();
    await expect(rowTitled(page, en.setup.setupRow.title)).toHaveCount(0);

    await row(page, `${en.shell.headings.plan} ${en.setup.editPlan.summary}`).click();
    await expect(page).toHaveURL('/settings/plan');
    await expect(heading(page, en.shell.headings.plan)).toBeVisible();
    await page.getByRole('link', { name: en.shell.backToSettings, exact: true }).click();
    await expect(page).toHaveURL('/settings');
    await expect(heading(page, en.shell.headings.settings)).toBeVisible();
  });
});

test.describe('Appearance', () => {
  test('Dark is drawn at once, named on the Settings list, and kept over a reload', async ({ page }) => {
    await ensureClock(page);
    await openApp(page, '/settings/appearance');
    const dark = page.getByRole('radio', { name: en.theme.choices.dark, exact: true });
    await expect(page.getByRole('radio', { name: en.theme.choices.light, exact: true })).toBeChecked();
    await expect(html(page)).not.toHaveClass(/\bdark\b/);

    await dark.click();
    await expect(html(page)).toHaveClass(/\bdark\b/);

    await page.reload();
    await waitForApp(page);
    await expect(dark).toBeChecked();
    await expect(html(page)).toHaveClass(/\bdark\b/);

    // No plan here, so the page's back link leads to setup: the list is opened as a page.
    await openApp(page, '/settings');
    await expect(row(page, `${en.shell.headings.appearance} ${en.theme.choices.dark}`)).toBeVisible();
  });

  test('Same as phone follows the phone’s own setting, and Light draws light again', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await ensureClock(page);
    await openApp(page, '/settings/appearance');
    // Light, the default, ignores the dark phone.
    await expect(html(page)).not.toHaveClass(/\bdark\b/);

    await page.getByRole('radio', { name: en.theme.choices.system, exact: true }).click();
    await expect(html(page)).toHaveClass(/\bdark\b/);

    await page.emulateMedia({ colorScheme: 'light' });
    await expect(html(page)).not.toHaveClass(/\bdark\b/);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(html(page)).toHaveClass(/\bdark\b/);

    await page.getByRole('radio', { name: en.theme.choices.light, exact: true }).click();
    await expect(html(page)).not.toHaveClass(/\bdark\b/);
  });

  test('a stored theme this build doesn’t know draws light, with Light chosen', async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, 'TEST-sepia'), THEME_STORAGE_KEY);
    await ensureClock(page);
    await openApp(page, '/settings/appearance');

    await expect(page.getByRole('radio', { name: en.theme.choices.light, exact: true })).toBeChecked();
    await expect(html(page)).not.toHaveClass(/\bdark\b/);
    // No plan here, so the page's back link leads to setup: the list is opened as a page.
    await openApp(page, '/settings');
    await expect(row(page, `${en.shell.headings.appearance} ${en.theme.choices.light}`)).toBeVisible();
  });
});

test.describe('the language on Settings', () => {
  test('the globe switches Settings to German, kept on the next page and over a reload', async ({ page }) => {
    await ensureClock(page);
    await openApp(page, '/settings');
    await expect(heading(page, en.shell.headings.settings)).toBeVisible();

    await chooseFromGlobe(page, en.language.label, LANGUAGES.de.name);
    await expect(heading(page, de.shell.headings.settings)).toBeVisible();
    await expect(html(page)).toHaveAttribute('lang', 'de');
    await expect(row(page, `${de.shell.headings.appearance} ${de.theme.choices.light}`)).toBeVisible();

    await row(page, `${de.shell.headings.appearance} ${de.theme.choices.light}`).click();
    await expect(heading(page, de.shell.headings.appearance)).toBeVisible();
    await expect(page.getByRole('radio', { name: de.theme.choices.dark, exact: true })).toBeVisible();

    await page.reload();
    await waitForApp(page);
    await expect(heading(page, de.shell.headings.appearance)).toBeVisible();
    await expect(html(page)).toHaveAttribute('lang', 'de');
  });

  test('a stored language this build doesn’t offer falls back to English', async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, 'xx'), LANGUAGE_STORAGE_KEY);
    await ensureClock(page);
    await openApp(page, '/settings');

    await expect(heading(page, en.shell.headings.settings)).toBeVisible();
    await expect(html(page)).toHaveAttribute('lang', 'en');
    await expect(row(page, `${en.shell.headings.appearance} ${en.theme.choices.light}`)).toBeVisible();
  });
});

test.describe('settings · de-DE', () => {
  test.use({ locale: 'de-DE' });

  test('a phone set to German opens Settings in German, until English is chosen and kept', async ({ page }) => {
    await ensureClock(page);
    await openApp(page, '/settings');
    await expect(heading(page, de.shell.headings.settings)).toBeVisible();
    await expect(row(page, `${de.shell.headings.appearance} ${de.theme.choices.light}`)).toBeVisible();

    await chooseFromGlobe(page, de.language.label, LANGUAGES.en.name);
    await expect(heading(page, en.shell.headings.settings)).toBeVisible();

    await page.reload();
    await waitForApp(page);
    await expect(heading(page, en.shell.headings.settings)).toBeVisible();
    await expect(html(page)).toHaveAttribute('lang', 'en');
  });
});

test.describe('the plan from Settings', () => {
  test('Plan sums what comes in and the fixed costs, and Edit plan’s new rent shows there once saved', async ({ page }) => {
    const text = en.setup;
    await openPlan(page);
    await expect(planCard(page).getByText(text.editPlan.eachMonth, { exact: true })).toBeVisible();
    await expect(monthlyLine(page)).toHaveText('€900 in · €400 fixed');

    await planCard(page).getByRole('link', { name: text.editPlan.link, exact: true }).click();
    await expect(page).toHaveURL('/setup?edit=1');
    await expect(heading(page, text.headingEdit)).toBeVisible();
    await expect(stepTitle(page, text.titles.income)).toBeVisible();
    await button(page, text.next).click();
    await expect(stepTitle(page, text.titles.fixed)).toBeVisible();
    const rent = page.getByRole('textbox', { name: text.fixed.rentLabel, exact: true });
    await expect(rent).toHaveValue('400');
    await rent.fill('450');
    await button(page, text.next).click();
    await expect(stepTitle(page, text.titles['one-offs'])).toBeVisible();
    await button(page, text.next).click();
    await expect(stepTitle(page, text.titles.envelopes)).toBeVisible();
    await button(page, text.save).click();
    await waitForHome(page);

    await page.getByRole('link', { name: en.shell.nav.settings, exact: true }).click();
    await rowTitled(page, en.shell.headings.plan).click();
    await expect(monthlyLine(page)).toHaveText('€900 in · €450 fixed');
    const [plan] = await readStore<Plan>(page, 'plan');
    expect(plan.fixed.find((line) => line.categoryId === 'rent')?.monthlyMinor).toBe(45_000);
  });

  test('rent that is no amount keeps Edit plan on its step, and the plan stays as it was', async ({ page }) => {
    const text = en.setup;
    await openPlan(page);
    await planCard(page).getByRole('link', { name: text.editPlan.link, exact: true }).click();
    await expect(stepTitle(page, text.titles.income)).toBeVisible();
    await button(page, text.next).click();
    await page.getByRole('textbox', { name: text.fixed.rentLabel, exact: true }).fill('four hundred');
    await button(page, text.next).click();

    // Scoped to the main region: Next's route announcer is an alert too.
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      text.problems.checkAmount(categoryNameIn(en, 'rent')),
    );
    await expect(stepTitle(page, text.titles.fixed)).toBeVisible();

    await page.getByRole('link', { name: en.shell.nav.settings, exact: true }).click();
    await rowTitled(page, en.shell.headings.plan).click();
    await expect(monthlyLine(page)).toHaveText('€900 in · €400 fixed');
    const [plan] = await readStore<Plan>(page, 'plan');
    expect(plan.fixed.find((line) => line.categoryId === 'rent')?.monthlyMinor).toBe(40_000);
  });

  test('a paused rent leaves the monthly sum, and Resume brings it back', async ({ page }) => {
    const rentName = categoryNameIn(en, 'rent');
    await openPlan(page, { schedules: true });
    await expect(monthlyLine(page)).toHaveText('€900 in · €400 fixed');

    await button(page, en.recurring.pauseLine(rentName)).click();
    await expect(monthlyLine(page)).toHaveText('€900 in');
    await expect(button(page, en.recurring.resumeLine(rentName))).toBeVisible();

    await button(page, en.recurring.resumeLine(rentName)).click();
    await expect(monthlyLine(page)).toHaveText('€900 in · €400 fixed');
  });

  test('with no income and no fixed costs, only the words and Edit plan show', async ({ page }) => {
    await seedSetup(page, { rent: '', incomes: { parents: '', job: '' } }, { open: false });
    await openApp(page, '/settings/plan');
    await expect(planCard(page).getByRole('link', { name: en.setup.editPlan.link, exact: true })).toBeVisible();
    await expect(planCard(page).getByText(en.setup.editPlan.body, { exact: true })).toBeVisible();
    await expect(planCard(page).getByText(en.setup.editPlan.eachMonth, { exact: true })).toHaveCount(0);
  });

  test('without a plan, Plan says to set one up first and leads to setup', async ({ page }) => {
    await ensureClock(page);
    await openApp(page, '/settings/plan');
    await expect(heading(page, en.shell.headings.plan)).toBeVisible();
    await expect(page.getByText(en.setup.editPlan.noPlan, { exact: true })).toBeVisible();
    await expect(planCard(page)).toHaveCount(0);

    await page.getByRole('link', { name: en.common.toSetup, exact: true }).click();
    await expect(page).toHaveURL('/setup');
    await expect(heading(page, en.setup.headingNew)).toBeVisible();
  });
});

test.describe('the pages as a whole', () => {
  test('Settings, Plan and Appearance have no serious accessibility finding, light and dark, and nothing scrolls sideways', async ({
    page,
  }) => {
    await seedSetup(page, {}, { open: false, schedules: true });
    for (const { path, name } of [
      { path: '/settings', name: en.shell.headings.settings },
      { path: '/settings/plan', name: en.shell.headings.plan },
      { path: '/settings/appearance', name: en.shell.headings.appearance },
    ]) {
      await openApp(page, path);
      await expect(heading(page, name)).toBeVisible();
      await noSeriousAxeFindings(page);
      expect(await horizontalOverflow(page), await widerThanThePage(page)).toBe(0);
    }

    await page.getByRole('radio', { name: en.theme.choices.dark, exact: true }).click();
    await expect(html(page)).toHaveClass(/\bdark\b/);
    await noSeriousAxeFindings(page);
    await openApp(page, '/settings/plan');
    await expect(monthlyLine(page)).toHaveText('€900 in · €400 fixed');
    await noSeriousAxeFindings(page);
  });
});
