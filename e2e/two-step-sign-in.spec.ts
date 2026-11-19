import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Request } from '@playwright/test';
import { LANGUAGE_STORAGE_KEY, LANGUAGES, OFFERED, type Language } from '../src/i18n/languages';
import { MESSAGES, type Messages } from '../src/i18n/messages';
import { openApp, waitForApp } from './helpers/app';
import {
  E2E_TOTP_CODE,
  mockSupabaseAuth,
  mockSupabaseData,
  skipUnlessAccountsShow,
  type AuthCall,
  type AuthFactors,
} from './helpers/supabase';

// Synthetic accounts only: the mock answers for them, and nothing leaves this machine.
const EMAIL = 'test-two-step@example.com';
const PLAIN_EMAIL = 'test-password-only@example.com';
const PASSWORD = 'TEST-password-1';
/** A six-digit code the mocked authenticator doesn't accept. */
const WRONG_CODE = '135791';

const t = MESSAGES.en;

/** An account with a confirmed authenticator (two-step sign-in on), and one without. */
function accounts() {
  const factors: AuthFactors = new Map([
    [EMAIL, [{ id: 'factor-e2e', friendly_name: 'TEST phone', factor_type: 'totp', status: 'verified' }]],
  ]);
  return { passwords: { [EMAIL]: PASSWORD, [PLAIN_EMAIL]: PASSWORD }, factors };
}

/** The mocked account server and tables, for an account with two-step sign-in. Resolves with the auth calls. */
async function mockAccounts(page: Page): Promise<AuthCall[]> {
  const { passwords, factors } = accounts();
  const calls = await mockSupabaseAuth(page, passwords, { factors });
  await mockSupabaseData(page, { twoStep: true });
  return calls;
}

/**
 * The code step, by its level-3 heading. Signed in, Sign-in and security has a section of the same name (its level-4
 * heading, the on/off switch), in every language, so the name alone would find that one too.
 */
const codeStep = (page: Page, m: Messages = t) =>
  page
    .getByRole('region', { name: m.auth.secondStep.heading, exact: true })
    .filter({ has: page.getByRole('heading', { level: 3, name: m.auth.secondStep.heading, exact: true }) });
const codeField = (page: Page, m: Messages = t) =>
  codeStep(page, m).getByRole('textbox', { name: m.auth.secondStep.code, exact: true });
const continueButton = (page: Page, m: Messages = t) =>
  codeStep(page, m).getByRole('button', { name: m.auth.secondStep.continue, exact: true });
/** The signed-in panel, by its heading. */
const signedIn = (page: Page, m: Messages = t) => page.getByRole('region', { name: m.auth.signedIn.heading, exact: true });

/** The first step: email and password, on whichever form the page shows. */
async function signInWithPassword(page: Page, email: string, m: Messages = t) {
  const form = page.getByRole('region', { name: m.auth.signIn.headingSignIn, exact: true });
  await form.getByRole('textbox', { name: m.auth.signIn.email, exact: true }).fill(email);
  await form.getByLabel(m.auth.signIn.password, { exact: true }).fill(PASSWORD);
  await form.getByRole('button', { name: m.auth.signIn.signIn, exact: true }).click();
}

/** The code checks the app sent: each `/factors/<id>/verify` call's code. */
const verifyCodes = (calls: AuthCall[]) =>
  calls.filter((c) => /^\/factors\/[^/]+\/verify$/.test(c.path)).map((c) => (c.body as { code?: string }).code);

/** The assurance level a request's mocked token states, or null without a session. */
function aalOf(request: Request): string | null {
  const token = (request.headers()['authorization'] ?? '').replace(/^Bearer /, '');
  const payload = token.split('.')[1];
  if (!payload) return null;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString() || '{}') as { aal?: string };
  return claims.aal ?? null;
}

test.beforeEach(async ({ context }) => {
  // Nothing but this machine answers: the account server's host is mocked by path on the page, which wins over this.
  await context.route(
    (url) => !['localhost', '127.0.0.1'].includes(url.hostname),
    (route) => route.abort(),
  );
});

