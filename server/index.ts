import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkDatabaseHealth, ensureSchema } from "./db.js";
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
ensureSchema().catch((err) => {
  console.error("Schema check failed:", (err as Error).message);
});

app.listen(port, () => {
  console.log(`Unstable Truck server listening on port ${port}`);
});
