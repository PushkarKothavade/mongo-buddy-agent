import base64
import json

import pytest

from lambda_function import (
    build_prompt,
    describe_alert,
    handle_webhook,
    investigate,
    lambda_handler,
    read_response_text,
    runtime_session_id,
    sign_body,
    summarize_agent_output,
)
from mongo_buddy.present import extract_prompt

SECRET = "test-webhook-secret-value"
RUNTIME_ARN = "arn:aws:bedrock-agentcore:ap-south-1:123456789012:runtime/mongo-buddy"
ALERT = {
    "id": "5d1b6f8e8c2e4e2d3c4a5b6c",
    "groupId": "5d1b6f8e8c2e4e2d3c4a5b6d",
    "eventTypeName": "OUTSIDE_METRIC_THRESHOLD",
    "status": "OPEN",
    "metricName": "CONNECTIONS",
    "severity": "WARNING",
    "clusterName": "summit-demo",
    "currentValue": {"number": 120, "units": "RAW"},
    "humanReadable": "Connections above threshold. Project: Demo Organization: Demo",
}


class Context:
    invoked_function_arn = "arn:aws:lambda:ap-south-1:123456789012:function:mongodb-atlas-alert-webhook"


def http_event(body: bytes, *, event_type: str = "alert.open", secret: str = SECRET, signature: str | None = None):
    signed = sign_body(secret, body) if signature is None else signature
    return {
        "version": "2.0",
        "rawPath": "/atlas-alert",
        "headers": {
            "x-mms-signature": signed,
            "x-mms-event": event_type,
        },
        "body": body.decode("utf-8"),
        "isBase64Encoded": False,
        "requestContext": {"http": {"method": "POST", "path": "/atlas-alert"}},
    }


@pytest.fixture(autouse=True)
def runtime_env(monkeypatch):
    monkeypatch.setenv("WEBHOOK_SECRET", SECRET)
    monkeypatch.setenv("AGENT_RUNTIME_ARN", RUNTIME_ARN)


def test_open_alert_is_queued_after_a_valid_signature(monkeypatch):
    queued = []
    monkeypatch.setattr("lambda_function.enqueue_investigation", lambda arn, message: queued.append((arn, message)))
    body = json.dumps(ALERT).encode("utf-8")

    result = lambda_handler(http_event(body), Context())

    assert result["statusCode"] == 202
    payload = json.loads(result["body"])
    assert payload["alert_id"] == ALERT["id"]
    assert queued[0][0] == Context.invoked_function_arn
    assert queued[0][1]["alert"]["groupId"] == ALERT["groupId"]
    assert queued[0][1]["source"] == "atlas-alert-worker"


def test_invalid_signature_does_not_queue_the_agent(monkeypatch):
    queued = []
    monkeypatch.setattr("lambda_function.enqueue_investigation", lambda arn, message: queued.append(message))
    body = json.dumps(ALERT).encode("utf-8")

    result = lambda_handler(http_event(body, signature="not-a-valid-signature"), Context())

    assert result["statusCode"] == 401
    assert queued == []


def test_signature_uses_the_raw_base64_body(monkeypatch):
    queued = []
    monkeypatch.setattr("lambda_function.enqueue_investigation", lambda arn, message: queued.append(message))
    body = json.dumps(ALERT).encode("utf-8")
    event = http_event(body)
    event["body"] = base64.b64encode(body).decode("ascii")
    event["isBase64Encoded"] = True

    result = lambda_handler(event, Context())

    assert result["statusCode"] == 202
    assert queued[0]["alert"]["id"] == ALERT["id"]


def test_update_events_are_acknowledged_without_invocation(monkeypatch):
    queued = []
    monkeypatch.setattr("lambda_function.enqueue_investigation", lambda arn, message: queued.append(message))
    body = json.dumps(ALERT).encode("utf-8")

    result = handle_webhook(http_event(body, event_type="alert.update"), Context())

    assert result["statusCode"] == 200
    assert json.loads(result["body"])["event"] == "alert.update"
    assert queued == []


def test_invalid_json_is_rejected():
    result = lambda_handler(http_event(b"not-json"), Context())
    assert result["statusCode"] == 400


def test_http_payload_cannot_skip_the_signature_by_claiming_to_be_the_worker(monkeypatch):
    queued = []
    monkeypatch.setattr("lambda_function.enqueue_investigation", lambda arn, message: queued.append(message))
    event = http_event(json.dumps({"source": "atlas-alert-worker", "alert": ALERT}).encode("utf-8"), signature="nope")

    result = lambda_handler(event, Context())

    assert result["statusCode"] == 401
    assert queued == []


