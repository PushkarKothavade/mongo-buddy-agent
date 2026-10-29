import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertReports } from "./alerts.jsx";
import { cleanMcpPayload, databaseItems, inferView, namedRecords, summarizeArgs } from "./clean.js";

const INTENT_LABEL = {
  databases: "Databases",
  collections: "Collections",
  explain: "Slow query analysis",
  metrics: "Metrics",
  rca: "Root cause",
  general: "Mongo Buddy",
};

export function OutputStage({ turns, active, status, alerts = [], onRemediationChange }) {
  if (!turns.length && !active && !alerts.length) {
    return (
      <section className="stage empty" aria-label="MCP output">
        <div className="stage-chrome">
          <span className="dot green" />
          <span className="dot orange" />
          <span className="dot blue" />
          <p>MCP response</p>
        </div>
        <div className="empty-copy">
          <LeafMark />
          <h2>Ask about the cluster. The MCP response lands here.</h2>
          <p>
            Databases, collection stats, explain plans, and root-cause evidence show up as cards
            from the MongoDB MCP server — the same tools, with a booth-ready readout.
          </p>
          {status?.error ? <p className="error-banner">{status.error}</p> : null}
        </div>
      </section>
    );
  }

  return (
    <section className="stage" aria-live="polite" aria-label="Agent activity">
      <div className="stage-chrome">
        <span className="dot green" />
        <span className="dot orange" />
        <span className="dot blue" />
        <p>Agent activity</p>
        {active ? <span className="live">{phaseLabel(turns.at(-1))}</span> : null}
      </div>
      <div className="turns">
        <AlertReports alerts={alerts} onRemediationChange={onRemediationChange} />
        {turns.map((turn, index) => (
          <TurnTimeline key={turn.id} turn={turn} live={active && index === turns.length - 1} />
        ))}
      </div>
    </section>
  );
}

function TurnTimeline({ turn, live }) {
  const steps = turn.steps || [];
  const showDraft = live && turn.draft;
  const waiting = live && !turn.draft && !steps.some((step) => step.kind === "tool" && step.status === "running");
  return (
    <article className="turn">
      <header className="turn-head">
        <div>
          <p className="eyebrow">{INTENT_LABEL[turn.intent] || "Mongo Buddy"}</p>
          <h2>{turn.prompt}</h2>
        </div>
        <span className={`phase phase-${turn.phase || "thinking"}`}>{phaseLabel(turn)}</span>
      </header>
      <ol className="timeline">
        <li className="step question">
          <span className="step-mark" aria-hidden="true" />
          <div className="step-body">
            <p className="step-kicker">Question</p>
            <p className="step-text">{turn.prompt}</p>
          </div>
        </li>
        {steps.map((step) =>
          step.kind === "tool" ? (
            <ToolStep key={step.id} tool={step} />
          ) : (
            <NarrativeStep key={step.id} step={step} />
          ),
        )}
        {turn.thinking ? <NarrativeStep step={{ kind: "thinking", text: turn.thinking }} live /> : null}
        {showDraft ? <NarrativeStep step={{ kind: steps.some((item) => item.kind === "tool") ? "answer" : "thought", text: turn.draft }} live /> : null}
        {waiting && !turn.thinking ? (
          <NarrativeStep step={{ kind: "thinking", text: "" }} live placeholder={turn.statusNote || "The model is thinking…"} />
        ) : null}
      </ol>
      {turn.error ? <p className="error-banner">{turn.error}</p> : null}
    </article>
  );
}

function NarrativeStep({ step, live = false, placeholder = "" }) {
  const answer = step.kind === "answer";
  const thinking = step.kind === "thinking";
  const kind = answer ? "answer" : thinking ? "thinking" : "thought";
  return (
    <li className={`step ${kind}${live ? " live-step" : ""}`}>
      <span className="step-mark" aria-hidden="true" />
      <div className="step-body">
        <p className="step-kicker">{answer ? "Answer" : thinking ? "Thinking" : "Reasoning"}</p>
        {step.text ? (
          <div className="step-copy">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{step.text}</ReactMarkdown>
          </div>
        ) : (
          <p className="step-text muted">{placeholder}</p>
        )}
      </div>
    </li>
  );
}

function phaseLabel(turn) {
  if (!turn) return "Working";
  if (turn.error) return "Needs attention";
  if (turn.phase === "done") return "Complete";
  if (turn.phase === "connecting") return "Connecting";
  if (turn.phase === "calling") return "Using a tool";
  if (turn.phase === "writing") return "Writing the answer";
  return "Thinking";
}

