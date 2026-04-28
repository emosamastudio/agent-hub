const relativeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

export function formatAbsoluteTime(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Unknown time";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatRelativeTime(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  const deltaMs = date.getTime() - Date.now();
  const deltaMinutes = Math.round(deltaMs / 60_000);

  if (Math.abs(deltaMinutes) < 60) {
    return relativeFormatter.format(deltaMinutes, "minute");
  }

  const deltaHours = Math.round(deltaMinutes / 60);

  if (Math.abs(deltaHours) < 24) {
    return relativeFormatter.format(deltaHours, "hour");
  }

  const deltaDays = Math.round(deltaHours / 24);
  return relativeFormatter.format(deltaDays, "day");
}
