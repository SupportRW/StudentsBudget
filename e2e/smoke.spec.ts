import { expect, test } from '@playwright/test';
import { en } from '../src/i18n/messages/en';
import { openApp } from './helpers/app';
import { collectPageErrors } from './helpers/page-errors';
import { heading } from './helpers/pages';
import { seedSetup } from './helpers/seed-setup';

// The smoke spec: CI's `changed` runs add it to every list of picked specs (scripts/ci-affected.mjs, SMOKE_SPEC), so it
// stays short. It proves the app starts and its frame works, never a feature: each feature has its own spec.

const nav = en.shell.nav;
const headings = en.shell.headings;

test('a phone with no plan opens the start page', async ({ page }) => {
  const errors = collectPageErrors(page);
  await openApp(page, '/');

  await expect(page).toHaveURL('/start');
  await expect(heading(page, headings.start)).toBeAttached(); // visually hidden: it names the page, the headline shows
  for (const name of [en.account.start.create, en.account.start.signIn, en.account.start.guest]) {
    await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
  }
  // No navigation before a plan exists: a tap there would leave a half-finished setup behind (BottomNav).
  await expect(page.getByRole('navigation', { name: en.shell.navLabel, exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('with a plan, the navigation opens each of its pages', async ({ page }) => {
  const errors = collectPageErrors(page);
  await seedSetup(page);

  const menu = page.getByRole('navigation', { name: en.shell.navLabel, exact: true });
  const home = page.getByRole('region', { name: en.home.leftThisMonth.heading, exact: true });
  await expect(home).toBeVisible();

  // Client-side navigation, as a person taps through: a page that throws or loses its heading fails here.
  const pages = [
    { link: nav.entries, path: '/entries', heading: headings.entries },
    { link: nav.charts, path: '/charts', heading: headings.charts },
    { link: nav.tips, path: '/tips', heading: headings.tips },
    { link: nav.settings, path: '/settings', heading: headings.settings },
  ];
  for (const target of pages) {
    await menu.getByRole('link', { name: target.link, exact: true }).click();
    await expect(page).toHaveURL(target.path);
    await expect(heading(page, target.heading)).toBeVisible();
  }

  await menu.getByRole('link', { name: nav.home, exact: true }).click();
  await expect(page).toHaveURL('/');
  await expect(home).toBeVisible();
  expect(errors).toEqual([]);
});
