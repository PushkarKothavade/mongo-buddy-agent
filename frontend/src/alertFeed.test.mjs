import assert from "node:assert/strict";
import test from "node:test";
import { alertKey, visibleAlerts } from "./alertFeed.js";

const memory = { id: "alert-memory", title: "Max System Memory Used", status: "error" };
const disk = { id: "alert-disk", title: "Disk space", status: "processing" };

test("new session hides alerts that were already on the page", () => {
  const dismissed = new Set([alertKey(memory)]);
  assert.deepEqual(visibleAlerts([memory, disk], dismissed), [disk]);
});

test("an alert without an id is still dismissed", () => {
  const unnamed = { title: "Connections", detectedAt: "2026-10-15T09:58:00Z" };
  const dismissed = new Set([alertKey(unnamed)]);
  assert.deepEqual(visibleAlerts([unnamed], dismissed), []);
});

test("remediations on an alert do not change dismissal filtering", () => {
  const withRemediations = {
    ...memory,
    remediations: [
      {
        id: "rem-create-index",
        action: "create_index",
        label: "Create recommended index",
        status: "proposed",
        needsApproval: true,
      },
    ],
  };
  const dismissed = new Set([alertKey(memory)]);
  assert.deepEqual(visibleAlerts([withRemediations, disk], dismissed), [disk]);
});

test("remediation ids are not used as alert ids for visibility", () => {
  const alert = {
    id: "alert-connections",
    title: "Connections",
    remediations: [{ id: "remediation-only-id", status: "proposed" }],
  };
  assert.equal(alertKey(alert), "alert-connections");
  assert.deepEqual(visibleAlerts([alert], new Set(["remediation-only-id"])), [alert]);
});