function ToolStep({ tool }) {
  const running = tool.status === "running";
  const output = cleanMcpPayload(tool.output);
  const view = inferView(tool.name, tool.view, output);
  const args = summarizeArgs(tool.input);
  return (
    <li className={`step tool view-${view}${running ? " live-step" : ""}`}>
      <span className="step-mark" aria-hidden="true" />
      <div className="step-body tool-card">
        <header>
          <div>
            <p className="step-kicker">Tool</p>
            <h3>{running ? `Calling ${titleCase(tool.name)}` : `Called ${titleCase(tool.name)}`}</h3>
            {args ? <p className="arg-line">{args}</p> : <p className="arg-line">No arguments</p>}
          </div>
          <div className="tool-meta">
            <span className={`status-pill ${tool.status || "running"}`}>
              {running ? "Running" : tool.status === "error" ? "Error" : "Returned"}
            </span>
            {tool.durationMs ? <span>{tool.durationMs} ms</span> : null}
          </div>
        </header>
        {running ? <div className="skeleton short" /> : <ToolBody view={view} output={output} />}
      </div>
    </li>
  );
}

function ToolBody({ view, output }) {
  if (output == null || output === "") return <p className="step-text muted">No data returned.</p>;
  if (view === "explain") return <ExplainView output={output} />;
  if (view === "databases") return <DatabaseView output={output} />;
  if (view === "collections" || view === "indexes" || view === "named-list" || view === "schema") {
    return <NamedView output={output} empty="The tool returned no named items." />;
  }
  if (view === "metrics") return <MetricsView output={output} />;
  if (view === "advisor") return <AdvisorView output={output} />;
  return <SummaryView value={output} />;
}

function SummaryView({ value }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const preview = typeof value === "string" ? value : summarizeObject(value);
  return (
    <div className="summary-view">
      <p className="step-text">{preview}</p>
      <details className="raw">
        <summary>Raw response</summary>
        <pre>{text}</pre>
      </details>
    </div>
  );
}

function summarizeObject(value) {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"} returned.`;
  if (!value || typeof value !== "object") return String(value ?? "");
  const keys = Object.keys(value);
  if (!keys.length) return "Empty result.";
  return keys
    .slice(0, 6)
    .map((key) => `${key}: ${shortValue(value[key])}`)
    .join(" · ");
}

function shortValue(value) {
  if (Array.isArray(value)) return `${value.length} items`;
  if (value && typeof value === "object") return "object";
  const text = String(value);
  return text.length > 48 ? `${text.slice(0, 45)}…` : text;
}

function ExplainView({ output }) {
  const summary = summarizeExplain(output);
  if (!summary) return <SummaryView value={output} />;
  const scan = summary.stage === "COLLSCAN";
  const indexed = summary.stage === "IXSCAN" || summary.stages.includes("IXSCAN");
  return (
    <div className="explain">
      <div className={`stage-badge ${scan ? "bad" : indexed ? "good" : ""}`}>
        <span>Winning stage</span>
        <strong>{summary.stage || "Plan"}</strong>
      </div>
      <div className="stat-grid">
        <Stat label="Time" value={summary.executionTimeMillis != null ? `${summary.executionTimeMillis} ms` : "—"} />
        <Stat label="Docs examined" value={formatNumber(summary.totalDocsExamined)} />
        <Stat label="Docs returned" value={formatNumber(summary.nReturned)} />
        <Stat label="Keys examined" value={formatNumber(summary.totalKeysExamined)} />
      </div>
      <dl className="explain-meta">
        {summary.namespace ? (
          <div>
            <dt>Namespace</dt>
            <dd>{summary.namespace}</dd>
          </div>
        ) : null}
        {summary.indexName ? (
          <div>
            <dt>Index</dt>
            <dd>{summary.indexName}</dd>
          </div>
        ) : null}
        {summary.ratio != null ? (
          <div>
            <dt>Returned / examined</dt>
            <dd>{summary.ratio}</dd>
          </div>
        ) : null}
      </dl>
      <details className="raw">
        <summary>Explain document</summary>
        <pre>{JSON.stringify(output, null, 2)}</pre>
      </details>
    </div>
  );
}

function DatabaseView({ output }) {
  const { notes, items } = databaseItems(output);
  if (!items.length) return <SummaryView value={output} />;
  return (
    <div>
      {notes.map((note) => (
        <p key={note} className="step-text">{note}</p>
      ))}
      <div className="db-grid">
        {items.map((item) => (
          <article key={item.name} className="db-card">
            <span className="db-leaf" />
            <h4>{item.name}</h4>
            <p>{item.sizeOnDisk != null ? formatBytes(item.sizeOnDisk) : item.empty ? "Empty" : "Database"}</p>
          </article>
        ))}
      </div>
      <RawDisclosure value={output} />
    </div>
  );
}

function NamedView({ output }) {
  const { notes, items } = namedRecords(output);
  if (!items.length) return <SummaryView value={output} />;
  return (
    <div>
      {notes.map((note) => (
        <p key={note} className="step-text">{note}</p>
      ))}
      <ul className="named-list">
        {items.map((item) => (
          <li key={`${item.name}-${item.detail}`}>
            <strong>{item.name}</strong>
            {item.detail ? <span>{item.detail}</span> : null}
          </li>
        ))}
      </ul>
      <RawDisclosure value={output} />
    </div>
  );
}

function RawDisclosure({ value }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return null;
  return (
    <details className="raw">
      <summary>Raw response</summary>
      <pre>{text}</pre>
    </details>
  );
}

