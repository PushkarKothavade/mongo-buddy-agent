import { useEffect, useRef, useState } from "react";
import { alertKey, visibleAlerts } from "./alertFeed.js";
import { mergeApproveResponse } from "./remediation.js";
import { fetchAlerts, fetchStatus, resetSession, streamQuery } from "./api.js";
import { AlertBanner } from "./alerts.jsx";
import { AwsMark, MongoMark } from "./logos.jsx";
import { OutputStage } from "./output.jsx";

const SUGGESTIONS = [
  {
    label: "List databases",
    intent: "databases",
    prompt: "List every database on this Atlas project and include the size when the MCP server returns it.",
  },
  {
    label: "Inspect customers",
    intent: "collections",
    prompt:
      "In the aws_summit database, list collections, describe the customers schema, and show the indexes.",
  },
  {
    label: "Slow query",
    intent: "explain",
    prompt:
      "This query is slow on aws_summit.customers: find documents where city is Mumbai and age is greater than 40. Explain it with execution stats and recommend an index.",
  },
  {
    label: "Metrics",
    intent: "metrics",
    prompt: "Summarize document count and storage size for aws_summit.customers. Call out anything that looks unhealthy.",
  },
  {
    label: "Root cause",
    intent: "rca",
    prompt:
      "Lookups on aws_summit.customers by city feel slow. Do a root-cause analysis from indexes and explain, then give the specific fix.",
  },
];

export default function App() {
  const [status, setStatus] = useState({ state: "starting", tools: [], toolCount: 0 });
  const [prompt, setPrompt] = useState(SUGGESTIONS[0].prompt);
  const [turns, setTurns] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [running, setRunning] = useState(false);
  const scroller = useRef(null);
  const abortRef = useRef(null);
  const dismissedAlertIds = useRef(new Set());

  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const next = await fetchStatus();
        if (!stop) setStatus(next);
        if (next.state === "starting") {
          window.setTimeout(poll, 1200);
        }
      } catch (error) {
        if (!stop) setStatus({ state: "error", error: error.message, tools: [], toolCount: 0 });
      }
    }
    poll();
    return () => {
      stop = true;
    };
  }, []);

  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const next = await fetchAlerts();
        if (!stop) setAlerts(visibleAlerts(next, dismissedAlertIds.current));
      } catch {
        // Keep the last snapshot if the status feed is briefly unavailable.
      }
      if (!stop) window.setTimeout(poll, 2500);
    }
    poll();
    return () => {
      stop = true;
    };
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [turns, alerts]);

  async function ask(text) {
    const query = (text ?? prompt).trim();
    if (!query || running) return;
    setPrompt(query);
    const id = crypto.randomUUID();
    setTurns((current) => [
      ...current,
      { id, prompt: query, intent: "general", steps: [], draft: "", phase: "thinking", error: "" },
    ]);
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamQuery(query, (event) => applyEvent(id, event), controller.signal);
    } catch (error) {
      if (error.name !== "AbortError") {
        applyEvent(id, { type: "error", message: error.message });
      }
    } finally {
      setRunning(false);
    }
  }

  function applyEvent(id, event) {
    setTurns((current) => current.map((turn) => (turn.id === id ? reduceTurn(turn, event) : turn)));
  }

  function handleRemediationChange(alertId, payload) {
    setAlerts((current) => visibleAlerts(mergeApproveResponse(current, alertId, payload), dismissedAlertIds.current));
  }

  async function newSession() {
    abortRef.current?.abort();
    for (const alert of alerts) dismissedAlertIds.current.add(alertKey(alert));
    setAlerts([]);
    setTurns([]);
    setRunning(false);
    await resetSession();
  }

  const connected = status.state === "ready";
  const processing = alerts.filter((alert) => alert.status === "processing");

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <MongoMark />
          <div>
            <p className="product">Mongo Buddy</p>
            <p className="tag">Developer Companion for MongoDB</p>
          </div>
        </div>
        <div className="event">
          <span>AWS Community Day</span>
          <strong>Mumbai - 2026</strong>
        </div>
        <div className="aws-lockup">
          <AwsMark />
          <div>
            <p>Strands Agents</p>
            <p>Bedrock AgentCore</p>
          </div>
        </div>
      </header>

      {processing.length ? <AlertBanner alert={processing[0]} more={processing.length - 1} /> : null}

      <main>
        <section className="ask">
          <div className="status-row">
            <span className={`lamp ${status.state}`} />
            <p>
              {status.state === "ready" &&
                (status.backend === "agentcore"
                  ? "Amazon Bedrock AgentCore · ap-south-1"
                  : `MongoDB MCP · ${status.toolCount} tools`)}
              {status.state === "starting" && "Connecting to MongoDB MCP…"}
              {status.state === "error" && "MongoDB MCP needs attention"}
            </p>
          </div>
          {status.error ? <p className="error-banner">{status.error}</p> : null}
          <label htmlFor="query">Ask Mongo Buddy</label>
          <textarea
            id="query"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") ask();
            }}
            placeholder="List databases, explain a slow query, or ask for a root cause."
          />
          <div className="suggestions">
            {SUGGESTIONS.map((item) => (
              <button key={item.label} type="button" onClick={() => ask(item.prompt)} disabled={running}>
                {item.label}
              </button>
            ))}
          </div>
          <div className="ask-actions">
            <button className="primary" type="button" onClick={() => ask()} disabled={running || !prompt.trim()}>
              {running ? "Working…" : "Run query"}
            </button>
            <button className="ghost" type="button" onClick={newSession}>
              New session
            </button>
          </div>
          <p className="hint">⌘ Enter runs the query. The timeline shows reasoning, each tool call, and the answer.</p>
          {connected ? (
            <div className="tool-cloud" aria-label="MCP tools">
              {status.tools.slice(0, 12).map((tool) => (
                <span key={tool}>{tool}</span>
              ))}
              {status.toolCount > 12 ? <span>+{status.toolCount - 12}</span> : null}
            </div>
          ) : null}
          <p className="model-line">
            {status.modelId || "Bedrock"} · {status.region || "ap-south-1"}
          </p>
        </section>
        <div className="stage-wrap" ref={scroller}>
          <OutputStage
            turns={turns}
            active={running}
            status={status}
            alerts={alerts}
            onRemediationChange={handleRemediationChange}
          />
        </div>
      </main>
    </div>
  );
}

