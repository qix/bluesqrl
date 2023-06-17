import sqlite = require("better-sqlite3");

class Cache {
  db: any;

  constructor() {
    this.db = sqlite("/tmp/bluesqrl", {});
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS cache (key VARCHAR(255) NOT NULL PRIMARY KEY,  value TEXT);"
    );
  }

  get(key: string): string | null {
    const stmt = this.db.prepare("SELECT value FROM cache WHERE key = ?");
    const row = stmt.get(key);
    return row ? row.value : null;
  }

  set(key: string, value: string, ttlMs: number): void {
    // @todo: ttlrMs

    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO cache (key, value) VALUES (?, ?)"
    );
    const info = stmt.run(key, value);
    return info;
  }
}

const cache = new Cache();

/**
 * Create a cache, workaround for ESM in cache-manager
 */
export async function getCache(): Promise<Cache> {
  return cache;
}

export const CacheKeys = {
  requestWrapper(name: string, key: string) {
    return `request:${name}:${key}`;
  },
};
