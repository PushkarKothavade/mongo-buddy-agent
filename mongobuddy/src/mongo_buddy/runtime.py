"""Strands agent wired to the official MongoDB MCP server."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import threading
import time
import urllib.error
import urllib.request
from typing import Any

from mcp import StdioServerParameters, stdio_client
from strands import Agent
from strands.hooks import HookProvider, HookRegistry
from strands.hooks.events import AfterToolCallEvent, BeforeToolCallEvent
from strands.models import BedrockModel
from strands.tools.mcp import MCPClient

from mongo_buddy.config import Settings, load_settings
from mongo_buddy.present import (
    access_list_message,
    classify_intent,
    classify_view,
    extract_tool_output,
)

logger = logging.getLogger("mongo_buddy")

SYSTEM_PROMPT = """You are Mongo Buddy, the Developer Companion for MongoDB, demonstrated at AWS Community Day Mumbai.
You help developers debug issues, troubleshoot performance, and understand their Atlas data.
You are connected to the official MongoDB MCP server. Use those tools for every factual claim about databases, collections, indexes, explain plans, metrics, and Atlas resources. Never invent numbers, index names, or cluster facts.

Demo context: the Atlas database `aws_summit` has a `customers` collection of about 1 million documents with fields customerId, name, age, city, and address. Confirm that with tools when the user is talking about the summit dataset.

How to work:
1. If a tool needs a connection id, use the MCP connect or list-connection tools first, then query. Do not guess ids.
2. For inventory questions, list databases or collections and include sizes when the tool returns them.
3. For slow queries, inspect indexes and run explain with executionStats. Say whether the plan is COLLSCAN or IXSCAN.
4. Quote the evidence: totalDocsExamined, nReturned, totalKeysExamined, and executionTimeMillis.
5. For a root-cause question, gather that evidence first, then state the cause, the proof, and the specific fix.
6. For an Atlas alert or a memory or performance incident, read Performance Advisor slow query logs for the last 10 minutes. If that window is empty, say so, then use suggested indexes and explain plans.
7. When the evidence points at a missing index, name the database, collection, and the exact mongosh command, for example db.getSiblingDB("aws_summit").customers.createIndex({ city: 1, age: 1 }). That command is an action item for a human developer.
8. Never create an index, kill an operation, drop, insert, scale, or restart. This demo is read-only. Give the developer the command and leave the change to them.

