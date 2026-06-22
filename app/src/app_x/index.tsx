import { useEffect, useState, type ReactNode } from "react";
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
import {
  DEFAULT_SCORING_RULES,
  evaluateFormula,
  formatScoringFormula,
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

const tooltipText: Record<string, string> = {
  theater: "Your roster. The league config sets how many films it can hold.",
  postered: "A film is postered when it reaches its first US/Canada theatrical release date. Postered films are locked.",
  obfuscation: "A reversible spoiler curtain for active bid payloads. It is not real security against someone inspecting app code.",
  commissioner: "The user whose Firebase folder owns a league object. That object assigns player ids, members, and scoring rules.",
};

const SCORE_AXES: Record<string, { x: ScoreAxisKey; y: ScoreAxisKey }> = {
  "budget-alchemy": { x: "B", y: "G" },
  "cult-furnace": { x: "R", y: "A" },
  disasterpiece: { x: "B", y: "A" },
  "packed-house": { x: "G", y: "A" },
  "rotten-crowd": { x: "R", y: "A" },
  "tiny-thunder": { x: "B", y: "R" },
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
const SCORE_BLUE = "#5aa9ff";

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
          <button className="ffb-primary" type="button" onClick={() => navigateTo("/league")}>
            Enter League
          </button>
          <button type="button" onClick={() => navigateTo("/rules")}>
            Full Rules
          </button>
        </nav>
        <p className="ffb-kicker">FantasyFilmBall</p>
        <h1>Fantasy sports for summer movies.</h1>
      </header>

      <section className="ffb-season-banner" aria-label="Season timing">
        <p className="ffb-label">Pilot Season</p>
        <p>
          In the future, FantasyFilmBall will run from May 1 - August 31. While we work out issues
          during the first season, it will run from July 14 - November 8.
        </p>
      </section>

      <section className="ffb-landing-summary" aria-label="Game summary">
        <article>
          <p className="ffb-label">Pick Movies</p>
          <h2>Fill your theater</h2>
          <p>
            Draft, bid, and claim films before they release. Your theater is the roster of movies
            you can use for scoring after the season ends.
          </p>
        </article>
        <article>
          <p className="ffb-label">Watch Outcomes</p>
          <h2>Real data scores</h2>
          <p>
            A film's points are based on combinations of real world outcomes: domestic gross,
            production budget, and Letterboxd ratings.
          </p>
        </article>
        <article>
          <p className="ffb-label">Postseason</p>
          <h2>Pick Oscar contenders</h2>
          <p>
            After nominations are announced, each player drafts one Oscar-nominated film. The
            postseason winner is based on Academy Award wins.
          </p>
        </article>
      </section>

      <section className="ffb-rule-section" aria-labelledby="sample-title">
        <p className="ffb-label">Suggested Custom Categories</p>
        <h2 id="sample-title">How last year's movies would have scored</h2>
        <CategoryWinners movies={movies} />
        <div className="ffb-position-grid">
          {DEFAULT_SCORING_RULES.positions.map((position) => (
            <PositionShowcase key={position.id} movies={movies} position={position} />
          ))}
        </div>
      </section>

      <section className="ffb-rule-section" aria-labelledby="start-title">
        <p className="ffb-label">Start</p>
        <h2 id="start-title">Create or join a private league</h2>
        <p>
          Commissioners start leagues and edit the categories. Players sign in to record bids,
          pickups, drops, scoring assignments, and Oscar picks.
        </p>
        <div className="ffb-actions">
          <button className="ffb-primary" type="button" onClick={() => navigateTo("/league")}>
            Enter League
          </button>
          <button type="button" onClick={() => navigateTo("/rules")}>
            Read Full Rules
          </button>
        </div>
      </section>
    </main>
  );
}

