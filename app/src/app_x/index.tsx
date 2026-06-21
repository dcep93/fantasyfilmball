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

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

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
  commitment: "A cryptographic hash proving a hidden bid payload was fixed before the reveal window.",
  reveal: "Publishing the bid payload so every player can verify it matches the original commitment.",
  waiver: "A 48-hour blind auction created when an unpostered film is dropped.",
  position: "One final scoring slot. Each position has a formula and receives one postered film.",
};

const positionCards = [
  {
    name: "Packed House",
    subtitle: "Rewards high domestic gross and high Letterboxd average.",
    formula: "100 * G * (A - 2)",
  },
  {
    name: "Budget Alchemy",
    subtitle: "Rewards high domestic gross with a moderate production budget.",
    formula: "250 * G / (1 + abs(B - 2))",
  },
  {
    name: "Cult Furnace",
    subtitle: "Rewards high Letterboxd average with substantial rating volume.",
    formula: "150 * (A - 3) * sqrt(R)",
  },
  {
    name: "Rotten Crowd",
    subtitle: "Rewards low Letterboxd average with substantial rating volume.",
    formula: "250 * (3 - A) * sqrt(R)",
  },
  {
    name: "Tiny Thunder",
    subtitle: "Rewards high Letterboxd average and substantial rating volume despite low domestic gross.",
    formula: "200 * (A - 3) * sqrt(R) / (1 + G)",
  },
  {
    name: "Disasterpiece",
    subtitle: "Rewards low Letterboxd average with high production budget.",
    formula: "175 * B * (3 - A)",
  },
];

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
  useEffect(() => {
    document.title = "FantasyFilmBall";
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
        <h2 id="market-title">Bids are sealed, logs are public, reveals are mandatory</h2>
        <p>
          Every film with a known release date enters its initial auction exactly 60 days before
          release. The bid deadline is 6:00 PM ET that day. Each player can hold one active bid per
          film. Submitting, editing, or withdrawing a bid costs 1 stub. Active auction logs do not
          reveal the film, amount, auction id, or drop stipulation. They only show that a player
          submitted, edited, or withdrew a bid by transaction id.
        </p>
        <p>
          Fairness comes from commit-reveal. When you bid, the app commits to a canonical hidden
          payload that includes the film id, auction id, amount, optional drop film, timestamp, and
          salt. The public log stores only a <Term id="commitment">commitment</Term> hash plus an
          encrypted copy of the payload. After the bid deadline, a 48-hour{" "}
          <Term id="reveal">reveal</Term> window begins. Reveals are free. If an active bid is not
          revealed in time, it is invalid and the player pays a 25-stub penalty. The original action
          fees stay spent.
        </p>
        <p>
          A winning bid is valid only if the player has enough stubs and theater room. A bid may
          include a stipulation such as "if I win, drop this unpostered film." If the stipulated
          drop is no longer owned or has already postered, the bid is invalid. Ties go to the
          earliest current bid timestamp, so editing a bid resets its tie priority.
        </p>
      </section>

      <section className="ffb-rule-section" aria-labelledby="privacy-title">
        <p className="ffb-label">Privacy</p>
        <h2 id="privacy-title">Your passphrase unlocks your bid vault</h2>
        <p>
          Google login identifies the player, but it is not used as a secret. Each player manages a
          bid passphrase. The app derives an encryption key locally from that passphrase, the
          Firebase uid, Gmail address, and a random salt. The app stores a verifier so it can tell
          whether the passphrase is correct, but it does not know the passphrase itself. If you
          choose "remember on this device," the passphrase is stored in localStorage for
          convenience. You can show or forget the saved passphrase from the app.
        </p>
        <p>
          Private league contents are blocked until the passphrase is verified. On login, after the
          passphrase gate, the app automatically decrypts and reveals any of your due bids before
          showing the league dashboard. This prevents a player from reading the current league
          state while quietly withholding their own reveal. Static research pages, including the
          movie charts, remain public.
        </p>
      </section>

      <section className="ffb-rule-section" aria-labelledby="moves-title">
        <p className="ffb-label">Roster Moves</p>
        <h2 id="moves-title">Free agents, drops, waivers, and trades</h2>
        <p>
          If a film is unowned, inside its 60-day window, and has no pending initial auction or
          waiver, it can be picked up immediately for 1 stub. Dropping an unpostered film costs 1
          stub and starts a 48-hour <Term id="waiver">waiver</Term> auction. If nobody submits a
          valid revealed waiver bid, the film becomes a free agent again. The app warns users
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
          by everyone in the league. Only the commissioner can publish edits, and those edits are
          recorded as transactions in the commissioner's own Firebase folder. The page also shows
          the top 25 films from last year's data for each position, using the active formulas.
        </p>
        <div className="ffb-position-grid">
          {positionCards.map((position) => (
            <article className="ffb-position-card" key={position.name}>
              <h3>{position.name}</h3>
              <p>{position.subtitle}</p>
              <code>{position.formula}</code>
            </article>
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
          Every operation writes a transaction to the acting player's folder. Transaction ids use
          the form <code>x.y</code>, where <code>x</code> is the player's league id and{" "}
          <code>y</code> is that player's transaction index. The client derives the current league
          state by replaying static season files and all player logs. Invalid transactions remain
          visible with explanations: insufficient stubs, theater full, commitment mismatch,
          unrevealed bid, postered film, stale trade, or invalid drop stipulation.
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
