# Mongo Buddy

Mongo Buddy is a developer companion for MongoDB. A [Strands Agents](https://strandsagents.com/) agent calls the official MongoDB MCP server, and a React console shows the MCP response: databases, slow-query explain plans, metrics, and root-cause evidence. The same Python app is the Amazon Bedrock AgentCore entrypoint.

The demo is aimed at [AWS Community Day Mumbai](https://acd.awsugmum.in/).

## Run it locally

Requirements: Python 3.14, [uv](https://docs.astral.sh/uv/), Node.js, and AWS credentials that can call Amazon Bedrock in `ap-south-1`.

```bash
cp .env.example .env
# Fill in MDB_MCP_API_CLIENT_ID and MDB_MCP_API_CLIENT_SECRET.
# Add this laptop's public IP to that service account's Atlas API access list.
# Atlas returns 403 IP_ADDRESS_NOT_ON_ACCESS_LIST until the current address is listed.

chmod +x scripts/dev.sh
./scripts/dev.sh
```

Open http://127.0.0.1:5173. The agent listens on http://127.0.0.1:8080 (`POST /invocations`, `GET /ping`).

The MCP process is the official remote server, started as:

```bash
npx -y mongodb-atlas-mcp-remote@latest
```

Credentials are passed through `MDB_MCP_API_CLIENT_ID` and `MDB_MCP_API_CLIENT_SECRET`. A `MDB_MCP_CONNECTION_STRING` is optional if you would rather connect as a database user.

Try the chips in the ask panel: list databases, inspect `aws_summit.customers`, explain a city/age query, read storage metrics, or ask for a root cause.

## Deploy to AgentCore

The runtime entrypoint is `src/mongo_buddy/agentcore_app.py`. It exposes the required `POST /invocations` and `GET /ping` routes via `BedrockAgentCoreApp`. An async entrypoint streams tool calls and the answer as server-sent events.

Build the ARM64 image and push it to ECR in `ap-south-1`, then create a runtime. Set the same environment variables as `.env` on the runtime, including the Atlas service account, and allow the runtime's egress IP in the Atlas API access list.

```bash
docker build --platform linux/arm64 -t mongo-buddy .
# tag, push to ECR, then:
agentcore configure -e src/mongo_buddy/agentcore_app.py --name mongo_buddy --region ap-south-1
agentcore launch
```

The model id defaults to `in.anthropic.claude-opus-5` in `ap-south-1`. Override `MODEL_ID` if that inference profile is not enabled on the account. `apac.amazon.nova-pro-v1:0` is a working fallback.

## Atlas alert webhook

Atlas can POST an alert to the Lambda function URL. Lambda checks the `X-MMS-Signature` HMAC, ignores every event except `alert.open`, and invokes the AgentCore runtime that is already deployed. The agent receives `{"prompt": "..."}`, the same payload the developer UI sends, and investigates with the MongoDB MCP server.

The HTTP handler returns 202 as soon as the investigation is queued. A second invocation of the same function calls AgentCore, so a long diagnosis does not expire the Atlas webhook. The console shows "New alert detected" while that investigation runs, then the developer-facing analysis.

```bash
cd webhook
sam build
sam deploy --guided --parameter-overrides "WebhookSecret=$(openssl rand -base64 32)"
```

Use the printed URL and the same secret in Atlas: Project Settings → Integrations → Webhook Settings. Then add Webhook as a notification on the alerts that should wake Mongo Buddy. The inline policy in `webhook/iam-policy.json` is the same permission the template attaches: `bedrock-agentcore:InvokeAgentRuntime` on the Mongo Buddy runtime.

Keep the AgentCore runtime's MCP credentials read-only. The investigation prompt asks for diagnostics and recommendations, and it will not treat an alert as approval to change the cluster.

## Tests

```bash
uv run --with pytest pytest
```
