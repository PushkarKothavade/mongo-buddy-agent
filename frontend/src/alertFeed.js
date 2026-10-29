export function alertKey(alert) {
  if (alert?.id) return String(alert.id);
  return [alert?.title, alert?.detectedAt, alert?.updatedAt].filter(Boolean).join("|");
}

export function visibleAlerts(alerts, dismissed) {
  return alerts.filter((alert) => !dismissed.has(alertKey(alert)));
}
