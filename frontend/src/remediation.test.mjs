import assert from "node:assert/strict";
import test from "node:test";
import {
  canSubmitRemediationApprove,
  mergeApproveResponse,
  remediationIsInProgress,
  remediationNeedsConfirm,
} from "./remediation.js";

test("proposed and error remediations require explicit confirmation", () => {
  assert.equal(remediationNeedsConfirm("proposed"), true);
  assert.equal(remediationNeedsConfirm("error"), true);
  assert.equal(remediationNeedsConfirm("running"), false);
  assert.equal(remediationNeedsConfirm("complete"), false);
});

test("approve cannot be submitted without confirmation", () => {
  assert.equal(canSubmitRemediationApprove("proposed", false, false), false);
  assert.equal(canSubmitRemediationApprove("proposed", true, false), true);
  assert.equal(canSubmitRemediationApprove("proposed", true, true), false);
  assert.equal(canSubmitRemediationApprove("running", true, false), false);
});

test("approved and running are treated as in progress", () => {
  assert.equal(remediationIsInProgress("approved"), true);
  assert.equal(remediationIsInProgress("running"), true);
  assert.equal(remediationIsInProgress("complete"), false);
});

test("mergeApproveResponse patches one remediation on the matching alert", () => {
  const alerts = [
    {
      id: "a1",
      remediations: [{ id: "r1", status: "proposed" }, { id: "r2", status: "proposed" }],
    },
    { id: "a2", remediations: [{ id: "r3", status: "proposed" }] },
  ];
  const next = mergeApproveResponse(alerts, "a1", {
    ok: false,
    updatedAt: "2026-10-15T12:00:00Z",
    remediation: { id: "r1", status: "error", error: "Atlas said no" },
  });
  assert.equal(next[0].updatedAt, "2026-10-15T12:00:00Z");
  assert.equal(next[0].remediations[0].status, "error");
  assert.equal(next[0].remediations[0].error, "Atlas said no");
  assert.equal(next[0].remediations[1].status, "proposed");
  assert.equal(next[1].remediations[0].status, "proposed");
});