def test_worker_invokes_agentcore_with_the_prompt_schema(monkeypatch):
    captured = {}

    def invoke(runtime_arn, session_id, payload):
        captured["runtime_arn"] = runtime_arn
        captured["session_id"] = session_id
        captured["payload"] = payload
        body = (
            'data: {"type":"tool_call","name":"atlas-list-alerts"}\n\n'
            'data: {"type":"token","text":"Connections spiked on the primary."}\n\n'
        )
        return {"statusCode": 200, "response": body.encode("utf-8")}

    monkeypatch.setattr("lambda_function.invoke_runtime", invoke)
    result = investigate({"source": "atlas-alert-worker", "alert": ALERT, "eventType": "alert.open"})

    prompt = json.loads(captured["payload"].decode("utf-8"))["prompt"]
    assert captured["runtime_arn"] == RUNTIME_ARN
    assert len(captured["session_id"]) >= 33
    assert extract_prompt(json.loads(captured["payload"].decode("utf-8"))) == prompt
    assert ALERT["groupId"] in prompt
    assert "read-only" in prompt
    assert "## Summary" in prompt
    assert "## Recommended fix" in prompt
    assert "Needs approval" in prompt
    assert result["ok"] is True
    assert result["tools"] == ["atlas-list-alerts"]


def test_open_alert_publishes_a_processing_record(monkeypatch):
    published = []
    monkeypatch.setattr("lambda_function.enqueue_investigation", lambda arn, message: None)
    monkeypatch.setattr("lambda_function.publish_alert", lambda record: published.append(record))

    result = lambda_handler(http_event(json.dumps(ALERT).encode("utf-8")), Context())

    assert result["statusCode"] == 202
    assert published[0]["status"] == "processing"
    assert published[0]["title"] == "Connections above threshold"
    assert "summit-demo" in published[0]["summary"]
    assert published[0]["currentValue"] == "120"
    assert published[0]["analysis"] == ""


def test_investigation_publishes_the_developer_analysis(monkeypatch):
    published = []

    def invoke(runtime_arn, session_id, payload):
        body = (
            'data: {"type":"tool_call","name":"atlas-list-alerts"}\n\n'
            'data: {"type":"token","text":"## What happened\\n\\nConnections on summit-demo are above the threshold."}\n\n'
        )
        return {"statusCode": 200, "response": body.encode("utf-8")}

    monkeypatch.setattr("lambda_function.invoke_runtime", invoke)
    monkeypatch.setattr("lambda_function.publish_alert", lambda record: published.append(record))

    investigate({"source": "atlas-alert-worker", "alert": ALERT, "eventType": "alert.open", "detectedAt": "2026-10-13T12:00:00Z"})

    assert published[0]["status"] == "complete"
    assert "Connections on summit-demo" in published[0]["analysis"]
    assert published[0]["cluster"] == "summit-demo"
    assert published[0]["tools"] == ["atlas-list-alerts"]


def test_describe_alert_names_the_cluster_and_value():
    brief = describe_alert(ALERT)
    assert brief["title"] == "Connections above threshold"
    assert brief["summary"] == (
        "Connections above threshold on summit-demo. "
        "The current reading is 120. "
        "Atlas severity is WARNING."
    )


def test_banner_alert_drops_the_email_chrome_and_formats_memory():
    brief = describe_alert(
        {
            **ALERT,
            "metricName": "MAX_SYSTEM_MEMORY_USED",
            "severity": "CRITICAL",
            "clusterName": "sample-mflix-cluster",
            "currentValue": {"number": 6948748, "units": "KILOBYTES"},
            "humanReadable": (
                "Project: Pushkar Organization: Demo "
                "---------------------------------------- "
                "OPEN System Memory: Max Used has gone above 4.5 GB "
                "sample-mflix-cluster-shard-00-01.example.mongodb.net "
                "Severity: CRITICAL Created: 2026/10/15 09:09 IST "
                "Type: Mongos Current Value: 6,948,748 kilobytes "
                "----------------------------------------"
            ),
        }
    )
    assert "Project:" not in brief["summary"]
    assert "mongodb.net" not in brief["summary"]
    assert "System Memory: Max Used has gone above 4.5 GB on sample-mflix-cluster." in brief["summary"]
    assert brief["currentValue"] == "6.6 GB (6,948,748 KB)"


def test_access_denied_publishes_a_developer_rca(monkeypatch):
    published = []

    def invoke(runtime_arn, session_id, payload):
        raise RuntimeError(
            "An error occurred (AccessDeniedException) when calling the InvokeAgentRuntime operation: "
            "not authorized to perform: bedrock-agentcore:InvokeAgentRuntime "
            "on resource: arn:aws:bedrock-agentcore:ap-south-1:1:runtime/mongo/runtime-endpoint/DEFAULT"
        )

    monkeypatch.setattr("lambda_function.invoke_runtime", invoke)
    monkeypatch.setattr("lambda_function.publish_alert", lambda record: published.append(record))

    result = investigate({"source": "atlas-alert-worker", "alert": ALERT, "detectedAt": "2026-10-15T04:37:26Z"})

    assert result["ok"] is False
    record = published[0]
    assert record["status"] == "error"
    assert "runtime endpoint" in record["error"]
    assert "## Summary" in record["analysis"]
    assert "runtime-endpoint/DEFAULT" in record["analysis"]
    assert "Recommended fix" in record["analysis"]
    assert "summit-demo" in record["analysis"]


