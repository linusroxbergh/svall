/** A command's actions, imported on the first call: defining every command loads none of what they run. */
export function lazy<T extends Record<string, (...args: never[]) => unknown>>(load: () => Promise<T>) {
  let loaded: Promise<T> | undefined;
  return <K extends keyof T>(name: K) => async (...args: Parameters<T[K]>): Promise<Awaited<ReturnType<T[K]>>> => {
    const act = (await (loaded ??= load()))[name] as (...a: Parameters<T[K]>) => ReturnType<T[K]>;
    return await act(...args);
  };
}
