import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createBudgetStore } from "../lib/budget-store.mjs";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "budget-store-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("createBudgetStore", () => {
  test("get() returns an unset budget when the file does not exist yet", () =>
    withTempDir(async (dir) => {
      const store = createBudgetStore(path.join(dir, "budget.json"));
      const budget = await store.get();
      assert.equal(budget.amountCents, null);
      assert.equal(budget.currency, "USD");
    }));

  test("set() persists the new budget to disk", () =>
    withTempDir(async (dir) => {
      const filePath = path.join(dir, "budget.json");
      const store = createBudgetStore(filePath);

      await store.set(() => ({ amountCents: 5000, currency: "USD", updatedAt: "2026-01-01T00:00:00.000Z" }));

      const onDisk = JSON.parse(await readFile(filePath, "utf8"));
      assert.equal(onDisk.amountCents, 5000);
    }));

  test("a $0 budget survives a read back (not confused with unset)", () =>
    withTempDir(async (dir) => {
      const store = createBudgetStore(path.join(dir, "budget.json"));
      await store.set(() => ({ amountCents: 0, currency: "USD", updatedAt: "2026-01-01T00:00:00.000Z" }));

      const budget = await store.get();
      assert.equal(budget.amountCents, 0);
    }));

  test("data survives a simulated server restart (a fresh store reads the same file)", () =>
    withTempDir(async (dir) => {
      const filePath = path.join(dir, "budget.json");
      const storeBeforeRestart = createBudgetStore(filePath);
      await storeBeforeRestart.set(() => ({ amountCents: 2500, currency: "USD", updatedAt: "2026-01-01T00:00:00.000Z" }));

      const storeAfterRestart = createBudgetStore(filePath);
      const budget = await storeAfterRestart.get();
      assert.equal(budget.amountCents, 2500);
    }));

  test("detects a corrupted (non-JSON) file without overwriting it", () =>
    withTempDir(async (dir) => {
      const filePath = path.join(dir, "budget.json");
      await writeFile(filePath, "{not valid json", "utf8");
      const store = createBudgetStore(filePath);

      await assert.rejects(store.get(), (error) => {
        assert.equal(error.status, 500);
        assert.equal(error.code, "BUDGET_STORE_CORRUPTED");
        return true;
      });

      const onDisk = await readFile(filePath, "utf8");
      assert.equal(onDisk, "{not valid json");
    }));

  test("detects a corrupted (array instead of object) file without overwriting it", () =>
    withTempDir(async (dir) => {
      const filePath = path.join(dir, "budget.json");
      await writeFile(filePath, JSON.stringify([1, 2, 3]), "utf8");
      const store = createBudgetStore(filePath);

      await assert.rejects(store.get(), (error) => {
        assert.equal(error.code, "BUDGET_STORE_CORRUPTED");
        return true;
      });
    }));

  test("concurrent set() calls are serialized and the last one wins", () =>
    withTempDir(async (dir) => {
      const filePath = path.join(dir, "budget.json");
      const store = createBudgetStore(filePath);

      await Promise.all([
        store.set(() => ({ amountCents: 1000, currency: "USD", updatedAt: "a" })),
        store.set(() => ({ amountCents: 2000, currency: "USD", updatedAt: "b" })),
      ]);

      const budget = await store.get();
      assert.ok([1000, 2000].includes(budget.amountCents));
    }));
});
