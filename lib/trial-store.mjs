import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

function corruptionError() {
  const error = new Error(
    "Trial storage file is corrupted and could not be read. It was left untouched."
  );
  error.status = 500;
  error.code = "TRIAL_STORE_CORRUPTED";
  return error;
}

// A small JSON-file store for manually tracked trials. Reads and writes are
// funneled through a single in-process queue so concurrent requests never
// interleave a read-modify-write cycle, and writes land via a temp file +
// rename so a reader never observes a half-written file.
export function createTrialStore(filePath) {
  let queue = Promise.resolve();

  function enqueue(task) {
    const result = queue.then(task, task);
    queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async function readAll() {
    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw corruptionError();
    }

    if (!Array.isArray(data)) {
      throw corruptionError();
    }

    return data;
  }

  async function writeAll(trials) {
    const dir = path.dirname(filePath);
    const tmpPath = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    await writeFile(tmpPath, JSON.stringify(trials, null, 2), "utf8");
    await rename(tmpPath, filePath);
  }

  return {
    list: () => enqueue(readAll),
    // mutator receives the current trials array and returns
    // { trials, result }. If it throws, nothing is written.
    mutate: (mutator) =>
      enqueue(async () => {
        const trials = await readAll();
        const { trials: nextTrials, result } = await mutator(trials);
        await writeAll(nextTrials);
        return result;
      }),
  };
}