test.describe('the code step on Settings → Your account', () => {
  test.beforeEach(async ({ page }) => {
    await skipUnlessAccountsShow(page);
  });

  test('the password alone stops at the code step, and the right code signs in at aal2', async ({ page }) => {
    const calls = await mockAccounts(page);
    // What the account's tables are asked, and with which session.
    const dataCalls: (string | null)[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/rest/v1/') && request.method() !== 'OPTIONS') dataCalls.push(aalOf(request));
    });
    await openApp(page, '/settings/account');

    await signInWithPassword(page, EMAIL);

    await expect(codeStep(page)).toBeVisible();
    await expect(codeStep(page)).toContainText(`Enter the code from your authenticator app for ${EMAIL}.`);
    await expect(signedIn(page)).toHaveCount(0);
    // Owing the code, the phone asks the account's tables nothing.
    expect(dataCalls).toEqual([]);

    await codeField(page).fill(E2E_TOTP_CODE);
    await continueButton(page).click();

    await expect(signedIn(page)).toContainText(`Signed in as ${EMAIL}.`);
    await expect(codeStep(page)).toHaveCount(0);
    expect(verifyCodes(calls)).toEqual([E2E_TOTP_CODE]);
    // Linking starts once the code is given, with a session that gave it.
    await expect.poll(() => dataCalls.length).toBeGreaterThan(0);
    expect(dataCalls.every((aal) => aal === 'aal2')).toBe(true);
  });

  test('a wrong code says so, keeps the code step, and signs nobody in', async ({ page }) => {
    const calls = await mockAccounts(page);
    await openApp(page, '/settings/account');
    await signInWithPassword(page, EMAIL);

    await codeField(page).fill(WRONG_CODE);
    await continueButton(page).click();

    await expect(codeStep(page).getByRole('alert')).toHaveText(t.auth.errors.codeFailed);
    await expect(codeField(page)).toBeVisible();
    await expect(signedIn(page)).toHaveCount(0);
    expect(verifyCodes(calls)).toEqual([WRONG_CODE]);

    // The newest code still works after a wrong one.
    await codeField(page).fill(E2E_TOTP_CODE);
    await continueButton(page).click();
    await expect(signedIn(page)).toContainText(`Signed in as ${EMAIL}.`);
  });

  for (const [what, typed] of [
    ['five digits', '24680'],
    ['letters', 'abcdef'],
    ['nothing', ''],
  ] as const) {
    test(`a code of ${what} is refused on the phone, before anything is sent`, async ({ page }) => {
      const calls = await mockAccounts(page);
      await openApp(page, '/settings/account');
      await signInWithPassword(page, EMAIL);

      await codeField(page).fill(typed);
      await continueButton(page).click();

      await expect(codeStep(page).getByRole('alert')).toHaveText(t.auth.check.code);
      await expect(signedIn(page)).toHaveCount(0);
      expect(verifyCodes(calls)).toEqual([]);
    });
  }

  test('a code typed with a space, as apps show it, is sent as six digits', async ({ page }) => {
    const calls = await mockAccounts(page);
    await openApp(page, '/settings/account');
    await signInWithPassword(page, EMAIL);

    await codeField(page).fill(`${E2E_TOTP_CODE.slice(0, 3)} ${E2E_TOTP_CODE.slice(3)}`);
    await continueButton(page).click();

    await expect(signedIn(page)).toContainText(`Signed in as ${EMAIL}.`);
    expect(verifyCodes(calls)).toEqual([E2E_TOTP_CODE]);
  });

  test('a challenge that ran out says to enter the newest code, and the next one signs in', async ({ page }) => {
    await mockAccounts(page);
    // Registered after the mock, so it answers first: the account server's reply to a code given too late, once.
    await page.route(
      '**/auth/v1/factors/*/verify',
      (route) =>
        route.fulfill({
          status: 422,
          headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
          json: { error_code: 'mfa_challenge_expired', msg: 'MFA challenge has expired' },
        }),
      { times: 1 },
    );
    await openApp(page, '/settings/account');
    await signInWithPassword(page, EMAIL);

    await codeField(page).fill(E2E_TOTP_CODE);
    await continueButton(page).click();

    await expect(codeStep(page).getByRole('alert')).toHaveText(t.auth.errors.codeExpired);
    await expect(signedIn(page)).toHaveCount(0);

    await continueButton(page).click();
    await expect(signedIn(page)).toContainText(`Signed in as ${EMAIL}.`);
  });

  test('offline, the code waits and nothing is sent', async ({ page, context }) => {
    const calls = await mockAccounts(page);
    await openApp(page, '/settings/account');
    await signInWithPassword(page, EMAIL);
    await expect(codeStep(page)).toBeVisible();

    await context.setOffline(true);
    await codeField(page).fill(E2E_TOTP_CODE);
    await continueButton(page).click();

    await expect(codeStep(page).getByRole('alert')).toHaveText(t.auth.offline);
    await expect(signedIn(page)).toHaveCount(0);
    expect(verifyCodes(calls)).toEqual([]);

    await context.setOffline(false);
    await continueButton(page).click();
    await expect(signedIn(page)).toContainText(`Signed in as ${EMAIL}.`);
  });

  test('the code is still owed after a reload, and Settings says so', async ({ page }) => {
    await mockAccounts(page);
    await openApp(page, '/settings/account');
    await signInWithPassword(page, EMAIL);
    await expect(codeStep(page)).toBeVisible();

    await page.reload();
    await waitForApp(page);
    await expect(codeStep(page)).toBeVisible();
    await expect(signedIn(page)).toHaveCount(0);

    await openApp(page, '/settings');
    await expect(page.getByRole('link', { name: /^Your account/ })).toContainText(t.account.card.secondStep(EMAIL));
  });

  test('“Use a different account” goes back to the password', async ({ page }) => {
    await mockAccounts(page);
    await openApp(page, '/settings/account');
    await signInWithPassword(page, EMAIL);

    await codeStep(page).getByRole('button', { name: t.auth.secondStep.otherAccount, exact: true }).click();

    const form = page.getByRole('region', { name: t.auth.signIn.headingSignIn, exact: true });
    await expect(form.getByRole('textbox', { name: t.auth.signIn.email, exact: true })).toBeVisible();
    await expect(codeStep(page)).toHaveCount(0);

    // The other account has no two-step sign-in: its password alone signs in.
    await signInWithPassword(page, PLAIN_EMAIL);
    await expect(signedIn(page)).toContainText(`Signed in as ${PLAIN_EMAIL}.`);
    await expect(codeStep(page)).toHaveCount(0);
  });

  test('the code step has no serious accessibility finding', async ({ page }) => {
    await mockAccounts(page);
    await openApp(page, '/settings/account');
    await signInWithPassword(page, EMAIL);
    await codeField(page).fill(WRONG_CODE);
    await continueButton(page).click();
    // With its error showing, the state most likely to break a rule.
    await expect(codeStep(page).getByRole('alert')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .include('main')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});

test.describe('the code step on the start page', () => {
  test('a new phone signs in with its code, and an empty account goes on to setup', async ({ page }) => {
    await skipUnlessAccountsShow(page);
    const calls = await mockAccounts(page);
    await openApp(page, '/start/sign-in');

    await signInWithPassword(page, EMAIL);
    await expect(codeStep(page)).toBeVisible();
    await codeField(page).fill(E2E_TOTP_CODE);
    await continueButton(page).click();

    await expect(page).toHaveURL('/setup');
    await expect(page.getByRole('heading', { level: 3, name: 'Accounts', exact: true })).toBeVisible();
    expect(verifyCodes(calls)).toEqual([E2E_TOTP_CODE]);
  });
});

// Sign-in is a critical flow, so its two most common steps run in every offered language: the texts come from each
// language's own dictionary, and the phone's choice is stored, not only the browser's.
for (const code of OFFERED) {
  const m = MESSAGES[code];
  test.describe(`two-step sign-in · ${code}`, () => {
    test.use({ locale: LANGUAGES[code].locale });

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [LANGUAGE_STORAGE_KEY, code] as [
        string,
        Language,
      ]);
      await skipUnlessAccountsShow(page);
      await mockAccounts(page);
      await openApp(page, '/settings/account');
      await expect(page.locator('html')).toHaveAttribute('lang', code);
      await signInWithPassword(page, EMAIL, m);
    });

    test('the right code signs in', async ({ page }) => {
      await codeField(page, m).fill(E2E_TOTP_CODE);
      await continueButton(page, m).click();

      await expect(signedIn(page, m)).toContainText(EMAIL);
      await expect(codeStep(page, m)).toHaveCount(0);
    });

    test('a wrong code is refused in the phone’s language', async ({ page }) => {
      await codeField(page, m).fill(WRONG_CODE);
      await continueButton(page, m).click();

      await expect(codeStep(page, m).getByRole('alert')).toHaveText(m.auth.errors.codeFailed);
      await expect(signedIn(page, m)).toHaveCount(0);
    });
  });
}
