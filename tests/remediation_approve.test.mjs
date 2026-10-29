// Run: node --test tests/remediation_approve.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  approveRemediation,
  createIndexAction,
  createRemediationDeps,
  killOperationAction,
} from "../frontend/agentcore-proxy.js";

const PROJECT = "5d1b6f8e8c2e4e2d3c4a5b6d";

function indexRemediation(overrides = {}) {
  return {
    id: "idx-1",
    action: "create_index",
    label: "Create recommended index",
    reason: "COLLSCAN",
    impact: "Builds one rolling index.",
    needsApproval: true,
    status: "proposed",
    target: {
      cluster: "summit-demo",
      projectId: PROJECT,
      database: "aws_summit",
      collection: "customers",
      keys: { city: 1, age: -1 },
    },
    error: null,
    result: null,
    ...overrides,
  };
}

function killRemediation(overrides = {}) {
  return {
    id: "kill-1",
    action: "kill_operation",
    label: "Kill the operation causing the alert",
    reason: "40 minute scan",
    impact: "Stops one operation.",
    needsApproval: true,
    status: "proposed",
    target: { cluster: "summit-demo", projectId: PROJECT, opId: 4711, namespace: "aws_summit.customers" },
    error: null,
    result: null,
    ...overrides,
  };
}

function memoryStore(remediations) {
  const state = {
    record: {
      id: "alert1",
      cluster: "summit-demo",
      projectId: PROJECT,
      status: "complete",
      analysis: "## Summary\n\nOriginal analysis.",
      updatedAt: "2026-10-15T00:00:00Z",
      remediations,
    },
    version: 1,
    saves: [],
  };
  return {
    state,
    deps(executors, extra = {}) {
      return createRemediationDeps({
        now: () => "2026-10-15T10:00:00Z",
        executors,
        context: {},
        async load() {
          return { record: structuredClone(state.record), etag: `"v${state.version}"` };
        },
        async save(_key, record, etag) {
          if (etag !== `"v${state.version}"`) {
            const error = new Error("precondition");
            error.$metadata = { httpStatusCode: 412 };
            throw error;
          }
          state.version += 1;
          state.record = structuredClone(record);
          state.saves.push(structuredClone(record.remediations.map((item) => item.status)));
        },
        ...extra,
      });
    },
  };
}

const call = (deps, overrides = {}) =>
  approveRemediation(
    {
      method: "POST",
      alertId: "alert1",
      remediationId: "idx-1",
      contentType: "application/json",
      rawBody: Buffer.from(JSON.stringify({ confirm: true })),
      ...overrides,
    },
    deps,
  );

test("approving runs only that remediation and records the result", async () => {
  const store = memoryStore([indexRemediation(), killRemediation()]);
  const calls = [];
  const deps = store.deps({
    create_index: async (target) => {
      calls.push(["create_index", target]);
      return { accepted: true };
    },
    kill_operation: async () => {
      calls.push(["kill_operation"]);
      return {};
    },
  });

  const result = await call(deps);

  assert.equal(result.status, 403);
  assert.match(result.body.error, /does not run this command/);
  assert.equal(calls.length, 0);
  assert.equal(store.state.saves.length, 0);
  assert.equal(store.state.record.remediations[0].status, "proposed");
  assert.equal(store.state.record.analysis, "## Summary\n\nOriginal analysis.");
});

for (const [name, rawBody, contentType] of [
  ["no body", Buffer.from(""), "application/json"],
  ["confirm false", Buffer.from('{"confirm":false}'), "application/json"],
  ["confirm as string", Buffer.from('{"confirm":"true"}'), "application/json"],
  ["extra keys", Buffer.from('{"confirm":true,"force":true}'), "application/json"],
  ["array", Buffer.from("[true]"), "application/json"],
  ["not json", Buffer.from("confirm=true"), "application/json"],
  ["wrong content type", Buffer.from('{"confirm":true}'), "text/plain"],
]) {
  test(`rejects ${name} without touching the record`, async () => {
    const store = memoryStore([indexRemediation()]);
    let ran = false;
    const deps = store.deps({ create_index: async () => (ran = true) });

    const result = await call(deps, { rawBody, contentType });

    assert.ok(result.status >= 400 && result.status < 500, `got ${result.status}`);
    assert.equal(ran, false);
    assert.equal(store.state.saves.length, 0);
  });
}

test("rejects methods other than POST", async () => {
  const store = memoryStore([indexRemediation()]);
  const result = await call(store.deps({}), { method: "GET" });
  assert.equal(result.status, 405);
  assert.equal(store.state.saves.length, 0);
});

