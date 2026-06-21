import { useEffect, useMemo, useState } from "react";

type AttributeKey =
  | "domestic_gross"
  | "budget"
  | "letterboxd_ratings"
  | "letterboxd_avg";

type MovieRow = {
  title: string;
  rank: number | null;
  domestic_gross: number | null;
  budget: number | null;
  letterboxd_ratings: number | null;
  letterboxd_avg: number | null;
  letterboxd_slug: string | null;
};

type MoviePoint = MovieRow & {
  percentiles: Partial<Record<AttributeKey, number>>;
};

type ChartPair = {
  x: AttributeKey;
  y: AttributeKey;
};

type ScoreCoefficients = {
  a: number;
  b: number;
  c: number;
  d: number;
};

const DATA_URL = "/movie_charts/2025/movie_2025_data.csv";

const ATTRIBUTES: Record<
  AttributeKey,
  { label: string; short: string; log: boolean; kind: "money" | "count" | "rating" }
> = {
  domestic_gross: {
    label: "Domestic gross",
    short: "Gross",
    log: true,
    kind: "money",
  },
  budget: {
    label: "Production budget",
    short: "Budget",
    log: true,
    kind: "money",
  },
  letterboxd_ratings: {
    label: "Letterboxd ratings",
    short: "LB ratings",
    log: true,
    kind: "count",
  },
  letterboxd_avg: {
    label: "Letterboxd average",
    short: "LB avg",
    log: false,
    kind: "rating",
  },
};

const STAT_ORDER: AttributeKey[] = [
  "domestic_gross",
  "budget",
  "letterboxd_ratings",
  "letterboxd_avg",
];

const PAIRS: ChartPair[] = [
  { x: "budget", y: "domestic_gross" },
  { x: "budget", y: "letterboxd_ratings" },
  { x: "budget", y: "letterboxd_avg" },
  { x: "domestic_gross", y: "letterboxd_ratings" },
  { x: "domestic_gross", y: "letterboxd_avg" },
  { x: "letterboxd_ratings", y: "letterboxd_avg" },
];

const WIDTH = 960;
const HEIGHT = 560;
const PADDING = { top: 36, right: 34, bottom: 72, left: 92 };
const SCORE_NEUTRAL = "#d8b38a";
const SCORE_GREEN = "#58c978";
const SCORE_RED = "#f05d63";
const SCORE_COEFFICIENTS: Record<string, ScoreCoefficients> = {
  "budget/domestic_gross": { a: -2.705, b: 0.104, c: -1.556, d: 4.601 },
  "budget/letterboxd_ratings": { a: 0, b: 0, c: 0, d: 0 },
  "budget/letterboxd_avg": { a: -0.755, b: -0.602, c: 0.345, d: 2.21 },
  "domestic_gross/letterboxd_ratings": { a: 0, b: 0, c: 0, d: 0 },
  "domestic_gross/letterboxd_avg": { a: 0.396, b: -2.154, c: 0.267, d: 2 },
  "letterboxd_ratings/letterboxd_avg": { a: 15.454, b: -45.313, c: 29.483, d: 2.331 },
};

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current);
  return cells;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  const headers = parseCsvLine(lines[0] ?? "");

  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
}

