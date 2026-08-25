import type { RequestHandler } from "express";

const ALLOWED_EXACT = new Set(["https://lewistrick.com"]);
const ALLOWED_SUFFIXES = [".itch.zone", ".hwcdn.net", ".itch.io"];

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_EXACT.has(origin)) return true;
  try {
    const { hostname, protocol } = new URL(origin);
    if (
      (protocol === "http:") &&
      (hostname === "localhost" || hostname === "127.0.0.1")
    ) {
      return true;
    }
    return ALLOWED_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

export const cors: RequestHandler = (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
};
