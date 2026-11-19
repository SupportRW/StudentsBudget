import type { Page } from '@playwright/test';
import type { Account, Entry } from '../../src/db/types';
import { defaultAccount, sortAccounts } from '../../src/features/accounts/balances';
import type { IsoDate } from '../../src/lib/dates';
import type { Minor } from '../../src/lib/money';
import { readStore } from './setup';

/** An expense or an income a spec starts with, as it would have been saved earlier. */
export type EntrySeed = {
  /** An expense unless said otherwise. */
  type?: 'expense' | 'income';
  date: IsoDate;
  categoryId: string;
  /** In the account's own currency. */
  amountMinor: Minor;
  /** Its value in euros: the amount itself unless the account is in another currency. */
  eurMinor?: Minor;
  note?: string;
  /** The account's name; the default account (the fixture's Local bank, in euros) without one. */
  account?: string;
};

/**
 * Writes entries straight into IndexedDB, for a spec whose subject is not the entry form: the rows `saveEntry` would
 * write, in the order given, each saved a second after the one before (a list that shows the last saved first reads
 * them backwards). The accounts must be there already (`seedSetup`).
 *
 * A page that is open does not notice the write (Dexie only hears its own): call it before the page under test loads,
 * as after `seedSetup(page, {}, { open: false })`. Resolves with the rows it wrote.
 */
export async function putEntries(page: Page, seeds: EntrySeed[]): Promise<Entry[]> {
  const accounts = sortAccounts(await readStore<Account>(page, 'accounts'));
  const already = (await readStore<Entry>(page, 'entries')).length;

  const entries = seeds.map((seed, i): Entry => {
    const account =
      seed.account === undefined ? defaultAccount(accounts) : accounts.find((a) => a.name === seed.account);
    if (account === undefined) throw new Error(`putEntries: no account "${seed.account ?? 'default'}" is saved`);
    const n = already + i;
    return {
      id: `e2e-entry-${n + 1}`,
      type: seed.type ?? 'expense',
      date: seed.date,
      accountId: account.id,
      amountMinor: seed.amountMinor,
      eurMinor: seed.eurMinor ?? seed.amountMinor,
      note: seed.note ?? '',
      categoryId: seed.categoryId,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    };
  });

  await page.evaluate(
    (rows) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('studentsbudget');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const transaction = database.transaction('entries', 'readwrite');
          for (const row of rows) transaction.objectStore('entries').put(row);
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        };
      }),
    entries,
  );
  return entries;
}
