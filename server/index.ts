import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkDatabaseHealth, ensureSchema, pruneOldRunLogs } from "./db.js";
import { startPrecomputeSchedule } from "./optimal.js";
import { scoresRouter } from "./routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This file compiles to <project-root>/server/dist/index.js, so climbing two
// levels up reaches the project root, which holds index.html/style.css plus
// the browser-facing dist/ tree built separately by the client's own
// tsconfig - never this server/dist/, so backend source is never exposed.
const projectRoot = path.join(__dirname, "..", "..");

const app = express();
app.use(express.json({ limit: "256kb" }));

app.use("/dist", express.static(path.join(projectRoot, "dist")));
app.get("/", (_req, res) => {
  res.sendFile(path.join(projectRoot, "index.html"));
});
app.get("/style.css", (_req, res) => {
  res.sendFile(path.join(projectRoot, "style.css"));
});
// Unlisted diagnostics page (not linked from the game) - the run-log viewer.
app.get("/logs", (_req, res) => {
  res.sendFile(path.join(projectRoot, "logs.html"));
});

app.use(scoresRouter);

app.get("/api/health", async (_req, res) => {
  try {
    await checkDatabaseHealth();
    res.json({ status: "ok" });
  } catch (err) {
    res.status(503).json({ status: "error", message: (err as Error).message });
  }
});

const port = Number(process.env.PORT) || 8080;

// Ensure newer tables exist (init.sql only runs on first DB init) before
// serving. Best-effort: a DB hiccup here shouldn't stop the app from booting,
// since scoring is already resilient to the DB being unreachable.
ensureSchema()
  .then(() => {
    // Once the optimal_routes table is guaranteed to exist, begin precomputing
    // (and daily-refreshing) the "Optimal" solver route for every browsable
    // daily map, so players never wait on the solve. Best-effort and off the
    // request path (it runs on a worker thread).
    startPrecomputeSchedule();
  })
  .catch((err) => {
    console.error("Schema check failed:", (err as Error).message);
  });

// Retention: drop run_logs rows past their window (see pruneOldRunLogs), at
// boot and once a day after. Best-effort - a failure just leaves old rows for
// the next sweep.
const RUN_LOG_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
function pruneRunLogs(): void {
  pruneOldRunLogs()
    .then((removed) => {
      if (removed > 0) console.log(`Pruned ${removed} run-log row(s) past the retention window`);
    })
    .catch((err) => console.error("Run-log prune failed:", (err as Error).message));
}
pruneRunLogs();
setInterval(pruneRunLogs, RUN_LOG_PRUNE_INTERVAL_MS).unref();

app.listen(port, () => {
  console.log(`Unstable Truck server listening on port ${port}`);
});
