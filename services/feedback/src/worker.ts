import { DurableObject } from 'cloudflare:workers';
import { SubmissionBudget } from './budget.js';
import type { Env } from './index.js';

export class FeedbackBudget extends DurableObject<Env> {
  private readonly budget: SubmissionBudget;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.budget = new SubmissionBudget(ctx);
  }

  override fetch(req: Request): Promise<Response> { return this.budget.fetch(req); }
}

export { default } from './index.js';
