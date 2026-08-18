import assert from "node:assert/strict";
import test from "node:test";

import { UPDATE_POLL_ACTIVE_MS, UPDATE_POLL_IDLE_MS, updateFinished, updatePollDelay } from "../client/src/update-polling.js";

test("update polling stays fast only while an installation is active", () => {
  assert.equal(updatePollDelay("applying"), UPDATE_POLL_ACTIVE_MS);
  assert.equal(updatePollDelay("current"), UPDATE_POLL_IDLE_MS);
  assert.equal(updatePollDelay("available"), UPDATE_POLL_IDLE_MS);
  assert.equal(updatePollDelay("failed"), UPDATE_POLL_IDLE_MS);
});

test("the page reloads only after its own active update has finished", () => {
  assert.equal(updateFinished("applying", "current"), true);
  assert.equal(updateFinished("applying", "updated"), true);
  assert.equal(updateFinished("applying", "failed"), false);
  assert.equal(updateFinished("current", "current"), false);
  assert.equal(updateFinished(null, "current"), false);
});
