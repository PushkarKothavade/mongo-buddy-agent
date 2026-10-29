"""Mongo Buddy — a Strands agent on Amazon Bedrock AgentCore, with a local developer UI."""

from mongo_buddy.agentcore_app import app


def main() -> None:
    from mongo_buddy.config import load_settings

    settings = load_settings()
    print(f"Mongo Buddy agent  http://127.0.0.1:{settings.port}")
    print("Developer UI       http://127.0.0.1:5173  (npm run dev --prefix frontend)")
    print(f"Model              {settings.model_id}  ({settings.region})")
    app.run(port=settings.port, log_level="info")