def test_prompt_round_trips_through_the_agent_entrypoint():
    prompt = build_prompt(ALERT)
    assert extract_prompt({"prompt": prompt}) == prompt


def test_session_id_stays_within_agentcore_limits():
    session_id = runtime_session_id(ALERT["id"])
    assert 33 <= len(session_id) <= 100
    assert session_id.startswith("atlas-")


def test_stream_reader_stops_when_the_agent_is_done():
    class Stream:
        def iter_chunks(self, size):
            yield b'data: {"type":"token","text":"Memory is elevated."}\n\n'
            yield b'data: {"type":"done"}\n\n'
            yield b'data: {"type":"token","text":"late"}\n\n'

    raw = read_response_text({"response": Stream()})
    assert "Memory is elevated." in raw
    assert "late" not in raw


def test_summary_keeps_the_report_and_drops_the_scratch_notes():
    raw = (
        'data: {"type":"token","text":"Checking the alert."}\n\n'
        'data: {"type":"tool_call","name":"atlas-list-alerts"}\n\n'
        'data: {"type":"tool_call","name":"atlas-list-alerts"}\n\n'
        'data: {"type":"token","text":"## Summary\\n\\nLag is on the secondary."}\n'
        "not-an-event\n"
    )
    summary = summarize_agent_output(raw)
    assert summary["answer"] == "## Summary\n\nLag is on the secondary."
    assert summary["notes"] == "Checking the alert."
    assert summary["tools"] == ["atlas-list-alerts"]
    assert summary["errors"] == []


INDEX_BLOCK = (
    "\n\n```mongo-buddy-remediations\n"
    + json.dumps(
        [
            {
                "id": "model-chosen-id",
                "action": "create_index",
                "label": "model chose another label",
                "reason": "COLLSCAN on aws_summit.customers examines 1,000,000 documents.",
                "impact": "Builds one rolling index.",
                "needsApproval": False,
                "status": "complete",
                "target": {
                    "cluster": "summit-demo",
                    "projectId": ALERT["groupId"],
                    "database": "aws_summit",
                    "collection": "customers",
                    "keys": [{"city": 1}, {"age": -1}],
                    "evidence": "find({city: 'Pune', age: {$gt: 30}}) is a COLLSCAN",
                },
            },
            {"action": "drop_collection", "reason": "no", "target": {"database": "aws_summit", "collection": "customers"}},
            {
                "action": "kill_operation",
                "reason": "One query has run for 40 minutes.",
                "target": {"opId": "4711", "namespace": "aws_summit.customers", "description": "find city=Pune"},
            },
        ]
    )
    + "\n```\n"
)


def run_investigation(monkeypatch, text, alert=ALERT):
    published = []
    body = f'data: {json.dumps({"type": "token", "text": text})}\n\n'
    monkeypatch.setattr(
        "lambda_function.invoke_runtime",
        lambda arn, session, payload: {"statusCode": 200, "response": body.encode("utf-8")},
    )
    monkeypatch.setattr("lambda_function.publish_alert", lambda record: published.append(record))
    investigate({"source": "atlas-alert-worker", "alert": alert, "detectedAt": "2026-10-15T04:37:26Z"})
    return published[0]


def test_prompt_asks_for_the_remediation_block_and_marks_mutations():
    prompt = build_prompt(ALERT)
    assert "```mongo-buddy-remediations" in prompt
    assert "Create recommended index" in prompt
    assert "Kill the operation causing the alert" in prompt
    assert "Needs approval" in prompt
    assert "Last 10 minutes" in prompt
    assert "createIndex" in prompt
    assert "Mongo Buddy does not run them" in prompt
    assert "Never invent an op id" in prompt
    assert ALERT["groupId"] in prompt


