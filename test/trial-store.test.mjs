import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTrialStore } from "../lib/trial-store.mjs";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "trial-store-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("createTrialStore", () => {
  test("list() returns an empty array when the file does not exist yet", () =>
    withTempDir(async (dir) => {
      const store = createTrialStore(path.join(dir, "trials.json"));
      assert.deepEqual(await store.list(), []);
    }));

  test("mutate() persists a new entry to disk", () =>
    withTempDir(async (dir) => {
      const filePath = path.join(dir, "trials.json");
      const store = createTrialStore(filePath);

      await store.mutate((trials) => ({
        trials: [...trials, { id: "a", serviceName: "StreamBox" }],
        result: "ok",
      }));

      const onDisk = JSON.parse(await readFile(filePath, "utf8"));
      assert.deepEqual(onDisk, [{ id: "a", serviceName: "StreamBox" }]);
    }));

  test("data survives a simulated server restart (a fresh store reads the same file)", () =>
    withTempDir(async (dir) => {
      const filePath = path.join(dir, "trials.json");
      const storeBeforeRestart = createTrialStore(filePath);

      await storeBeforeRestart.mutate((trials) => ({
        trials: [...trials, { id: "a", serviceName: "StreamBox" }],
        result: "ok",
      }));

      // A restart means a brand new process constructing a brand new store
      // instance against the same file path, with no shared in-memory state.
      const storeAfterRestart = createTrialStore(filePath);
      const trials = await storeAfterRestart.list();
      assert.equal(trials.length, 1);
      assert.equal(trials[0].id, "a");
    }));

  test("a mutator that throws (e.g. not found) writes nothing", () =>
    withTempDir(async (dir) => {
      const filePath = path.join(dir, "trials.json");
      const store = createTrialStore(filePath);

      await store.mutate((trials) => ({ trials: [...trials, { id: "a" }], result: "ok" }));

      await assert.rejects(
        store.mutate(() => {
          throw new Error("not found");
        })
      );

      const trials = await store.list();
      assert.equal(trials.length, 1);
      assert.equal(trials[0].id, "a");
    }));

  test("detects a corrupted (non-JSON) file without overwriting it", () =>
    withTempDir(async (dir) => {
      const filePath = path.join(dir, "trials.json");
      await writeFile(filePath, "{not valid json", "utf8");
      const store = createTrialStore(filePath);

      await assert.rejects(store.list(), (error) => {
        assert.equal(error.status, 500);
        assert.equal(error.code, "TRIAL_STORE_CORRUPTED");
        return true;
      });

      // The corrupted content must still be there — list() never wrote an
      // empty array over it.
      const onDisk = await readFile(filePath, "utf8");
      assert.equal(onDisk, "{not valid json");
    }));

  test("detects a corrupted (non-array) file without overwriting it", () =>
    withTempDir(async (dir) => {
      const filePath = path.join(dir, "trials.json");
      await writeFile(filePath, JSON.stringify({ not: "an array" }), "utf8");
      const store = createTrialStore(filePath);

      await assert.rejects(store.list(), (error) => {
        assert.equal(error.status, 500);
        return true;
      });

      const onDisk = JSON.parse(await readFile(filePath, "utf8"));
      assert.deepEqual(onDisk, { not: "an array" });
    }));

  test("a mutate() attempt against corrupted storage does not touch the file", () =>
    withTempDir(async (dir) => {
      const filePath = path.join(dir, "trials.json");
      await writeFile(filePath, "not json at all", "utf8");
      const store = createTrialStore(filePath);

      await assert.rejects(
        store.mutate((trials) => ({ trials: [...trials, { id: "a" }], result: "ok" }))
      );

      const onDisk = await readFile(filePath, "utf8");
      assert.equal(onDisk, "not json at all");
    }));

  test("concurrent mutate() calls are serialized and both entries survive", () =>
    withTempDir(async (dir) => {
      const filePath = path.join(dir, "trials.json");
      const store = createTrialStore(filePath);

      const addOne = (id) =>
        store.mutate((trials) => ({ trials: [...trials, { id }], result: id }));

      // Fired without awaiting in between, so they genuinely overlap — the
      // store's internal queue is what has to keep this correct.
      await Promise.all([addOne("first"), addOne("second")]);

      const trials = await store.list();
      assert.equal(trials.length, 2);
      assert.deepEqual(
        trials.map((t) => t.id).sort(),
        ["first", "second"]
      );
    }));

  test("ten concurrent mutate() calls all persist", () =>
    withTempDir(async (dir) => {
      const filePath = path.join(dir, "trials.json");
      const store = createTrialStore(filePath);

      const tasks = Array.from({ length: 10 }, (_, i) =>
        store.mutate((trials) => ({ trials: [...trials, { id: `t${i}` }], result: i }))
      );
      await Promise.all(tasks);

      const trials = await store.list();
      assert.equal(trials.length, 10);
    }));
});
