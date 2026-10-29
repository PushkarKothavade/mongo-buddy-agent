"""MongoDB Atlas alert webhook for the deployed Mongo Buddy agent.

The Lambda function URL receives the Atlas POST. The function checks the
X-MMS-Signature HMAC, ignores events other than alert.open, and invokes the
existing AgentCore runtime. The HTTP handler returns as soon as that work is
queued so a long investigation does not fail Atlas webhook delivery.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger()
logger.setLevel(logging.INFO)

WORKER_SOURCE = "atlas-alert-worker"
ACTIONABLE_EVENT = "alert.open"
SESSION_SAFE = re.compile(r"[^A-Za-z0-9-_]")

REMEDIATION_BLOCK = "mongo-buddy-remediations"
ACTION_LABELS = {
    "create_index": "Create recommended index",
    "kill_operation": "Kill the operation causing the alert",
}
MAX_REMEDIATIONS = 3
INDEX_DIRECTIONS = {1, -1, "text", "hashed", "2dsphere"}
OBJECT_ID = re.compile(r"^[0-9a-fA-F]{24}$")
NAME_SAFE = re.compile(r"^[^\x00/\\. \"$*<>:|?]{1,64}$")
COLLECTION_SAFE = re.compile(r"^(?!system\.)[^\x00$]{1,120}$")
OP_ID_SAFE = re.compile(r"^[A-Za-z0-9_.-]{1,64}:\d{1,12}$")
REMEDIATION_FENCE = re.compile(
    r"```[ \t]*" + REMEDIATION_BLOCK + r"[ \t]*\r?\n(.*?)(?:```|\Z)",
    re.DOTALL | re.IGNORECASE,
)

INVESTIGATION_PROMPT = """You are Mongo Buddy. A MongoDB Atlas alert just opened. Investigate it with read-only MongoDB MCP tools, then write a root-cause analysis a developer can act on. Do not change the cluster, data, or configuration. You have no tool that can. Remediations are only proposed here, for a human to approve later. You never run them.

Atlas project id (groupId): {project_id}
Cluster: {cluster}
Metric: {metric}
Severity: {severity}
Current value: {current_value}
What Atlas reported: {summary}

Use groupId as the project id when a tool asks for one. Work in this order, and do not create an index, kill an operation, resize, or restart anything:
1. Triggering event. Confirm the live metric, the host or process that crossed the threshold, and any recent change you can see.
2. Last 10 minutes of evidence. Read Performance Advisor slow query logs with `since` set to 10 minutes before now, in UTC, ending in `Z`. Also read suggested indexes. If that window has no slow query logs, say so in Evidence. Then use the suggested index, existing indexes, and an explain plan. Name the namespace, the query shape when a log has one, and the plan (COLLSCAN or IXSCAN).
3. Action items. Propose at most three actions a human developer will run. Mongo Buddy does not run them. If a tool fails, say exactly what you could not verify.

Write these sections, in this order. Use short sentences and bullets. Do not repeat the raw alert banner or paste JSON in them. The visible answer must start with the characters `## Summary`. Text before that heading is discarded. Do not end the turn on a sentence about the next tool you intend to call.

## Summary
Two or three sentences: which cluster, which condition, the current reading, and whether the application is at risk now.

## Evidence
What you checked and what it showed. Name each tool in plain language.

## Likely cause
The most plausible cause, tied to the evidence, then one alternative if the evidence does not rule it out.

## Recommended fix
Numbered steps for a human developer. Prefer the smallest safe change. For an index, include the exact command they should run, for example `db.getSiblingDB("aws_summit").customers.createIndex({{ city: 1, age: 1 }})`. Say that Mongo Buddy will not run it. Mark it "Needs approval". Mark any other step that resizes, restarts, reconfigures, or changes data with "Needs approval". Say what to watch afterward.

## What not to do
One or two actions that would hide the symptom or make the incident worse.

After the last section, append one fenced block for the console, with the exact info string `mongo-buddy-remediations`. It holds a JSON array of proposed actions, or `[]`. Nothing may follow it. The developer does not see the block. Use only these two actions:

