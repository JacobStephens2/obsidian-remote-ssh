/**
 * Race a promise against a timeout. Rejects with a labelled error if
 * `ms` elapses before `promise` settles; the timer is always cleared so
 * a fast-settling promise leaves no dangling handle.
 *
 * Callers can signal cancellation via `onTimeout` before the race settles.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  // `window.setTimeout` returns a number in the Obsidian renderer (DOM),
  // not a NodeJS.Timeout — type it as such so @types/node's global
  // overload doesn't leak in.
  let timer: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
      onTimeout?.();
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  });
}
