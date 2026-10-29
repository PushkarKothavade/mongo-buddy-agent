# Mongo Buddy on Amazon Bedrock AgentCore.
# The container must be linux/arm64. Node is included because the official
# MongoDB MCP server is launched with npx, unchanged from the local demo.
FROM --platform=linux/arm64 ghcr.io/astral-sh/uv:python3.14-bookworm-slim

COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
COPY src ./src
RUN uv sync --frozen --no-dev

ENV PORT=8080
EXPOSE 8080
CMD ["uv", "run", "mongo-buddy"]
