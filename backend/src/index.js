import express from "express";
import cors from "cors";
import { initSchema, read, write, pingWrite } from "./db.js";
import redis from "./redisClient.js";
import { enqueueItemCreated } from "./queue.js";
import { searchHealth } from "./search.js";
import { metricsMiddleware, metricsHandler } from "./metrics.js";

const app = express();
app.use(cors());
app.use(express.json());
app.use(metricsMiddleware);

// Prometheus scrape endpoint (not routed by the Ingress, which only exposes /api).
app.get("/metrics", metricsHandler);

const PORT = process.env.PORT || 4000;

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Liveness: is the process itself up (no dependency checks).
app.get("/api/health/live", (req, res) => res.json({ status: "alive" }));

// Readiness: are our dependencies reachable. Used by k8s to gate traffic.
app.get("/api/health/ready", async (req, res) => {
  try {
    await pingWrite();
    res.json({ status: "ready" });
  } catch (err) {
    res.status(503).json({ status: "not-ready", error: err.message });
  }
});

app.get("/api/health/redis", async (req, res) => {
  try {
    await redis.ping();
    res.json({ status: "ok" });
  } catch (err) {
    res.status(503).json({ status: "error", error: err.message });
  }
});

app.get("/api/health/search", async (req, res) => {
  try {
    const health = await searchHealth();
    res.json({ status: "ok", cluster: health.status });
  } catch (err) {
    res.status(503).json({ status: "error", error: err.message });
  }
});

// Reads are served from the "read" pool (replica in a real cluster).
app.get("/api/items", async (req, res) => {
  try {
    const { rows } = await read(
      "SELECT id, name, created_at FROM items ORDER BY id DESC LIMIT 50"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Writes always go through the "write" pool (primary in a real cluster),
// then fan out a job to the queue for async work (e.g. search indexing).
app.post("/api/items", async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required" });
  try {
    const { rows } = await write(
      "INSERT INTO items (name) VALUES ($1) RETURNING id, name, created_at",
      [name]
    );
    const item = rows[0];
    enqueueItemCreated(item).catch((err) =>
      console.error("failed to enqueue item-created event:", err.message)
    );
    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`backend listening on :${PORT}`));
  })
  .catch((err) => {
    console.error("failed to initialize schema:", err);
    process.exit(1);
  });