- `create_index`, label exactly "Create recommended index". Only when Performance Advisor, a slow query log, or an explain plan names the index. target: {{"cluster", "projectId", "database", "collection", "keys", "evidence"}}. keys is an object of field to 1 or -1 in index order, for example {{"city": 1, "age": 1}}. evidence is the query shape or plan that justifies the index.
- `kill_operation`, label exactly "Kill the operation causing the alert". Only when a current-operations result identifies one specific running operation. target: {{"cluster", "projectId", "opId", "namespace", "description"}}. Copy opId and namespace from the tool result.

Never invent an op id, namespace, database, collection, or index key. If the evidence does not support a specific safe action, return `[]`. This shows the shape of one item:

```mongo-buddy-remediations
[{{"id": "idx-1", "action": "create_index", "label": "Create recommended index", "reason": "why this addresses the alert", "impact": "what changes if approved", "needsApproval": true, "status": "proposed", "target": {{"cluster": "{cluster}", "projectId": "{project_id}", "database": "db", "collection": "coll", "keys": {{"field": 1}}, "evidence": "query or plan"}}, "error": null, "result": null}}]
```

The example only shows the shape. Replace every value with what you verified.

Atlas alert:
{alert}
"""


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    if is_http_event(event):
        return handle_webhook(event, context)
    if is_worker_event(event):
        return investigate(event)
    return http_response(400, {"error": "Unrecognized event"})


def handle_webhook(event: dict[str, Any], context: Any) -> dict[str, Any]:
    secret = os.environ.get("WEBHOOK_SECRET", "")
    if not secret:
        logger.error("WEBHOOK_SECRET is not configured")
        return http_response(500, {"error": "Webhook is not configured"})

    raw_body = request_body(event)
    headers = normalize_headers(event.get("headers"))
    received = headers.get("x-mms-signature", "")
    if not received or not signatures_match(secret, raw_body, received):
        logger.warning("Rejected Atlas webhook with an invalid signature")
        return http_response(401, {"error": "Invalid signature"})

    try:
        alert = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return http_response(400, {"error": "Invalid JSON"})
    if not isinstance(alert, dict):
        return http_response(400, {"error": "Invalid JSON"})

    event_type = headers.get("x-mms-event") or ACTIONABLE_EVENT
    if event_type != ACTIONABLE_EVENT:
        logger.info("Ignored Atlas event %s for alert %s", event_type, alert.get("id"))
        return http_response(
            200,
            {"message": "Event received; no agent invocation", "event": event_type},
        )

    runtime_arn = os.environ.get("AGENT_RUNTIME_ARN", "").strip()
    if not runtime_arn:
        logger.error("AGENT_RUNTIME_ARN is not configured")
        return http_response(500, {"error": "Agent runtime is not configured"})

    function_arn = getattr(context, "invoked_function_arn", "") if context else ""
    if not function_arn:
        logger.error("Cannot queue investigation without the Lambda function ARN")
        return http_response(500, {"error": "Unable to queue investigation"})

    detected_at = utc_now()
    publish_alert(alert_status_record(alert, status="processing", detected_at=detected_at))
    enqueue_investigation(
        function_arn,
        {
            "source": WORKER_SOURCE,
            "alert": alert,
            "eventType": event_type,
            "detectedAt": detected_at,
        },
    )
    logger.info(
        "Queued investigation alert_id=%s event=%s metric=%s project=%s",
        alert.get("id"),
        event_type,
        alert.get("metricName") or alert.get("eventTypeName"),
        alert.get("groupId"),
    )
    return http_response(
        202,
        {
            "message": "Atlas alert accepted",
            "alert_id": alert.get("id"),
            "event": event_type,
        },
    )


def investigate(event: dict[str, Any]) -> dict[str, Any]:
    alert = event.get("alert")
    if not isinstance(alert, dict):
        logger.error("Worker event did not include an alert object")
        return {"ok": False, "error": "Missing alert"}

    runtime_arn = os.environ.get("AGENT_RUNTIME_ARN", "").strip()
    if not runtime_arn:
        logger.error("AGENT_RUNTIME_ARN is not configured")
        return {"ok": False, "error": "Agent runtime is not configured"}

    detected_at = str(event.get("detectedAt") or utc_now())
    prompt = build_prompt(alert)
    session_id = runtime_session_id(str(alert.get("id") or ""))
    payload = json.dumps({"prompt": prompt}).encode("utf-8")
    try:
        response = invoke_runtime(runtime_arn, session_id, payload)
        summary = summarize_agent_output(read_response_text(response))
        remediations = parse_remediations(summary.get("remediation_block", ""), alert)
    except Exception as exc:
        logger.exception("AgentCore invocation failed alert_id=%s", alert.get("id"))
        analysis, error = investigation_failure(alert, exc)
        publish_alert(
            alert_status_record(
                alert,
                status="error",
                detected_at=detected_at,
                analysis=analysis,
                error=error,
            )
        )
        return {"ok": False, "alert_id": alert.get("id"), "error": "Agent invocation failed"}
    status_code = response.get("statusCode")
    logger.info(
        "Mongo Buddy investigation alert_id=%s agent_status=%s tools=%s errors=%s",
        alert.get("id"),
        status_code,
        summary["tools"],
        summary["errors"],
    )
    analysis = summary["answer"] or unfinished_analysis(alert, summary.get("notes", ""))
    if analysis:
        logger.info("Mongo Buddy findings alert_id=%s %s", alert.get("id"), analysis[:4000])
    publish_alert(
        alert_status_record(
            alert,
            status="error" if summary["errors"] and not summary["answer"] else "complete",
            detected_at=detected_at,
            analysis=analysis,
            tools=summary["tools"],
            error="; ".join(summary["errors"]),
            remediations=remediations,
        )
    )
    return {
        "ok": not summary["errors"],
        "alert_id": alert.get("id"),
        "agent_status": status_code,
        "tools": summary["tools"],
    }


def describe_alert(alert: dict[str, Any]) -> dict[str, str]:
    """Turn an Atlas alert into the facts a developer needs before the investigation."""
    metric = str(alert.get("metricName") or "")
    event_name = str(alert.get("eventTypeName") or "Atlas alert")
    cluster = str(alert.get("clusterName") or alert.get("replicaSetName") or alert.get("hostnameAndPort") or "")
    human = " ".join(str(alert.get("humanReadable") or "").split())
    severity = str(alert.get("severity") or "")
    current = alert.get("currentValue") if isinstance(alert.get("currentValue"), dict) else {}
    number = current.get("number") if isinstance(current, dict) else None
    units = str(current.get("units") or "") if isinstance(current, dict) else ""
    value = format_reading(number, units)

    condition = alert_condition(human)
    if condition and len(condition) <= 120:
        title = condition.split(".")[0].strip()
    elif metric:
        title = metric.replace("_", " ").title()
    else:
        title = event_name.replace("_", " ").title()

    sentences: list[str] = []
    if condition:
        lead = condition.rstrip(".")
        if cluster and cluster.lower() not in lead.lower():
            lead = f"{lead} on {cluster}"
        sentences.append(f"{lead}.")
    else:
        subject = metric.replace("_", " ").lower() if metric else event_name.replace("_", " ").lower()
        where = f" on {cluster}" if cluster else ""
        sentences.append(f"Atlas opened a {subject} alert{where}.")
    if value and value not in " ".join(sentences):
        sentences.append(f"The current reading is {value}.")
    if severity and severity.lower() not in " ".join(sentences).lower():
        sentences.append(f"Atlas severity is {severity}.")

    return {
        "id": str(alert.get("id") or ""),
        "title": title,
        "summary": " ".join(sentences),
        "severity": severity,
        "cluster": cluster,
        "projectId": str(alert.get("groupId") or ""),
        "metric": metric,
        "eventType": event_name,
        "currentValue": value,
    }


def alert_status_record(
    alert: dict[str, Any],
    *,
    status: str,
    detected_at: str,
    analysis: str = "",
    tools: list[str] | None = None,
    error: str = "",
    remediations: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        **describe_alert(alert),
        "status": status,
        "detectedAt": detected_at,
        "updatedAt": utc_now(),
        "analysis": analysis,
        "tools": tools or [],
        "error": error,
        "remediations": remediations or [],
    }


def parse_remediations(block: str, alert: dict[str, Any]) -> list[dict[str, Any]]:
    """Validate the model's proposed actions. Anything doubtful is dropped, never repaired.

    Bad JSON, unknown actions, and targets missing a required field yield no
    remediation. The investigation itself is never failed by this step.
    """
    if not block or not block.strip():
        return []
    try:
        proposed = json.loads(block.strip())
    except (json.JSONDecodeError, ValueError):
        logger.warning("Ignored remediation block that is not valid JSON alert_id=%s", alert.get("id"))
        return []
    if not isinstance(proposed, list):
        return []
    brief = describe_alert(alert)
    remediations: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in proposed:
        try:
            remediation = normalize_remediation(item, brief)
        except Exception:
            logger.warning("Dropped a malformed remediation alert_id=%s", alert.get("id"), exc_info=True)
            continue
        if remediation is None:
            continue
        base = remediation["id"]
        candidate, bump = base, 2
        while candidate in seen:
            candidate = f"{base}-{bump}"
            bump += 1
        remediation["id"] = candidate
        seen.add(candidate)
        remediations.append(remediation)
        if len(remediations) >= MAX_REMEDIATIONS:
            break
    return remediations


def normalize_remediation(item: Any, brief: dict[str, str]) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    action = item.get("action")
    if action not in ACTION_LABELS:
        return None
    raw_target = item.get("target")
    if not isinstance(raw_target, dict):
        return None

    project_id = brief["projectId"] or text_value(raw_target.get("projectId"))
    cluster = brief["cluster"] or text_value(raw_target.get("cluster"))
    # The alert is the authority for where this happened. A model that names another
    # project or cluster is wrong, not a request to act elsewhere.
    for claimed, actual in ((raw_target.get("projectId"), brief["projectId"]), (raw_target.get("cluster"), brief["cluster"])):
        if claimed not in (None, "") and actual and str(claimed) != actual:
            return None
    if not OBJECT_ID.match(project_id) or not cluster:
        return None

    if action == "create_index":
        database = text_value(raw_target.get("database"))
        collection = text_value(raw_target.get("collection"))
        keys = normalize_index_keys(raw_target.get("keys"))
        if not NAME_SAFE.match(database) or not COLLECTION_SAFE.match(collection) or not keys:
            return None
        if (database, collection) == ("db", "coll"):
            return None  # the shape example in the prompt, copied rather than verified
        target: dict[str, Any] = {
            "cluster": cluster,
            "projectId": project_id,
            "database": database,
            "collection": collection,
            "keys": keys,
        }
        evidence = text_value(raw_target.get("evidence") or raw_target.get("query") or raw_target.get("plan"))
        if evidence:
            target["evidence"] = evidence[:1000]
        identity = f"{database}.{collection}:{json.dumps(keys)}"
        prefix = "idx"
    else:
        op_id = normalize_op_id(raw_target.get("opId"))
        namespace = text_value(raw_target.get("namespace"))
        if op_id is None or "." not in namespace or len(namespace) > 255:
            return None
        target = {
            "cluster": cluster,
            "projectId": project_id,
            "opId": op_id,
            "namespace": namespace,
        }
        description = text_value(raw_target.get("description"))
        if description:
            target["description"] = description[:500]
        identity = f"{namespace}:{op_id}"
        prefix = "kill"

    reason = text_value(item.get("reason"))[:1000]
    impact = text_value(item.get("impact"))[:1000]
    if not reason:
        return None
    return {
        "id": f"{prefix}-{hashlib.sha1(identity.encode('utf-8')).hexdigest()[:8]}",
        "action": action,
        "label": ACTION_LABELS[action],
        "reason": reason,
        "impact": impact or default_impact(action),
        "needsApproval": True,
        "status": "proposed",
        "target": target,
        "error": None,
        "result": None,
    }


def default_impact(action: str) -> str:
    if action == "create_index":
        return "A developer runs this command. Queries keep running while the index builds, and writes pay the extra index maintenance."
    return "Stops this one running operation. The client that issued it receives an error."


def text_value(value: Any) -> str:
    if value is None or isinstance(value, (dict, list, bool)):
        return ""
    return str(value).strip()


def normalize_index_keys(keys: Any) -> dict[str, Any] | None:
    """Accept {field: 1} or [{field: 1}, ...]. Return an ordered mapping or None."""
    pairs: list[tuple[Any, Any]] = []
    if isinstance(keys, dict):
        pairs = list(keys.items())
    elif isinstance(keys, list):
        for entry in keys:
            if not isinstance(entry, dict) or len(entry) != 1:
                return None
            pairs.extend(entry.items())
    else:
        return None
    if not pairs or len(pairs) > 32:
        return None
    normalized: dict[str, Any] = {}
    for field, direction in pairs:
        field = str(field)
        if not field or field.startswith("$") or "\x00" in field or field in normalized:
            return None
        if isinstance(direction, str) and direction.strip() in {"1", "-1"}:
            direction = int(direction.strip())
        if isinstance(direction, bool) or direction not in INDEX_DIRECTIONS:
            return None
        normalized[field] = direction
    return normalized


def normalize_op_id(value: Any) -> int | str | None:
    """A replica-set op id is an integer. Through mongos it is "shard:number"."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if 0 <= value < 2**53 else None
    if isinstance(value, str):
        candidate = value.strip()
        if candidate.isdigit() and len(candidate) <= 15:
            return int(candidate)
        if OP_ID_SAFE.match(candidate):
            return candidate
    return None