test("approval never executes, including a running, complete, or missing remediation", async () => {
  for (const status of ["running", "complete", "proposed"]) {
    const store = memoryStore([indexRemediation({ status })]);
    let ran = false;
    const result = await call(store.deps({ create_index: async () => (ran = true) }));
    assert.equal(result.status, 403);
    assert.equal(ran, false);
    assert.equal(store.state.saves.length, 0);
  }
  const store = memoryStore([indexRemediation()]);
  assert.equal((await call(store.deps({}), { remediationId: "nope" })).status, 403);
});

test("a failed remediation is not retried by Mongo Buddy", async () => {
  const store = memoryStore([indexRemediation({ status: "error", error: "earlier failure" })]);
  const result = await call(store.deps({ create_index: async () => ({ accepted: true }) }));
  assert.equal(result.status, 403);
  assert.equal(store.state.record.remediations[0].status, "error");
  assert.equal(store.state.record.remediations[0].error, "earlier failure");
});

test("an approval does not call the executor or rewrite the analysis", async () => {
  const store = memoryStore([indexRemediation()]);
  let ran = false;
  const deps = store.deps({
    create_index: async () => {
      ran = true;
      throw new Error("mdb_sa_sk_SECRETVALUE leaked in a message");
    },
  });

  const result = await call(deps);

  const saved = store.state.record.remediations[0];
  assert.equal(result.status, 403);
  assert.equal(ran, false);
  assert.equal(saved.status, "proposed");
  assert.equal(saved.result, null);
  assert.equal(store.state.record.analysis, "## Summary\n\nOriginal analysis.");
});

test("a target for another project or cluster is not executed", async () => {
  for (const target of [
    { ...indexRemediation().target, projectId: "aaaaaaaaaaaaaaaaaaaaaaaa" },
    { ...indexRemediation().target, cluster: "someone-elses-cluster" },
  ]) {
    const store = memoryStore([indexRemediation({ target })]);
    let ran = false;
    const result = await call(store.deps({ create_index: async () => (ran = true) }));
    assert.equal(ran, false);
    assert.equal(result.status, 403);
    assert.equal(store.state.record.remediations[0].status, "proposed");
  }
});

test("unsupported actions never reach an executor", async () => {
  const store = memoryStore([indexRemediation({ action: "drop_collection" })]);
  let ran = false;
  const result = await call(
    store.deps({ create_index: async () => (ran = true), kill_operation: async () => (ran = true), constructor: async () => (ran = true) }),
  );
  assert.equal(ran, false);
  assert.equal(result.status, 403);
  assert.equal(store.state.record.remediations[0].status, "proposed");
});

test("two simultaneous approvals both refuse and run nothing", async () => {
  const store = memoryStore([indexRemediation()]);
  let runs = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const deps = store.deps({
    create_index: async () => {
      runs += 1;
      await gate;
      return { accepted: true };
    },
  });

  const first = call(deps);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await call(deps);
  release();
  const done = await first;

  assert.equal(second.status, 403);
  assert.equal(done.status, 403);
  assert.equal(runs, 0);
  assert.equal(store.state.saves.length, 0);
});

test("create_index without Atlas credentials fails clearly and sends nothing", async () => {
  let fetched = false;
  await assert.rejects(
    createIndexAction(indexRemediation().target, {}, { credentials: null, fetch: async () => (fetched = true) }),
    /No Atlas service account is configured/,
  );
  assert.equal(fetched, false);
});

test("create_index sends only the proposed keys as a rolling index", async () => {
  const requests = [];
  const fetchStub = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith("/api/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    }
    return new Response("{}", { status: 202 });
  };

  const result = await createIndexAction(
    indexRemediation().target,
    {},
    { credentials: { clientId: "id", clientSecret: "secret-value" }, fetch: fetchStub },
  );

  assert.equal(result.accepted, true);
  assert.equal(result.mode, "rolling");
  const index = requests[1];
  assert.equal(
    index.url,
    `https://cloud.mongodb.com/api/atlas/v2/groups/${PROJECT}/clusters/summit-demo/index`,
  );
  assert.equal(index.init.method, "POST");
  assert.deepEqual(JSON.parse(index.init.body), {
    db: "aws_summit",
    collection: "customers",
    keys: [{ city: "1" }, { age: "-1" }],
  });
});

test("create_index rejects operator keys and system collections before any request", async () => {
  for (const patch of [
    { keys: { $where: 1 } },
    { keys: {} },
    { collection: "system.users" },
    { database: "a.b" },
  ]) {
    let fetched = false;
    await assert.rejects(
      createIndexAction(
        { ...indexRemediation().target, ...patch },
        {},
        { credentials: { clientId: "id", clientSecret: "secret" }, fetch: async () => (fetched = true) },
      ),
      /no index was created/i,
    );
    assert.equal(fetched, false);
  }
});