def test_remediation_block_is_stripped_and_persisted_with_the_contract_shape(monkeypatch):
    record = run_investigation(monkeypatch, "## Summary\n\nScan on customers.\n\n## Recommended fix\n1. Add an index. Needs approval." + INDEX_BLOCK)

    assert "mongo-buddy-remediations" not in record["analysis"]
    assert "```" not in record["analysis"]
    assert record["analysis"].startswith("## Summary")
    assert record["analysis"].rstrip().endswith("Needs approval.")
    index, kill = record["remediations"]
    assert [r["action"] for r in record["remediations"]] == ["create_index", "kill_operation"]
    assert index == {
        "id": index["id"],
        "action": "create_index",
        "label": "Create recommended index",
        "reason": "COLLSCAN on aws_summit.customers examines 1,000,000 documents.",
        "impact": "Builds one rolling index.",
        "needsApproval": True,
        "status": "proposed",
        "target": {
            "cluster": "summit-demo",
            "projectId": ALERT["groupId"],
            "database": "aws_summit",
            "collection": "customers",
            "keys": {"city": 1, "age": -1},
            "evidence": "find({city: 'Pune', age: {$gt: 30}}) is a COLLSCAN",
        },
        "error": None,
        "result": None,
    }
    assert kill["label"] == "Kill the operation causing the alert"
    assert kill["target"] == {
        "cluster": "summit-demo",
        "projectId": ALERT["groupId"],
        "opId": 4711,
        "namespace": "aws_summit.customers",
        "description": "find city=Pune",
    }
    assert kill["status"] == "proposed" and kill["error"] is None and kill["result"] is None
    assert index["id"] != kill["id"]


@pytest.mark.parametrize(
    "tail",
    [
        "\n\n```mongo-buddy-remediations\nnot json at all\n```\n",
        "\n\n```mongo-buddy-remediations\n[{\"action\": \"create_index\", \n",
        "\n\n```mongo-buddy-remediations\n{\"action\": \"create_index\"}\n```\n",
        "\n\n```mongo-buddy-remediations\n[]\n```\n",
        "",
    ],
)
def test_bad_or_missing_remediation_json_keeps_the_analysis(monkeypatch, tail):
    record = run_investigation(monkeypatch, "## Summary\n\nMemory is high." + tail)

    assert record["status"] == "complete"
    assert record["analysis"] == "## Summary\n\nMemory is high."
    assert record["remediations"] == []


def test_remediations_never_invent_a_target(monkeypatch):
    block = json.dumps(
        [
            # no database or collection
            {"action": "create_index", "reason": "r", "target": {"keys": {"a": 1}}},
            # no keys
            {"action": "create_index", "reason": "r", "target": {"database": "d", "collection": "c"}},
            # operator in an index key
            {"action": "create_index", "reason": "r", "target": {"database": "d", "collection": "c", "keys": {"$where": 1}}},
            # prompt placeholder copied rather than verified
            {"action": "create_index", "reason": "r", "target": {"database": "db", "collection": "coll", "keys": {"a": 1}}},
            # no op id
            {"action": "kill_operation", "reason": "r", "target": {"namespace": "d.c"}},
            # op id that is not a number
            {"action": "kill_operation", "reason": "r", "target": {"opId": "1; db.dropDatabase()", "namespace": "d.c"}},
            # another cluster than the alert
            {"action": "kill_operation", "reason": "r", "target": {"opId": 1, "namespace": "d.c", "cluster": "other"}},
            # unsupported
            {"action": "resize_cluster", "reason": "r", "target": {}},
        ]
    )
    record = run_investigation(monkeypatch, f"## Summary\n\nx\n\n```mongo-buddy-remediations\n{block}\n```")

    assert record["remediations"] == []


def test_at_most_three_remediations_are_kept(monkeypatch):
    items = [
        {"action": "create_index", "reason": "r", "target": {"database": "d", "collection": "c", "keys": {f"f{i}": 1}}}
        for i in range(6)
    ]
    record = run_investigation(monkeypatch, f"## Summary\n\nx\n\n```mongo-buddy-remediations\n{json.dumps(items)}\n```")

    assert len(record["remediations"]) == 3
    assert len({r["id"] for r in record["remediations"]}) == 3


def test_unterminated_block_is_hidden_and_ignored(monkeypatch):
    record = run_investigation(monkeypatch, '## Summary\n\nx\n\n```mongo-buddy-remediations\n[{"action": "kill_op')

    assert record["analysis"] == "## Summary\n\nx"
    assert record["remediations"] == []


def test_processing_and_error_records_carry_an_empty_remediation_list(monkeypatch):
    published = []
    monkeypatch.setattr("lambda_function.enqueue_investigation", lambda arn, message: None)
    monkeypatch.setattr("lambda_function.publish_alert", lambda record: published.append(record))
    lambda_handler(http_event(json.dumps(ALERT).encode("utf-8")), Context())

    def boom(arn, session, payload):
        raise RuntimeError("down")

    monkeypatch.setattr("lambda_function.invoke_runtime", boom)
    investigate({"source": "atlas-alert-worker", "alert": ALERT})

    assert [record["status"] for record in published] == ["processing", "error"]
    assert all(record["remediations"] == [] for record in published)
    assert "## Summary" in published[1]["analysis"]
