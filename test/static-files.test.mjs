import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readStaticFile } from "../lib/static-files.mjs";

const publicDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "public"
);

test("serves index.html for /", async () => {
  const file = await readStaticFile(publicDir, "/");
  assert.ok(file);
  assert.equal(file.contentType, "text/html; charset=utf-8");
});

test("serves app.mjs with a script content type", async () => {
  const file = await readStaticFile(publicDir, "/app.mjs");
  assert.ok(file);
  assert.equal(file.contentType, "text/javascript; charset=utf-8");
});

test("refuses to escape the public directory", async () => {
  const file = await readStaticFile(publicDir, "/../server.mjs");
  assert.equal(file, null);
});

test("returns null for a missing file", async () => {
  const file = await readStaticFile(publicDir, "/does-not-exist.html");
  assert.equal(file, null);
});

test("returns null for an unrecognized extension", async () => {
  const file = await readStaticFile(publicDir, "/../.env");
  assert.equal(file, null);
});
