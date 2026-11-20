import { expect, test, type Page } from '@playwright/test';
import type { Account, Entry, Plan } from '../src/db/types';
import { BACKUP_VERSION, MAX_BACKUP_BYTES, parseBackup } from '../src/features/backup/backup';
import { MESSAGES } from '../src/i18n/messages';
import { formatDateTime } from '../src/lib/dates';
import { openApp, waitForHome } from './helpers/app';
import { noSeriousAxeFindings } from './helpers/axe';
import { backupDataOf, backupFile, chooseFile, otherFile, wipePhone, type ChosenFile } from './helpers/backup';
import { putEntries } from './helpers/entries';
import { heading } from './helpers/pages';
import { seedSetup } from './helpers/seed-setup';
import { readStore, SETUP_DAY } from './helpers/setup';

// Settings → Backup and data (/settings/backup): exporting a backup file, restoring one (in Settings and on a new
// phone's /setup), the files a restore refuses, and Delete everything. The words come from the app's own dictionary;
// the notes, amounts and file names, which are what the tests are about, are written out. Every file is made up here.

const t = MESSAGES.en;
const text = t.backup;

/** The fixture's default account (seedSetup's Local bank, in euros), as an entry's row names it. */
const BANK = 'Local bank';

/** The entry already on the phone before a restore. */
const PHONE_ENTRY = { date: '2026-10-14', categoryId: 'food', amountMinor: 2000, note: 'TEST-Phone groceries' } as const;
const PHONE_ROW = `TEST-Phone groceries Food & groceries · ${BANK} €20.00`;

/** The entry only the backup file has. */
const FILE_ROW = `TEST-Restored lunch Eating out · ${BANK} €6.50`;

/** One of the page's three cards, a region named by its title. */
const card = (page: Page, title: string) => page.getByRole('region', { name: title, exact: true });

/** The restore's question, shown once a file passes the checks. */
const confirmGroup = (page: Page) => page.getByRole('group', { name: text.restore.confirmGroup, exact: true });

/** An entry's row in the Entries list: a button named by its note, its category and account, and its amount. */
const entryRow = (page: Page, name: string) =>
  page.getByRole('region', { name: t.entries.list.label, exact: true }).getByRole('button', { name, exact: true });

/** A phone with the fixture's plan and one entry of its own, on the Backup page. */
async function openBackupWithAPlan(page: Page) {
  await seedSetup(page, {}, { open: false });
  await putEntries(page, [PHONE_ENTRY]);
  await openApp(page, '/settings/backup');
  await expect(heading(page, t.shell.headings.backup)).toBeVisible();
}

/** This phone's data with its own entry swapped for one only the file has: a backup from another day. */
async function anotherDaysBackup(page: Page): Promise<ChosenFile> {
  const data = await backupDataOf(page);
  const bank = (await readStore<Account>(page, 'accounts')).find((a) => a.name === BANK);
  if (bank === undefined) throw new Error(`no account "${BANK}" is saved`);
  const restored: Entry = {
    id: 'TEST-restored-1',
    type: 'expense',
    date: '2026-10-15',
    accountId: bank.id,
    amountMinor: 650,
    eurMinor: 650,
    note: 'TEST-Restored lunch',
    categoryId: 'eating-out',
    createdAt: '2026-10-15T12:00:00.000Z',
  };
  return backupFile({ ...data, entries: [restored] });
}

test.beforeEach(async ({ context }) => {
  // Nothing but this machine answers: a host no helper mocks is refused rather than reached.
  await context.route(
    (url) => !['localhost', '127.0.0.1'].includes(url.hostname),
    (route) => route.abort(),
  );
});

