import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export const RUNTIME_ARN =
  process.env.AGENTCORE_RUNTIME_ARN ||
  "arn:aws:bedrock-agentcore:ap-south-1:979559056307:runtime/mongobuddy_mongo_buddy-1NVzOI7fA8";

const REGION = process.env.AWS_REGION || "ap-south-1";
const ALERT_BUCKET = process.env.ALERT_BUCKET || "mongobuddy-atlas-alerts-979559056307";
const ALERT_PREVIEW_FILE = process.env.ALERT_PREVIEW_FILE || "";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function writeStream(res, body) {
  if (!body) {
    res.end();
    return;
  }
  if (typeof body.transformToWebStream === "function") {
    const reader = body.transformToWebStream().getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
    return;
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) {
      res.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    res.end();
    return;
  }
  res.end(Buffer.from(body));
}

async function loadAlerts() {
  if (ALERT_PREVIEW_FILE) {
    const body = JSON.parse(await readFile(ALERT_PREVIEW_FILE, "utf8"));
    return Array.isArray(body) ? body : body.alerts || [];
  }
  const s3 = new S3Client({ region: REGION });
  const listed = await s3.send(
    new ListObjectsV2Command({ Bucket: ALERT_BUCKET, Prefix: "alerts/", MaxKeys: 20 }),
  );
  const keys = (listed.Contents || [])
    .filter((item) => item.Key && item.Key.endsWith(".json"))
    .sort((left, right) => (right.LastModified?.getTime() || 0) - (left.LastModified?.getTime() || 0))
    .slice(0, 8);
  const alerts = [];
  for (const item of keys) {
    const object = await s3.send(new GetObjectCommand({ Bucket: ALERT_BUCKET, Key: item.Key }));
    alerts.push(JSON.parse(await object.Body.transformToString()));
  }
  alerts.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  return alerts;
}

// ---------------------------------------------------------------------------
// Remediation approval.
//
// The investigation agent is read-only and only proposes actions. This is the one
// place that can change a cluster, and it runs a single proposed action after an
// explicit POST with {"confirm": true}. Two actions exist, nothing else:
//   create_index    Atlas Admin API "create one rolling index" (service account).
//   kill_operation  mongosh: verify one op id and namespace, then killOp on that id.
// ---------------------------------------------------------------------------

