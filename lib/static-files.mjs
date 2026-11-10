import { readFile } from "node:fs/promises";
import path from "node:path";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

// Resolves a request path to a file inside publicDir, refusing anything
// that would escape it (e.g. "/../server.mjs").
export async function readStaticFile(publicDir, requestPath) {
  const relative = requestPath === "/" ? "/index.html" : requestPath;
  const resolved = path.join(publicDir, path.normalize(relative));

  if (!resolved.startsWith(publicDir)) {
    return null;
  }

  const ext = path.extname(resolved);
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) {
    return null;
  }

  try {
    const body = await readFile(resolved);
    return { body, contentType };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
