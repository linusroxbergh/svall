const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MINUTE_LIMIT = 30;
const DAY_LIMIT = 300;

// The subset of Durable Object storage used here; keeping it structural also lets tests use real SQLite.
export type BudgetStorage = {
  sql: { exec<T extends Record<string, number>>(query: string, ...bindings: number[]): Iterable<T> };
  transactionSync<T>(run: () => T): T;
};

export class SubmissionBudget {
  constructor(private readonly ctx: { storage: BudgetStorage }) {
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS submissions (at INTEGER NOT NULL)');
  }

  async fetch(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response(null, { status: 405 });
    // All locations use one object named for the destination repo. Synchronous SQL in one transaction prevents
    // concurrent reservations from sharing a slot; persisted rows preserve the budget across restarts/deploys.
    const retryAfter = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const now = Date.now();
      sql.exec('DELETE FROM submissions WHERE at <= ?', now - DAY);
      const day = [...sql.exec<{ at: number }>('SELECT at FROM submissions ORDER BY at')];
      const minute = day.filter(({ at }) => at > now - MINUTE);
      let wait = 0;
      if (day.length >= DAY_LIMIT) wait = day[0]!.at + DAY - now;
      if (minute.length >= MINUTE_LIMIT) wait = Math.max(wait, minute[0]!.at + MINUTE - now);
      if (wait > 0) return Math.max(1, Math.ceil(wait / 1000));
      // Reserve before contacting GitHub and never refund failures: upstream errors must not enable unlimited retries.
      sql.exec('INSERT INTO submissions (at) VALUES (?)', now);
      return 0;
    });
    return new Response(null, retryAfter
      ? { status: 429, headers: { 'Retry-After': String(retryAfter) } }
      : { status: 204 });
  }
}