def format_reading(number: Any, units: str) -> str:
    if number is None:
        return ""
    try:
        amount = float(number)
    except (TypeError, ValueError):
        return str(number)
    unit = units.upper()
    if unit in {"KILOBYTES", "KB"}:
        return f"{amount / (1024 * 1024):.1f} GB ({amount:,.0f} KB)"
    if unit in {"BYTES", "BYTE"}:
        return f"{amount / (1024 ** 3):.1f} GB"
    if unit in {"", "RAW"}:
        return str(int(amount)) if amount.is_integer() else f"{amount:g}"
    shown = f"{int(amount):,}" if amount.is_integer() else f"{amount:,.1f}"
    return f"{shown} {units}"


def alert_condition(human: str) -> str:
    """Keep the condition sentence and drop the Atlas email banner."""
    text = " ".join(human.split())
    parts = re.split(r"-{5,}", text)
    if len(parts) >= 3:
        text = " ".join(parts[1].split())
        text = re.sub(r"^(OPEN|CLOSED|INFORMATIONAL|INFORM)\s+", "", text, flags=re.IGNORECASE)
        text = re.split(r"\s+(?:Severity|Created|Type|Replica Set|Current Value):", text, maxsplit=1)[0]
        text = re.sub(r"\s+\S+\.mongodb\.net\b", "", text)
    else:
        text = re.split(r"\bProject:", text, maxsplit=1)[0]
    return text.strip(" .")


