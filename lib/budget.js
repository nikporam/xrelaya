// A small subrequest budget tracker.
//
// Cloudflare Workers allow a limited number of outbound `fetch()` calls per
// invocation on the free plan (50). A cron run that checks several accounts,
// translates tweets and sends Telegram messages can reach that ceiling, and
// going over it makes the whole invocation fail. Every outbound call in the
// Worker goes through this budget, so the run stops gracefully instead of
// being killed half-way.

export function createBudget(limit = 40) {
  let used = 0;
  const safeLimit = Math.max(1, Number(limit) || 40);
  return {
    limit: safeLimit,
    get used() {
      return used;
    },
    remaining() {
      return Math.max(0, safeLimit - used);
    },
    take(cost = 1) {
      if (used + cost > safeLimit) return false;
      used += cost;
      return true;
    },
    spend(cost = 1) {
      used += cost;
    },
  };
}

// fetch() wrapper that refuses calls the budget cannot afford.
export async function budgetFetch(budget, url, init = {}, cost = 1) {
  if (budget && !budget.take(cost)) return null;
  return fetch(url, init);
}
