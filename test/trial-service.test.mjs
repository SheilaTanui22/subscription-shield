import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createTrialService } from "../lib/trial-service.mjs";

// A minimal in-memory stand-in for the real trial-store, implementing the
// same { list, mutate } contract so trial-service's validation and CRUD
// logic can be tested in isolation from file I/O.
function fakeStore(initial = []) {
  let trials = initial;
  return {
    list: async () => trials,
    mutate: async (mutator) => {
      const { trials: nextTrials, result } = await mutator(trials);
      trials = nextTrials;
      return result;
    },
  };
}

function validInput(overrides = {}) {
  return {
    serviceName: "StreamBox",
    trialEndDate: "2026-12-01",
    renewalPrice: "12.99",
    currency: "USD",
    billingFrequency: "monthly",
    reminderLeadDays: 3,
    ...overrides,
  };
}

describe("create", () => {
  test("creates a trial with an id, timestamps, and source=manual", async () => {
    const service = createTrialService(fakeStore());
    const trial = await service.create(validInput());

    assert.ok(trial.id);
    assert.equal(trial.source, "manual");
    assert.ok(trial.createdAt);
    assert.ok(trial.updatedAt);
    assert.equal(trial.serviceName, "StreamBox");
    assert.equal(trial.renewalPriceCents, 1299);
  });

  test("rejects invalid input with field errors and does not store anything", async () => {
    const store = fakeStore();
    const service = createTrialService(store);

    await assert.rejects(
      service.create(validInput({ serviceName: "" })),
      (error) => {
        assert.equal(error.status, 400);
        assert.ok(error.fieldErrors.serviceName);
        return true;
      }
    );

    assert.deepEqual(await service.list(), []);
  });

  test("assigns distinct ids to separate trials", async () => {
    const service = createTrialService(fakeStore());
    const a = await service.create(validInput({ serviceName: "A" }));
    const b = await service.create(validInput({ serviceName: "B" }));
    assert.notEqual(a.id, b.id);
  });

  test("creates a trial with source=ai_import when requested", async () => {
    const service = createTrialService(fakeStore());
    const trial = await service.create(validInput({ source: "ai_import" }));
    assert.equal(trial.source, "ai_import");
  });
});

describe("list", () => {
  test("sorts trials by trial end date ascending", async () => {
    const service = createTrialService(fakeStore());
    await service.create(validInput({ serviceName: "Later", trialEndDate: "2026-12-25" }));
    await service.create(validInput({ serviceName: "Sooner", trialEndDate: "2026-11-01" }));

    const trials = await service.list();
    assert.deepEqual(
      trials.map((t) => t.serviceName),
      ["Sooner", "Later"]
    );
  });
});

describe("update", () => {
  test("updates an existing trial's fields and bumps updatedAt", async () => {
    const service = createTrialService(fakeStore());
    const created = await service.create(validInput());

    await new Promise((resolve) => setTimeout(resolve, 2));
    const updated = await service.update(created.id, validInput({ serviceName: "NewName" }));

    assert.equal(updated.id, created.id);
    assert.equal(updated.serviceName, "NewName");
    assert.equal(updated.createdAt, created.createdAt);
    assert.notEqual(updated.updatedAt, created.updatedAt);
  });

  test("preserves the original source label when editing an ai_import trial", async () => {
    const service = createTrialService(fakeStore());
    const created = await service.create(validInput({ source: "ai_import" }));

    const updated = await service.update(created.id, validInput({ serviceName: "Renamed", source: "manual" }));

    assert.equal(updated.source, "ai_import");
  });

  test("rejects an update for an unknown id", async () => {
    const service = createTrialService(fakeStore());
    await assert.rejects(service.update("missing", validInput()), (error) => {
      assert.equal(error.status, 404);
      return true;
    });
  });

  test("rejects invalid input on update without modifying the existing trial", async () => {
    const service = createTrialService(fakeStore());
    const created = await service.create(validInput());

    await assert.rejects(service.update(created.id, validInput({ renewalPrice: "-1" })));

    const [stillThere] = await service.list();
    assert.equal(stillThere.serviceName, created.serviceName);
    assert.equal(stillThere.renewalPriceCents, created.renewalPriceCents);
  });
});

describe("remove", () => {
  test("deletes an existing trial", async () => {
    const service = createTrialService(fakeStore());
    const created = await service.create(validInput());

    const result = await service.remove(created.id);
    assert.deepEqual(result, { id: created.id });
    assert.deepEqual(await service.list(), []);
  });

  test("rejects deleting an unknown id", async () => {
    const service = createTrialService(fakeStore());
    await assert.rejects(service.remove("missing"), (error) => {
      assert.equal(error.status, 404);
      return true;
    });
  });

  test("deleting one trial leaves the others intact", async () => {
    const service = createTrialService(fakeStore());
    const a = await service.create(validInput({ serviceName: "A" }));
    const b = await service.create(validInput({ serviceName: "B" }));

    await service.remove(a.id);

    const remaining = await service.list();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, b.id);
  });
});
