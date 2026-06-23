import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
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
import { decodeFirebaseValue } from "./firebaseCodec";
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
  letterboxdUrl: string | null;
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
let landingMovieCache: LandingMovie[] | null = null;
let landingMoviePromise: Promise<LandingMovie[]> | null = null;

const tooltipText: Record<string, string> = {
  blindBid: "A private bid amount submitted before the auction deadline. Other players can see that a bid happened, but not its details until the auction ends.",
  categoryFormula: "The math rule for a scoring category. It turns two real-world film stats into that category's point value.",
  domesticGross: "US/Canada theatrical box office dollars only.",
  oscarAllocation: "The order Oscar rankings are resolved. Here it is based on regular-season point standings.",
  freeAgent: "An unowned eligible film that can be claimed immediately because it is inside its 60-day window and has no active auction.",
  letterboxd: "Public Letterboxd average rating and rating count from the movie data file.",
  optimizer: "The app tries possible film-to-category assignments and keeps the lineup with the highest total score.",
  theater: "Your roster. The league config sets how many films it can hold.",
  stubs: "The league currency used to bid on, claim, and drop films after the draft.",
  unreleased: "A film that has not yet reached its first eligible US/Canada theatrical release date. It can still be dropped.",
  waiverAuction: "A 48-hour blind-bid auction created when someone drops an unreleased film.",
  released: "A film is released when it reaches its first eligible US/Canada theatrical release date. Released films are locked.",
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

const CATEGORY_ICON_BY_ID: Record<string, string> = {
  "budget-alchemy": "/category-icons/moneymaker.png",
  "cult-furnace": "/category-icons/letterboom.png",
  disasterpiece: "/category-icons/disasterpiece.png",
  "packed-house": "/category-icons/crowd-favorite.png",
  "rotten-crowd": "/category-icons/letterbust.png",
  "tiny-thunder": "/category-icons/word-of-mouth.png",
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
const DEFAULT_LEAGUE_PATH = "/league/dcep93/1782180560";

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
          value: snapshot.exists() ? decodeFirebaseValue(snapshot.val()) : {},
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
  const [movies, setMovies] = useState<LandingMovie[]>(() => landingMovieCache ?? []);

  useEffect(() => {
    document.title = "FantasyFilmBall";
  }, []);

  useEffect(() => {
    let active = true;

    loadLandingMovies()
      .then((loadedMovies) => {
        if (active) {
          setMovies(loadedMovies);
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
          <button type="button" onClick={() => navigateTo("/rules")}>
            Rules
          </button>
          <button type="button" onClick={() => navigateTo("/league")}>
            Enter League
          </button>
        </nav>
        <p className="ffb-kicker">FantasyFilmBall</p>
        <h1>Fantasy sports for summer movies.</h1>
      </header>

      <section className="ffb-season-banner" aria-label="Season timing">
        <p className="ffb-label">Pilot Season</p>
        <p>
          <span>In the future, FantasyFilmBall will run from May 1 - August 31.</span>
          <span>
            While we work out issues during the first season, it will run from July 14 - November 8,
            2026.
          </span>
        </p>
      </section>

      <section className="ffb-landing-hook" aria-label="How the game works">
        <h2>The best pick is not always the biggest hit.</h2>
        <p>
          Draft movies before they open, bid on the ones your friends missed, then let real box
          office and Letterboxd data decide which films fit the scoring categories best. A famous
          blockbuster can matter. So can a tiny breakout, a cult favorite, or a beautiful disaster.
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
            After nominations are announced, each player ranks Oscar-nominated films. The
            postseason winner is based on Academy Award wins.
          </p>
        </article>
      </section>

      <section className="ffb-rule-section" aria-labelledby="start-title">
        <p className="ffb-label">Start</p>
        <h2 id="start-title">Create or join a private league</h2>
        <div className="ffb-actions">
          <button type="button" onClick={() => navigateTo("/rules")}>
            Rules
          </button>
          <button type="button" onClick={() => navigateTo("/league")}>
            Enter League
          </button>
        </div>
      </section>

      <section className="ffb-rule-section" aria-labelledby="sample-title">
        <p className="ffb-label">Default Scoring Categories</p>
        <h2 id="sample-title">How last year's movies would have scored</h2>
        <p>
          These winners and charts use 2025 film data as a preview of the recommended default
          categories. The colors run from weak category fit to neutral to strong category fit.
        </p>
        <ChartLegend />
        <ChartInputLegend />
        <CategoryWinners movies={movies} />
        <div className="ffb-position-grid">
          {DEFAULT_SCORING_RULES.positions.map((position) => (
            <PositionShowcase key={position.id} movies={movies} position={position} />
          ))}
        </div>
        <div className="ffb-bottom-cta">
          <p className="ffb-label">Ready?</p>
          <h2>Start building your theater.</h2>
          <div className="ffb-actions">
            <button type="button" onClick={() => navigateTo("/rules")}>
              Rules
            </button>
            <button type="button" onClick={() => navigateTo("/league")}>
              Enter League
            </button>
          </div>
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
        <div className="ffb-rules-hero-lockup">
          <h1 className="ffb-rules-image-title">
            <img alt="Da Rules" height="1000" src="/da-rules.png" width="1000" />
          </h1>
          <div className="ffb-rules-hero-copy">
            <p className="ffb-landing-lede">
              A FantasyFilmBall league is a competition to build the best theater of movies, locked
              upon release. Films are scored according to special categories, which don't always
              correspond to a traditionally successful film.
            </p>
            <p className="ffb-rules-goal-panel">
              The goal of this game is to encourage its users to watch more movies, new releases
              especially.
            </p>
          </div>
        </div>
      </header>

      <nav className="ffb-rules-toc" aria-label="Rules sections">
        <a href="#goal">Goal</a>
        <a href="#season">Season</a>
        <a href="#acquisition">Acquisition</a>
        <a href="#theater">Theater</a>
        <a href="#scoring">Scoring</a>
        <a href="#example">Example</a>
        <a href="#postseason">Postseason</a>
        <a href="#app-transparency">Move Log</a>
      </nav>

      <section id="goal" className="ffb-rule-section" aria-labelledby="goal-title">
        <p className="ffb-label">Goal</p>
        <h2 id="goal-title">What makes a film valuable</h2>
        <p>
          A valuable film is not always the biggest hit. It is a film that fits a scoring category
          nicely. <Term id="domesticGross">Domestic gross</Term>, budgets, and{" "}
          <Term id="letterboxd">Letterboxd ratings</Term> decide category value. One category may
          reward a blockbuster with strong audience response. Another may reward a cheap movie that
          attracted heavy attention. Another may reward an expensive movie that audiences disliked.
          Your job is to build a theater that covers those category shapes better than your friends
          do.
        </p>
        <p>
          Each category uses exactly two real-world inputs, among domestic box office, production
          budget, Letterboxd average, and Letterboxd rating count. The commissioner may edit the
          category names, descriptions, formulas, and number of scoring categories for a league,
          but the default categories are the recommended starting point.
        </p>
      </section>

      <section id="season" className="ffb-rule-section" aria-labelledby="season-title">
        <p className="ffb-label">Season</p>
        <h2 id="season-title">Which films count</h2>
        <p>
          The regular season covers a fixed theatrical window chosen for the league. By default it
          is the summer movie season, May 1 through August 31. A film is eligible only if it has a
          public US/Canada theatrical release in that window. Streaming-only titles do not count.
          Festival screenings do not count unless they lead to a public theatrical run.
        </p>
        <p>
          A film becomes <Term id="released">released</Term> on its first eligible theatrical
          release date. A released film is locked in its current theater. It will be auto assigned
          to a category that maximizes your total score.
        </p>
      </section>

      <section id="acquisition" className="ffb-rule-section" aria-labelledby="acquisition-title">
        <p className="ffb-label">Acquisition</p>
        <h2 id="acquisition-title">How players get films</h2>
        <p>
          A league starts with a preseason snake draft. Drafted films enter the player's{" "}
          <Term id="theater">theater</Term>. The league config sets the max number of films in a
          theater and the number of films drafted.
        </p>
        <p>
          After the draft, undrafted films are acquired using <Term id="stubs">stubs</Term> through{" "}
          <Term id="blindBid">blind bids</Term> or <Term id="freeAgent">free-agent pickups</Term>.
          An initial auction opens 60 days before a film's eligible release. Its bid deadline is
          6:00 PM ET on that day. A dropped <Term id="unreleased">unreleased</Term> film goes to a
          48-hour <Term id="waiverAuction">waiver auction</Term>. An unowned film inside its 60-day
          window, with no active auction or waiver, can be picked up immediately.
        </p>
        <p>
          A bid may include a drop stipulation: if the bid wins, the named{" "}
          <Term id="unreleased">unreleased</Term> film is dropped to make room. A bid is valid only
          if the player can pay it and can fit the film in the theater after applying any valid drop
          stipulation. Ties go to the earliest current bid timestamp.
        </p>
        <p>
          Stubs are the season budget for acquiring movies after the draft. Each player starts
          with 1000 stubs. Draft picks and page views are free. Submitting or editing a bid costs
          1 stub, to prevent Jon and Bu from spamming. Free-agent pickups and drops also cost 1
          stub so players cannot churn the market without consequence.
        </p>
      </section>

      <section id="theater" className="ffb-rule-section" aria-labelledby="theater-title">
        <p className="ffb-label">Theater</p>
        <h2 id="theater-title">How rosters change</h2>
        <p>
          A player's theater holds the films that player controls. A player may only drop an{" "}
          <Term id="unreleased">unreleased</Term> film. If a drop creates a{" "}
          <Term id="waiverAuction">waiver auction</Term>, other players may bid during the waiver
          window.
        </p>
      </section>

      <section id="scoring" className="ffb-rule-section" aria-labelledby="scoring-title">
        <p className="ffb-label">Scoring</p>
        <h2 id="scoring-title">How final scoring works</h2>
        <p>
          At season's end, the app auto-assigns released films to the league's scoring categories.
          One film may fill one category for that player. A category score comes from that{" "}
          <Term id="categoryFormula">category's formula</Term> and the film's real-world data.
        </p>
        <p>
          The <Term id="optimizer">optimizer</Term> checks every one-to-one film/category assignment
          and chooses the lineup with the highest total score. If a player has fewer released films
          than scoring categories, the remaining categories are empty. Ties are settled by the best
          single category score, then by film title.
        </p>
        <div className="ffb-typical-callout">
          <p className="ffb-label">Typical Setup</p>
          <p>
            A typical player holds 10 films, with 6 scoring categories, meaning 4 films will not
            contribute to that player's total score.
          </p>
        </div>
        <p>The recommended default categories and formulas are:</p>
        <FormulaGlossary />
        <DefaultCategoryList />
        <p>
          The{" "}
          <a
            href="/"
            onClick={(event) => {
              event.preventDefault();
              navigateTo("/");
            }}
          >
            landing page
          </a>{" "}
          shows the default categories against last year's real-world data. Use that as a preview
          of the recommended scoring shape before changing league formulas.
        </p>
      </section>

      <section id="example" className="ffb-rule-section" aria-labelledby="example-title">
        <p className="ffb-label">Example</p>
        <h2 id="example-title">How a season feels</h2>
        <p>
          You draft one likely blockbuster, spend stubs on a horror sequel that looks cheap enough
          to overperform, and claim a smaller film after everyone else ignores its trailer. Once
          those movies release, they stay in your theater.
        </p>
        <p>
          At the end of the season, the app might place the blockbuster into Crowd Favorite, the
          horror sequel into Moneymaker, and the smaller film into Word of Mouth. Another film
          in your theater might sit out because it does not improve your best six-category total.
        </p>
        <p>
          Months later, when Oscar nominations are announced, you rank your choices. Since you lost
          to Dan and got second place in the regular season, you are guaranteed one of your top two
          choices.
        </p>
      </section>

      <section id="postseason" className="ffb-rule-section" aria-labelledby="postseason-title">
        <p className="ffb-label">Postseason</p>
        <h2 id="postseason-title">The Oscars become the playoff board</h2>
        <p>
          When Oscar nominations are announced, each player submits a ranked list of Oscar-nominated
          films. Rankings cannot be edited after the deadline. Rankings are due 48 hours after
          nominations are announced. After that deadline, films are assigned in regular-season point
          order: the regular-season winner receives the highest-ranked available film on their list,
          then the rest of the league follows in regular-season point order.
        </p>
        <p>
          Each player receives one nominated movie. The postseason winner is the player whose
          assigned film wins the most Academy Awards. Ties go to regular-season point rank. Oscar
          picks do not change regular-season rosters, locked films, or scoring positions.
        </p>
      </section>

      <section id="app-transparency" className="ffb-rule-section" aria-labelledby="app-transparency-title">
        <p className="ffb-label">Move Log</p>
        <h2 id="app-transparency-title">How moves are recorded</h2>
        <p>
          Google login identifies each user. A <Term id="commissioner">commissioner</Term> can
          start one or more leagues. The commissioner accepts members, kicks members, and edits the
          scoring categories.
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
        <p>
          The app uses Firebase Realtime Database as a shared log store, not as a custom backend.
          Commissioner decisions write to the commissioner's folder. Player actions write to the
          acting player's folder. Transaction ids use the form <code>x.y</code>, where{" "}
          <code>x</code> is the commissioner-assigned player id and <code>y</code> is that player's
          transaction index. The client derives league state from the commissioner-owned league
          object, static movie files, and active member logs.
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
          <CategoryIcon position={position} />
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

function CategoryHeader({
  detail,
  position,
}: {
  detail: ReactNode;
  position: ScoringPosition;
}) {
  return (
    <div className="ffb-category-header">
      <CategoryIcon position={position} />
      <div>
        <p className="ffb-category-name">{position.name}</p>
        {detail}
      </div>
    </div>
  );
}

function CategoryIcon({ position }: { position: ScoringPosition }) {
  const iconSrc = CATEGORY_ICON_BY_ID[position.id];

  return iconSrc ? (
    <img
      alt=""
      aria-hidden="true"
      className="ffb-category-icon"
      height="512"
      src={iconSrc}
      width="512"
    />
  ) : null;
}

function ChartLegend() {
  return (
    <div className="ffb-chart-legend" aria-label="Chart color scale">
      <span>
        <i className="ffb-legend-red" /> weaker fit
      </span>
      <span>
        <i className="ffb-legend-brown" /> neutral
      </span>
      <span>
        <i className="ffb-legend-blue" /> stronger fit
      </span>
    </div>
  );
}

function ChartInputLegend() {
  return (
    <div className="ffb-chart-inputs" aria-label="Chart inputs">
      <span>
        <strong>Gross</strong> US/Canada box office
      </span>
      <span>
        <strong>Budget</strong> production budget
      </span>
      <span>
        <strong>LB Avg</strong> Letterboxd average
      </span>
      <span>
        <strong>LB Ratings</strong> Letterboxd rating count
      </span>
    </div>
  );
}

function FormulaGlossary() {
  return (
    <div className="ffb-formula-glossary" aria-label="Formula variables">
      <span>
        <strong>DOMESTIC_GROSS</strong> US/Canada box office dollars
      </span>
      <span>
        <strong>PRODUCTION_BUDGET</strong> budget dollars
      </span>
      <span>
        <strong>LETTERBOXD_AVERAGE</strong> average rating
      </span>
      <span>
        <strong>LETTERBOXD_RATING_COUNT</strong> number of ratings
      </span>
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
    <section className="ffb-winner-panel" aria-label="2025 category winners">
      <div className="ffb-winner-panel-intro">
        <p className="ffb-label">2025 Winners</p>
        <p>Each card shows the top film from last year's data for that default category.</p>
      </div>
      <div className="ffb-winner-panel-grid">
        {winners.map(({ axes, position, winner }) => (
          <article key={position.id}>
            <div className="ffb-winner-card-head">
              <CategoryIcon position={position} />
              <div>
                <p className="ffb-category-name">{position.name}</p>
                <h3>{winner ? winner.movie.title : "Loading films"}</h3>
              </div>
            </div>
            <span className="ffb-winner-meta">
              {winner ? (
                <>
                  <strong>{winner.score.toFixed(1)} pts</strong> · {AXIS_META[axes.x].short}:{" "}
                  {formatMovieAxisValue(winner.movie, axes.x)} · {AXIS_META[axes.y].short}:{" "}
                  {formatMovieAxisValue(winner.movie, axes.y)}
                </>
              ) : (
                "2025 data will appear here."
              )}
            </span>
          </article>
        ))}
      </div>
    </section>
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

  return (
    <article className="ffb-position-card">
      <div className="ffb-position-card-head">
        <CategoryHeader detail={<p>{position.subtitle}</p>} position={position} />
        <code>{formatScoringFormula(position.formula)}</code>
      </div>
      <PositionScatter axes={axes} points={points} />
      <div className="ffb-position-ranking">
        <p className="ffb-label">2025 Top 20</p>
        {topRows.length > 0 ? (
          <div className="ffb-position-ranking-columns">
            <ol>
              {topRows.map((row) => (
                <li key={`${position.id}-${row.movie.title}`}>
                  <span className="ffb-ranking-row">
                    {row.movie.letterboxdUrl ? (
                      <a href={row.movie.letterboxdUrl} rel="noreferrer" target="_blank">
                        {row.movie.title}
                      </a>
                    ) : (
                      <span>{row.movie.title}</span>
                    )}
                    <small>
                      {AXIS_META[axes.x].short}: {formatMovieAxisValue(row.movie, axes.x)} ·{" "}
                      {AXIS_META[axes.y].short}: {formatMovieAxisValue(row.movie, axes.y)}
                    </small>
                    <strong>{row.score.toFixed(1)} pts</strong>
                  </span>
                </li>
              ))}
            </ol>
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
  const height = 240;
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
          const openPoint = () => openLetterboxd(point.movie);
          const openPointFromKeyboard = (event: KeyboardEvent<SVGCircleElement>) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openPoint();
            }
          };

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
                onClick={openPoint}
                onFocus={showPoint}
                onKeyDown={openPointFromKeyboard}
                onMouseEnter={showPoint}
                onMouseLeave={clearPoint}
                onMouseOver={showPoint}
                onPointerEnter={showPoint}
                r={8}
                aria-label={
                  point.movie.letterboxdUrl
                    ? `Open ${point.movie.title} on Letterboxd`
                    : undefined
                }
                role={point.movie.letterboxdUrl ? "link" : undefined}
                tabIndex={point.movie.letterboxdUrl ? 0 : -1}
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

function openLetterboxd(movie: LandingMovie) {
  if (!movie.letterboxdUrl) {
    return;
  }

  window.open(movie.letterboxdUrl, "_blank", "noopener,noreferrer");
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
    return formatCountShort(value * 100_000);
  }

  if (key === "B" || key === "G") {
    return formatMoneyShort(value * 100_000_000);
  }

  return value.toLocaleString();
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

function loadLandingMovies(): Promise<LandingMovie[]> {
  if (landingMovieCache) {
    return Promise.resolve(landingMovieCache);
  }

  landingMoviePromise ??= fetch(MOVIE_DATA_URL)
    .then((response) => (response.ok ? response.text() : ""))
    .then((text) => {
      const movies = text ? parseCsv(text).map(toLandingMovie).filter((movie) => movie.title) : [];
      landingMovieCache = movies;
      return movies;
    })
    .catch(() => {
      landingMovieCache = [];
      return [];
    });

  return landingMoviePromise;
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
    letterboxdUrl: letterboxdUrl(row.letterboxd_slug),
    title: row.title?.trim() ?? "",
  };
}

function letterboxdUrl(slug: string | undefined): string | null {
  const cleanSlug = slug?.trim().replace(/^\/+|\/+$/g, "");

  return cleanSlug ? `https://letterboxd.com/${cleanSlug}/` : null;
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
  const [isReady, setIsReady] = useState(false);

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
      } catch (redirectError: unknown) {
        setErrorMessage(formatAuthError(redirectError, error));
      }
    }
  }

  return (
    <main className="ffb-page ffb-page--center">
      <section className="ffb-login" aria-label="FantasyFilmBall sign in">
        <p className="ffb-kicker">FantasyFilmBall</p>
        <label className="ffb-oath-check">
          <input
            checked={isReady}
            onChange={(event) => setIsReady(event.target.checked)}
            type="checkbox"
          />
          <span>
            I'm <em>ready</em> to join and <strong>I WILL NOT CHEAT</strong>
          </span>
        </label>
        <div className="ffb-actions">
          <button className="ffb-primary" disabled={!isReady} type="button" onClick={signIn}>
            Sign in with Google
          </button>
          <button type="button" onClick={() => navigateTo("/")}>
            Home
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

function formatAuthError(error: unknown, fallback?: unknown) {
  const message = errorMessage(error) ?? errorMessage(fallback) ?? "Google sign-in failed.";
  if (message.includes("auth/unauthorized-domain")) {
    return `Firebase Auth does not allow this domain yet. Add ${window.location.hostname} in Firebase Console > Authentication > Settings > Authorized domains.`;
  }

  return message;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : null;
}

function AppShell() {
  const pathname = usePathname();

  if (pathname === "/") {
    return <LandingPage />;
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

  useEffect(() => {
    if (authState.status === "signed-in" && pathname === "/league") {
      navigateTo(DEFAULT_LEAGUE_PATH);
    }
  }, [authState.status, pathname]);

  async function signOutToLeague() {
    if (clientState.status !== "ready") {
      navigateTo("/league");
      return;
    }

    await signOut(clientState.client.auth);
    navigateTo("/league");
  }

  if (!pathname.startsWith("/league") && pathname !== "/debug") {
    return <LandingPage />;
  }

  if (clientState.status === "loading") {
    return <main className="ffb-page" aria-label="Loading FantasyFilmBall" />;
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
    return <main className="ffb-page" aria-label="Checking sign-in" />;
  }

  if (authState.status === "signed-out") {
    return <LoginPage client={clientState.client} />;
  }

  if (pathname === "/league") {
    return <main className="ffb-page" aria-label="Opening league" />;
  }

  if (pathname === "/debug") {
    return (
      <DebugConsole
        client={clientState.client}
        onNavigate={navigateTo}
        onSignOut={signOutToLeague}
        universeState={universeState}
        user={authState.user}
      />
    );
  }

  return (
    <LeagueConsole
      client={clientState.client}
      pathname={pathname}
      onNavigate={navigateTo}
      onSignOut={signOutToLeague}
      universeState={universeState}
      user={authState.user}
    />
  );
}

export default AppShell;
