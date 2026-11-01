/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SubmissionBudget, type BudgetStorage } from '../src/budget.js';

let db: DatabaseSync;
let storage: BudgetStorage;
let now: number;
const minute = 60_000;
const day = 24 * 60 * minute;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  storage = {
    sql: { exec: <T extends Record<string, number>>(query: string, ...bindings: number[]) => db.prepare(query).all(...bindings) as T[] },
    transactionSync: (run) => {
      db.exec('BEGIN');
      try { const result = run(); db.exec('COMMIT'); return result; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
  now = Date.UTC(2026, 10, 1);
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => { vi.restoreAllMocks(); db.close(); });

const reserve = (budget: SubmissionBudget) => budget.fetch(new Request('https://budget/reserve', { method: 'POST' }));
const stored = () => (db.prepare('SELECT count(*) AS n FROM submissions').get() as { n: number }).n;

test('concurrent reservations share a strict 30-per-rolling-minute budget', async () => {
  const budget = new SubmissionBudget({ storage });
  const results = await Promise.all(Array.from({ length: 100 }, () => reserve(budget)));
  expect(results.filter((r) => r.status === 204)).toHaveLength(30);
  expect(results.filter((r) => r.status === 429)).toHaveLength(70);
  expect(stored()).toBe(30);
  now += minute - 1;
  expect((await reserve(budget)).status).toBe(429);
  now++;
  expect((await reserve(budget)).status).toBe(204);
});

test('restarting the object does not reset the budget or create a second table', async () => {
  const first = new SubmissionBudget({ storage });
  for (let i = 0; i < 30; i++) await reserve(first);
  const restarted = new SubmissionBudget({ storage });
  expect((await reserve(restarted)).status).toBe(429);
  expect(stored()).toBe(30);
});

test('300 submissions across minutes exhaust the rolling 24-hour budget', async () => {
  const budget = new SubmissionBudget({ storage });
  const start = now;
  for (let batch = 0; batch < 10; batch++) {
    for (let i = 0; i < 30; i++) expect((await reserve(budget)).status).toBe(204);
    now += minute;
  }
  const denied = await reserve(budget);
  expect(denied.status).toBe(429);
  expect(denied.headers.get('Retry-After')).toBe(String((day - 10 * minute) / 1000));
  now = start + day - 1;
  expect((await reserve(budget)).status).toBe(429);
  now++;
  for (let i = 0; i < 30; i++) expect((await reserve(budget)).status).toBe(204);
  expect((await reserve(budget)).status).toBe(429);
  expect(stored()).toBe(300);
});

test('rolling windows do not grant a second allowance at a clock-minute boundary', async () => {
  const budget = new SubmissionBudget({ storage });
  now += minute - 500;
  for (let i = 0; i < 30; i++) await reserve(budget);
  now += 1000;
  const res = await reserve(budget);
  expect(res.status).toBe(429);
  expect(res.headers.get('Retry-After')).toBe('59');
});

test('a storage failure rolls back the reservation instead of granting an unrecorded slot', async () => {
  const budget = new SubmissionBudget({ storage });
  const exec = storage.sql.exec;
  vi.spyOn(storage.sql, 'exec').mockImplementation((query, ...bindings) => {
    if (query.startsWith('INSERT')) throw new Error('storage unavailable');
    return exec(query, ...bindings);
  });
  await expect(reserve(budget)).rejects.toThrow('storage unavailable');
  expect(stored()).toBe(0);
});

test('non-POST requests cannot reserve budget', async () => {
  const budget = new SubmissionBudget({ storage });
  expect((await budget.fetch(new Request('https://budget/reserve'))).status).toBe(405);
  expect(stored()).toBe(0);
});
