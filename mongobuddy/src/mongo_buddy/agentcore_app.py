"""Amazon Bedrock AgentCore entrypoint for Mongo Buddy.

Local development and the managed runtime both serve this Starlette app:
POST /invocations streams the agent, GET /ping is the runtime health check.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from mongo_buddy.present import extract_prompt
from mongo_buddy.runtime import BuddyRuntime, build_runtime

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("mongo_buddy")

runtime: BuddyRuntime = build_runtime()


@asynccontextmanager
async def lifespan(_app: BedrockAgentCoreApp):
    import asyncio

    starter = asyncio.create_task(asyncio.to_thread(runtime.start))
    try:
        yield
    finally:
        starter.cancel()
        runtime.stop()


app = BedrockAgentCoreApp(
    lifespan=lifespan,
    middleware=[
        Middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_methods=["*"],
            allow_headers=["*"],
        )
    ],
)


@app.entrypoint
async def invoke(payload):
    """AgentCore invocation. Yields SSE events consumed by the developer UI."""
    if isinstance(payload, dict) and payload.get("action") == "reset":
        runtime.reset()
        yield {"type": "reset"}
        return

    prompt = extract_prompt(payload)
    if not prompt:
        yield {"type": "error", "message": "Type a question for Mongo Buddy."}
        return

    logger.info("Invocation: %s", prompt[:180])
    async for event in runtime.stream(prompt):
        yield event


async def status(_request: Request) -> JSONResponse:
    return JSONResponse(runtime.status())


async def reset(_request: Request) -> JSONResponse:
    runtime.reset()
    return JSONResponse({"ok": True})


app.router.routes.insert(0, Route("/api/status", status, methods=["GET"]))
app.router.routes.insert(0, Route("/api/reset", reset, methods=["POST"]))
