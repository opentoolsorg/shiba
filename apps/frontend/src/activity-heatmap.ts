/**
 * Pure helpers for the workspace Activity report's contribution heatmap.
 * The wire array is UTC days oldest-first; these bucket it into Monday-first
 * week columns and place month labels on the column containing each 1st.
 */

export interface HeatmapDay {
  /** YYYY-MM-DD (UTC). */
  date: string;
  count: number;
}

export interface HeatmapColumn {
  /** ISO date of the column's Monday — unique, stable React key. */
  key: string;
  /** Short month name when this column holds the 1st of a month. */
  monthLabel: string | null;
  /** Seven cells Mon..Sun; null = outside the window's day range. */
  days: (HeatmapDay | null)[];
}

export interface HeatmapGrid {
  columns: HeatmapColumn[];
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const toUtcMs = (date: string): number => Date.parse(`${date}T00:00:00Z`);
const toIsoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** Day of week with Monday = 0 … Sunday = 6. */
const mondayFirstDow = (ms: number): number => (new Date(ms).getUTCDay() + 6) % 7;

/**
 * Anchor on the last day's week: the newest column is always the week
 * containing the final entry, so a mid-week ending right-pads with nulls
 * and days older than the window drop off the left edge.
 */
export function bucketContributionWeeks(days: HeatmapDay[], weeks = 52): HeatmapGrid {
  const lastDate = days[days.length - 1]?.date;
  if (lastDate === undefined) {
    return { columns: [] };
  }
  const lastMs = toUtcMs(lastDate);
  if (Number.isNaN(lastMs)) {
    return { columns: [] };
  }
  const lastMonday = lastMs - mondayFirstDow(lastMs) * DAY_MS;
  const start = lastMonday - (weeks - 1) * WEEK_MS;

  const columns: HeatmapColumn[] = [];
  for (let w = 0; w < weeks; w++) {
    columns.push({
      key: toIsoDate(start + w * WEEK_MS),
      monthLabel: null,
      days: Array.from({ length: 7 }, () => null),
    });
  }

  for (const day of days) {
    const ms = toUtcMs(day.date);
    if (Number.isNaN(ms)) continue;
    const col = Math.floor((ms - start) / WEEK_MS);
    const column = columns[col];
    if (column) column.days[mondayFirstDow(ms)] = day;
  }

  // A month label belongs to the column that first contains a day of that
  // month — equivalently, the first column whose Sunday falls in it.
  let previousMonth = -1;
  for (const column of columns) {
    const month = new Date(toUtcMs(column.key) + 6 * DAY_MS).getUTCMonth();
    column.monthLabel = month === previousMonth ? null : (MONTHS[month] ?? null);
    previousMonth = month;
  }
  // Two adjacent labels overlap; the partial first column yields.
  const [first, second] = columns;
  if (first && second?.monthLabel) first.monthLabel = null;

  return { columns };
}

/** Bucket a day count into a 0–4 intensity (quartiles of the window max). */
export function contributionLevel(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  if (count * 4 <= max) return 1;
  if (count * 2 <= max) return 2;
  if (count * 4 <= max * 3) return 3;
  return 4;
}
