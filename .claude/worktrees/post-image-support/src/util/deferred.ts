export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly settled: boolean;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });

  let settled = false;
  const resolve = (value: T): void => {
    if (settled) return;
    settled = true;
    resolveFn(value);
  };
  const reject = (error: unknown): void => {
    if (settled) return;
    settled = true;
    rejectFn(error);
  };

  return {
    promise,
    get settled() {
      return settled;
    },
    resolve,
    reject,
  };
}
