"""Turn MongoDB MCP payloads into a view the UI can decorate."""

from __future__ import annotations

import json
from typing import Any


def access_list_message(body: str) -> str | None:
    """Turn Atlas's IP rejection into a sentence a developer can act on."""
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return None
    if payload.get("errorCode") != "IP_ADDRESS_NOT_ON_ACCESS_LIST":
        return None
    parameters = payload.get("parameters") or []
    ip = parameters[0] if parameters else "this machine"
    return (
        f"Atlas refused this laptop ({ip}). Add {ip}/32 to the service account "
        "API access list in Atlas, then restart Mongo Buddy."
    )


def extract_prompt(payload: Any) -> str:
    if isinstance(payload, str):
        return payload.strip()
    if not isinstance(payload, dict):
        return ""
    prompt = payload.get("prompt")
    if isinstance(prompt, str) and prompt.strip():
        return prompt.strip()
    nested = payload.get("input")
    if isinstance(nested, str):
        return nested.strip()
    if isinstance(nested, dict):
        inner = nested.get("prompt") or nested.get("query") or ""
        return inner.strip() if isinstance(inner, str) else ""
    return ""


def classify_intent(prompt: str) -> str:
    text = prompt.lower()
    if any(word in text for word in ("root cause", "rca", "why is", "why are", "what's wrong", "what is wrong")):
        return "rca"
    if any(word in text for word in ("slow", "explain", "collscan", "ixscan", "index", "performance advisor")):
        return "explain"
    if any(word in text for word in ("metric", "storage", "size on disk", "db stats", "statistics", "how big")):
        return "metrics"
    if "collection" in text:
        return "collections"
    if "database" in text:
        return "databases"
    return "general"


def coerce_output(value: Any) -> Any:
    """Parse JSON strings the MCP server often returns as text."""
    if isinstance(value, str):
        stripped = value.strip()
        if stripped[:1] in "[{":
            try:
                return json.loads(stripped)
            except json.JSONDecodeError:
                return value
        return value
    return value


def extract_tool_output(result: Any) -> Any:
    if isinstance(result, Exception):
        return {"error": str(result)}
    if not isinstance(result, dict):
        return coerce_output(result)

    content = result.get("content")
    if not isinstance(content, list):
        return coerce_output(result)

    parts: list[Any] = []
    for block in content:
        if not isinstance(block, dict):
            parts.append(block)
            continue
        if "json" in block:
            parts.append(coerce_output(block["json"]))
        elif "text" in block:
            parts.append(coerce_output(block["text"]))
        else:
            parts.append(block)

    if not parts:
        return {}
    if len(parts) == 1:
        return parts[0]
    return parts


def classify_view(tool_name: str, output: Any) -> str:
    name = tool_name.lower().replace("_", "-")
    if _looks_like_explain(output) or "explain" in name:
        return "explain"
    if any(token in name for token in ("performance-advisor", "suggested-index", "slow")):
        return "advisor"
    if "database" in name and "list" in name:
        return "databases"
    if "collection" in name and ("list" in name or "index" in name or "schema" in name):
        if "index" in name:
            return "indexes"
        if "schema" in name:
            return "schema"
        return "collections"
    if any(token in name for token in ("stats", "metric", "storage", "size")):
        return "metrics"
    if isinstance(output, dict) and _database_list(output):
        return "databases"
    if isinstance(output, list) and _named_items(output):
        if "collection" in name:
            return "collections"
        if "database" in name:
            return "databases"
        return "named-list"
    if isinstance(output, dict) and _metric_count(output) >= 3:
        return "metrics"
    if isinstance(output, str):
        return "text"
    return "json"


def summarize_explain(output: Any) -> dict[str, Any] | None:
    plan = _find_explain(output)
    if not plan:
        return None
    stats = plan.get("executionStats") if isinstance(plan.get("executionStats"), dict) else {}
    planner = plan.get("queryPlanner") if isinstance(plan.get("queryPlanner"), dict) else {}
    winning = planner.get("winningPlan") if isinstance(planner.get("winningPlan"), dict) else {}
    stages = _collect_stages(winning) or _collect_stages(stats.get("executionStages"))
    stage = stages[0] if stages else ""
    examined = _first_number(stats, "totalDocsExamined", "docsExamined")
    returned = _first_number(stats, "nReturned")
    return {
        "namespace": planner.get("namespace") or plan.get("namespace") or "",
        "stage": stage,
        "stages": stages,
        "indexName": _find_key(winning, "indexName") or "",
        "executionTimeMillis": _first_number(stats, "executionTimeMillis"),
        "totalDocsExamined": examined,
        "totalKeysExamined": _first_number(stats, "totalKeysExamined"),
        "nReturned": returned,
        "ratio": _ratio(returned, examined),
    }