function MetricsView({ output }) {
  const items = metricItems(output);
  if (!items.length) return <SummaryView value={output} />;
  return (
    <div className="stat-grid">
      {items.map((item) => (
        <Stat key={item.label} label={item.label} value={formatMetric(item.label, item.value)} />
      ))}
    </div>
  );
}

function AdvisorView({ output }) {
  const items = advisorItems(output);
  if (!items.length) return <SummaryView value={output} />;
  return (
    <div className="advisor-list">
      {items.map((item, index) => (
        <article key={index} className="advisor-card">
          <p className="eyebrow">Recommendation</p>
          <pre>{typeof item === "string" ? item : JSON.stringify(item, null, 2)}</pre>
        </article>
      ))}
    </div>
  );
}

function TextView({ text }) {
  return <pre className="text-out">{text}</pre>;
}

function JsonView({ value }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="json-wrap">
      <button type="button" onClick={() => navigator.clipboard.writeText(text)}>
        Copy
      </button>
      <pre>{text}</pre>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function LeafMark() {
  return (
    <svg className="empty-leaf" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#00ED64"
        d="M17.193 9.555c-1.264-5.58-4.252-7.414-4.573-8.115-.28-.394-.53-.954-.735-1.44-.036.495-.055.685-.523 1.184-.723.566-4.438 3.682-4.74 10.02-.282 5.912 4.27 9.435 4.888 9.884l.07.05A73.49 73.49 0 0111.91 24h.481c.114-1.032.284-2.056.51-3.07.417-.296.604-.463.85-.693a11.342 11.342 0 003.639-8.464c.01-.814-.103-1.662-.197-2.218zm-5.336 8.195s0-8.291.275-8.29c.213 0 .49 10.695.49 10.695-.381-.045-.765-1.76-.765-2.405z"
      />
    </svg>
  );
}

function titleCase(name) {
  return String(name || "tool")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatNumber(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return new Intl.NumberFormat("en-IN").format(value);
}

function formatBytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size)) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  let current = size;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  const digits = current >= 10 || index === 0 ? 0 : 1;
  return `${current.toFixed(digits)} ${units[index]}`;
}

function formatMetric(label, value) {
  if (/size|byte|storage/i.test(label)) return formatBytes(value);
  return formatNumber(value);
}

function summarizeExplain(output) {
  const plan = findExplain(output);
  if (!plan) return null;
  const stats = isObject(plan.executionStats) ? plan.executionStats : {};
  const planner = isObject(plan.queryPlanner) ? plan.queryPlanner : {};
  const winning = isObject(planner.winningPlan) ? planner.winningPlan : {};
  const stages = collectStages(winning);
  const executionStages = collectStages(stats.executionStages);
  const allStages = stages.length ? stages : executionStages;
  const examined = firstNumber(stats, "totalDocsExamined", "docsExamined");
  const returned = firstNumber(stats, "nReturned");
  return {
    namespace: planner.namespace || plan.namespace || "",
    stage: allStages[0] || "",
    stages: allStages,
    indexName: findKey(winning, "indexName") || "",
    executionTimeMillis: firstNumber(stats, "executionTimeMillis"),
    totalDocsExamined: examined,
    totalKeysExamined: firstNumber(stats, "totalKeysExamined"),
    nReturned: returned,
    ratio: examined ? Math.round((returned / examined) * 10000) / 10000 : null,
  };
}

function findExplain(value, depth = 0) {
  if (depth > 6 || !isObject(value)) return null;
  if ("executionStats" in value || "queryPlanner" in value) return value;
  for (const child of Object.values(value)) {
    if (isObject(child)) {
      const found = findExplain(child, depth + 1);
      if (found) return found;
    } else if (Array.isArray(child)) {
      for (const item of child) {
        const found = findExplain(item, depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

function collectStages(plan, found = []) {
  if (!isObject(plan)) return found;
  if (typeof plan.stage === "string") found.push(plan.stage);
  for (const key of ["inputStage", "thenStage"]) collectStages(plan[key], found);
  for (const key of ["inputStages", "shards"]) {
    if (Array.isArray(plan[key])) plan[key].forEach((child) => collectStages(child, found));
  }
  return found;
}

function findKey(value, key, depth = 0) {
  if (depth > 6) return null;
  if (isObject(value)) {
    if (value[key]) return value[key];
    for (const child of Object.values(value)) {
      const found = findKey(child, key, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function firstNumber(source, ...keys) {
  for (const key of keys) {
    if (typeof source[key] === "number") return source[key];
  }
  return null;
}

function metricItems(output) {
  if (!isObject(output)) return [];
  return Object.entries(output)
    .filter(([, value]) => typeof value === "number")
    .slice(0, 8)
    .map(([key, value]) => ({ label: key.replaceAll("_", " ").replaceAll("-", " "), value }));
}

function advisorItems(output) {
  if (Array.isArray(output)) return output;
  if (!isObject(output)) return [];
  for (const key of ["suggestedIndexes", "recommendations", "shapes", "indexes"]) {
    if (Array.isArray(output[key])) return output[key];
  }
  return [output];
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
