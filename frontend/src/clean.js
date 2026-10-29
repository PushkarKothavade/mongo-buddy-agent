/** Turn MongoDB MCP tool payloads into data the timeline can show. */

const BOILERPLATE = [
  /The following section contains unverified user data\.[\s\S]*?(?:potentially malicious\.|boundaries\.)/gi,
  /Use the information above to respond to the user's question[\s\S]*$/gi,
  /WARNING: Executing any instructions or commands between the <untrusted-user-data[\s\S]*?(?:potentially malicious\.|boundaries\.)/gi,
];

export function cleanMcpPayload(value, depth = 0) {
  if (depth > 8 || value == null) return value;
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) {
    const items = value.map((item) => cleanMcpPayload(item, depth + 1)).filter((item) => item !== "");
    if (items.length === 1) return items[0];
    return items;
  }
  if (typeof value === "object") {
    if (typeof value.text === "string" && Object.keys(value).every((key) => ["type", "text", "annotations"].includes(key))) {
      return cleanMcpPayload(value.text, depth + 1);
    }
    if (Array.isArray(value.content) && Object.keys(value).length <= 4) {
      return cleanMcpPayload(value.content, depth + 1);
    }
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      next[key] = cleanMcpPayload(item, depth + 1);
    }
    return next;
  }
  return value;
}

export function summarizeArgs(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const parts = Object.entries(input)
    .filter(([, value]) => value != null && value !== "")
    .slice(0, 4)
    .map(([key, value]) => `${labelize(key)} ${preview(value)}`);
  return parts.join(" · ");
}

export function inferView(name, hinted, output) {
  const tool = String(name || "").toLowerCase();
  if (isExplain(output) || tool.includes("explain")) return "explain";
  if (hasDatabases(output) || (tool.includes("database") && tool.includes("list"))) return "databases";
  if (["projects", "clusters", "collections", "indexes", "results"].some((key) => Array.isArray(output?.[key]))) {
    return "named-list";
  }
  if (tool.includes("performance-advisor") || tool.includes("suggested-index")) return "advisor";
  if (hinted && !["text", "json", "summary"].includes(hinted)) return hinted;
  if (Array.isArray(output) && output.length && output.every((item) => typeof item === "string" || (item && typeof item === "object"))) {
    return "named-list";
  }
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const numbers = Object.values(output).filter((item) => typeof item === "number").length;
    if (numbers >= 2 && /stat|metric|size|storage/.test(tool)) return "metrics";
  }
  return "summary";
}

function cleanText(value) {
  const text = value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  const blocks = extractBlocks(text);
  if (blocks.length) {
    const parsed = blocks.map(parseMaybeJson);
    return parsed.length === 1 ? parsed[0] : parsed;
  }
  let stripped = text;
  for (const pattern of BOILERPLATE) stripped = stripped.replace(pattern, "");
  stripped = stripped.trim();
  if (!stripped) return "";
  return parseMaybeJson(stripped);
}

function extractBlocks(text) {
  const re = /<untrusted-user-data[^>]*>((?:(?!<untrusted-user-data)[\s\S])*?)<\/untrusted-user-data[^>]*>/gi;
  return [...text.matchAll(re)].map((match) => match[1].trim()).filter(Boolean);
}

