const TARGET_FIELDS = [
  ["Database", "database"],
  ["Collection", "collection"],
  ["Keys", "keys"],
  ["Op ID", "opId"],
  ["Namespace", "namespace"],
  ["Cluster", "cluster"],
];

export function remediationNeedsConfirm(status) {
  return status === "proposed" || status === "error";
}

export function canSubmitRemediationApprove(status, confirmed, submitting = false) {
  if (submitting) return false;
  if (!remediationNeedsConfirm(status)) return false;
  return confirmed === true;
}

export function remediationIsInProgress(status) {
  return status === "approved" || status === "running";
}

export function remediationStatusLabel(status) {
  if (status === "complete") return "Complete";
  if (status === "error") return "Error";
  if (status === "running") return "Running";
  if (status === "approved") return "Approved";
  return "For the developer";
}

export function formatRemediationTarget(target) {
  if (!target || typeof target !== "object") return [];
  return TARGET_FIELDS.flatMap(([label, key]) => {
    const value = target[key];
    if (value == null || value === "") return [];
    return [[label, formatTargetValue(value)]];
  });
}

function formatTargetValue(value) {
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function remediationCommand(remediation) {
  const target = remediation?.target;
  if (!target || typeof target !== "object") return "";
  if (remediation.action === "create_index" && target.database && target.collection && target.keys) {
    return `db.getSiblingDB(${JSON.stringify(target.database)}).${target.collection}.createIndex(${formatIndexKeys(target.keys)})`;
  }
  if (remediation.action === "kill_operation" && target.opId) {
    const namespace = target.namespace ? ` // ${target.namespace}` : "";
    return `db.killOp(${JSON.stringify(target.opId)})${namespace}`;
  }
  return "";
}

function formatIndexKeys(keys) {
  if (typeof keys === "string") return keys;
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) return "{}";
  const parts = Object.entries(keys).map(([field, direction]) => `${JSON.stringify(field)}: ${direction}`);
  return `{ ${parts.join(", ")} }`;
}

export function formatRemediationResult(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

/** Apply a successful POST /approve JSON body onto the in-memory alert list. */
export function mergeApproveResponse(alerts, alertId, payload) {
  if (!Array.isArray(alerts) || !alertId || !payload?.remediation) return alerts;
  return alerts.map((alert) => {
    if (alert?.id !== alertId) return alert;
    const remediations = Array.isArray(alert.remediations) ? alert.remediations : [];
    const index = remediations.findIndex((item) => item?.id === payload.remediation.id);
    const merged =
      index === -1
        ? payload.remediation
        : { ...remediations[index], ...payload.remediation };
    const nextRemediations =
      index === -1
        ? [...remediations, merged]
        : remediations.map((item, i) => (i === index ? merged : item));
    return {
      ...alert,
      ...(payload.updatedAt ? { updatedAt: payload.updatedAt } : {}),
      remediations: nextRemediations,
    };
  });
}
