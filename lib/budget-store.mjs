import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const EMPTY_BUDGET = { amountCents: null, currency: "USD", updatedAt: null };

function corruptionError() {
  const error = new Error(
    "Budget storage file is corrupted and could not be read. It was left untouched."
  );
  error.status = 500;
  error.code = "BUDGET_STORE_CORRUPTED";
  return error;
}

// A small JSON-file store for the user's monthly budget, following the same
// pattern as trial-store.mjs: a single in-process queue (no interleaved
// read-modify-write across concurrent requests) and temp-file + rename
// writes (a reader never observes a half-written file). Unlike trials, this
// stores one object, not a list, and "no file yet" means "budget not set"
// (amountCents: null) rather than an empty collection.
export function createBudgetStore(filePath) {
  let queue = Promise.resolve();

  function enqueue(task) {
    const result = queue.then(task, task);
    queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async function read() {
    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return { ...EMPTY_BUDGET };
      throw error;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw corruptionError();
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw corruptionError();
    }

    const amountCents =
      data.amountCents === null || Number.isInteger(data.amountCents) ? data.amountCents : null;

    return {
      amountCents,
      currency: typeof data.currency === "string" ? data.currency : "USD",
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
    };
  }

  async function write(value) {
    const dir = path.dirname(filePath);
    const tmpPath = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    await writeFile(tmpPath, JSON.stringify(value, null, 2), "utf8");
    await rename(tmpPath, filePath);
  }

  return {
    get: () => enqueue(read),
    // mutator receives the current budget object and returns the next one.
    // If it throws, nothing is written.
    set: (mutator) =>
      enqueue(async () => {
        const current = await read();
        const next = await mutator(current);
        await write(next);
        return next;
      }),
  };
}