function RulesPage() {
  useEffect(() => {
    document.title = "FantasyFilmBall Rules";
  }, []);

  return (
    <main className="ffb-page ffb-landing ffb-rules-page">
      <header className="ffb-landing-hero">
        <nav className="ffb-nav ffb-landing-nav" aria-label="Primary">
          <button type="button" onClick={() => navigateTo("/")}>
            Home
          </button>
          <button type="button" onClick={() => navigateTo("/league")}>
            Enter League
          </button>
        </nav>
        <p className="ffb-kicker">FantasyFilmBall</p>
        <h1>Full league rules.</h1>
        <p className="ffb-landing-lede">
          A FantasyFilmBall league is a competition to build the best theater of movies, acquired
          before release. Films are scored according to categories, which don't always correspond
          to a traditionally successful film.
        </p>
      </header>

      <section className="ffb-rule-section" aria-labelledby="value-title">
        <p className="ffb-label">Goal</p>
        <h2 id="value-title">What makes a film valuable</h2>
        <p>
          A valuable film is not always the biggest hit. It is a film that fits a scoring category
          nicely. Domestic gross, budgets, and Letterboxd ratings decide category value. One
          category may reward a blockbuster with strong audience response. Another may reward a
          cheap movie that attracted heavy attention. Another may reward an expensive movie that
          audiences disliked. Your job is to uniquely adhere to these categories to fill your
          theater.
        </p>
        <p>
          Each category uses exactly two real-world inputs, among domestic box office, production
          budget, Letterboxd average, and Letterboxd rating count. The commissioner may edit the
          category names, descriptions, formulas, and number of scoring categories for a league,
          but the default categories are the recommended starting point.
        </p>
      </section>

      <section className="ffb-rule-section" aria-labelledby="season-title">
        <p className="ffb-label">Season</p>
        <h2 id="season-title">Which films count</h2>
        <p>
          The regular season covers a fixed theatrical window chosen for the league. By default it
          is the summer movie season, May 1 through August 31. A film is eligible only if it has a
          public US/Canada theatrical release in that window. Domestic gross means US/Canada
          theatrical box office. Streaming-only titles do not count. Festival screenings do not
          count unless they lead to a public theatrical run.
        </p>
        <p>
          A film becomes <Term id="postered">postered</Term> on its first eligible theatrical
          release date. A postered film is locked in its current theater. It will be auto assigned
          to a category that maximizes your total score.
        </p>
      </section>

      <section className="ffb-rule-section" aria-labelledby="market-title">
        <p className="ffb-label">Acquisition</p>
        <h2 id="market-title">How players get films</h2>
        <p>
          A league starts with a preseason snake draft. Draft picks are free. Drafted films enter
          the player's <Term id="theater">theater</Term>. The league config sets how many players
          may join and how many films fit in each theater.
        </p>
        <p>
          After the draft, undrafted films are acquired through blind bids or free-agent pickups.
          An initial auction opens 60 days before a film's eligible release. Its bid deadline is
          6:00 PM ET on that day. A dropped unpostered film goes to a 48-hour waiver auction. An
          unowned film inside its 60-day window, with no active auction or waiver, can be picked up
          immediately.
        </p>
        <p>
          A bid may include a drop stipulation: if the bid wins, the named unpostered film is
          dropped to make room. A bid is valid only if the player can pay it and can fit the film
          in the theater after applying any valid drop stipulation. Ties go to the earliest current
          bid timestamp.
        </p>
        <p>
          Stubs are the season budget for acquiring movies after the draft. Each player starts
          with 1000 stubs. Draft picks and page views are free. Submitting or editing a bid costs
          1 stub, to prevent Jon and Bu from spamming. Free-agent pickups and drops also cost 1
          stub so players cannot churn the market without consequence.
        </p>
      </section>

      <section className="ffb-rule-section" aria-labelledby="moves-title">
        <p className="ffb-label">Theater</p>
        <h2 id="moves-title">How rosters change</h2>
        <p>
          A player's theater holds the films that player controls. A player may drop an unpostered
          film, but may not drop a postered film. If a drop creates a waiver auction, other
          players may bid during the waiver window.
        </p>
      </section>

      <section className="ffb-rule-section" aria-labelledby="positions-title">
        <p className="ffb-label">Scoring</p>
        <h2 id="positions-title">How final scoring works</h2>
        <p>
          At season's end, the app auto-assigns postered films to the league's scoring categories.
          One film may fill one category for that player. A category score comes from that
          category's formula and the film's real-world data.
        </p>
        <p>
          A typical league will have 6 players, each holding 10 films, with 6 scoring categories,
          meaning 4 films will not contribute to your total score.
        </p>
        <DefaultCategoryList />
        <p>
          The landing page shows the default categories against last year's real-world data. Use
          that as a preview of the recommended scoring shape before changing league formulas.
        </p>
      </section>

      <section className="ffb-rule-section" aria-labelledby="postseason-title">
        <p className="ffb-label">Postseason</p>
        <h2 id="postseason-title">The Oscars become the playoff board</h2>
        <p>
          When the regular season ends, the point standings determine Oscar draft order. The
          regular-season winner gets first choice, then the rest of the league follows in standings
          order. Each player drafts one Oscar-nominated film after nominations are announced. The
          postseason winner is the player whose drafted film wins the most Academy Awards. Ties go
          to regular-season point rank.
        </p>
        <p>
          Oscar picks do not change regular-season rosters, locked films, or scoring positions.
          They are a short postseason layer on top of the completed summer league: one nominated
          movie per player, wins counted from the real ceremony, and no extra backend needed.
        </p>
      </section>

      <section className="ffb-rule-section" aria-labelledby="ledger-title">
        <p className="ffb-label">League Admin</p>
        <h2 id="ledger-title">How the app records the league</h2>
        <p>
          Google login identifies each user. A <Term id="commissioner">commissioner</Term> can
          start one or more leagues. The commissioner accepts members, kicks members, and edits the
          scoring categories.
        </p>
        <p>
          The app uses Firebase Realtime Database as a shared log store, not as a custom backend.
          Commissioner decisions write to the commissioner's folder. Player actions write to the
          acting player's folder. Transaction ids use the form <code>x.y</code>, where{" "}
          <code>x</code> is the commissioner-assigned player id and <code>y</code> is that player's
          transaction index. The client derives league state from the commissioner-owned league
          object, static movie files, and active member logs.
        </p>
        <p>
          The console is intentionally transparent: it records events first, then the league can
          review whether a move is valid against these rules. The app does not hide the existence
          of player actions, but it does hide active bid details until the auction deadline.
        </p>
        <p>
          Active bid details are stored with casual <Term id="obfuscation">obfuscation</Term> so a
          player reading the database does not casually spoil an auction. This is not cryptographic
          secrecy. After the deadline, the app can decode and show the bid amount, film, and drop
          stipulation.
        </p>
        <div className="ffb-actions">
          <button className="ffb-primary" type="button" onClick={() => navigateTo("/league")}>
            Enter League
          </button>
        </div>
      </section>
    </main>
  );
}

