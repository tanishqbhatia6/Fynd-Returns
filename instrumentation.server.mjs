/**
 * OpenTelemetry SDK Bootstrap
 *
 * Loaded via NODE_OPTIONS='--import ./instrumentation.server.mjs' BEFORE the app boots.
 * Patches HTTP, fetch, Express, DNS, Net, and Prisma modules so auto-instrumentation
 * is active when the React Router server starts.
 *
 * Environment-driven configuration:
 *   OTEL_EXPORTER_OTLP_ENDPOINT  → OTLP protobuf exporter (traces + metrics)
 *   OTEL_EXPORTER_OTLP_HEADERS   → Auth headers for OTLP endpoint
 *   OTEL_SERVICE_NAME             → defaults to "returnpromax"
 *   OTEL_ENVIRONMENT              → defaults to NODE_ENV
 *   OTEL_TRACES_SAMPLER           → e.g. "parentbased_traceidratio"
 *   OTEL_TRACES_SAMPLER_ARG       → e.g. "0.1" for 10% sampling
 *
 * When no OTLP endpoint is set, traces go to console (dev mode).
 */

import os from "node:os";
import { performance, PerformanceObserver, monitorEventLoopDelay } from "node:perf_hooks";

// All @opentelemetry/* packages ship as CJS — named ESM imports break on
// Node 22+.  Use default-import + destructure for full compatibility.
import _sdkNode from "@opentelemetry/sdk-node";
const { NodeSDK } = _sdkNode;

import _resources from "@opentelemetry/resources";
const { Resource } = _resources;

import _instrHttp from "@opentelemetry/instrumentation-http";
const { HttpInstrumentation } = _instrHttp;

import _instrExpress from "@opentelemetry/instrumentation-express";
const { ExpressInstrumentation } = _instrExpress;

import _instrPrisma from "@prisma/instrumentation";
const { PrismaInstrumentation } = _instrPrisma;

import _exporterTrace from "@opentelemetry/exporter-trace-otlp-proto";
const { OTLPTraceExporter } = _exporterTrace;

import _exporterMetrics from "@opentelemetry/exporter-metrics-otlp-proto";
const { OTLPMetricExporter } = _exporterMetrics;

import _sdkTraceNode from "@opentelemetry/sdk-trace-node";
const { ConsoleSpanExporter } = _sdkTraceNode;

import _sdkMetrics from "@opentelemetry/sdk-metrics";
const { PeriodicExportingMetricReader } = _sdkMetrics;

import _api from "@opentelemetry/api";
const { metrics } = _api;

// Semantic convention attribute keys (string literals avoid CJS interop issues)
const ATTR_SERVICE_NAME = "service.name";
const ATTR_SERVICE_VERSION = "service.version";
const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = "deployment.environment.name";

// ---------------------------------------------------------------------------
// Determine exporters based on environment
// ---------------------------------------------------------------------------
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

const traceExporter = otlpEndpoint
  ? new OTLPTraceExporter()
  : new ConsoleSpanExporter();

const metricsReader = otlpEndpoint
  ? new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 30_000,
    })
  : undefined;