def investigation_failure(alert: dict[str, Any], exc: BaseException) -> tuple[str, str]:
    """Explain a failed start in the same shape as a completed RCA."""
    brief = describe_alert(alert)
    message = str(exc)
    resource = ""
    match = re.search(r"on resource: (\S+)", message)
    if match:
        resource = match.group(1).rstrip(".")
    if "Read timeout" in message or exc.__class__.__name__ in {"ReadTimeoutError", "ReadTimeout"}:
        error = "The investigation started, but the result did not arrive in time."
        why = (
            "AgentCore accepted the investigation. The webhook then waited on the result stream, "
            "and that stream stayed quiet longer than the HTTP read timeout. No analysis was saved. "
            "This is a timeout in the webhook, not a finding about the database."
        )
        fix = (
            "1. Let the webhook read the stream until Mongo Buddy sends `done`, with a read timeout long enough for a cold start.\n"
            "2. Deliver the alert again.\n"
            "3. Do not resize or restart the cluster from this card."
        )
    elif "AccessDenied" in message and "InvokeAgentRuntime" in message:
        target = resource or "the DEFAULT runtime endpoint"
        error = "The webhook role cannot invoke the AgentCore runtime endpoint."
        why = (
            "Mongo Buddy accepted the alert, then AWS denied `bedrock-agentcore:InvokeAgentRuntime` "
            f"on `{target}`. The webhook role allows that action on the runtime ARN, but AgentCore "
            "authorizes the call against the runtime endpoint. The endpoint is a different ARN, so the "
            "investigation stops before any MongoDB tool runs."
        )
        fix = (
            f"1. Allow `bedrock-agentcore:InvokeAgentRuntime` on `{target}`.\n"
            "2. Redeploy the webhook role, or update its inline policy.\n"
            "3. Deliver the alert again. Do not resize or restart the cluster from this card."
        )
    else:
        error = "Mongo Buddy could not start the investigation."
        detail = " ".join(message.split())[:400] or exc.__class__.__name__
        why = f"The AgentCore invocation failed before the investigation started: {detail}"
        fix = "Check the webhook Lambda log for this alert id, correct the invocation error, and deliver the alert again."
    if "did not arrive" in error:
        outcome = "The investigation started, but the webhook did not receive the finished analysis."
    else:
        outcome = "Mongo Buddy could not start the investigation, so this is not yet a diagnosis of the database."
    analysis = "\n".join(
        [
            "## Summary",
            f"{brief['summary']} {outcome}",
            "",
            "## Why the investigation did not start",
            why,
            "",
            "## Recommended fix",
            fix,
            "",
            "## Until then",
            "Use the Atlas reading as the only confirmed fact. Do not resize, restart, or change cluster configuration until the investigation can run.",
        ]
    )
    return analysis, error


