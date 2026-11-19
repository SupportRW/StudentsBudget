import { expect, test, type Page } from '@playwright/test';
import { OFFERED, type Language } from '../src/i18n/languages';
import { MESSAGES } from '../src/i18n/messages';
import { openApp } from './helpers/app';
import { chooseLanguage } from './helpers/languages';
import { heading } from './helpers/pages';
import { seedSetup } from './helpers/seed-setup';

const en = MESSAGES.en;

/**
 * The empty week's line, written out rather than read from the dictionaries: the spec is about this wording (it names
 * quick add above), so a change to it must fail here, not follow along.
 */
const EMPTY_WEEK: Record<Language, string> = {
  en: 'Nothing logged this week yet. Add your first expense with quick add above.',
  de: 'Diese Woche ist noch nichts erfasst. Trag deine erste Ausgabe oben mit „Schnell erfassen“ ein.',
  fr: 'Rien de saisi cette semaine pour l’instant. Ajoute ta première dépense avec l’ajout rapide ci-dessus.',
  es: 'Esta semana aún no hay nada registrado. Añade tu primer gasto arriba con Añadir rápido.',
};

/** A plan with no entries (the fixture's lines are added by hand), then the check-in on `SETUP_DAY`'s week. */
async function openEmptyCheckIn(page: Page) {
  await seedSetup(page, {}, { open: false });
  await openApp(page, '/check-in');
  await expect(heading(page, en.shell.headings.checkIn)).toBeVisible();
}

test.describe('check-in: a week with nothing logged', () => {
  test('points to quick add, which sits above it', async ({ page }) => {
    await openEmptyCheckIn(page);

    const empty = page.getByText(EMPTY_WEEK.en, { exact: true });
    await expect(empty).toBeVisible();
    // The line says "above": the field it names must be there, and higher on the page.
    const quickAdd = page.getByRole('textbox', { name: en.entries.quickAdd.label, exact: true });
    await expect(quickAdd).toBeVisible();
    const field = await quickAdd.boundingBox();
    const line = await empty.boundingBox();
    expect(field && line && field.y + field.height <= line.y).toBe(true);
  });

  test('the line goes once quick add logs the first expense', async ({ page }) => {
    await openEmptyCheckIn(page);
    await expect(page.getByText(EMPTY_WEEK.en, { exact: true })).toBeVisible();

    const quickAdd = page.getByRole('textbox', { name: en.entries.quickAdd.label, exact: true });
    await quickAdd.fill('Döner 6');
    await quickAdd.press('Enter');

    const logged = page.getByRole('list', { name: en.checkIn.thisWeek.logged, exact: true });
    await expect(logged.getByRole('listitem')).toHaveCount(1);
    await expect(page.getByText(EMPTY_WEEK.en, { exact: true })).toBeHidden();
  });

  for (const code of OFFERED.filter((c): c is Exclude<Language, 'en'> => c !== 'en')) {
    test(`says so in ${code}, naming its quick add field`, async ({ page }) => {
      const t = MESSAGES[code];
      await openEmptyCheckIn(page);
      await chooseLanguage(page, code);

      await expect(heading(page, t.shell.headings.checkIn)).toBeVisible();
      await expect(page.getByText(EMPTY_WEEK[code], { exact: true })).toBeVisible();
      // The line names the field by its label in this language.
      await expect(page.getByRole('textbox', { name: t.entries.quickAdd.label, exact: true })).toBeVisible();
    });
  }
});