// ---------------------------------------------------------------------------
// Build resource with deployment metadata
// ---------------------------------------------------------------------------
const resource = new Resource({
  [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "returnpromax",
  [ATTR_SERVICE_VERSION]: process.env.BUILD_VERSION || process.env.npm_package_version || "0.0.0",
  [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]:
    process.env.OTEL_ENVIRONMENT || process.env.NODE_ENV || "development",
  "host.name": os.hostname(),
  "process.runtime.name": "node",
  "process.runtime.version": process.version,
  "build.commit": process.env.BUILD_COMMIT || "unknown",
  "build.timestamp": process.env.BUILD_TIMESTAMP || new Date().toISOString(),
  "service.namespace": "shopify-apps",
});

// ---------------------------------------------------------------------------
// Initialize SDK
// ---------------------------------------------------------------------------
const sdk = new NodeSDK({
  resource,
  traceExporter,
  ...(metricsReader ? { metricReader: metricsReader } : {}),
  instrumentations: [
    new HttpInstrumentation({
      // Filter out health checks and static assets from traces
      ignoreIncomingRequestHook: (req) => {
        const url = req.url || "";
        return (
          url === "/api/healthz" ||
          url.startsWith("/build/") ||
          url.startsWith("/assets/") ||
          url === "/favicon.ico"
        );
      },
    }),
    new ExpressInstrumentation(),
    new PrismaInstrumentation(),
  ],
});

sdk.start();

// ---------------------------------------------------------------------------
// Runtime metrics — event loop, GC, memory
// ---------------------------------------------------------------------------
const meter = metrics.getMeter("returnpromax.runtime");

// Event loop delay monitoring
const eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
eventLoopHistogram.enable();

const eluState = { prev: performance.eventLoopUtilization() };

const eventLoopDelayP50 = meter.createObservableGauge("nodejs.event_loop.delay_p50", {
  description: "Event loop delay p50 in milliseconds",
  unit: "ms",
});
const eventLoopDelayP99 = meter.createObservableGauge("nodejs.event_loop.delay_p99", {
  description: "Event loop delay p99 in milliseconds",
  unit: "ms",
});
const eventLoopDelayMax = meter.createObservableGauge("nodejs.event_loop.delay_max", {
  description: "Event loop delay max in milliseconds",
  unit: "ms",
});
const eventLoopUtilization = meter.createObservableGauge("nodejs.event_loop.utilization", {
  description: "Event loop utilization ratio (0-1)",
});

meter.addBatchObservableCallback(
  (observer) => {
    observer.observe(eventLoopDelayP50, eventLoopHistogram.percentile(50) / 1e6);
    observer.observe(eventLoopDelayP99, eventLoopHistogram.percentile(99) / 1e6);
    observer.observe(eventLoopDelayMax, eventLoopHistogram.max / 1e6);

    const elu = performance.eventLoopUtilization(eluState.prev);
    observer.observe(eventLoopUtilization, elu.utilization);
    eluState.prev = performance.eventLoopUtilization();

    eventLoopHistogram.reset();
  },
  [eventLoopDelayP50, eventLoopDelayP99, eventLoopDelayMax, eventLoopUtilization],
);

// Memory gauges
const heapUsed = meter.createObservableGauge("process.memory.heap.used", {
  description: "Heap memory used in bytes",
  unit: "By",
});
const heapTotal = meter.createObservableGauge("process.memory.heap.total", {
  description: "Total heap memory in bytes",
  unit: "By",
});
const rss = meter.createObservableGauge("process.memory.rss", {
  description: "Resident set size in bytes",
  unit: "By",
});
const external = meter.createObservableGauge("process.memory.external", {
  description: "External memory in bytes",
  unit: "By",
});

meter.addBatchObservableCallback(
  (observer) => {
    const mem = process.memoryUsage();
    observer.observe(heapUsed, mem.heapUsed);
    observer.observe(heapTotal, mem.heapTotal);
    observer.observe(rss, mem.rss);
    observer.observe(external, mem.external);
  },
  [heapUsed, heapTotal, rss, external],
);

// GC pressure tracking
const gcDuration = meter.createHistogram("nodejs.gc.duration", {
  description: "GC pause duration in milliseconds",
  unit: "ms",
});
const gcCount = meter.createCounter("nodejs.gc.count", {
  description: "Number of GC events",
});

const GC_KIND_NAMES = { 1: "major", 2: "minor", 4: "incremental", 8: "weakcb", 15: "all" };

const gcObserver = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const kind = entry.detail?.kind ?? 0;
    const kindName = GC_KIND_NAMES[kind] || "unknown";
    gcDuration.record(entry.duration, { "gc.type": kindName });
    gcCount.add(1, { "gc.type": kindName });
  }
});
gcObserver.observe({ type: "gc", buffered: true });

// Active handles/requests
const activeHandles = meter.createObservableGauge("nodejs.active_handles", {
  description: "Number of active handles",
});
const activeRequests = meter.createObservableGauge("nodejs.active_requests", {
  description: "Number of active requests",
});

meter.addBatchObservableCallback(
  (observer) => {
    observer.observe(activeHandles, process._getActiveHandles?.()?.length ?? 0);
    observer.observe(activeRequests, process._getActiveRequests?.()?.length ?? 0);
  },
  [activeHandles, activeRequests],
);

// ---------------------------------------------------------------------------
// Global error handlers
// ---------------------------------------------------------------------------
process.on("uncaughtException", (err) => {
  console.error("[instrumentation] Uncaught exception:", err);
  sdk.shutdown().finally(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
  console.error("[instrumentation] Unhandled rejection:", reason);
  // Don't exit — log and continue for operational errors
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
const shutdown = () => {
  sdk.shutdown().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Startup log
console.log(
  `[instrumentation] OTel SDK started — exporter: ${otlpEndpoint ? "OTLP" : "console"}, ` +
    `service: ${process.env.OTEL_SERVICE_NAME || "returnpromax"}, ` +
    `env: ${process.env.OTEL_ENVIRONMENT || process.env.NODE_ENV || "development"}`,
);