def build_prompt(alert: dict[str, Any]) -> str:
    brief = describe_alert(alert)
    return INVESTIGATION_PROMPT.format(
        project_id=brief["projectId"] or "not included",
        cluster=brief["cluster"] or "not named in the alert",
        metric=brief["metric"] or "not named in the alert",
        severity=brief["severity"] or "not set",
        current_value=brief["currentValue"] or "not included",
        summary=brief["summary"],
        alert=json.dumps(alert, ensure_ascii=False),
    ).strip()


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def alert_object_key(alert_id: str) -> str:
    safe = SESSION_SAFE.sub("", alert_id)[:80] or "unknown"
    return f"alerts/{safe}.json"


def publish_alert(record: dict[str, Any]) -> None:
    bucket = os.environ.get("ALERT_BUCKET", "").strip()
    if not bucket:
        logger.info("ALERT_BUCKET is unset; the console will not see alert %s", record.get("id"))
        return
    import boto3

    boto3.client("s3").put_object(
        Bucket=bucket,
        Key=alert_object_key(str(record.get("id") or "")),
        Body=json.dumps(record).encode("utf-8"),
        ContentType="application/json",
        CacheControl="no-store",
    )


def sign_body(secret: str, body: bytes) -> str:
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha1).digest()
    return base64.b64encode(digest).decode("ascii")


