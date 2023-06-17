import { caching } from "cache-manager";
import sqliteStore from "cache-manager-better-sqlite3";

export function buildNewCache() {
  return caching(sqliteStore, {
    name: "bluesqrl",
    path: "/tmp/bluesqrl.db",
  });
}
