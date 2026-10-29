import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  formatRemediationResult,
  formatRemediationTarget,
  remediationCommand,
  remediationIsInProgress,
  remediationStatusLabel,
} from "./remediation.js";

const FACTS = [
  ["Severity", "severity"],
  ["Cluster", "cluster"],
  ["Metric", "metric"],
  ["Current value", "currentValue"],
  ["Project", "projectId"],
];

export function AlertBanner({ alert, more = 0 }) {
  return (
    <div className="alert-banner" role="status" aria-live="assertive">
      <span className="alert-pulse" aria-hidden="true" />
      <div>
        <p className="alert-kicker">New alert detected</p>
        <strong>Mongo Buddy is investigating this alert.</strong>
        <p>{alert.summary || alert.title}</p>
        {more > 0 ? (
          <p className="alert-more">
            {more} more alert{more === 1 ? "" : "s"} also in progress.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function AlertReports({ alerts, onRemediationChange }) {
  if (!alerts.length) return null;
  return (
    <div className="alert-reports">
      {alerts.map((alert) => (
        <article key={alert.id || alert.updatedAt} className={`alert-report status-${alert.status || "processing"}`}>
          <header>
            <div>
              <p className="alert-kicker">{alert.status === "complete" ? "Alert analysis" : "Atlas alert"}</p>
              <h2>{alert.title || "Atlas alert"}</h2>
            </div>
            <span className={`phase phase-${alert.status || "processing"}`}>{statusLabel(alert.status)}</span>
          </header>
          <p className="alert-summary">{alert.summary}</p>
          <AlertFacts alert={alert} />
          {alert.status === "processing" ? (
            <p className="alert-working">Mongo Buddy is examining this alert with read-only MongoDB tools.</p>
          ) : null}
          {alert.status === "error" && !alert.analysis ? (
            <p className="error-banner">{alert.error || "The investigation did not finish."}</p>
          ) : null}
          {alert.analysis ? (
            <div className="step-copy alert-analysis">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{alert.analysis}</ReactMarkdown>
            </div>
          ) : null}
          <RemediationActions
            alertId={alert.id}
            remediations={alert.remediations}
            onRemediationChange={onRemediationChange}
          />
        </article>
      ))}
    </div>
  );
}

function RemediationActions({ alertId, remediations, onRemediationChange }) {
  if (!Array.isArray(remediations) || !remediations.length) return null;
  return (
    <section className="alert-remediations" aria-label="Action items">
      <p className="alert-kicker">Action items for a developer</p>
      <p className="remediation-note">Mongo Buddy does not run these. A developer reviews each command and runs it.</p>
      <div className="remediation-list">
        {remediations.map((item) => (
          <RemediationCard
            key={item.id}
            alertId={alertId}
            remediation={item}
            onRemediationChange={onRemediationChange}
          />
        ))}
      </div>
    </section>
  );
}

function RemediationCard({ remediation }) {
  const [copied, setCopied] = useState(false);
  const status = remediation.status || "proposed";
  const targetFacts = formatRemediationTarget(remediation.target);
  const command = remediationCommand(remediation);
  const inProgress = remediationIsInProgress(status);
  const resultText = formatRemediationResult(remediation.result);

  async function onCopy() {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <article className={`remediation-card status-${status}`}>
      <header>
        <h3>{remediation.label || "Action item"}</h3>
        <span className={`status-pill remediation-status-${status}`}>{remediationStatusLabel(status)}</span>
      </header>
      {remediation.reason ? <p className="remediation-reason">{remediation.reason}</p> : null}
      {remediation.impact ? <p className="remediation-impact"><strong>Impact:</strong> {remediation.impact}</p> : null}
      {targetFacts.length ? (
        <dl className="alert-facts remediation-target">
          {targetFacts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {command ? (
        <div className="remediation-command">
          <p className="step-kicker">Command for the developer</p>
          <pre>{command}</pre>
          <button className="ghost" type="button" onClick={onCopy}>
            {copied ? "Copied" : "Copy command"}
          </button>
        </div>
      ) : null}
      {status === "error" && remediation.error ? (
        <p className="error-banner remediation-error">{remediation.error}</p>
      ) : null}
      {inProgress ? <p className="alert-working">This action was started earlier and is still marked in progress.</p> : null}
      {status === "complete" && resultText ? (
        <div className="remediation-result">
          <p className="step-kicker">Result</p>
          <pre>{resultText}</pre>
        </div>
      ) : null}
    </article>
  );
}

function AlertFacts({ alert }) {
  const facts = FACTS.flatMap(([label, key]) => (alert[key] ? [[label, alert[key]]] : []));
  if (!facts.length) return null;
  return (
    <dl className="alert-facts">
      {facts.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{label === "Metric" ? humanize(value) : value}</dd>
        </div>
      ))}
    </dl>
  );
}

function humanize(value) {
  return String(value)
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusLabel(status) {
  if (status === "complete") return "Analysis ready";
  if (status === "error") return "Needs attention";
  return "Investigating";
}
