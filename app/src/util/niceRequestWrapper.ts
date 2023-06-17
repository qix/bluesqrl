import { Sema } from "async-sema";
import { nowMonotonicMs } from "./nowMonotonic";
import { delayMs } from "./delayMs";
import { Pacer } from "./Pacer";
import { Trace } from "./Trace";
import { getCache, CacheKeys } from "./cache";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

export interface RequestConfig<I, O> {
  name: string;
  maxConcurrent: number;
  initialRetryMs: number;
  jitter: number;
  backoffMultiply: number;
  shouldRetryError: (err: Error) => boolean;
  shouldSlowRetry: (err: Error) => boolean;
  cacheKey: (input: I) => string | null;
  deserialize: (serialized: string) => O;
  serialize: (output: O) => string;

  // Stop retrying after this total timeout
  timeoutMs: number;
  cacheTtlMs: number;
}

// @todo: Expose these configuration options to the command line somehow
const defaultRequestConfig = {
  maxConcurrent: 100,
  initialRetryMs: 10,
  jitter: 0.5,
  timeoutMs: 5000,
  backoffMultiply: 2,
  shouldRetryError: () => false,
  shouldSlowRetry: () => false,
  cacheKey: () => null,
  cacheTtlMs: FIFTEEN_MINUTES_MS,
  deserialize: () => {
    throw new Error("deserialize() not implemented");
  },
  serialize: () => {
    throw new Error("serialize() not implemented");
  },
};
const slowRequestConfig = {
  ...defaultRequestConfig,
  timeoutMs: 15000,
  initialRetryMs: 50,
};

export const niceRequestConfig = {
  resolveDid: {
    name: "resolveDid",
    ...defaultRequestConfig,
  },
  resolveDidSlow: {
    name: "resolveDidSlow",
    ...slowRequestConfig,
  },
};

const statusByName: {
  [name: string]: {
    pacer: Pacer;
    retryCount: number;
  };
} = {};

export function niceRequestWrapper<I, O>(
  props: RequestConfig<I, O>,
  callback: (trc: Trace, input: I) => Promise<O>
): (trc: Trace, input: I) => Promise<O> {
  const concurrentLimit = new Sema(props.maxConcurrent);

  if (!statusByName[props.name]) {
    statusByName[props.name] = {
      pacer: new Pacer({ intervalMs: 5000 }),
      retryCount: 0,
    };
  }
  const status = statusByName[props.name];

  return async (trc: Trace, input: I) => {
    // First try see if it's in the cache
    const inputCacheKey = props.cacheKey(input);
    const cacheKey = inputCacheKey
      ? CacheKeys.requestWrapper(props.name, inputCacheKey)
      : null;

    if (cacheKey) {
      const cache = await getCache();
      const cached = await cache.get(cacheKey);
      if (cached !== null) {
        return props.deserialize(cached);
      }
    }
    let requestRetryCount = 0;
    await concurrentLimit.acquire();
    try {
      // While we're holding the request we do the retries, so that we don't overwhelm the
      // remote server
      const startMs = nowMonotonicMs();
      const endMs = startMs + props.timeoutMs;
      let nextWait = props.initialRetryMs;
      while (true) {
        try {
          const result = await callback(trc, input);

          if (cacheKey) {
            // @todo: Don't need to wait here, and could throw errors that are retried
            const cache = await getCache();
            cache.set(cacheKey, props.serialize(result), props.cacheTtlMs);
          }
          return result;
        } catch (err) {
          if (!(err instanceof Error) || !props.shouldRetryError(err)) {
            throw err;
          }

          // @todo: Improve slow mode, but to start drop retry to minimum 1 second
          if (props.shouldSlowRetry(err)) {
            nextWait = Math.min(nextWait, 1000);
          }

          const nowMs = nowMonotonicMs();
          const jitter = (Math.random() * 2 - 1) * props.jitter;
          const waitMs = nextWait + jitter * nextWait;
          requestRetryCount += 1;

          if (nowMs + waitMs > endMs) {
            // If we're out of time, throw the error
            trc.warn(
              `Request retry timeout out after ${requestRetryCount} attempts`
            );
            throw err;
          }

          // Make sure we're logging these retries somewhere
          status.retryCount += 1;
          if (status.pacer.test()) {
            trc.warn(`Retried ${status.retryCount} requests on ${props.name}`);
          }

          // Otherwise wait, bump the retry and retry
          await delayMs(waitMs);
          nextWait = nextWait * props.backoffMultiply;
        }
      }
    } finally {
      concurrentLimit.release();
    }
  };
}
