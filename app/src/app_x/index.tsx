import { useEffect, useState } from "react";
import {
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from "firebase/auth";
import {
  onValue,
  ref,
  type DataSnapshot,
} from "firebase/database";
import DebugConsole from "./DebugConsole";
import { getFirebaseClient, type FirebaseClient } from "./firebaseClient";
import LeagueConsole from "./LeagueConsole";
import MovieCharts from "./MovieCharts";
import ScoringRulesPage from "./ScoringRulesPage";
import {
  DEFAULT_SCORING_RULES,
  evaluateFormula,
  type MovieScoreInput,
  type ScoringPosition,
} from "./scoringRules";
import "./styles.css";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; client: FirebaseClient }
  | { status: "error"; message: string };

type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; user: User };

type UniverseState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; value: unknown }
  | { status: "error"; message: string };

type ScoreAxisKey = keyof MovieScoreInput;

type LandingMovie = {
  budget: number | null;
  domestic_gross: number | null;
  letterboxd_avg: number | null;
  letterboxd_ratings: number | null;
  title: string;
};

type PositionPoint = {
  movie: LandingMovie;
  score: number;
  x: number;
  y: number;
};

type AxisDomain = {
  normalize(value: number): number;
  ticks: number[];
};

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

const MOVIE_DATA_URL = "/movie_charts/2025/movie_2025_data.csv";

const seasonFacts = [
  "6 players",
  "May 1-August 31",
  "10-film theater",
  "6 scoring positions",
  "1000 starting stubs",
  "Oscar postseason",
];

const tooltipText: Record<string, string> = {
  theater: "Your roster. A theater can hold at most 10 films before scoring.",
  postered: "A film is postered when it reaches its first US/Canada theatrical release date. Postered films are locked.",
  stubs: "The only league currency. You spend stubs on actions and bids, then earn stubs from scoring positions.",
  obfuscation: "A reversible spoiler curtain for active bid payloads. It is not real security against someone inspecting app code.",
  commissioner: "The user whose Firebase folder owns a league object. That object assigns player ids, members, and scoring rules.",
  waiver: "A 48-hour blind auction created when an unpostered film is dropped.",
  position: "One final scoring slot. Each position has a formula and receives one postered film.",
};

const SCORE_AXES: Record<string, { x: ScoreAxisKey; y: ScoreAxisKey }> = {
  "budget-alchemy": { x: "B", y: "G" },
  "cult-furnace": { x: "R", y: "A" },
  disasterpiece: { x: "B", y: "A" },
  "packed-house": { x: "G", y: "A" },
  "rotten-crowd": { x: "R", y: "A" },
  "tiny-thunder": { x: "G", y: "R" },
};

const AXIS_META: Record<
  ScoreAxisKey,
  { label: string; log: boolean; short: string }
> = {
  A: { label: "Letterboxd average", log: false, short: "LB avg" },
  B: { label: "Budget", log: true, short: "Budget" },
  G: { label: "Domestic gross", log: true, short: "Gross" },
  R: { label: "Letterboxd ratings", log: true, short: "Ratings" },
};

const SCORE_RED = "#f05d63";
const SCORE_BROWN = "#d8b38a";
const SCORE_GREEN = "#58c978";

function usePathname() {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    function syncPathname() {
      setPathname(window.location.pathname);
    }

    window.addEventListener("popstate", syncPathname);
    return () => window.removeEventListener("popstate", syncPathname);
  }, []);

  return pathname;
}

function useFirebaseClient(): LoadState {
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let isCurrent = true;

    getFirebaseClient()
      .then((client) => {
        if (isCurrent) {
          setLoadState({ status: "ready", client });
        }
      })
      .catch((error: unknown) => {
        if (isCurrent) {
          const message =
            error instanceof Error ? error.message : "Unable to load Firebase.";
          setLoadState({ status: "error", message });
        }
      });

    return () => {
      isCurrent = false;
    };
  }, []);

  return loadState;
}

function useAuth(client: FirebaseClient | null): AuthState {
  const [authState, setAuthState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    if (!client) {
      return;
    }

    getRedirectResult(client.auth).catch(() => undefined);

    return onAuthStateChanged(client.auth, (user) => {
      setAuthState(user ? { status: "signed-in", user } : { status: "signed-out" });
    });
  }, [client]);

  return authState;
}