def signatures_match(secret: str, body: bytes, received: str) -> bool:
    expected = sign_body(secret, body)
    return hmac.compare_digest(expected.encode("ascii"), received.strip().encode("utf-8"))


def runtime_session_id(alert_id: str) -> str:
    suffix = uuid.uuid4().hex
    safe = SESSION_SAFE.sub("", alert_id)[:40]
    candidate = f"atlas-{safe}-{suffix}" if safe else suffix
    if len(candidate) < 33:
        candidate = f"{candidate}-{suffix}"
    return candidate[:100]


def request_body(event: dict[str, Any]) -> bytes:
    body = event.get("body") or ""
    if event.get("isBase64Encoded"):
        if isinstance(body, str):
            return base64.b64decode(body)
        return b""
    if isinstance(body, str):
        return body.encode("utf-8")
    if isinstance(body, (bytes, bytearray)):
        return bytes(body)
    return b""


def normalize_headers(headers: Any) -> dict[str, str]:
    if not isinstance(headers, dict):
        return {}
    normalized: dict[str, str] = {}
    for key, value in headers.items():
        if isinstance(value, list):
            value = value[0] if value else ""
        normalized[str(key).lower()] = str(value).strip()
    return normalized


def is_http_event(event: Any) -> bool:
    if not isinstance(event, dict):
        return False
    if "httpMethod" in event or "rawPath" in event:
        return True
    context = event.get("requestContext")
    return isinstance(context, dict) and ("http" in context or "elb" in context)


def is_worker_event(event: Any) -> bool:
    return (
        isinstance(event, dict)
        and event.get("source") == WORKER_SOURCE
        and not is_http_event(event)
    )


def enqueue_investigation(function_arn: str, message: dict[str, Any]) -> None:
    import boto3

    boto3.client("lambda").invoke(
        FunctionName=function_arn,
        InvocationType="Event",
        Payload=json.dumps(message).encode("utf-8"),
    )


def invoke_runtime(runtime_arn: str, session_id: str, payload: bytes) -> dict[str, Any]:
    import boto3
    from botocore.config import Config

    client = boto3.client(
        "bedrock-agentcore",
        config=Config(connect_timeout=10, read_timeout=240, retries={"max_attempts": 1}),
    )
    return client.invoke_agent_runtime(
        agentRuntimeArn=runtime_arn,
        runtimeSessionId=session_id,
        qualifier="DEFAULT",
        payload=payload,
        contentType="application/json",
        accept="text/event-stream",
    )