def database_items(output: Any) -> list[dict[str, Any]]:
    rows = _database_list(output)
    items: list[dict[str, Any]] = []
    for row in rows:
        if isinstance(row, str):
            items.append({"name": row})
        elif isinstance(row, dict):
            items.append(
                {
                    "name": row.get("name") or row.get("database") or "unnamed",
                    "sizeOnDisk": row.get("sizeOnDisk") or row.get("size") or row.get("dataSize"),
                    "empty": row.get("empty"),
                }
            )
    return items


def named_items(output: Any) -> list[dict[str, Any]]:
    if isinstance(output, dict):
        for key in ("collections", "indexes", "items", "results"):
            if isinstance(output.get(key), list):
                output = output[key]
                break
    if not isinstance(output, list):
        return []
    items = []
    for row in output:
        if isinstance(row, str):
            items.append({"name": row})
        elif isinstance(row, dict):
            items.append(
                {
                    "name": str(row.get("name") or row.get("ns") or row.get("namespace") or "unnamed"),
                    "detail": _named_detail(row),
                }
            )
    return items


def metric_items(output: Any) -> list[dict[str, Any]]:
    if not isinstance(output, dict):
        return []
    items = []
    for key, value in output.items():
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            items.append({"label": _label(key), "value": value})
    return items[:8]


def advisor_items(output: Any) -> list[Any]:
    if isinstance(output, list):
        return output
    if not isinstance(output, dict):
        return []
    for key in ("suggestedIndexes", "recommendations", "shapes", "indexes"):
        if isinstance(output.get(key), list):
            return output[key]
    return [output]


def _looks_like_explain(value: Any, depth: int = 0) -> bool:
    return _find_explain(value, depth) is not None


def _find_explain(value: Any, depth: int = 0) -> dict[str, Any] | None:
    if depth > 6 or not isinstance(value, dict):
        return None
    if "executionStats" in value or "queryPlanner" in value:
        return value
    for child in value.values():
        if isinstance(child, dict):
            found = _find_explain(child, depth + 1)
            if found:
                return found
        elif isinstance(child, list):
            for item in child:
                found = _find_explain(item, depth + 1)
                if found:
                    return found
    return None


def _collect_stages(plan: Any, found: list[str] | None = None) -> list[str]:
    if found is None:
        found = []
    if not isinstance(plan, dict):
        return found
    stage = plan.get("stage")
    if isinstance(stage, str):
        found.append(stage)
    for key in ("inputStage", "thenStage", "outerStage", "innerStage"):
        _collect_stages(plan.get(key), found)
    for key in ("inputStages", "shards"):
        children = plan.get(key)
        if isinstance(children, list):
            for child in children:
                _collect_stages(child, found)
    return found


def _find_key(value: Any, key: str, depth: int = 0) -> Any:
    if depth > 6:
        return None
    if isinstance(value, dict):
        if key in value and value[key]:
            return value[key]
        for child in value.values():
            found = _find_key(child, key, depth + 1)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _find_key(child, key, depth + 1)
            if found:
                return found
    return None


def _first_number(source: dict[str, Any], *keys: str) -> int | float | None:
    for key in keys:
        value = source.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return value
    return None


def _ratio(returned: int | float | None, examined: int | float | None) -> float | None:
    if returned is None or not examined:
        return None
    return round(float(returned) / float(examined), 4)


def _database_list(output: Any) -> list[Any]:
    if isinstance(output, dict):
        for key in ("databases", "databaseNames"):
            if isinstance(output.get(key), list):
                return output[key]
    if isinstance(output, list) and _named_items(output):
        return output
    return []


def _named_items(output: Any) -> bool:
    if not output or not isinstance(output, list):
        return False
    sample = output[0]
    if isinstance(sample, str):
        return True
    return isinstance(sample, dict) and any(key in sample for key in ("name", "ns", "namespace"))


def _named_detail(row: dict[str, Any]) -> str:
    for key in ("type", "kind", "status"):
        if row.get(key):
            return str(row[key])
    keys = row.get("key")
    if isinstance(keys, dict):
        return ", ".join(f"{name}:{order}" for name, order in keys.items())
    return ""


def _metric_count(output: dict[str, Any]) -> int:
    return sum(1 for value in output.values() if isinstance(value, (int, float)) and not isinstance(value, bool))


def _label(key: str) -> str:
    spaced = key.replace("_", " ").replace("-", " ")
    return spaced[:1].upper() + spaced[1:]
