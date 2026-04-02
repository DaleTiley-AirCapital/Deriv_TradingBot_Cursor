import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  max: 10,
});

pool.on("error", (err) => {
  console.error("[DB] Pool error (client will be removed and reconnected automatically):", err.message);
});

export const db = drizzle(pool, { schema });

export const backgroundPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: 60_000,
  max: 4,
});

backgroundPool.on("error", (err) => {
  console.error("[DB:bg] Background pool error:", err.message);
});

export const backgroundDb = drizzle(backgroundPool, { schema });

export * from "./schema";
