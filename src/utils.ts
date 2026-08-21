const DEFAULT_DATE_FORMAT = "MMMM d, yyyy";
const DEFAULT_TIMEZONE = "UTC";
const supportedDateFormat = /^(?:(?:MMMM|MMM|MM|M|dd|d|yyyy|yy)|[\s,./-])+$/;

function getDateParts(date: Date, timezone: string) {
  const numeric = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    numeric
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    day: values.day,
    month: values.month,
    year: values.year,
    longMonth: new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "long" }).format(date),
    shortMonth: new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short" }).format(date),
  };
}

export function formatDate(
  date: Date,
  dateFormat = DEFAULT_DATE_FORMAT,
  timezone = DEFAULT_TIMEZONE,
): string {
  const format = supportedDateFormat.test(dateFormat)
    ? dateFormat
    : DEFAULT_DATE_FORMAT;

  let parts: ReturnType<typeof getDateParts>;
  try {
    parts = getDateParts(date, timezone);
  } catch {
    parts = getDateParts(date, DEFAULT_TIMEZONE);
  }

  return format.replace(/MMMM|MMM|MM|M|dd|d|yyyy|yy/g, (token) => {
    switch (token) {
      case "MMMM": return parts.longMonth;
      case "MMM": return parts.shortMonth;
      case "MM": return parts.month;
      case "M": return String(Number(parts.month));
      case "dd": return parts.day;
      case "d": return String(Number(parts.day));
      case "yyyy": return parts.year;
      case "yy": return parts.year.slice(-2);
      default: return token;
    }
  });
}

export function readingTime(content: string): string {
  const words = content.trim().split(/\s+/).length;
  const minutes = Math.ceil(words / 200);
  return `${minutes} min read`;
}
