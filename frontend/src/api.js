let sessionId = crypto.randomUUID();

export function rotateSession() {
  sessionId = crypto.randomUUID();
  return sessionId;
}

function sessionHeaders() {
  return { "x-runtime-session-id": sessionId };
}

export async function fetchAlerts() {
  const response = await fetch("/api/alerts");
  if (!response.ok) return [];
  const body = await response.json();
  return Array.isArray(body.alerts) ? body.alerts : [];
}

export async function approveRemediation(alertId, remediationId) {
  const response = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/remediations/${encodeURIComponent(remediationId)}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  });
  if (!response.ok) {
    const raw = await response.text();
    let detail = raw;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.error === "string") detail = parsed.error;
    } catch {
      // Keep raw text.
    }
    throw new Error(detail || `Approve failed (${response.status})`);
  }
  return response.json().catch(() => ({}));
}

export async function fetchStatus() {
  const response = await fetch("/api/status");
  if (!response.ok) {
    throw new Error(`Status check failed (${response.status})`);
  }
  return response.json();
}

export async function resetSession() {
  rotateSession();
  await fetch("/api/reset", { method: "POST", headers: sessionHeaders() });
}

export async function streamQuery(prompt, onEvent, signal) {
  const response = await fetch("/invocations", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...sessionHeaders() },
    body: JSON.stringify({ prompt }),
    signal,
  });
  if (!response.ok || !response.body) {
    const detail = await response.text();
    throw new Error(detail || `Request failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame
        .split("\n")
        .map((item) => item.trim())
        .find((item) => item.startsWith("data:"));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      onEvent(JSON.parse(payload));
    }
  }
}