Lead with the finding, then the evidence, then the next step. Write so a developer can read the answer out loud at a booth.
"""


class _ToolTrace(HookProvider):
    """Capture MCP tool calls while the Strands loop is running."""

    def __init__(self) -> None:
        self._pending: list[dict[str, Any]] = []

    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(BeforeToolCallEvent, self._before)
        registry.add_callback(AfterToolCallEvent, self._after)

    def drain(self) -> list[dict[str, Any]]:
        items = self._pending
        self._pending = []
        return items

    def _before(self, event: BeforeToolCallEvent) -> None:
        tool = event.tool_use
        self._pending.append(
            {
                "type": "tool_call",
                "id": tool.get("toolUseId", ""),
                "name": tool.get("name", "tool"),
                "input": _jsonable(tool.get("input", {})),
            }
        )

    def _after(self, event: AfterToolCallEvent) -> None:
        tool = event.tool_use
        name = tool.get("name", "tool")
        status = "error" if event.exception else "success"
        result = event.result
        if isinstance(result, dict) and result.get("status") == "error":
            status = "error"
        output = extract_tool_output(event.exception or result)
        self._pending.append(
            {
                "type": "tool_result",
                "id": tool.get("toolUseId", ""),
                "name": name,
                "status": status,
                "durationMs": round((event.duration or 0) * 1000),
                "view": classify_view(name, output),
                "output": _jsonable(output),
            }
        )


class BuddyRuntime:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or load_settings()
        self._mcp: MCPClient | None = None
        self._agent: Agent | None = None
        self._trace = _ToolTrace()
        self._lock = threading.Lock()
        self.tool_names: list[str] = []
        self.ready = False
        self.error: str | None = None

    def start(self) -> None:
        if not self.settings.credentials_configured:
            self.error = (
                "MongoDB MCP credentials are missing. Set MDB_MCP_API_CLIENT_ID and "
                "MDB_MCP_API_CLIENT_SECRET in .env, then restart."
            )
            logger.error(self.error)
            return
        blocked = _atlas_access_error(self.settings)
        if blocked:
            self.error = blocked
            logger.error(blocked)
            return
        try:
            logger.info(
                "Starting MongoDB MCP via %s %s",
                self.settings.mcp_command,
                " ".join(self.settings.mcp_args),
            )
            self._mcp = MCPClient(
                lambda: stdio_client(
                    StdioServerParameters(
                        command=self.settings.mcp_command,
                        args=self.settings.mcp_args,
                        env=self.settings.mcp_env,
                    )
                ),
                startup_timeout=self.settings.startup_timeout,
            )
            self._mcp.start()
            tools = self._mcp.list_tools_sync()
            self.tool_names = sorted(tool.tool_name for tool in tools)
            model = BedrockModel(
                model_id=self.settings.model_id,
                region_name=self.settings.region,
                max_tokens=16000,
                additional_request_fields={
                    "thinking": {"type": "adaptive", "display": "summarized"},
                    "output_config": {"effort": "high"},
                },
            )
            self._agent = Agent(
                model=model,
                system_prompt=SYSTEM_PROMPT,
                tools=tools,
                hooks=[self._trace],
                callback_handler=None,
            )
            self.ready = True
            self.error = None
            logger.info("MongoDB MCP connected with %s tools", len(self.tool_names))
        except Exception as exc:
            self.ready = False
            self.error = str(exc)
            logger.exception("MongoDB MCP failed to start")

    def stop(self) -> None:
        if self._mcp is not None:
            try:
                self._mcp.stop(None, None, None)
            except Exception:
                logger.exception("MongoDB MCP stop failed")
        self._mcp = None
        self._agent = None
        self.ready = False

    def reset(self) -> None:
        if self._agent is not None:
            self._agent.messages.clear()

    def status(self) -> dict[str, Any]:
        if self.ready:
            state = "ready"
        elif self.error:
            state = "error"
        else:
            state = "starting"
        return {
            "state": state,
            "error": self.error,
            "modelId": self.settings.model_id,
            "region": self.settings.region,
            "toolCount": len(self.tool_names),
            "tools": self.tool_names,
            "mcp": f"{self.settings.mcp_command} {' '.join(self.settings.mcp_args)}",
        }

    async def stream(self, prompt: str):
        # Yield before MCP is ready so the UI gets a first byte during cold start.
        yield {
            "type": "phase",
            "phase": "connecting",
            "message": "Connecting to MongoDB MCP",
        }
        started = time.perf_counter()
        await self._wait_until_settled()
        logger.info("MCP settled after %.1fs", time.perf_counter() - started)
        if self.error or self._agent is None:
            yield {"type": "error", "message": self.error or "Mongo Buddy is not ready."}
            return

        yield {
            "type": "turn",
            "prompt": prompt,
            "intent": classify_intent(prompt),
        }
        yield {"type": "phase", "phase": "thinking", "message": "The model is thinking"}

        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._lock.acquire)
        try:
            async for event in self._agent.stream_async(prompt):
                for item in self._trace.drain():
                    yield item
                normalized = _normalize_stream_event(event)
                if normalized is not None:
                    yield normalized
            for item in self._trace.drain():
                yield item
            yield {"type": "done"}
        except Exception as exc:
            logger.exception("Agent invocation failed")
            yield {"type": "error", "message": str(exc)}
        finally:
            self._lock.release()

    async def _wait_until_settled(self) -> None:
        for _ in range(self.settings.startup_timeout * 5):
            if self.ready or self.error:
                return
            await asyncio.sleep(0.2)
        self.error = "MongoDB MCP did not become ready in time."


def _normalize_stream_event(event: dict[str, Any]) -> dict[str, Any] | None:
    reasoning = event.get("reasoningText")
    if event.get("reasoning") and isinstance(reasoning, str) and reasoning:
        return {"type": "thinking", "text": reasoning}
    if isinstance(event.get("data"), str):
        return {"type": "token", "text": event["data"]}
    tool = event.get("current_tool_use")
    if isinstance(tool, dict) and tool.get("name"):
        return {
            "type": "tool_call",
            "id": tool.get("toolUseId", ""),
            "name": tool.get("name", "tool"),
            "input": _jsonable(tool.get("input", {})),
        }
    return None


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return str(value)


def build_runtime() -> BuddyRuntime:
    return BuddyRuntime(load_settings())


def _atlas_access_error(settings: Settings) -> str | None:
    """Ask the official remote MCP endpoint whether this machine is allowlisted."""
    if not settings.client_id or not settings.client_secret or "mongodb-atlas-mcp-remote" not in " ".join(settings.mcp_args):
        return None
    token = _service_account_token(settings)
    if not token:
        return None
    body = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "mongo-buddy", "version": "0.1.0"},
            },
        }
    ).encode()
    request = urllib.request.Request(
        "https://mcp.mongodb.com",
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            response.read(64)
    except urllib.error.HTTPError as exc:
        message = access_list_message(exc.read().decode("utf-8", "replace"))
        if message:
            return message
        if exc.code == 403:
            return "Atlas rejected the MongoDB MCP login. Check the service account API access list, then restart."
    except Exception:
        logger.debug("Atlas access preflight skipped", exc_info=True)
    return None


def _service_account_token(settings: Settings) -> str | None:
    credentials = base64.b64encode(f"{settings.client_id}:{settings.client_secret}".encode()).decode()
    request = urllib.request.Request(
        "https://cloud.mongodb.com/api/oauth/token",
        data=b"grant_type=client_credentials",
        headers={
            "Authorization": f"Basic {credentials}",
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode())
    except Exception:
        logger.debug("Service account token preflight failed", exc_info=True)
        return None
    token = payload.get("access_token")
    return token if isinstance(token, str) else None


__all__ = ["BuddyRuntime", "SYSTEM_PROMPT", "build_runtime"]