function numberCell(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function textCell(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function computePercentiles(rows: MovieRow[]): MoviePoint[] {
  const valuesByAttribute = Object.fromEntries(
    STAT_ORDER.map((key) => [
      key,
      rows
        .map((row) => row[key])
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
        .sort((a, b) => a - b),
    ]),
  ) as Record<AttributeKey, number[]>;

  return rows.map((row) => {
    const percentiles: Partial<Record<AttributeKey, number>> = {};

    for (const key of STAT_ORDER) {
      const value = row[key];
      const values = valuesByAttribute[key];

      if (typeof value === "number" && values.length > 0) {
        const lessOrEqual = values.filter((candidate) => candidate <= value).length;
        percentiles[key] = (100 * (lessOrEqual - 0.5)) / values.length;
      }
    }

    return { ...row, percentiles };
  });
}

function formatValue(key: AttributeKey, value: number | null): string {
  if (value === null) {
    return "Not available";
  }

  const attr = ATTRIBUTES[key];

  if (attr.kind === "money") {
    if (value >= 1_000_000) {
      return `$${(value / 1_000_000).toFixed(value >= 100_000_000 ? 0 : 1)}M`;
    }

    return `$${Math.round(value).toLocaleString()}`;
  }

  if (attr.kind === "count") {
    if (value >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(2)}M`;
    }

    return Math.round(value).toLocaleString();
  }

  return value.toFixed(2);
}

function formatPercentile(value: number | undefined): string {
  return typeof value === "number" ? `${value.toFixed(1)} plotted percentile` : "No percentile";
}

function getLetterboxdUrl(movie: MoviePoint): string | null {
  if (!movie.letterboxd_slug) {
    return null;
  }

  const slug = movie.letterboxd_slug.replace(/^\/+|\/+$/g, "");
  return `https://letterboxd.com/${slug}/`;
}

function transform(value: number, key: AttributeKey): number {
  return ATTRIBUTES[key].log ? Math.log10(value) : value;
}

function clampScore(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function pairKey(pair: ChartPair): string {
  return `${pair.x}/${pair.y}`;
}

function scoreDomain(values: number[], key: AttributeKey) {
  const transformed = values.map((value) => transform(value, key));
  const min = Math.min(...transformed);
  const max = Math.max(...transformed);
  const span = max - min || 1;

  return {
    normalize(value: number) {
      return (transform(value, key) - min) / span;
    },
  };
}

function scoreMovie(
  movie: MoviePoint,
  pair: ChartPair,
  xScoreDomain: ReturnType<typeof scoreDomain>,
  yScoreDomain: ReturnType<typeof scoreDomain>,
): number {
  const xValue = movie[pair.x];
  const yValue = movie[pair.y];
  const coefficients = SCORE_COEFFICIENTS[pairKey(pair)];

  if (
    !coefficients ||
    typeof xValue !== "number" ||
    typeof yValue !== "number"
  ) {
    return 0;
  }

  const x = xScoreDomain.normalize(xValue);
  const y = yScoreDomain.normalize(yValue);
  return clampScore(coefficients.a + coefficients.b * x + coefficients.c * x * x + coefficients.d * y);
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function mixHex(from: string, to: string, amount: number): string {
  const fromRgb = hexToRgb(from);
  const toRgb = hexToRgb(to);
  const channels = fromRgb.map((channel, index) =>
    Math.round(channel + (toRgb[index] - channel) * amount),
  );

  return `rgb(${channels.join(", ")})`;
}

function scoreColor(score: number): string {
  if (score >= 0) {
    return mixHex(SCORE_NEUTRAL, SCORE_GREEN, score);
  }

  return mixHex(SCORE_NEUTRAL, SCORE_RED, Math.abs(score));
}

function niceLinearTicks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    return [min];
  }

  const span = max - min;
  const step = span / Math.max(1, count - 1);
  return Array.from({ length: count }, (_, index) => min + step * index);
}

function logTicks(min: number, max: number): number[] {
  const start = Math.ceil(Math.log10(min));
  const end = Math.floor(Math.log10(max));
  const ticks: number[] = [];

  for (let power = start; power <= end; power += 1) {
    ticks.push(10 ** power);
  }

  if (ticks.length < 3) {
    return niceLinearTicks(Math.log10(min), Math.log10(max), 4).map((value) => 10 ** value);
  }

  return ticks;
}

function getScale(values: number[], key: AttributeKey, start: number, end: number) {
  const transformed = values.map((value) => transform(value, key));
  const min = Math.min(...transformed);
  const max = Math.max(...transformed);
  const pad = (max - min || 1) * 0.06;
  const domainMin = min - pad;
  const domainMax = max + pad;

  return {
    position(value: number) {
      const transformedValue = transform(value, key);
      const t = (transformedValue - domainMin) / (domainMax - domainMin);
      return start + t * (end - start);
    },
    domainMin,
    domainMax,
  };
}

function Graph({
  pair,
  movies,
}: {
  pair: ChartPair;
  movies: MoviePoint[];
}) {
  const [hovered, setHovered] = useState<MoviePoint | null>(null);
  const [activeMovie, setActiveMovie] = useState<MoviePoint | null>(null);
  const plotted = useMemo(
    () =>
      computePercentiles(
        movies.filter(
          (movie) =>
            typeof movie[pair.x] === "number" &&
            typeof movie[pair.y] === "number" &&
            (movie[pair.x] as number) > 0 &&
            (movie[pair.y] as number) > 0,
        ),
      ),
    [movies, pair.x, pair.y],
  );

  const xValues = plotted.map((movie) => movie[pair.x] as number);
  const yValues = plotted.map((movie) => movie[pair.y] as number);
  const xScale = getScale(xValues, pair.x, PADDING.left, WIDTH - PADDING.right);
  const yScale = getScale(yValues, pair.y, HEIGHT - PADDING.bottom, PADDING.top);
  const xScoreDomain = scoreDomain(xValues, pair.x);
  const yScoreDomain = scoreDomain(yValues, pair.y);

  const xTicks = ATTRIBUTES[pair.x].log
    ? logTicks(Math.min(...xValues), Math.max(...xValues))
    : niceLinearTicks(Math.min(...xValues), Math.max(...xValues));
  const yTicks = ATTRIBUTES[pair.y].log
    ? logTicks(Math.min(...yValues), Math.max(...yValues))
    : niceLinearTicks(Math.min(...yValues), Math.max(...yValues));

  const active = hovered ?? activeMovie;

  function activateMovie(movie: MoviePoint) {
    setActiveMovie(movie);
    setHovered(movie);
  }

  function openLetterboxdPage(movie: MoviePoint) {
    activateMovie(movie);

    const url = getLetterboxdUrl(movie);
    if (url) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <section className="ffb-chart" aria-labelledby={`chart-${pair.x}-${pair.y}`}>
      <div className="ffb-chart-head">
        <div>
          <p className="ffb-label">{plotted.length} plotted films</p>
          <h2 id={`chart-${pair.x}-${pair.y}`}>
            {ATTRIBUTES[pair.y].label} vs. {ATTRIBUTES[pair.x].label}
          </h2>
        </div>
      </div>

      <div className="ffb-chart-layout">
        <div className="ffb-chart-plot">
          <svg
            className="ffb-scatter"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="img"
            aria-label={`${ATTRIBUTES[pair.y].label} against ${ATTRIBUTES[pair.x].label}`}
          >
            <line
              className="ffb-axis"
              x1={PADDING.left}
              x2={WIDTH - PADDING.right}
              y1={HEIGHT - PADDING.bottom}
              y2={HEIGHT - PADDING.bottom}
            />
            <line
              className="ffb-axis"
              x1={PADDING.left}
              x2={PADDING.left}
              y1={PADDING.top}
              y2={HEIGHT - PADDING.bottom}
            />

            {xTicks.map((tick) => {
              const x = xScale.position(tick);
              return (
                <g key={`x-${tick}`} className="ffb-tick">
                  <line x1={x} x2={x} y1={PADDING.top} y2={HEIGHT - PADDING.bottom} />
                  <text x={x} y={HEIGHT - 38} textAnchor="middle">
                    {formatValue(pair.x, tick)}
                  </text>
                </g>
              );
            })}

            {yTicks.map((tick) => {
              const y = yScale.position(tick);
              return (
                <g key={`y-${tick}`} className="ffb-tick">
                  <line x1={PADDING.left} x2={WIDTH - PADDING.right} y1={y} y2={y} />
                  <text x={PADDING.left - 12} y={y + 4} textAnchor="end">
                    {formatValue(pair.y, tick)}
                  </text>
                </g>
              );
            })}

            <text className="ffb-axis-label" x={WIDTH / 2} y={HEIGHT - 8} textAnchor="middle">
              {ATTRIBUTES[pair.x].label}
              {ATTRIBUTES[pair.x].log ? " (log)" : ""}
            </text>
            <text
              className="ffb-axis-label"
              x={18}
              y={HEIGHT / 2}
              textAnchor="middle"
              transform={`rotate(-90 18 ${HEIGHT / 2})`}
            >
              {ATTRIBUTES[pair.y].label}
              {ATTRIBUTES[pair.y].log ? " (log)" : ""}
            </text>

            {plotted.map((movie) => {
              const cx = xScale.position(movie[pair.x] as number);
              const cy = yScale.position(movie[pair.y] as number);
              const isActive = active?.title === movie.title;
              const letterboxdUrl = getLetterboxdUrl(movie);
              const score = scoreMovie(movie, pair, xScoreDomain, yScoreDomain);

              return (
                <circle
                  key={`${pair.x}-${pair.y}-${movie.title}`}
                  className={isActive ? "ffb-dot ffb-dot--active" : "ffb-dot"}
                  style={{ fill: scoreColor(score) }}
                  cx={cx}
                  cy={cy}
                  r={5}
                  tabIndex={0}
                  aria-label={
                    letterboxdUrl
                      ? `Open ${movie.title} on Letterboxd, score ${score.toFixed(2)}`
                      : `${movie.title} has no Letterboxd page, score ${score.toFixed(2)}`
                  }
                  onMouseEnter={() => activateMovie(movie)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => openLetterboxdPage(movie)}
                  onFocus={() => activateMovie(movie)}
                  onBlur={() => setHovered(null)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openLetterboxdPage(movie);
                    }
                  }}
                />
              );
            })}
          </svg>
        </div>

        <MovieTooltip movie={active} pair={pair} />
      </div>
    </section>
  );
}

function MovieTooltip({ movie, pair }: { movie: MoviePoint | null; pair: ChartPair }) {
  if (!movie) {
    return (
      <aside className="ffb-tooltip">
        <p className="ffb-label">Film data</p>
        <h3>Hover a film</h3>
        <p className="ffb-muted">
          Pick a point on the plot to inspect its charted values and percentiles.
        </p>
      </aside>
    );
  }

  return (
    <aside className="ffb-tooltip" aria-live="polite">
      <p className="ffb-label">Film data</p>
      <dl>
        {STAT_ORDER.map((key) => {
          const isGraphed = key === pair.x || key === pair.y;
          const value = movie[key];
          const label = <span>{ATTRIBUTES[key].label}</span>;
          const statValue = (
            <span>
              {formatValue(key, value)} <small>{formatPercentile(movie.percentiles[key])}</small>
            </span>
          );

          return (
            <div key={key} className={isGraphed ? "ffb-stat ffb-stat--graphed" : "ffb-stat"}>
              <dt>{isGraphed ? <strong>{label}</strong> : label}</dt>
              <dd>{isGraphed ? <strong>{statValue}</strong> : statValue}</dd>
            </div>
          );
        })}
      </dl>
      <h3 className="ffb-tooltip-title">
        <strong>{movie.title}</strong>
      </h3>
    </aside>
  );
}

export default function MovieCharts() {
  const [rows, setRows] = useState<MoviePoint[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [activePairIndex, setActivePairIndex] = useState(0);

  useEffect(() => {
    let isCurrent = true;

    fetch(DATA_URL)
      .then((response) => {
        if (!response.ok) {
          throw new Error("Movie chart data could not be loaded.");
        }
        return response.text();
      })
      .then((text) => {
        const parsed = parseCsv(text).map((row) => ({
          title: row.title ?? "Untitled",
          rank: numberCell(row.rank),
          domestic_gross: numberCell(row.domestic_gross),
          budget: numberCell(row.budget),
          letterboxd_ratings: numberCell(row.letterboxd_ratings),
          letterboxd_avg: numberCell(row.letterboxd_avg),
          letterboxd_slug: textCell(row.letterboxd_slug),
        }));

        if (isCurrent) {
          setRows(computePercentiles(parsed));
          setStatus("ready");
        }
      })
      .catch(() => {
        if (isCurrent) {
          setStatus("error");
        }
      });

    return () => {
      isCurrent = false;
    };
  }, []);

  if (status === "loading") {
    return <section className="ffb-chart ffb-chart--state">Loading movie chart data.</section>;
  }

  if (status === "error") {
    return <section className="ffb-chart ffb-chart--state">Movie chart data failed to load.</section>;
  }

  const activePair = PAIRS[activePairIndex];

  return (
    <section className="ffb-charts" aria-labelledby="movie-chart-title">
      <div className="ffb-chart-intro">
        <p className="ffb-kicker">2025 Movie Charts</p>
        <h1 id="movie-chart-title">Release value map</h1>
      </div>

      <div className="ffb-chart-tabs" role="tablist" aria-label="Chart pairs">
        {PAIRS.map((pair, index) => (
          <button
            key={`${pair.x}-${pair.y}`}
            type="button"
            aria-selected={index === activePairIndex}
            onClick={() => setActivePairIndex(index)}
          >
            {ATTRIBUTES[pair.x].short} / {ATTRIBUTES[pair.y].short}
          </button>
        ))}
      </div>

      <Graph pair={activePair} movies={rows} />
    </section>
  );
}