def read_response_text(response: dict[str, Any], limit: int = 120_000) -> str:
    stream = response.get("response")
    if stream is None:
        return ""
    if isinstance(stream, str):
        return stream[:limit]
    if isinstance(stream, (bytes, bytearray)):
        return bytes(stream[:limit]).decode("utf-8", errors="replace")
    chunks: list[bytes] = []
    size = 0
    for piece in _iter_stream(stream):
        if isinstance(piece, str):
            piece = piece.encode("utf-8")
        chunks.append(piece)
        size += len(piece)
        if size >= limit or b'"type":"done"' in piece or b'"type": "done"' in piece:
            break
    return b"".join(chunks).decode("utf-8", errors="replace")[:limit]


def _iter_stream(stream: Any):
    if hasattr(stream, "iter_chunks"):
        yield from stream.iter_chunks(4096)
        return
    while True:
        piece = stream.read(4096)
        if not piece:
            return
        yield piece


def summarize_agent_output(raw: str) -> dict[str, Any]:
    tools: list[str] = []
    tokens: list[str] = []
    errors: list[str] = []
    for line in raw.splitlines():
        if not line.startswith("data:"):
            continue
        try:
            event = json.loads(line[5:].strip())
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        if kind == "token" and isinstance(event.get("text"), str):
            tokens.append(event["text"])
        elif kind == "tool_call" and isinstance(event.get("name"), str):
            if not tools or tools[-1] != event["name"]:
                tools.append(event["name"])
        elif kind == "error" and event.get("message"):
            errors.append(str(event["message"])[:500])
    full, remediation_block = split_remediation_block("".join(tokens).strip())
    heading = full.find("## ")
    if heading == 0:
        answer = full
        notes = ""
    elif heading > 0:
        answer = full[heading:]
        notes = tidy_prose(full[:heading])
    else:
        answer = ""
        notes = tidy_prose(full)
    return {
        "tools": tools[:12],
        "answer": answer.strip()[:16000],
        "notes": notes[:4000],
        "errors": errors[:5],
        "remediation_block": remediation_block,
    }


def split_remediation_block(text: str) -> tuple[str, str]:
    """Remove every machine-contract fence from the visible text.

    Returns the visible text and the body of the last fence. An unterminated
    fence (the model stopped mid-block) is removed too, and fails to parse.
    """
    bodies = [match.group(1) for match in REMEDIATION_FENCE.finditer(text)]
    if not bodies:
        return text, ""
    visible = REMEDIATION_FENCE.sub("", text)
    return visible.strip(), bodies[-1].strip()


def tidy_prose(text: str) -> str:
    collapsed = " ".join(text.split())
    return re.sub(r"([.!?])([A-Za-z])", r"\1 \2", collapsed).strip()


def unfinished_analysis(alert: dict[str, Any], notes: str) -> str:
    brief = describe_alert(alert)
    evidence = evidence_bullets(notes)
    lowered = notes.lower()
    if "collscan" in lowered or "index" in lowered:
        cause = (
            "The strongest lead is a collection scan against a collection that lacks a suitable secondary index. "
            "A scan of a large collection keeps data in memory on the node that runs it, which can trip a system-memory alert. "
            "Confirm that this scan is still running before changing the cluster."
        )
    else:
        cause = (
            "Use the evidence as the working cause. Confirm it against the current Atlas metric before changing the cluster."
        )
    return "\n".join(
        [
            "## Summary",
            f"{brief['summary']} The notes below are the read-only findings. They are the working explanation, not a process-level memory profile.",
            "",
            "## Evidence",
            evidence,
            "",
            "## Likely cause",
            cause,
            "",
            "## Recommended fix",
            "1. In Atlas, check whether this metric is still above the threshold. If it has recovered and the alert is closed, do not change cluster size.",
            "2. If the evidence names a collection scan or a missing index, add the index that matches that query. Needs approval.",
            "3. Run explain again and confirm the plan is no longer a collection scan. Watch this metric through the next peak.",
            "",
            "## What not to do",
            "Do not scale the cluster to hide a query or index problem. Do not restart the process until you know the reading is still high.",
        ]
    )


def evidence_bullets(notes: str) -> str:
    sentences = [sentence.strip() for sentence in re.split(r"(?<=[.!?])\s+", notes) if sentence.strip()]
    findings = [
        sentence
        for sentence in sentences
        if not sentence.lower().startswith(("i'll ", "i will ", "let me ", "now let me "))
    ]
    if not findings:
        return "- No tool notes were captured."
    return "\n".join(f"- {sentence}" for sentence in findings)


def http_response(status: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }
