import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkDatabaseHealth, ensureSchema, pruneExpiredSessions, pruneOldCampaignScores, pruneOldRunLogs, syncAdmins } from "./db.js";
import { startPrecomputeSchedule } from "./optimal.js";
import { cors } from "./cors.js";
import { scoresRouter } from "./routes.js";
import { authRouter } from "./auth-routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This file compiles to <project-root>/server/dist/index.js, so climbing two
// levels up reaches the project root, which holds index.html/style.css plus
// the browser-facing dist/ tree built separately by the client's own
// tsconfig - never this server/dist/, so backend source is never exposed.
const projectRoot = path.join(__dirname, "..", "..");

const app = express();
// One proxy hop: Caddy sits in front (see docker-compose.yml's `edge` network).
// Without this, req.ip is the proxy's address for every request, and the login
// rate limiters in auth-routes.ts would either do nothing or throttle the entire
// internet as a single client.
app.set("trust proxy", 1);
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

app.use("/api", cors);
app.use(authRouter);
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
import { configuredAdmins } from "./config.js";

ensureSchema()
  .then(async () => {
    const admins = configuredAdmins();
    if (admins === null) return;
    try {
      const { promoted, demoted } = await syncAdmins(admins);
      if (promoted.length > 0) console.log(`Granted admin to: ${promoted.join(", ")}`);
      if (demoted.length > 0) console.log(`Revoked admin from: ${demoted.join(", ")}`);
    } catch (err) {
      console.error("Admin sync failed:", (err as Error).message);
    }
  })
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

// Retention: drop run_logs rows past their window (see pruneOldRunLogs) and
// lapsed login sessions, at boot and once a day after. Both are best-effort - a
// failure just leaves the rows for the next sweep, and an expired session is
// already refused by getSessionUser() regardless of whether its row is gone.
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
function pruneStaleRows(): void {
  pruneOldRunLogs()
    .then((removed) => {
      if (removed > 0) console.log(`Pruned ${removed} run-log row(s) past the retention window`);
    })
    .catch((err) => console.error("Run-log prune failed:", (err as Error).message));
  pruneExpiredSessions()
    .then((removed) => {
      if (removed > 0) console.log(`Pruned ${removed} expired session(s)`);
    })
    .catch((err) => console.error("Session prune failed:", (err as Error).message));
  pruneOldCampaignScores()
    .then((removed) => {
      if (removed > 0) console.log(`Pruned ${removed} old campaign score/champion row(s)`);
    })
    .catch((err) => console.error("Campaign score prune failed:", (err as Error).message));
}
pruneStaleRows();
setInterval(pruneStaleRows, PRUNE_INTERVAL_MS).unref();

app.listen(port, () => {
  console.log(`Unstable Truck server listening on port ${port}`);
});
