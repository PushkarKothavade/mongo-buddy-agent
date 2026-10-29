"""Runtime settings. Credentials stay in the environment, never in source."""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()

DEFAULT_MODEL_ID = "in.anthropic.claude-opus-5"
DEFAULT_REGION = "ap-south-1"
DEFAULT_MCP_COMMAND = "npx"
DEFAULT_MCP_ARGS = "-y mongodb-atlas-mcp-remote@latest"


@dataclass(frozen=True)
class Settings:
    model_id: str
    region: str
    mcp_command: str
    mcp_args: list[str]
    client_id: str
    client_secret: str
    connection_string: str
    read_only: bool
    port: int
    startup_timeout: int

    @property
    def mcp_env(self) -> dict[str, str]:
        """Subprocess environment for the official MongoDB MCP server."""
        env = os.environ.copy()
        if self.client_id:
            env["MDB_MCP_API_CLIENT_ID"] = self.client_id
        if self.client_secret:
            env["MDB_MCP_API_CLIENT_SECRET"] = self.client_secret
        if self.connection_string:
            env["MDB_MCP_CONNECTION_STRING"] = self.connection_string
        if self.read_only:
            env["MDB_MCP_READ_ONLY"] = "true"
        return env

    @property
    def credentials_configured(self) -> bool:
        return bool(self.connection_string or (self.client_id and self.client_secret))


def load_settings() -> Settings:
    args = os.getenv("MDB_MCP_ARGS", DEFAULT_MCP_ARGS).split()
    read_only = os.getenv("MDB_MCP_READ_ONLY", "").strip().lower() in {"1", "true", "yes"}
    return Settings(
        model_id=os.getenv("MODEL_ID", DEFAULT_MODEL_ID).strip() or DEFAULT_MODEL_ID,
        region=os.getenv("AWS_REGION", DEFAULT_REGION).strip() or DEFAULT_REGION,
        mcp_command=os.getenv("MDB_MCP_COMMAND", DEFAULT_MCP_COMMAND).strip() or DEFAULT_MCP_COMMAND,
        mcp_args=args,
        client_id=os.getenv("MDB_MCP_API_CLIENT_ID", "").strip(),
        client_secret=os.getenv("MDB_MCP_API_CLIENT_SECRET", "").strip(),
        connection_string=os.getenv("MDB_MCP_CONNECTION_STRING", "").strip(),
        read_only=read_only,
        port=int(os.getenv("PORT", "8080")),
        startup_timeout=int(os.getenv("MDB_MCP_STARTUP_TIMEOUT", "180")),
    )
