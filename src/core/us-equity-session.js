const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});

export function usEquitySession(date = new Date()) {
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  const weekday = parts.weekday;
  const minuteOfDay = Number(parts.hour) * 60 + Number(parts.minute);
  const businessDay = !["Sat", "Sun"].includes(weekday);
  const regular = businessDay && minuteOfDay >= 9 * 60 + 30 && minuteOfDay < 16 * 60;
  const extended = businessDay && (
    (minuteOfDay >= 4 * 60 && minuteOfDay < 9 * 60 + 30)
    || (minuteOfDay >= 16 * 60 && minuteOfDay < 20 * 60)
  );
  const mode = regular ? "regular" : extended ? "extended" : "closed";
  return { mode, weekday, minuteOfDay, timeZone: "America/New_York" };
}