function useUniverse(client: FirebaseClient | null, user: User | null): UniverseState {
  const [universeState, setUniverseState] = useState<UniverseState>({
    status: "idle",
  });

  useEffect(() => {
    if (!client || !user) {
      return;
    }

    return onValue(
      ref(client.database, "/"),
      (snapshot: DataSnapshot) => {
        setUniverseState({
          status: "ready",
          value: snapshot.exists() ? snapshot.val() : {},
        });
      },
      (error) => {
        setUniverseState({ status: "error", message: error.message });
      },
    );
  }, [client, user]);

  return universeState;
}

function navigateTo(pathname: string) {
  window.history.pushState(null, "", pathname);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function Term({ children, id }: { children: string; id: keyof typeof tooltipText }) {
  return (
    <span className="ffb-term" tabIndex={0}>
      {children}
      <span className="ffb-term-tip" role="tooltip">
        {tooltipText[id]}
      </span>
    </span>
  );
}

function LandingPage() {
  const [movies, setMovies] = useState<LandingMovie[]>([]);

  useEffect(() => {
    document.title = "FantasyFilmBall";
  }, []);

  useEffect(() => {
    let active = true;

    fetch(MOVIE_DATA_URL)
      .then((response) => (response.ok ? response.text() : ""))
      .then((text) => {
        if (active && text) {
          setMovies(parseCsv(text).map(toLandingMovie).filter((movie) => movie.title));
        }
      })
      .catch(() => {
        if (active) {
          setMovies([]);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="ffb-page ffb-landing">
      <header className="ffb-landing-hero">
        <nav className="ffb-nav ffb-landing-nav" aria-label="Primary">
          <button type="button" onClick={() => navigateTo("/app")}>
            Enter League
          </button>
          <button type="button" onClick={() => navigateTo("/league")}>
            Movie Charts
          </button>
          <button type="button" onClick={() => navigateTo("/scoring")}>
            Scoring
          </button>
        </nav>
        <p className="ffb-kicker">FantasyFilmBall</p>
        <h1>Run a summer movie theater with your friends.</h1>
        <p className="ffb-landing-lede">
          FantasyFilmBall is a no-backend fantasy league for domestic US/Canada theatrical
          releases. Six players draft films, spend stubs, keep a 10-film theater, and score by
          placing released films into commissioner-defined positions. The game is built around one
          clean loop: currency in, currency out. You spend <Term id="stubs">stubs</Term> to act,
          bid, and reshape your slate; your final lineup earns stubs from real box office and
          Letterboxd data.
        </p>
        <div className="ffb-fact-row" aria-label="League facts">
          {seasonFacts.map((fact) => (
            <span key={fact}>{fact}</span>
          ))}
        </div>
      </header>

      <section className="ffb-rule-section" aria-labelledby="season-title">
        <p className="ffb-label">Season</p>
        <h2 id="season-title">May through August, theatrical only</h2>
        <p>
          The regular season runs from May 1 through August 31. A film is in scope only if it has a
          US/Canada theatrical release in that window. Domestic gross means US/Canada theatrical
          box office. Streaming-only titles are out. Festival-only screenings are out unless they
          lead to a public theatrical run. The commissioner updates static season files from time
          to time with release dates, final box office, Letterboxd averages, rating counts, and
          scoring positions.
        </p>
        <p>
          Each player starts the season with 1000 stubs. The preseason opens with a free six-round
          snake draft. Drafted films enter your <Term id="theater">theater</Term>, which can hold
          at most 10 films. A film becomes <Term id="postered">postered</Term> on its first
          US/Canada theatrical release date. Once postered, it is locked: it cannot be dropped or
          traded. At the end of the season, you assign six postered films to six scoring positions.
          One film can occupy one position, and saving a changed lineup costs 1 stub.
        </p>
      </section>

      <section className="ffb-rule-section" aria-labelledby="market-title">
        <p className="ffb-label">Market</p>
        <h2 id="market-title">Bids are trusted, logs are public, spoilers are hidden</h2>
        <p>
          Every film with a known release date enters its initial auction exactly 60 days before
          release. The bid deadline is 6:00 PM ET that day. Each player can hold one active bid per
          film. Submitting, editing, or withdrawing a bid costs 1 stub. Active auction logs do not
          reveal the film, amount, auction id, or drop stipulation. They only show that a player
          submitted, edited, or withdrew a bid by transaction id.
        </p>
        <p>
          Active bid details are stored with casual <Term id="obfuscation">obfuscation</Term> so a
          player opening the raw database does not accidentally spoil themself. This is not
          cryptographic secrecy; a motivated user could decode it by inspecting the app. After the
          auction deadline, the app decodes the payload and shows the film, amount, and drop
          stipulation automatically. There are no passphrases, reveal actions, reveal grace
          periods, or unrevealed-bid penalties.
        </p>
        <p>
          A winning bid is valid only if the player has enough stubs and theater room. A bid may
          include a stipulation such as "if I win, drop this unpostered film." If the stipulated
          drop is no longer owned or has already postered, the bid is invalid. Ties go to the
          earliest current bid timestamp, so editing a bid resets its tie priority.
        </p>
      </section>

      <section className="ffb-rule-section" aria-labelledby="privacy-title">
        <p className="ffb-label">Leagues</p>
        <h2 id="privacy-title">Commissioners own leagues; players own their logs</h2>
        <p>
          Google login identifies the user. A <Term id="commissioner">commissioner</Term> can start
          one or more leagues, each stored inside the commissioner's own Firebase folder. That
          league object defines its name, season, members, assigned player ids, kicked users,
          scoring positions, and formulas. Repo files do not need to include commissioner UIDs.
        </p>
        <p>
          Players join by entering a league id, such as <code>defaultLeagueId</code>. If multiple
          commissioners have a league with that id, the app shows a picker. A join request is stored
          in the player's own folder, and the commissioner accepts by adding that user to the
          commissioner-owned league object. Kicked players cannot rejoin that commissioner's league.
          Static research pages, including the movie charts, remain public.
        </p>
      </section>

      <section className="ffb-rule-section" aria-labelledby="moves-title">
        <p className="ffb-label">Roster Moves</p>
        <h2 id="moves-title">Free agents, drops, waivers, and trades</h2>
        <p>
          If a film is unowned, inside its 60-day window, and has no pending initial auction or
          waiver, it can be picked up immediately for 1 stub. Dropping an unpostered film costs 1
          stub and starts a 48-hour <Term id="waiver">waiver</Term> auction. If nobody submits a
          valid waiver bid, the film becomes a free agent again. The app warns users
          before a move would invalidate an outstanding bid, such as filling the last theater slot
          while holding a bid without a drop stipulation.
        </p>
        <p>
          Trades execute immediately when accepted. There is no veto window and no expiration.
          Proposing a trade costs 1 stub. Accepting or declining is free. Canceling your own offer
          costs 1 stub. Trades can be one film for one film, one film for stubs, or stubs for one
          film. Multi-film trades, 2-for-1 trades, pure stubs-for-stubs trades, and trades involving
          postered films are not allowed.
        </p>
      </section>

      <section className="ffb-rule-section" aria-labelledby="positions-title">
        <p className="ffb-label">Scoring</p>
        <h2 id="positions-title">Positions turn real movie outcomes into stubs</h2>
        <p>
          The commissioner defines six scoring <Term id="position">positions</Term> each season.
          The formulas use true values rather than min-max normalization, so a movie's payout does
          not change just because other films exist. Formulas can produce decimals or negative
          values; there is no clamp and no automatic rounding. The scoring rules page is readable
          by everyone in the league. Only the commissioner who owns the selected league object can
          edit scoring positions and formulas. The page also shows
          the top 20 films from last year's data for each position, using the active formulas.
        </p>
        <div className="ffb-position-grid">
          {DEFAULT_SCORING_RULES.positions.map((position) => (
            <PositionShowcase key={position.id} movies={movies} position={position} />
          ))}
        </div>
      </section>

      <section className="ffb-rule-section" aria-labelledby="postseason-title">
        <p className="ffb-label">Postseason</p>
        <h2 id="postseason-title">The Oscars become the playoff board</h2>
        <p>
          When the regular season ends, the stub standings determine Oscar draft order. The
          regular-season winner gets first choice, then the rest of the league follows in standings
          order. Each player drafts one Oscar-nominated film after nominations are announced. The
          postseason winner is the player whose drafted film wins the most Academy Awards. Ties go
          to regular-season stub rank, so summer performance still matters even if Oscar night gets
          weird.
        </p>
        <p>
          Oscar picks do not change regular-season rosters, locked films, or scoring positions.
          They are a short postseason layer on top of the completed summer league: one nominated
          movie per player, wins counted from the real ceremony, and no extra backend needed.
        </p>
      </section>

      <section className="ffb-rule-section" aria-labelledby="ledger-title">
        <p className="ffb-label">Ledger</p>
        <h2 id="ledger-title">The database is a log, not a referee</h2>
        <p>
          The app uses Firebase Realtime Database as a shared log store, not as a custom backend.
          Commissioner decisions write to the commissioner's folder. Player actions write to the
          acting player's folder. Transaction ids use the form <code>x.y</code>, where{" "}
          <code>x</code> is the commissioner-assigned player id and <code>y</code> is that player's
          transaction index. The client derives league state by replaying the commissioner-owned
          league object, static movie files, and active member logs. Invalid transactions remain
          visible with explanations: insufficient stubs, theater full, postered film, stale trade,
          or invalid drop stipulation.
        </p>
        <div className="ffb-actions">
          <button className="ffb-primary" type="button" onClick={() => navigateTo("/app")}>
            Enter League
          </button>
          <button type="button" onClick={() => navigateTo("/league")}>
            View Movie Charts
          </button>
          <button type="button" onClick={() => navigateTo("/scoring")}>
            Scoring Rules
          </button>
        </div>
      </section>
    </main>
  );
}

function PositionShowcase({
  movies,
  position,
}: {
  movies: LandingMovie[];
  position: ScoringPosition;
}) {
  const axes = SCORE_AXES[position.id] ?? { x: "G", y: "A" };
  const points = movies
    .map((movie) => pointForMovie(movie, position, axes))
    .filter((point): point is PositionPoint => Boolean(point));
  const topRows = points
    .slice()
    .sort((left, right) => right.score - left.score)
    .slice(0, 20);
  const topColumns = [topRows.slice(0, 10), topRows.slice(10)];

  return (
    <article className="ffb-position-card">
      <div className="ffb-position-card-head">
        <div>
          <h3>{position.name}</h3>
          <p>{position.subtitle}</p>
        </div>
        <code>{position.formula}</code>
      </div>
      <PositionScatter axes={axes} points={points} />
      <div className="ffb-position-ranking">
        <p className="ffb-label">2025 Top 20</p>
        {topRows.length > 0 ? (
          <div className="ffb-position-ranking-columns">
            {topColumns.map((column, columnIndex) => (
              <ol key={`${position.id}-column-${columnIndex}`} start={columnIndex * 10 + 1}>
                {column.map((row) => (
                  <li key={`${position.id}-${row.movie.title}`}>
                    <span>{row.movie.title}</span>
                    <strong>{row.score.toFixed(1)}</strong>
                  </li>
                ))}
              </ol>
            ))}
          </div>
        ) : (
          <p className="ffb-muted">Loading 2025 films.</p>
        )}
      </div>
    </article>
  );
}

function PositionScatter({
  axes,
  points,
}: {
  axes: { x: ScoreAxisKey; y: ScoreAxisKey };
  points: PositionPoint[];
}) {
  const [hoveredTitle, setHoveredTitle] = useState<string | null>(null);
  const width = 430;
  const height = 270;
  const pad = { bottom: 50, left: 62, right: 18, top: 18 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const xDomain = axisDomain(points.map((point) => point.x), axes.x);
  const yDomain = axisDomain(points.map((point) => point.y), axes.y);
  const hoveredPoint = hoveredTitle
    ? points.find((point) => point.movie.title === hoveredTitle)
    : null;

  return (
    <div className="ffb-position-plot" aria-label={`${AXIS_META[axes.x].label} and ${AXIS_META[axes.y].label} plot`}>
      <div className="ffb-position-hover" aria-live="polite">
        {hoveredPoint ? (
          <>
            <span>{hoveredPoint.movie.title}</span>
            <strong>{hoveredPoint.score.toFixed(1)} stubs</strong>
          </>
        ) : (
          <span>Hover a film</span>
        )}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img">
        <line className="ffb-mini-axis" x1={pad.left} x2={pad.left} y1={pad.top} y2={height - pad.bottom} />
        <line className="ffb-mini-axis" x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} />
        {xDomain.ticks.map((tick, index) => {
          const x = pad.left + xDomain.normalize(tick) * plotWidth;

          return (
            <g className="ffb-mini-tick" key={`${axes.x}-${index}-${tick}`} transform={`translate(${x} 0)`}>
              <line y1={height - pad.bottom} y2={height - pad.bottom + 4} />
              <text x={0} y={height - pad.bottom + 17}>
                {formatAxisTick(tick, axes.x)}
              </text>
            </g>
          );
        })}
        {yDomain.ticks.map((tick, index) => {
          const y = pad.top + (1 - yDomain.normalize(tick)) * plotHeight;

          return (
            <g className="ffb-mini-tick" key={`${axes.y}-${index}-${tick}`} transform={`translate(0 ${y})`}>
              <line x1={pad.left - 4} x2={pad.left} />
              <text x={pad.left - 8} y={4} textAnchor="end">
                {formatAxisTick(tick, axes.y)}
              </text>
            </g>
          );
        })}
        <text className="ffb-mini-axis-label" x={pad.left + plotWidth / 2} y={height - 8}>
          {AXIS_META[axes.x].label}
        </text>
        <text
          className="ffb-mini-axis-label"
          transform={`translate(14 ${pad.top + plotHeight / 2}) rotate(-90)`}
        >
          {AXIS_META[axes.y].label}
        </text>
        {points.map((point) => {
          const cx = pad.left + xDomain.normalize(point.x) * plotWidth;
          const cy = pad.top + (1 - yDomain.normalize(point.y)) * plotHeight;

          return (
            <circle
              key={`${point.movie.title}-${point.score}`}
              cx={cx}
              cy={cy}
              fill={scoreColor(point.score)}
              onBlur={() => setHoveredTitle(null)}
              onFocus={() => setHoveredTitle(point.movie.title)}
              onMouseEnter={() => setHoveredTitle(point.movie.title)}
              onMouseLeave={() => setHoveredTitle(null)}
              r={3.2}
              tabIndex={0}
            >
              <title>{`${point.movie.title}: ${point.score.toFixed(1)} stubs`}</title>
            </circle>
          );
        })}
      </svg>
    </div>
  );
}

function pointForMovie(
  movie: LandingMovie,
  position: ScoringPosition,
  axes: { x: ScoreAxisKey; y: ScoreAxisKey },
): PositionPoint | null {
  const input = movieInput(movie);
  const score = evaluateFormula(position.formula, input);
  const x = input[axes.x];
  const y = input[axes.y];

  if (score === null || x === null || y === null) {
    return null;
  }

  return { movie, score, x, y };
}

function movieInput(movie: LandingMovie): MovieScoreInput {
  return {
    A: movie.letterboxd_avg,
    B: movie.budget === null ? null : movie.budget / 100_000_000,
    G: movie.domestic_gross === null ? null : movie.domestic_gross / 100_000_000,
    R: movie.letterboxd_ratings === null ? null : movie.letterboxd_ratings / 100_000,
  };
}

function axisDomain(values: number[], key: ScoreAxisKey): AxisDomain {
  const meta = AXIS_META[key];
  const transformed = values
    .filter((value) => Number.isFinite(value) && (!meta.log || value > 0))
    .map((value) => (meta.log ? Math.log10(value) : value));
  const rawMin = Math.min(...transformed);
  const rawMax = Math.max(...transformed);
  const min = Number.isFinite(rawMin) ? rawMin : 0;
  const max = Number.isFinite(rawMax) ? rawMax : 1;
  const span = max - min || 1;
  const transformedTicks = [min, min + span / 2, max];
  const ticks = transformedTicks.map((value) => (meta.log ? 10 ** value : value));

  return {
    normalize(value: number) {
      const transformedValue = meta.log ? Math.log10(Math.max(value, 0.000001)) : value;
      return Math.max(0, Math.min(1, (transformedValue - min) / span));
    },
    ticks,
  };
}

function formatAxisTick(value: number, key: ScoreAxisKey) {
  if (key === "A") {
    return value.toFixed(1);
  }

  if (key === "R") {
    return `${value.toFixed(value < 1 ? 1 : 0)}x`;
  }

  if (value < 1) {
    return `$${Math.round(value * 100)}M`;
  }

  return `$${value.toFixed(value < 10 ? 1 : 0)}B`;
}

function scoreColor(score: number) {
  const normalized = Math.max(-1, Math.min(1, score / 500));
  const start = hexToRgb(normalized >= 0 ? SCORE_BROWN : SCORE_RED);
  const end = hexToRgb(normalized >= 0 ? SCORE_GREEN : SCORE_BROWN);
  const amount = Math.abs(normalized);
  return `rgb(${Math.round(start.r + (end.r - start.r) * amount)} ${Math.round(start.g + (end.g - start.g) * amount)} ${Math.round(start.b + (end.b - start.b) * amount)})`;
}

function hexToRgb(hex: string) {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return {
    b: value & 255,
    g: (value >> 8) & 255,
    r: (value >> 16) & 255,
  };
}

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

function toLandingMovie(row: Record<string, string>): LandingMovie {
  return {
    budget: numberCell(row.budget),
    domestic_gross: numberCell(row.domestic_gross),
    letterboxd_avg: numberCell(row.letterboxd_avg),
    letterboxd_ratings: numberCell(row.letterboxd_ratings),
    title: row.title?.trim() ?? "",
  };
}

function numberCell(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function LeaguePage() {
  useEffect(() => {
    document.title = "FantasyFilmBall Movie Charts";
  }, []);

  return (
    <main className="ffb-page ffb-page--text">
      <nav className="ffb-nav" aria-label="Primary">
        <button type="button" onClick={() => navigateTo("/")}>
          Rules
        </button>
        <button type="button" onClick={() => navigateTo("/app")}>
          League App
        </button>
        <button type="button" onClick={() => navigateTo("/scoring")}>
          Scoring
        </button>
      </nav>
      <MovieCharts />
    </main>
  );
}

function LoginPage({ client }: { client: FirebaseClient }) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    document.title = "FantasyFilmBall";
  }, []);

  async function signIn() {
    setErrorMessage(null);

    try {
      await signInWithPopup(client.auth, provider);
    } catch (error: unknown) {
      try {
        await signInWithRedirect(client.auth, provider);
      } catch {
        const message =
          error instanceof Error ? error.message : "Google sign-in failed.";
        setErrorMessage(message);
      }
    }
  }

  return (
    <main className="ffb-page ffb-page--center">
      <section className="ffb-login" aria-labelledby="login-title">
        <p className="ffb-kicker">FantasyFilmBall</p>
        <h1 id="login-title">Enter the draft room</h1>
        <p>
          Sign in with Google to enter the private league console. The current console keeps a
          timestamped counter and database sanity checks while the full league log UI comes online.
        </p>
        <div className="ffb-actions">
          <button className="ffb-primary" type="button" onClick={signIn}>
            Sign in with Google
          </button>
          <button type="button" onClick={() => navigateTo("/league")}>
            Movie Charts
          </button>
          <button type="button" onClick={() => navigateTo("/scoring")}>
            Scoring
          </button>
          <button type="button" onClick={() => navigateTo("/")}>
            Rules
          </button>
        </div>
        {errorMessage ? <p className="ffb-error">{errorMessage}</p> : null}
      </section>
    </main>
  );
}

function AppShell() {
  const pathname = usePathname();

  if (pathname === "/") {
    return <LandingPage />;
  }

  if (pathname === "/league") {
    return <LeaguePage />;
  }

  return <PrivateApp />;
}

function PrivateApp() {
  const pathname = usePathname();
  const clientState = useFirebaseClient();
  const client = clientState.status === "ready" ? clientState.client : null;
  const authState = useAuth(client);
  const user = authState.status === "signed-in" ? authState.user : null;
  const universeState = useUniverse(client, user);

  if (pathname !== "/app" && pathname !== "/debug" && pathname !== "/scoring") {
    return <LandingPage />;
  }

  if (clientState.status === "loading") {
    return (
      <main className="ffb-page ffb-page--center">
        <section className="ffb-login">
          <p className="ffb-kicker">FantasyFilmBall</p>
          <h1>Loading Firebase</h1>
        </section>
      </main>
    );
  }

  if (clientState.status === "error") {
    return (
      <main className="ffb-page ffb-page--center">
        <section className="ffb-login">
          <p className="ffb-kicker">FantasyFilmBall</p>
          <h1>Firebase needs configuration</h1>
          <p>{clientState.message}</p>
        </section>
      </main>
    );
  }

  if (authState.status === "loading") {
    return (
      <main className="ffb-page ffb-page--center">
        <section className="ffb-login">
          <p className="ffb-kicker">FantasyFilmBall</p>
          <h1>Checking sign-in</h1>
        </section>
      </main>
    );
  }

  if (authState.status === "signed-out") {
    return <LoginPage client={clientState.client} />;
  }

  if (pathname === "/debug") {
    return (
      <DebugConsole
        client={clientState.client}
        onNavigate={navigateTo}
        onSignOut={() => signOut(clientState.client.auth)}
        universeState={universeState}
        user={authState.user}
      />
    );
  }

  if (pathname === "/scoring") {
    return (
      <ScoringRulesPage
        client={clientState.client}
        onNavigate={navigateTo}
        onSignOut={() => signOut(clientState.client.auth)}
        universeState={universeState}
        user={authState.user}
      />
    );
  }

  return (
    <LeagueConsole
      client={clientState.client}
      onNavigate={navigateTo}
      onSignOut={() => signOut(clientState.client.auth)}
      universeState={universeState}
      user={authState.user}
    />
  );
}

export default AppShell;