const ALERT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const REMEDIATION_ID = /^[A-Za-z0-9_.-]{1,80}$/;
const PROJECT_ID = /^[0-9a-fA-F]{24}$/;
const CLUSTER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DATABASE_NAME = /^[^\x00/\\. "$*<>:|?]{1,64}$/;
const COLLECTION_NAME = /^(?!system\.)[^\x00$]{1,120}$/;
const OP_ID_STRING = /^[A-Za-z0-9_.-]{1,64}:\d{1,12}$/;
const INDEX_DIRECTIONS = new Set([1, -1, "text", "hashed", "2dsphere"]);
const REMEDIABLE = new Set(["proposed", "error"]);
const ATLAS_API = "https://cloud.mongodb.com";
const ATLAS_API_VERSION = "application/vnd.atlas.2023-01-01+json";
const REMEDIATION_ROUTE = /^\/api\/alerts\/([^/]+)\/remediations\/([^/]+)\/approve$/;
const INTERNAL_NAMESPACE = /^(admin|local|config)\./;

class RemediationError extends Error {}

const inflight = new Set();

function envFileValues(names) {
  // The repo-root .env is what the agent uses. Read only the named keys from it.
  const wanted = new Set(names);
  const values = {};
  try {
    const text = readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match || !wanted.has(match[1])) continue;
      values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {
    // No .env is fine. The process environment may carry the settings.
  }
  return values;
}

function setting(name) {
  return (process.env[name] || envFileValues([name])[name] || "").trim();
}

function atlasCredentials() {
  // Prefer a dedicated writer. Fall back to the service account the MCP server already uses;
  // Atlas decides whether that account may create indexes.
  const clientId = setting("MONGO_BUDDY_REMEDIATION_CLIENT_ID") || setting("MDB_MCP_API_CLIENT_ID");
  const clientSecret = setting("MONGO_BUDDY_REMEDIATION_CLIENT_SECRET") || setting("MDB_MCP_API_CLIENT_SECRET");
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function killOpConnectionString() {
  return setting("MONGO_BUDDY_KILLOP_URI") || setting("MDB_MCP_CONNECTION_STRING");
}

function redact(message, secrets = []) {
  let text = String(message ?? "");
  for (const secret of secrets) {
    if (secret && secret.length >= 4) text = text.split(secret).join("[redacted]");
  }
  return text
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"']+/gi, "[connection string redacted]")
    .replace(/mdb_sa_(?:sk|id)_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .slice(0, 1200);
}

function validateIndexTarget(target) {
  const { database, collection, keys } = target;
  if (typeof database !== "string" || !DATABASE_NAME.test(database)) {
    throw new RemediationError("The proposal has no valid database name, so no index was created.");
  }
  if (typeof collection !== "string" || !COLLECTION_NAME.test(collection)) {
    throw new RemediationError("The proposal has no valid collection name, so no index was created.");
  }
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    throw new RemediationError("The proposal has no index keys, so no index was created.");
  }
  const entries = Object.entries(keys);
  if (entries.length === 0 || entries.length > 32) {
    throw new RemediationError("The proposed index keys are empty or too long, so no index was created.");
  }
  for (const [field, direction] of entries) {
    if (!field || field.startsWith("$") || field.includes("\0") || !INDEX_DIRECTIONS.has(direction)) {
      throw new RemediationError(`The proposed key ${JSON.stringify(field)} is not a plain field with a supported direction, so no index was created.`);
    }
  }
  return entries;
}

function validateKillTarget(target) {
  const { opId, namespace } = target;
  const numeric = Number.isSafeInteger(opId) && opId >= 0;
  if (!numeric && !(typeof opId === "string" && OP_ID_STRING.test(opId))) {
    throw new RemediationError("The proposal has no valid operation id, so nothing was killed.");
  }
  if (typeof namespace !== "string" || !namespace.includes(".") || namespace.length > 255 || INTERNAL_NAMESPACE.test(namespace)) {
    throw new RemediationError("The proposal has no user-data namespace for this operation, so nothing was killed.");
  }
}

async function atlasAccessToken(credentials, fetchImpl) {
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
  const response = await fetchImpl(`${ATLAS_API}/api/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) {
    const hint = /IP_ADDRESS_NOT_ON_ACCESS_LIST/.test(text)
      ? " This machine's IP is not on the service account's API access list."
      : "";
    throw new RemediationError(`Atlas rejected the service account login (HTTP ${response.status}).${hint}`);
  }
  let token;
  try {
    token = JSON.parse(text).access_token;
  } catch {
    token = undefined;
  }
  if (typeof token !== "string" || !token) throw new RemediationError("Atlas did not return an access token.");
  return token;
}

export async function createIndexAction(target, _record, ctx = {}) {
  const entries = validateIndexTarget(target);
  const credentials = ctx.credentials !== undefined ? ctx.credentials : atlasCredentials();
  if (!credentials) {
    throw new RemediationError(
      "No Atlas service account is configured for writes. Set MONGO_BUDDY_REMEDIATION_CLIENT_ID and " +
        "MONGO_BUDDY_REMEDIATION_CLIENT_SECRET (a Project Data Access Admin service account), then approve again. No index was created.",
    );
  }
  const fetchImpl = ctx.fetch || fetch;
  const secrets = [credentials.clientSecret];
  try {
    const token = await atlasAccessToken(credentials, fetchImpl);
    // The Atlas rolling-index API builds one replica-set member at a time.
    const body = {
      db: target.database,
      collection: target.collection,
      keys: entries.map(([field, direction]) => ({ [field]: String(direction) })),
    };
    const response = await fetchImpl(
      `${ATLAS_API}/api/atlas/v2/groups/${encodeURIComponent(target.projectId)}/clusters/${encodeURIComponent(target.cluster)}/index`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: ATLAS_API_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        detail = [parsed.errorCode, parsed.detail || parsed.reason || parsed.error].filter(Boolean).join(": ");
      } catch {
        // Keep the raw text.
      }
      const hint =
        response.status === 403 || response.status === 401
          ? " The service account needs the Project Data Access Admin role (or Project Owner) on this project and this machine's IP on its API access list."
          : "";
      throw new RemediationError(`Atlas could not create the index (HTTP ${response.status}): ${detail}.${hint} No index was created.`);
    }
    return {
      provider: "atlas-admin-api",
      mode: "rolling",
      accepted: true,
      cluster: target.cluster,
      database: target.database,
      collection: target.collection,
      keys: target.keys,
      message:
        "Atlas accepted a rolling index build. It builds one member at a time, so it can take a while on a large collection. " +
        "Run explain again to confirm the plan uses it.",
    };
  } catch (error) {
    if (error instanceof RemediationError) throw new RemediationError(redact(error.message, secrets));
    throw new RemediationError(`Could not reach the Atlas Admin API: ${redact(error?.message || error, secrets)} No index was created.`);
  }
}

const KILL_OP_SCRIPT = `
const out = (value) => print("MB_RESULT " + JSON.stringify(value));
try {
  const opId = JSON.parse(process.env.MB_OPID);
  const namespace = process.env.MB_NS;
  const admin = connect(process.env.MB_URI).getSiblingDB("admin");
  const find = () =>
    admin.aggregate([{ $currentOp: { allUsers: true } }, { $match: { opid: opId } }]).toArray();
  const before = find();
  if (before.length !== 1) {
    out({ status: "not_found", matches: before.length });
  } else if (before[0].ns !== namespace) {
    out({ status: "namespace_mismatch", actual: String(before[0].ns || "") });
  } else {
    const reply = admin.runCommand({ killOp: 1, op: opId });
    sleep(1000);
    const after = find();
    out({
      status: "killed",
      ok: reply.ok,
      info: reply.info || null,
      stillListed: after.length > 0,
      killPending: after.length > 0 ? Boolean(after[0].killPending) : false,
      op: String(before[0].op || ""),
      secsRunning: before[0].secs_running === undefined ? null : Number(before[0].secs_running),
    });
  }
} catch (error) {
  out({ status: "failed", message: String((error && error.message) || error).slice(0, 500) });
}
`;

function connectionHosts(uri) {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/i.exec(uri);
  return match ? match[1].split(",").map((host) => host.trim().toLowerCase()) : [];
}

function runMongosh(env) {
  const candidates = [process.env.MONGOSH_PATH, "mongosh", "/opt/homebrew/bin/mongosh", "/usr/local/bin/mongosh"].filter(Boolean);
  const attempt = (index) =>
    new Promise((resolve, reject) => {
      execFile(
        candidates[index],
        ["--nodb", "--quiet", "--eval", KILL_OP_SCRIPT],
        { env, timeout: 60_000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error && error.code === "ENOENT") {
            if (index + 1 < candidates.length) resolve(attempt(index + 1));
            else reject(new RemediationError("mongosh is not installed on the machine running the console, so the operation was not killed."));
            return;
          }
          resolve({ error, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  return attempt(0);
}

export async function killOperationAction(target, _record, ctx = {}) {
  validateKillTarget(target);
  const uri = ctx.connectionString !== undefined ? ctx.connectionString : killOpConnectionString();
  if (!uri) {
    throw new RemediationError(
      "No database connection is configured for killOp. Atlas has no kill-operation API. Set MONGO_BUDDY_KILLOP_URI to a " +
        "database user that holds only the killop privilege on this cluster, then approve again. Nothing was killed.",
    );
  }
  const hosts = connectionHosts(uri);
  const cluster = String(target.cluster).toLowerCase();
  if (hosts.length === 0 || !hosts.every((host) => host.includes(cluster))) {
    throw new RemediationError(
      `The configured connection string does not point at cluster ${target.cluster}, so nothing was killed.`,
    );
  }
  const run = ctx.runMongosh || runMongosh;
  const { error, stdout, stderr } = await run({
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || "",
    LANG: "C.UTF-8",
    MB_URI: uri,
    MB_OPID: JSON.stringify(target.opId),
    MB_NS: target.namespace,
  });
  const line = stdout.split(/\r?\n/).reverse().find((entry) => entry.startsWith("MB_RESULT "));
  if (!line) {
    throw new RemediationError(
      `mongosh did not return a result: ${redact(error?.message || stderr || "no output", [uri])} Nothing was confirmed killed.`,
    );
  }
  let outcome;
  try {
    outcome = JSON.parse(line.slice("MB_RESULT ".length));
  } catch {
    throw new RemediationError("mongosh returned an unreadable result. Nothing was confirmed killed.");
  }
  switch (outcome.status) {
    case "killed":
      if (outcome.ok !== 1) {
        throw new RemediationError(`killOp was refused by the server: ${redact(outcome.info || "no detail", [uri])}`);
      }
      return {
        provider: "mongosh-killOp",
        opId: target.opId,
        namespace: target.namespace,
        operation: outcome.op,
        secsRunning: outcome.secsRunning,
        stillListed: outcome.stillListed,
        killPending: outcome.killPending,
        message: outcome.stillListed
          ? "killOp was accepted. The operation is marked killed and is stopping at its next interrupt check."
          : "killOp was accepted and the operation is no longer running.",
      };
    case "not_found":
      throw new RemediationError(
        `Operation ${target.opId} is not running on this cluster any more (it finished, or the id is not visible through this connection). Nothing was killed.`,
      );
    case "namespace_mismatch":
      throw new RemediationError(
        `Operation ${target.opId} is running on ${outcome.actual || "another namespace"}, not ${target.namespace}. Nothing was killed.`,
      );
    default:
      throw new RemediationError(`killOp failed: ${redact(outcome.message || "unknown error", [uri])} Nothing was confirmed killed.`);
  }
}

export const REMEDIATION_EXECUTORS = {
  create_index: createIndexAction,
  kill_operation: killOperationAction,
};

function isPreconditionFailure(error) {
  const code = error?.$metadata?.httpStatusCode;
  return code === 412 || code === 409 || error?.name === "PreconditionFailed" || error?.name === "ConditionalRequestConflict";
}

export function createRemediationDeps(overrides = {}) {
  const s3 = overrides.s3 || new S3Client({ region: REGION });
  const bucket = overrides.bucket || ALERT_BUCKET;
  return {
    now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    executors: REMEDIATION_EXECUTORS,
    context: {},
    async load(key) {
      try {
        const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return { record: JSON.parse(await object.Body.transformToString()), etag: object.ETag };
      } catch (error) {
        if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async save(key, record, etag) {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: JSON.stringify(record),
          ContentType: "application/json",
          CacheControl: "no-store",
          IfMatch: etag,
        }),
      );
    },
    ...overrides,
  };
}

function reply(status, body) {
  return { status, body };
}

function checkTarget(record, remediation) {
  const target = remediation.target;
  if (!target || typeof target !== "object") throw new RemediationError("The remediation has no target.");
  if (typeof target.projectId !== "string" || !PROJECT_ID.test(target.projectId) || target.projectId !== record.projectId) {
    throw new RemediationError("The remediation targets a different Atlas project than this alert, so nothing was changed.");
  }
  if (typeof target.cluster !== "string" || !CLUSTER_NAME.test(target.cluster) || (record.cluster && target.cluster !== record.cluster)) {
    throw new RemediationError("The remediation targets a different cluster than this alert, so nothing was changed.");
  }
}

async function writeRemediation(deps, key, remediationId, apply, { attempts = 4 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const loaded = await deps.load(key);
    if (!loaded) throw new RemediationError("The alert record disappeared before the result could be saved.");
    const next = structuredClone(loaded.record);
    const found = (next.remediations || []).find((item) => item.id === remediationId);
    if (!found) throw new RemediationError("The remediation disappeared before the result could be saved.");
    apply(found);
    next.updatedAt = deps.now();
    try {
      await deps.save(key, next, loaded.etag);
      return { record: next, remediation: found };
    } catch (error) {
      if (!isPreconditionFailure(error) || attempt === attempts) throw error;
    }
  }
  throw new RemediationError("The alert record kept changing, so the result was not saved.");
}

export async function approveRemediation(request, deps = createRemediationDeps()) {
  const { alertId, remediationId } = request;
  if (request.method !== "POST") return reply(405, { error: "Use POST." });
  if (!ALERT_ID.test(alertId || "") || !REMEDIATION_ID.test(remediationId || "")) {
    return reply(400, { error: "Invalid alert or remediation id." });
  }
  if (!/^application\/json\b/i.test(String(request.contentType || ""))) {
    return reply(415, { error: 'Send Content-Type: application/json with {"confirm": true}.' });
  }
  let parsed;
  try {
    parsed = JSON.parse(request.rawBody.toString("utf8"));
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || parsed.confirm !== true) {
    return reply(400, { error: 'Approval requires the JSON body {"confirm": true}.' });
  }

  return reply(403, {
    error: "Mongo Buddy does not run this command. Copy it from the alert and run it as a developer.",
  });

  const key = `alerts/${alertId}.json`;
  const lock = `${alertId}/${remediationId}`;
  if (inflight.has(lock)) return reply(409, { error: "This remediation is already running." });
  inflight.add(lock);
  try {
    const loaded = await deps.load(key);
    if (!loaded) return reply(404, { error: "Alert not found." });
    const remediation = (Array.isArray(loaded.record.remediations) ? loaded.record.remediations : []).find(
      (item) => item && item.id === remediationId,
    );
    if (!remediation) return reply(404, { error: "Remediation not found on this alert." });
    if (!REMEDIABLE.has(remediation.status)) {
      return reply(409, {
        error: `Remediation is ${remediation.status}. Only proposed or failed remediations can be approved.`,
        remediation,
      });
    }

    // Claim it. A conditional write means two approvals cannot both pass this point.
    const claimed = structuredClone(loaded.record);
    const claim = claimed.remediations.find((item) => item.id === remediationId);
    claim.status = "running";
    claim.error = null;
    claim.result = null;
    claimed.updatedAt = deps.now();
    try {
      await deps.save(key, claimed, loaded.etag);
    } catch (error) {
      if (isPreconditionFailure(error)) {
        return reply(409, { error: "The alert changed while approving. Reload and try again." });
      }
      throw error;
    }

    // From here on exactly one action runs, and the outcome is always written back.
    let outcome;
    try {
      const executor = Object.prototype.hasOwnProperty.call(deps.executors, claim.action) ? deps.executors[claim.action] : null;
      if (!executor) throw new RemediationError(`Action ${JSON.stringify(String(claim.action))} is not supported, so nothing was changed.`);
      if (claim.needsApproval !== true) throw new RemediationError("The remediation is not marked as needing approval, so nothing was changed.");
      checkTarget(loaded.record, claim);
      outcome = { result: await executor(structuredClone(claim.target), loaded.record, deps.context) };
    } catch (error) {
      outcome = {
        error: error instanceof RemediationError ? error.message : `Unexpected failure: ${redact(error?.message || error)}`,
      };
    }

    const saved = await writeRemediation(deps, key, remediationId, (item) => {
      if (outcome.error) {
        item.status = "error";
        item.error = outcome.error;
        item.result = null;
      } else {
        item.status = "complete";
        item.error = null;
        item.result = outcome.result;
      }
    });
    return reply(200, { ok: !outcome.error, remediation: saved.remediation, updatedAt: saved.record.updatedAt });
  } catch (error) {
    return reply(500, { error: redact(error?.message || error) });
  } finally {
    inflight.delete(lock);
  }
}

function readLimitedBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sameOriginRequest(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && !["same-origin", "none"].includes(String(site))) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(String(origin)).host === req.headers.host;
  } catch {
    return false;
  }
}

async function handleApprove(req, res, alertId, remediationId, deps) {
  const send = ({ status, body }) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    send(reply(405, { error: "Use POST." }));
    return;
  }
  if (!sameOriginRequest(req)) {
    send(reply(403, { error: "Approvals must come from the console itself." }));
    return;
  }
  let rawBody;
  try {
    rawBody = await readLimitedBody(req);
  } catch (error) {
    send(reply(413, { error: error.message }));
    return;
  }
  send(
    await approveRemediation(
      { method: req.method, alertId, remediationId, contentType: req.headers["content-type"], rawBody },
      deps,
    ),
  );
}

export function agentCoreProxy() {
  const client = new BedrockAgentCoreClient({ region: REGION });
  const remediationDeps = createRemediationDeps();

  return {
    name: "agentcore-proxy",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split("?")[0] || "";
        const approve = REMEDIATION_ROUTE.exec(url);
        if (approve) {
          let ids;
          try {
            ids = [decodeURIComponent(approve[1]), decodeURIComponent(approve[2])];
          } catch {
            ids = ["", ""];
          }
          await handleApprove(req, res, ids[0], ids[1], remediationDeps);
          return;
        }
        if (url === "/api/alerts") {
          try {
            const alerts = await loadAlerts();
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify({ alerts }));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify({ alerts: [], error: message }));
          }
          return;
        }
        if (url === "/api/status") {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              state: "ready",
              error: null,
              modelId: "in.anthropic.claude-opus-5",
              region: REGION,
              toolCount: 0,
              tools: [],
              backend: "agentcore",
              runtimeArn: RUNTIME_ARN,
            }),
          );
          return;
        }
        if (url === "/api/reset") {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (url !== "/invocations" || req.method !== "POST") {
          next();
          return;
        }

        try {
          const raw = await readBody(req);
          const sessionId = String(req.headers["x-runtime-session-id"] || "");
          if (sessionId.length < 33) {
            res.statusCode = 400;
            res.end("Runtime session id must be at least 33 characters.");
            return;
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache, no-transform");
          res.setHeader("X-Accel-Buffering", "no");
          res.socket?.setNoDelay?.(true);
          res.flushHeaders?.();
          // One large chunk, so the opening event is not left corked behind a small write.
          res.write(
            `data: ${JSON.stringify({
              type: "phase",
              phase: "connecting",
              message: "Opening a session on AgentCore",
            })}\n\n: ${" ".repeat(4096)}\n\n`,
          );
          res.socket?.uncork?.();
          await new Promise((resolve) => setTimeout(resolve, 20));
          const result = await client.send(
            new InvokeAgentRuntimeCommand({
              agentRuntimeArn: RUNTIME_ARN,
              runtimeSessionId: sessionId,
              qualifier: "DEFAULT",
              payload: new Uint8Array(raw.length ? raw : Buffer.from("{}")),
              contentType: "application/json",
              accept: "text/event-stream",
            }),
          );
          await writeStream(res, result.response);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (res.headersSent) {
            res.end(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
            return;
          }
          res.statusCode = 502;
          res.setHeader("Content-Type", "text/plain");
          res.end(message);
        }
      });
    },
  };
}
