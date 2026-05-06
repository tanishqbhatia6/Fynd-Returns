import { PrismaClient } from "@prisma/client";
import { prismaLogger } from "./lib/observability/logger.server";
import { dbQueryDuration, dbPoolActive, dbPoolIdle } from "./lib/observability/metrics.server";

declare global {
  var prismaGlobal: PrismaClient;
}

const SLOW_QUERY_THRESHOLD_MS = 100;

function createClient(): PrismaClient {
  const client = new PrismaClient({
    log: [
      { level: "query", emit: "event" },
      { level: "warn", emit: "event" },
      { level: "error", emit: "event" },
    ],
  });

  // ---------------------------------------------------------------------------
  // Query event logging — slow query detection + metrics
  // ---------------------------------------------------------------------------
  client.$on("query", (e) => {
    const durationMs = e.duration;

    // Record query duration metric
    dbQueryDuration.record(durationMs, {
      "db.slow": durationMs > SLOW_QUERY_THRESHOLD_MS ? "true" : "false",
    });

    // Log slow queries
    if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
      prismaLogger.warn(
        {
          query: e.query.slice(0, 500),
          params: "[REDACTED]",
          duration_ms: durationMs,
          target: e.target,
        },
        `Slow query detected (${durationMs}ms)`,
      );
    }
  });

  client.$on("warn", (e) => {
    prismaLogger.warn({ target: e.target }, e.message);
  });

  client.$on("error", (e) => {
    prismaLogger.error({ target: e.target }, e.message);
  });

  return client;
}

const prisma =
  process.env.NODE_ENV !== "production" ? (global.prismaGlobal ??= createClient()) : createClient();

// ---------------------------------------------------------------------------
// Connection pool monitoring via pg_stat_activity (every 30s)
// ---------------------------------------------------------------------------
let poolMonitorInterval: ReturnType<typeof setInterval> | null = null;

const poolState = { active: 0, idle: 0 };

dbPoolActive.addCallback((observer) => observer.observe(poolState.active));
dbPoolIdle.addCallback((observer) => observer.observe(poolState.idle));

async function pollConnectionPool() {
  try {
    const result = await prisma.$queryRaw<Array<{ active: bigint; idle: bigint }>>`
      SELECT
        count(*) FILTER (WHERE state = 'active') AS active,
        count(*) FILTER (WHERE state = 'idle') AS idle
      FROM pg_stat_activity
      WHERE datname = current_database()
    `;
    if (result[0]) {
      poolState.active = Number(result[0].active);
      poolState.idle = Number(result[0].idle);
    }
  } catch {
    // Non-critical — don't crash for monitoring
  }
}

/* v8 ignore start */
// defensive: poolMonitorInterval initialized once at module load; second-import branch unreachable
// Start pool monitoring after first query
if (!poolMonitorInterval) {
  poolMonitorInterval = setInterval(pollConnectionPool, 30_000);
  // Prevent interval from keeping the process alive
  poolMonitorInterval.unref?.();
}
/* v8 ignore stop */

export default prisma;
