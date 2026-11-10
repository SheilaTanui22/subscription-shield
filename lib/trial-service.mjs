import { randomUUID } from "node:crypto";
import { validateTrialInput } from "../public/trial-validation.mjs";

function invalidInputError(errors) {
  const error = new Error("Invalid trial input.");
  error.status = 400;
  error.fieldErrors = errors;
  return error;
}

function notFoundError() {
  const error = new Error("Trial not found.");
  error.status = 404;
  return error;
}

export function createTrialService(store) {
  async function list() {
    const trials = await store.list();
    return [...trials].sort((a, b) => a.trialEndDate.localeCompare(b.trialEndDate));
  }

  async function create(input) {
    const validation = validateTrialInput(input);
    if (!validation.valid) {
      throw invalidInputError(validation.errors);
    }

    return store.mutate((trials) => {
      const now = new Date().toISOString();
      const trial = {
        id: randomUUID(),
        ...validation.value,
        createdAt: now,
        updatedAt: now,
      };
      return { trials: [...trials, trial], result: trial };
    });
  }

  async function update(id, input) {
    const validation = validateTrialInput(input);
    if (!validation.valid) {
      throw invalidInputError(validation.errors);
    }

    return store.mutate((trials) => {
      const index = trials.findIndex((trial) => trial.id === id);
      if (index === -1) throw notFoundError();

      const updated = {
        ...trials[index],
        ...validation.value,
        // The source label reflects how the trial was originally created and
        // is never changed by an edit, regardless of what the request sends.
        source: trials[index].source,
        updatedAt: new Date().toISOString(),
      };
      const nextTrials = [...trials];
      nextTrials[index] = updated;
      return { trials: nextTrials, result: updated };
    });
  }

  function remove(id) {
    return store.mutate((trials) => {
      const index = trials.findIndex((trial) => trial.id === id);
      if (index === -1) throw notFoundError();

      const nextTrials = trials.filter((trial) => trial.id !== id);
      return { trials: nextTrials, result: { id } };
    });
  }

  return { list, create, update, remove };
}