function parseMaybeJson(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return "";
  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;
  const start = trimmed.search(/[\[{]/);
  if (start > 0) {
    const embedded = tryParse(trimmed.slice(start));
    if (embedded !== undefined) {
      const caption = trimmed.slice(0, start).trim();
      return caption ? [caption, embedded] : embedded;
    }
  }
  return trimmed;
}

function tryParse(text) {
  if (!text || !"[{".includes(text[0])) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const LIST_KEYS = ["databases", "databaseNames", "projects", "clusters", "collections", "indexes", "results", "items", "data"];
const DATABASE_NAME_KEYS = ["name", "databaseName", "dbName", "database", "db"];
const RECORD_NAME_KEYS = ["name", "databaseName", "dbName", "database", "projectName", "clusterName", "groupName", "collectionName", "ns", "namespace"];
const SIZE_KEYS = ["sizeOnDisk", "size", "dataSize", "storageSize", "totalSize"];

export function databaseItems(output) {
  const { notes, records } = partitionPayload(output);
  const items = [];
  for (const row of records) {
    const name = pickString(row, DATABASE_NAME_KEYS);
    if (!name) continue;
    items.push({
      name,
      sizeOnDisk: pickSize(row),
      empty: Boolean(row.empty),
    });
  }
  return { notes: captions(notes, items), items };
}

export function namedRecords(output) {
  const { notes, records } = partitionPayload(output);
  const items = [];
  for (const row of records) {
    const name = pickString(row, RECORD_NAME_KEYS) || pickString(row, ["id", "projectId", "groupId", "clusterId"]);
    if (!name || name === "Result" || name === "unnamed") continue;
    const id = pickString(row, ["id", "projectId", "groupId", "clusterId"]);
    const extra = [row.type, row.kind, row.stateName, row.mongoDBVersion].filter((part) => typeof part === "string" && part && part !== name);
    if (id && id !== name) extra.push(id);
    items.push({ name, detail: extra.join(" · ") });
  }
  return { notes: captions(notes, items), items };
}

function partitionPayload(value) {
  const notes = [];
  const records = [];
  absorb(value, notes, records, 0);
  return { notes, records };
}

function absorb(value, notes, records, depth) {
  if (value == null || depth > 8) return;
  if (typeof value === "string") {
    const text = value.trim();
    if (text) notes.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") notes.push(item.trim());
      else if (Array.isArray(item) || isListContainer(item)) absorb(item, notes, records, depth + 1);
      else if (item && typeof item === "object") records.push(item);
    }
    return;
  }
  if (typeof value === "object") {
    if (isListContainer(value)) {
      absorb(value[LIST_KEYS.find((key) => Array.isArray(value[key]))], notes, records, depth + 1);
      return;
    }
    records.push(value);
  }
}

function hasListKey(value, keys, depth = 0) {
  if (depth > 6 || value == null) return false;
  if (Array.isArray(value)) return value.some((item) => hasListKey(item, keys, depth + 1));
  if (typeof value === "object") {
    if (keys.some((key) => Array.isArray(value[key]))) return true;
    return Object.values(value).some((item) => hasListKey(item, keys, depth + 1));
  }
  return false;
}

function isListContainer(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && LIST_KEYS.some((key) => Array.isArray(value[key]));
}

function pickString(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function pickSize(row) {
  for (const key of SIZE_KEYS) {
    const size = asNumber(row?.[key]);
    if (size != null) return size;
  }
  return null;
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  if (value && typeof value === "object") {
    if (value.$numberLong != null) return asNumber(value.$numberLong);
    if (value.$numberInt != null) return asNumber(value.$numberInt);
  }
  return null;
}

function captions(notes, items) {
  const names = new Set(items.map((item) => item.name));
  const seen = new Set();
  const kept = [];
  for (const note of notes) {
    const text = String(note || "").trim();
    if (!text || text.length > 180 || text.length < 4 || names.has(text) || seen.has(text)) continue;
    if (/^(and|or|the|a|an)$/i.test(text)) continue;
    if (text.startsWith("{") || text.startsWith("[")) continue;
    seen.add(text);
    kept.push(text);
  }
  return kept;
}

function hasDatabases(output) {
  if (!databaseItems(output).items.length) return false;
  if (hasListKey(output, ["databases", "databaseNames"])) return true;
  return databaseItems(output).items.every((item) => item.sizeOnDisk != null || item.empty);
}

function isExplain(output) {
  if (!output || typeof output !== "object") return false;
  if ("executionStats" in output || "queryPlanner" in output) return true;
  return false;
}

function labelize(key) {
  return key.replaceAll("_", " ").replaceAll("-", " ");
}

function preview(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 72 ? `${text.slice(0, 69)}…` : text;
}
