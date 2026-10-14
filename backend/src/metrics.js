import client from "prom-client";

// Process-level metrics (CPU, memory, event loop lag, GC) with a common prefix.
export const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: "backend_" });

// RED metrics: Rate, Errors, Duration - labelled by route template (not raw
// URL) to keep cardinality bounded.
const httpRequests = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"],
  registers: [register],
});

const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

export function metricsMiddleware(req, res, next) {
  if (req.path === "/metrics") return next();
  const end = httpDuration.startTimer();
  res.on("finish", () => {
    const labels = {
      method: req.method,
      route: req.route?.path || "unmatched",
      status: String(res.statusCode),
    };
    httpRequests.inc(labels);
    const seconds = end(labels);
    // One structured JSON log line per request (probes skipped to cut noise),
    // so Loki can filter with `| json | status >= 500` etc.
    if (!req.path.startsWith("/api/health")) {
      console.log(JSON.stringify({
        level: res.statusCode >= 500 ? "error" : "info",
        msg: "request",
        ...labels,
        path: req.path,
        duration_ms: Math.round(seconds * 1000),
      }));
    }
  });
  next();
}

export async function metricsHandler(req, res) {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
}
