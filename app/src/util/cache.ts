import { SqliteCacheAdapter } from "cache-manager-better-sqlite3";
import { Cache } from "cache-manager";

let cachePromise: Promise<Cache<SqliteCacheAdapter>>;

/**
 * Create a cache, workaround for ESM in cache-manager
 */
export function getCache(): Promise<Cache<SqliteCacheAdapter>> {
  if (!cachePromise) {
    console.log("STARTING IMPORT");
    cachePromise = import("./cacheBuilder").then(({ buildNewCache }) => {
      console.log("import done");
      return buildNewCache().then((cache) => {
        console.log("cache build done");
        return cache;
      });
    });
  }
  return cachePromise;
}

export const CacheKeys = {
  requestWrapper(name: string, key: string) {
    return `request:${name}:${key}`;
  },
};
