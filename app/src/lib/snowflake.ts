/**
 * lib/snowflake.ts
 *
 * Server-side Snowflake connection pool using key pair auth.
 */

import Snowflake from "snowflake-sdk";
import * as fs from "fs";

const privateKeyPath = process.env.SNOWFLAKE_PRIVATE_KEY_PATH || "";
const hasKey = privateKeyPath && fs.existsSync(privateKeyPath);

const connectionOptions: Record<string, unknown> = {
  account: process.env.SNOWFLAKE_ACCOUNT!,
  username: process.env.SNOWFLAKE_USER!,
  database: process.env.SNOWFLAKE_DATABASE || "FUB_DEMO",
  schema: process.env.SNOWFLAKE_SCHEMA || "BANKING",
  warehouse: process.env.SNOWFLAKE_WAREHOUSE || "FUB_DEMO_WH",
  clientSessionKeepAlive: true,
  authenticator: hasKey ? "SNOWFLAKE_JWT" : "SNOWFLAKE",
  ...(hasKey
    ? { privateKeyPath }
    : { password: process.env.SNOWFLAKE_PASSWORD! }),
};

let _pool: ReturnType<typeof Snowflake.createPool> | null = null;

function getPool() {
  if (!_pool) {
    _pool = Snowflake.createPool(connectionOptions as any, {
      max: 5,
      min: 1,
      acquireTimeoutMillis: 30_000,
    });
  }
  return _pool;
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  binds: unknown[] = []
): Promise<T[]> {
  const pool = getPool();
  return pool.use(
    (conn) =>
      new Promise<T[]>((resolve, reject) => {
        conn.execute({
          sqlText: sql,
          binds: binds as Snowflake.Binds,
          complete: (err, _stmt, rows) => {
            if (err) return reject(err);
            resolve((rows as T[]) ?? []);
          },
        });
      })
  );
}

export async function ping(): Promise<boolean> {
  try {
    await query("SELECT 1 AS ok");
    return true;
  } catch {
    return false;
  }
}