test.describe('exporting a backup', () => {
  test('Export backup downloads one file with the plan, the accounts and the entries', async ({ page }) => {
    // Where the browser can share a file, Export opens the share sheet instead (export-file-button.tsx); a headless
    // browser has no sheet to open, so this phone is one that downloads.
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'canShare', { value: undefined, configurable: true });
    });
    await openBackupWithAPlan(page);
    const exportCard = card(page, text.export.heading);

    const download = page.waitForEvent('download');
    await exportCard.getByRole('button', { name: text.export.button, exact: true }).click();
    const file = await download;

    await expect(exportCard.getByRole('status')).toHaveText(text.export.downloaded('studentsbudget-backup-2026-10-16.json'));
    expect(file.suggestedFilename()).toBe('studentsbudget-backup-2026-10-16.json');
    const chunks: Buffer[] = [];
    for await (const chunk of await file.createReadStream()) chunks.push(chunk as Buffer);
    const parsed = parseBackup(Buffer.concat(chunks).toString('utf8'));
    if (!parsed.ok) throw new Error(`the exported file doesn't restore: ${parsed.error}`);
    expect(parsed.data.accounts.map((a) => a.name).sort()).toEqual(['Cash', 'Home bank', 'Local bank']);
    expect(parsed.data.entries.map((e) => e.note)).toEqual(['TEST-Phone groceries']);
    expect(parsed.data.plan).not.toBeNull();
  });
});

test.describe('restoring a backup in Settings', () => {
  test('a backup file asks first, then replaces the phone’s data with the file’s', async ({ page }) => {
    await openBackupWithAPlan(page);
    const file = await anotherDaysBackup(page);

    await chooseFile(page, text.restore.choose, file);
    const question = confirmGroup(page);
    await expect(question.getByRole('paragraph').first()).toHaveText(`Replace all data with ${file.name}?`);
    await expect(question.getByRole('paragraph').nth(1)).toHaveText(
      `Saved ${formatDateTime(SETUP_DAY.toISOString())} · 3 accounts · 1 entry`,
    );
    await question.getByRole('button', { name: text.restore.replace, exact: true }).click();

    await waitForHome(page);
    await openApp(page, '/entries');
    await expect(entryRow(page, FILE_ROW)).toBeVisible();
    await expect(entryRow(page, PHONE_ROW)).toHaveCount(0);
  });

  test('Cancel closes the question and keeps the phone’s data', async ({ page }) => {
    await openBackupWithAPlan(page);
    const file = await anotherDaysBackup(page);

    await chooseFile(page, text.restore.choose, file);
    await confirmGroup(page).getByRole('button', { name: text.restore.cancel, exact: true }).click();

    await expect(confirmGroup(page)).toHaveCount(0);
    await openApp(page, '/entries');
    await expect(entryRow(page, PHONE_ROW)).toBeVisible();
    await expect(entryRow(page, FILE_ROW)).toHaveCount(0);
  });

  // One case per answer `parseBackup` and the size check give; the rules behind each (every damage it finds, the
  // older versions it reads) are unit-tested in backup.test.ts.
  const refused: { name: string; file: (page: Page) => Promise<ChosenFile>; error: string }[] = [
    {
      name: 'a file that isn’t JSON',
      file: async () => otherFile('TEST-these are my holiday notes', 'TEST-notes.txt'),
      error: text.file.notBackup,
    },
    {
      name: 'JSON from another app',
      file: async () => otherFile(JSON.stringify({ app: 'TEST-other-app', version: 1, data: {} })),
      error: text.file.notBackup,
    },
    {
      name: 'a backup from a newer version of the app',
      file: async () =>
        otherFile(JSON.stringify({ app: 'studentsbudget', version: BACKUP_VERSION + 1, exportedAt: SETUP_DAY.toISOString(), data: {} })),
      error: text.file.newer,
    },
    {
      name: 'a backup with its data missing',
      file: async () =>
        otherFile(JSON.stringify({ app: 'studentsbudget', version: BACKUP_VERSION, exportedAt: SETUP_DAY.toISOString() })),
      error: text.file.incomplete,
    },
    {
      name: 'a backup whose entry uses an account it doesn’t have',
      file: async (page) => {
        const data = await backupDataOf(page);
        const entries = data.entries.map((e) => ({ ...e, accountId: 'TEST-missing-account' }));
        return backupFile({ ...data, entries });
      },
      error: text.file.damaged(text.problems.entryAccount),
    },
    {
      name: 'a file over 20 MB',
      file: async () => otherFile(Buffer.alloc(MAX_BACKUP_BYTES + 1, ' '), 'TEST-huge.json'),
      error: text.restore.tooLarge,
    },
  ];

  for (const { name, file, error } of refused) {
    test(`${name} is refused with a message, and nothing changes`, async ({ page }) => {
      await openBackupWithAPlan(page);

      await chooseFile(page, text.restore.choose, await file(page));

      await expect(card(page, text.restore.heading).getByRole('alert')).toHaveText(error);
      await expect(confirmGroup(page)).toHaveCount(0);
      expect((await readStore<Entry>(page, 'entries')).map((e) => e.note)).toEqual(['TEST-Phone groceries']);
    });
  }
});