function DefaultCategoryList() {
  return (
    <div className="ffb-default-category-list" aria-label="Default scoring categories and formulas">
      {DEFAULT_SCORING_RULES.positions.map((position) => (
        <article key={position.id}>
          <div>
            <h3>{position.name}</h3>
            <p>{position.subtitle}</p>
          </div>
          <code>{formatScoringFormula(position.formula)}</code>
        </article>
      ))}
    </div>
  );
}

function CategoryWinners({ movies }: { movies: LandingMovie[] }) {
  const winners = DEFAULT_SCORING_RULES.positions
    .map((position) => {
      const axes = SCORE_AXES[position.id] ?? { x: "G", y: "A" };
      const winner = topRowsForPosition(movies, position, axes, 1)[0] ?? null;
      return { axes, position, winner };
    });

  return (
    <div className="ffb-winner-panel" aria-label="2025 category winners">
      {winners.map(({ axes, position, winner }) => (
        <article key={position.id}>
          <p>{position.name}</p>
          {winner ? (
            <>
              <h3>{winner.movie.title}</h3>
              <span>
                <strong>{winner.score.toFixed(1)} pts</strong> · {AXIS_META[axes.x].short}:{" "}
                {formatMovieAxisValue(winner.movie, axes.x)} · {AXIS_META[axes.y].short}:{" "}
                {formatMovieAxisValue(winner.movie, axes.y)}
              </span>
            </>
          ) : (
            <>
              <h3>Loading films</h3>
              <span>2025 data will appear here.</span>
            </>
          )}
        </article>
      ))}
    </div>
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
  const points = pointsForPosition(movies, position, axes);
  const topRows = topRowsForPosition(movies, position, axes, 20);
  const topColumns = [topRows.slice(0, 10), topRows.slice(10)];

  return (
    <article className="ffb-position-card">
      <div className="ffb-position-card-head">
        <div>
          <h3>{position.name}</h3>
          <p>{position.subtitle}</p>
        </div>
        <code>{formatScoringFormula(position.formula)}</code>
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
                    <span className="ffb-ranking-row">
                      <span>{row.movie.title}</span>
                      <small>
                        {AXIS_META[axes.x].short}: {formatMovieAxisValue(row.movie, axes.x)} ·{" "}
                        {AXIS_META[axes.y].short}: {formatMovieAxisValue(row.movie, axes.y)}
                      </small>
                      <strong>{row.score.toFixed(1)} pts</strong>
                    </span>
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
  const width = 480;
  const height = 300;
  const pad = { bottom: 72, left: 84, right: 66, top: 20 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const xDomain = axisDomain(points.map((point) => point.x), axes.x);
  const yDomain = axisDomain(points.map((point) => point.y), axes.y);
  const hoveredPoint = hoveredTitle
    ? points.find((point) => point.movie.title === hoveredTitle)
    : null;

  return (
    <div className="ffb-position-plot" aria-label={`${AXIS_META[axes.x].label} and ${AXIS_META[axes.y].label} plot`}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img">
        <line className="ffb-mini-axis" x1={pad.left} x2={pad.left} y1={pad.top} y2={height - pad.bottom} />
        <line className="ffb-mini-axis" x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} />
        {xDomain.ticks.map((tick, index) => {
          const x = pad.left + xDomain.normalize(tick) * plotWidth;
          const textAnchor = index === 0 ? "start" : index === xDomain.ticks.length - 1 ? "end" : "middle";

          return (
            <g className="ffb-mini-tick" key={`${axes.x}-${index}-${tick}`} transform={`translate(${x} 0)`}>
              <line y1={height - pad.bottom} y2={height - pad.bottom + 4} />
              <text x={0} y={height - pad.bottom + 17} textAnchor={textAnchor}>
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
        <text className="ffb-mini-axis-label" x={pad.left + plotWidth / 2} y={height - 16}>
          {AXIS_META[axes.x].label}
        </text>
        <text
          className="ffb-mini-axis-label"
          transform={`translate(22 ${pad.top + plotHeight / 2}) rotate(-90)`}
        >
          {AXIS_META[axes.y].label}
        </text>
        {points.map((point) => {
          const cx = pad.left + xDomain.normalize(point.x) * plotWidth;
          const cy = pad.top + (1 - yDomain.normalize(point.y)) * plotHeight;
          const key = `${point.movie.title}-${point.score}`;
          const showPoint = () => setHoveredTitle(point.movie.title);
          const clearPoint = () => setHoveredTitle(null);

          return (
            <g key={key}>
              <circle cx={cx} cy={cy} fill={scoreColor(point.score)} r={3.2}>
                <title>{`${point.movie.title}: ${point.score.toFixed(1)} points`}</title>
              </circle>
              <circle
                className="ffb-point-hit"
                cx={cx}
                cy={cy}
                onBlur={clearPoint}
                onClick={showPoint}
                onFocus={showPoint}
                onMouseEnter={showPoint}
                onMouseLeave={clearPoint}
                onMouseOver={showPoint}
                onPointerEnter={showPoint}
                r={8}
                tabIndex={0}
              >
                <title>
                  {`${point.movie.title}: ${point.score.toFixed(1)} points; ${AXIS_META[axes.x].short} ${formatMovieAxisValue(point.movie, axes.x)}; ${AXIS_META[axes.y].short} ${formatMovieAxisValue(point.movie, axes.y)}`}
                </title>
              </circle>
            </g>
          );
        })}
      </svg>
      <div className="ffb-position-hover" aria-live="polite">
        {hoveredPoint ? (
          <>
            <span>
              <b>{hoveredPoint.movie.title}</b>
              {AXIS_META[axes.x].short}: {formatMovieAxisValue(hoveredPoint.movie, axes.x)} ·{" "}
              {AXIS_META[axes.y].short}: {formatMovieAxisValue(hoveredPoint.movie, axes.y)}
            </span>
            <strong>{hoveredPoint.score.toFixed(1)} pts</strong>
          </>
        ) : (
          <>
            <span>
              <b>Hover a film</b>
              Gross, budget, ratings, and score will appear here.
            </span>
            <strong>&nbsp;</strong>
          </>
        )}
      </div>
    </div>
  );
}

function pointsForPosition(
  movies: LandingMovie[],
  position: ScoringPosition,
  axes: { x: ScoreAxisKey; y: ScoreAxisKey },
) {
  return movies
    .map((movie) => pointForMovie(movie, position, axes))
    .filter((point): point is PositionPoint => Boolean(point));
}

function topRowsForPosition(
  movies: LandingMovie[],
  position: ScoringPosition,
  axes: { x: ScoreAxisKey; y: ScoreAxisKey },
  limit: number,
) {
  return pointsForPosition(movies, position, axes)
    .slice()
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
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

function formatMovieAxisValue(movie: LandingMovie, key: ScoreAxisKey) {
  if (key === "A") {
    return movie.letterboxd_avg?.toFixed(2) ?? "-";
  }

  if (key === "B") {
    return formatMoneyShort(movie.budget);
  }

  if (key === "G") {
    return formatMoneyShort(movie.domestic_gross);
  }

  return formatCountShort(movie.letterboxd_ratings);
}

function formatMoneyShort(value: number | null) {
  if (value === null) {
    return "-";
  }

  if (value >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toFixed(1)}B`;
  }

  return `$${Math.round(value / 1_000_000)}M`;
}

function formatCountShort(value: number | null) {
  if (value === null) {
    return "-";
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }

  return `${Math.round(value / 1_000).toLocaleString()}K`;
}

function scoreColor(score: number) {
  const normalized = Math.max(-1, Math.min(1, score / 500));
  const start = hexToRgb(normalized >= 0 ? SCORE_BROWN : SCORE_RED);
  const end = hexToRgb(normalized >= 0 ? SCORE_BLUE : SCORE_BROWN);
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
          Sign in with Google to enter the private league console, manage league membership, record
          player transactions, and review scoring rules.
        </p>
        <div className="ffb-actions">
          <button className="ffb-primary" type="button" onClick={signIn}>
            Sign in with Google
          </button>
          <button type="button" onClick={() => navigateTo("/rules")}>
            Rules
          </button>
        </div>
        {errorMessage ? <p className="ffb-error">{errorMessage}</p> : null}
      </section>
    </main>
  );
}

function RedirectToLeague() {
  useEffect(() => {
    window.history.replaceState(null, "", "/league");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  return null;
}

function ConstructionLock({ children }: { children: ReactNode }) {
  return (
    <div className="ffb-construction-lock">
      <div className="ffb-construction-content" aria-hidden="true" inert>
        {children}
      </div>
      <div className="ffb-construction-overlay" role="status" aria-live="polite">
        <section className="ffb-construction-card">
          <p className="ffb-kicker">Under construction</p>
          <h1>League console paused</h1>
          <p>
            This app is currently under construction. League actions are disabled until the console
            is ready.
          </p>
        </section>
      </div>
    </div>
  );
}

function AppShell() {
  const pathname = usePathname();

  if (pathname === "/") {
    return <LandingPage />;
  }

  if (pathname === "/app") {
    return <RedirectToLeague />;
  }

  if (pathname === "/rules") {
    return <RulesPage />;
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
  const lockIfLeague = (node: ReactNode) =>
    pathname === "/league" ? <ConstructionLock>{node}</ConstructionLock> : node;

  if (pathname !== "/league" && pathname !== "/debug") {
    return <LandingPage />;
  }

  if (clientState.status === "loading") {
    return lockIfLeague(
      <main className="ffb-page ffb-page--center">
        <section className="ffb-login">
          <p className="ffb-kicker">FantasyFilmBall</p>
          <h1>Loading Firebase</h1>
        </section>
      </main>,
    );
  }

  if (clientState.status === "error") {
    return lockIfLeague(
      <main className="ffb-page ffb-page--center">
        <section className="ffb-login">
          <p className="ffb-kicker">FantasyFilmBall</p>
          <h1>Firebase needs configuration</h1>
          <p>{clientState.message}</p>
        </section>
      </main>,
    );
  }

  if (authState.status === "loading") {
    return lockIfLeague(
      <main className="ffb-page ffb-page--center">
        <section className="ffb-login">
          <p className="ffb-kicker">FantasyFilmBall</p>
          <h1>Checking sign-in</h1>
        </section>
      </main>,
    );
  }

  if (authState.status === "signed-out") {
    return lockIfLeague(<LoginPage client={clientState.client} />);
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

  return lockIfLeague(
    <LeagueConsole
      client={clientState.client}
      onNavigate={navigateTo}
      onSignOut={() => signOut(clientState.client.auth)}
      universeState={universeState}
      user={authState.user}
    />,
  );
}

export default AppShell;
