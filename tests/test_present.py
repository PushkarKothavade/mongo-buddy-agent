import json

from mongo_buddy.present import (
    access_list_message,
    advisor_items,
    classify_intent,
    classify_view,
    database_items,
    extract_prompt,
    extract_tool_output,
    metric_items,
    summarize_explain,
)

EXPLAIN = {
    "queryPlanner": {
        "namespace": "aws_summit.customers",
        "winningPlan": {
            "stage": "COLLSCAN",
            "filter": {"city": "Mumbai"},
        },
    },
    "executionStats": {
        "nReturned": 1200,
        "executionTimeMillis": 840,
        "totalKeysExamined": 0,
        "totalDocsExamined": 1_000_000,
        "executionStages": {"stage": "COLLSCAN"},
    },
}


def test_access_list_message_names_the_blocked_ip():
    body = json.dumps(
        {
            "detail": "IP address 203.0.113.8 is not allowed to access this resource.",
            "error": 403,
            "errorCode": "IP_ADDRESS_NOT_ON_ACCESS_LIST",
            "parameters": ["203.0.113.8"],
        }
    )
    message = access_list_message(body)
    assert message is not None
    assert "203.0.113.8/32" in message
    assert access_list_message("not-json") is None


def test_extract_prompt_accepts_agentcore_shapes():
    assert extract_prompt({"prompt": " list databases "}) == "list databases"
    assert extract_prompt({"input": {"prompt": "explain this"}}) == "explain this"
    assert extract_prompt("hello") == "hello"
    assert extract_prompt({}) == ""


def test_intent_for_the_booth_questions():
    assert classify_intent("List every database") == "databases"
    assert classify_intent("Why is this customers query slow?") == "rca"
    assert classify_intent("Explain the plan for city = Mumbai") == "explain"
    assert classify_intent("How big is the customers collection?") == "metrics"


def test_tool_text_json_is_parsed_and_classified():
    raw = {
        "content": [{"text": json.dumps({"databases": [{"name": "aws_summit", "sizeOnDisk": 4096}]})}],
        "status": "success",
    }
    output = extract_tool_output(raw)
    assert classify_view("list-databases", output) == "databases"
    assert database_items(output)[0]["name"] == "aws_summit"


def test_explain_summary_reads_collscan_evidence():
    assert classify_view("explain", EXPLAIN) == "explain"
    summary = summarize_explain(EXPLAIN)
    assert summary is not None
    assert summary["stage"] == "COLLSCAN"
    assert summary["totalDocsExamined"] == 1_000_000
    assert summary["nReturned"] == 1200
    assert summary["executionTimeMillis"] == 840
    assert summary["namespace"] == "aws_summit.customers"


def test_metrics_and_advisor_shapes():
    stats = {"count": 1000000, "size": 52_000_000, "avgObjSize": 52, "nindexes": 1}
    assert classify_view("collection-storage-size", stats) == "metrics"
    assert len(metric_items(stats)) == 4
    advisor = {"suggestedIndexes": [{"namespace": "aws_summit.customers", "index": {"city": 1}}]}
    assert classify_view("atlas-get-performance-advisor", advisor) == "advisor"
    assert advisor_items(advisor)[0]["namespace"] == "aws_summit.customers"