test("create_index surfaces an Atlas permission error without the secret", async () => {
  const fetchStub = async (url) =>
    url.endsWith("/api/oauth/token")
      ? new Response(JSON.stringify({ access_token: "tok" }), { status: 200 })
      : new Response(JSON.stringify({ errorCode: "CANNOT_CREATE_INDEX", detail: "secret-value is not allowed" }), { status: 403 });

  await assert.rejects(
    createIndexAction(
      indexRemediation().target,
      {},
      { credentials: { clientId: "id", clientSecret: "secret-value" }, fetch: fetchStub },
    ),
    (error) => /HTTP 403/.test(error.message) && !error.message.includes("secret-value") && /No index was created/.test(error.message),
  );
});

test("kill_operation without a connection fails clearly and runs nothing", async () => {
  let ran = false;
  await assert.rejects(
    killOperationAction(killRemediation().target, {}, { connectionString: "", runMongosh: async () => (ran = true) }),
    /Nothing was killed/,
  );
  assert.equal(ran, false);
});

test("kill_operation refuses a connection string for another cluster", async () => {
  let ran = false;
  await assert.rejects(
    killOperationAction(
      killRemediation().target,
      {},
      { connectionString: "mongodb+srv://user:pw@other-cluster.abc.mongodb.net/", runMongosh: async () => (ran = true) },
    ),
    /does not point at cluster summit-demo/,
  );
  assert.equal(ran, false);
});

test("kill_operation passes exactly one op id and namespace, and keeps the URI out of errors", async () => {
  const uri = "mongodb+srv://user:hunter2@summit-demo.abc.mongodb.net/";
  let seenEnv;
  const result = await killOperationAction(
    killRemediation().target,
    {},
    {
      connectionString: uri,
      runMongosh: async (env) => {
        seenEnv = env;
        return {
          error: null,
          stderr: "",
          stdout: `noise\nMB_RESULT ${JSON.stringify({ status: "killed", ok: 1, stillListed: false, op: "query", secsRunning: 2400 })}\n`,
        };
      },
    },
  );
  assert.equal(seenEnv.MB_OPID, "4711");
  assert.equal(seenEnv.MB_NS, "aws_summit.customers");
  assert.equal(result.provider, "mongosh-killOp");
  assert.equal(result.stillListed, false);

  await assert.rejects(
    killOperationAction(
      killRemediation().target,
      {},
      {
        connectionString: uri,
        runMongosh: async () => ({
          error: new Error(`failed to connect to ${uri}`),
          stderr: "",
          stdout: "",
        }),
      },
    ),
    (error) => !error.message.includes("hunter2"),
  );
});

test("kill_operation does not fake success when the op is gone or elsewhere", async () => {
  const uri = "mongodb+srv://user:pw@summit-demo.abc.mongodb.net/";
  for (const [outcome, pattern] of [
    [{ status: "not_found" }, /not running on this cluster/],
    [{ status: "namespace_mismatch", actual: "orders.items" }, /orders\.items/],
    [{ status: "failed", message: "not authorized on admin to execute command" }, /killOp failed/],
    [{ status: "killed", ok: 0, info: "denied" }, /refused/],
  ]) {
    await assert.rejects(
      killOperationAction(
        killRemediation().target,
        {},
        { connectionString: uri, runMongosh: async () => ({ error: null, stderr: "", stdout: `MB_RESULT ${JSON.stringify(outcome)}\n` }) },
      ),
      pattern,
    );
  }
});

test("kill_operation refuses internal namespaces and malformed op ids before connecting", async () => {
  for (const patch of [{ namespace: "local.oplog.rs" }, { namespace: "admin.system.users" }, { opId: "1; drop" }, { opId: -1 }]) {
    let ran = false;
    await assert.rejects(
      killOperationAction(
        { ...killRemediation().target, ...patch },
        {},
        { connectionString: "mongodb+srv://u:p@summit-demo.abc.mongodb.net/", runMongosh: async () => (ran = true) },
      ),
      /nothing was killed/i,
    );
    assert.equal(ran, false);
  }
});

test("the mongosh script reports a connection failure as a failed result, not a kill", async () => {
  // Real mongosh, unreachable host: proves the script parses and never claims success.
  const { execFile } = await import("node:child_process");
  const probe = await new Promise((resolve) =>
    execFile("mongosh", ["--version"], (error) => resolve(!error)),
  );
  if (!probe) return;
  const result = await killOperationAction(killRemediation().target, {}, {
    connectionString: "mongodb://summit-demo.invalid:1/?serverSelectionTimeoutMS=500&connectTimeoutMS=500",
  }).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, message: error.message }),
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /killOp failed|did not return a result/);
});