test.describe('restoring on a new phone', () => {
  test('setup’s Restore a backup brings the plan back without setting up', async ({ page }) => {
    await seedSetup(page, {}, { open: false });
    await putEntries(page, [PHONE_ENTRY]);
    const file = backupFile(await backupDataOf(page));
    await wipePhone(page);

    await openApp(page, '/setup');
    await expect(heading(page, t.setup.headingNew)).toBeVisible();
    await chooseFile(page, text.restore.setupButton, file);
    await confirmGroup(page).getByRole('button', { name: text.restore.replace, exact: true }).click();

    await waitForHome(page);
    await openApp(page, '/entries');
    await expect(entryRow(page, PHONE_ROW)).toBeVisible();
    expect(await readStore<Plan>(page, 'plan')).toHaveLength(1);
  });
});

test.describe('Delete everything', () => {
  /** Opens the confirmation and gives back its word field. */
  async function openConfirmation(page: Page) {
    const deleteCard = card(page, text.delete.heading);
    await deleteCard.getByRole('button', { name: text.delete.button, exact: true }).click();
    return deleteCard.getByRole('textbox', { name: text.delete.typeToConfirm(text.delete.word), exact: true });
  }

  test('the typed word, in any capitals, deletes the plan and the entries and opens setup', async ({ page }) => {
    await openBackupWithAPlan(page);
    const word = await openConfirmation(page);
    const confirm = card(page, text.delete.heading).getByRole('button', { name: text.delete.button, exact: true });
    await expect(confirm).toBeDisabled();

    await word.fill(' delete ');
    await confirm.click();

    await expect(page).toHaveURL('/setup');
    await expect(heading(page, t.setup.headingNew)).toBeVisible();
    expect(await readStore<Entry>(page, 'entries')).toEqual([]);
    expect(await readStore<Plan>(page, 'plan')).toEqual([]);
  });

  test('a word that isn’t DELETE never arms it, and Cancel hands the focus back and keeps the data', async ({ page }) => {
    await openBackupWithAPlan(page);
    const deleteCard = card(page, text.delete.heading);
    const word = await openConfirmation(page);

    await word.fill('DELET');
    await expect(deleteCard.getByRole('button', { name: text.delete.button, exact: true })).toBeDisabled();
    await deleteCard.getByRole('button', { name: text.delete.cancel, exact: true }).click();

    await expect(word).toHaveCount(0);
    await expect(deleteCard.getByRole('button', { name: text.delete.button, exact: true })).toBeFocused();
    expect((await readStore<Entry>(page, 'entries')).map((e) => e.note)).toEqual(['TEST-Phone groceries']);
  });
});

test('the Backup page with the restore question and the delete confirmation open has no serious axe findings', async ({ page }) => {
  await openBackupWithAPlan(page);
  await chooseFile(page, text.restore.choose, await anotherDaysBackup(page));
  await expect(confirmGroup(page)).toBeVisible();
  const deleteCard = card(page, text.delete.heading);
  await deleteCard.getByRole('button', { name: text.delete.button, exact: true }).click();
  await expect(deleteCard.getByRole('textbox')).toBeVisible();

  await noSeriousAxeFindings(page);
});
