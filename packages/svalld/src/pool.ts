/**
 * `fn` over `items`, at most `width` of them in flight, answers in the order the items came. After a failure no other
 * item starts, and the first failure is thrown once those in flight have ended.
 */
export async function pool<T, R>(items: T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i]); } catch (error) { failure ??= { error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  if (failure) throw failure.error;
  return out;
}
