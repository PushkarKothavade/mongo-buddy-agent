# Atlas alert webhook

A public Lambda function URL receives a MongoDB Atlas alert, Lambda checks the signature, and the deployed Mongo Buddy AgentCore runtime investigates it. The agent and the MCP server stay private.

```
Atlas  →  Lambda function URL  →  Lambda  →  AgentCore  →  MongoDB MCP
```

Only `alert.open` starts an investigation. `alert.update`, `alert.close`, `alert.acknowledge`, `alert.cancel`, and `alert.inform` return 200 and stop. The HTTP invocation returns 202 after it queues a second, asynchronous invocation of the same function. That second invocation calls `InvokeAgentRuntime` and writes the findings to CloudWatch.

## Deploy

From this directory, with AWS credentials for `ap-south-1`:

```bash
sam build
sam deploy --guided --parameter-overrides "WebhookSecret=$(openssl rand -base64 32)"
```

Save the secret. Atlas needs the same value. The default runtime ARN is the deployed Mongo Buddy runtime; pass `AgentRuntimeArn` to override it.

The template creates:

- Lambda function `mongodb-atlas-alert-webhook` (Python 3.12)
- A public function URL that accepts the Atlas POST
- Permission to invoke the AgentCore runtime and to invoke this function asynchronously
- CloudWatch logging from the basic Lambda execution role

The stack output `WebhookUrl` looks like `https://URL_ID.lambda-url.ap-south-1.on.aws/`.

The template also creates a private S3 bucket, `mongobuddy-atlas-alerts-<account-id>`. When an `alert.open` event arrives, Lambda writes a processing record there, then replaces it with the agent's analysis. The Mongo Buddy console polls that bucket and shows a banner while the investigation is running.

## Atlas

In the Atlas project, open Project Settings → Integrations → Webhook Settings. Paste `WebhookUrl` and the secret from the deploy command. On each alert that should call Mongo Buddy, add Webhook as a notification method.

Atlas signs the raw body with HMAC-SHA1 and sends the Base64 digest in `X-MMS-Signature`. The function rejects any other signature. There is no test-alert button; use an alert threshold you can cross on a non-production cluster.

## What the agent receives

The queued invocation sends the runtime a JSON object with one `prompt` field. That matches `extract_prompt` in the AgentCore app. The prompt includes the alert JSON, tells the agent that `groupId` is the project id, and limits it to read-only diagnostics unless someone approves a change.

Set `MDB_MCP_READ_ONLY=true` on the AgentCore runtime so the MCP server enforces that limit.

## Proposed remediations

The prompt asks the agent to isolate the triggering event, gather related read-only evidence, and propose at most three actions. It ends the answer with a fenced block whose info string is `mongo-buddy-remediations`. The worker removes that block from `analysis`, validates the JSON, and stores the result as `remediations` on `alerts/{alertId}.json`. Missing or invalid JSON stores `[]` and never fails the investigation.

Only two actions are accepted: `create_index` and `kill_operation`. A proposal is dropped when it lacks a database, collection, index keys, or op id and namespace, or when it names a different project or cluster than the alert. Every kept item starts as `status: "proposed"` with `needsApproval: true`. This function never executes one. Execution is a separate, explicit approval in the console server (`POST /api/alerts/:alertId/remediations/:remediationId/approve` with `{"confirm": true}`).

## Logs

Search CloudWatch for the alert id. An accepted webhook logs `Queued investigation`. The worker logs `Mongo Buddy investigation` with the AgentCore status and tool names, then `Mongo Buddy findings` with the model's text. Tool payloads are not written to the log.

For a later production pass, put the accepted event on SQS and record alert ids so repeated `alert.open` deliveries do not start a second investigation.