function reduceTurn(turn, event) {
  const steps = turn.steps || [];
  if (event.type === "turn") return { ...turn, steps, intent: event.intent || turn.intent };
  if (event.type === "phase") {
    return { ...turn, steps, phase: event.phase || turn.phase, statusNote: event.message || turn.statusNote };
  }
  if (event.type === "thinking") {
    return { ...turn, steps, thinking: `${turn.thinking || ""}${event.text || ""}`, phase: "thinking" };
  }
  if (event.type === "token") {
    const committed = commitThinking(turn);
    const draft = `${committed.draft || ""}${event.text || ""}`;
    const phase = committed.steps.some((step) => step.kind === "tool") ? "writing" : "thinking";
    return { ...committed, draft, phase };
  }
  if (event.type === "tool_call" || event.type === "tool_result") return applyTool(turn, event);
  if (event.type === "done") return finishTurn(turn);
  if (event.type === "error" || event.error) {
    return { ...finishTurn(turn), phase: "done", error: event.message || event.error };
  }
  return turn;
}

function commitThinking(turn) {
  const thinking = turn.thinking || "";
  if (!thinking.trim()) return { ...turn, steps: turn.steps || [] };
  const steps = turn.steps || [];
  return {
    ...turn,
    thinking: "",
    steps: [...steps, { kind: "thinking", id: `think-${steps.length}`, text: thinking }],
  };
}

function applyTool(turn, event) {
  const committed = commitThinking(turn);
  const id = event.id || event.name || "tool";
  let steps = committed.steps || [];
  const index = steps.findIndex((step) => step.kind === "tool" && step.id === id);
  let draft = committed.draft || "";
  if (index === -1 && draft.trim()) {
    steps = [...steps, { kind: "thought", id: `${id}-thought-${steps.length}`, text: draft }];
    draft = "";
  }
  const prior = index === -1 ? null : steps[index];
  const status = event.type === "tool_result" ? event.status || "success" : prior?.status === "success" || prior?.status === "error" ? prior.status : "running";
  const tool = {
    kind: "tool",
    id,
    name: event.name || prior?.name || "tool",
    input: event.type === "tool_call" ? event.input ?? prior?.input ?? {} : prior?.input ?? event.input ?? {},
    status,
    output: event.type === "tool_result" ? event.output : prior?.output,
    view: event.view || prior?.view || "json",
    durationMs: event.durationMs || prior?.durationMs || 0,
  };
  if (index === -1) steps = [...steps, tool];
  else {
    steps = steps.slice();
    steps[index] = { ...prior, ...tool };
  }
  return { ...committed, steps, draft, phase: status === "running" ? "calling" : "thinking" };
}

function finishTurn(turn) {
  const committed = commitThinking(turn);
  const draft = committed.draft || "";
  const steps = committed.steps || [];
  if (!draft.trim()) return { ...committed, steps, draft: "", phase: "done" };
  return {
    ...committed,
    draft: "",
    phase: "done",
    steps: [...steps, { kind: "answer", id: `${turn.id}-answer`, text: draft }],
  };
}

