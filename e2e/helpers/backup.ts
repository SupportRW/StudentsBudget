import type { Page } from '@playwright/test';
import type { BackupData } from '../../src/db/bulk';
import type { Entry, Plan, Profile } from '../../src/db/types';
import { serializeBackup } from '../../src/features/backup/backup';
import { readStore, SETUP_DAY } from './setup';

/** A file handed to the browser's file chooser, as `setFiles` takes it. */
export type ChosenFile = { name: string; mimeType: string; buffer: Buffer };

/**
 * The phone's data as Export would put it in a backup (`exportAll` in src/db/bulk.ts), read straight from IndexedDB.
 * A spec changes it and wraps it with `backupFile` to make the file it restores, so no file is typed by hand.
 */
export async function backupDataOf(page: Page): Promise<BackupData> {
  return {
    accounts: await readStore(page, 'accounts'),
    categories: await readStore(page, 'categories'),
    entries: await readStore<Entry>(page, 'entries'),
    plan: (await readStore<Plan>(page, 'plan'))[0] ?? null,
    fxRates: await readStore(page, 'fxRates'),
    weekResults: await readStore(page, 'weekResults'),
    discountVotes: await readStore(page, 'discountVotes'),
    profile: (await readStore<Profile>(page, 'profile'))[0] ?? null,
    checklistTicks: await readStore(page, 'checklistTicks'),
    planMonths: await readStore(page, 'planMonths'),
  };
}

/** A backup file of `data`, in the app's own format (`serializeBackup`), saved on `now`. */
export function backupFile(data: BackupData, name = 'TEST-backup.json', now = SETUP_DAY): ChosenFile {
  return { name, mimeType: 'application/json', buffer: Buffer.from(serializeBackup(data, now)) };
}

/** Any other file a student might pick by mistake. */
export function otherFile(text: string | Buffer, name = 'TEST-other.json'): ChosenFile {
  return { name, mimeType: 'application/json', buffer: Buffer.isBuffer(text) ? text : Buffer.from(text) };
}

/** Taps the button that opens the hidden file field, and picks `file` in the chooser it opens. */
export async function chooseFile(page: Page, buttonName: string, file: ChosenFile) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: buttonName, exact: true }).click();
  await (await chooser).setFiles(file);
}

/**
 * Deletes the phone's database, as a new or wiped phone has none: the app makes it again on the next load. The open
 * page's Dexie closes its connection on the delete's versionchange, so the delete isn't blocked.
 */
export async function wipePhone(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase('studentsbudget');
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      }),
  );
}
