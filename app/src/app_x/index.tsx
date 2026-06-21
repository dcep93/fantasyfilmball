import { useEffect, useMemo, useState } from "react";
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
  increment,
  onValue,
  ref,
  serverTimestamp,
  update,
  type DataSnapshot,
} from "firebase/database";
import { getFirebaseClient, type FirebaseClient } from "./firebaseClient";
import MovieCharts from "./MovieCharts";
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

function getCounter(universeValue: unknown, uid: string): number {
  if (!universeValue || typeof universeValue !== "object") {
    return 0;
  }

  const users = (universeValue as { users?: unknown }).users;
  if (!users || typeof users !== "object") {
    return 0;
  }

  const userRecord = (users as Record<string, unknown>)[uid];
  if (!userRecord || typeof userRecord !== "object") {
    return 0;
  }

  const data = (userRecord as { data?: unknown }).data;
  if (!data || typeof data !== "object") {
    return 0;
  }

  const counter = (data as { counter?: unknown }).counter;
  return typeof counter === "number" ? counter : 0;
}

function navigateTo(pathname: string) {
  window.history.pushState(null, "", pathname);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function LeaguePage() {
  useEffect(() => {
    document.title = "FantasyFilmBall Movie Charts";
  }, []);

  return (
    <main className="ffb-page ffb-page--text">
      <nav className="ffb-nav" aria-label="Primary">
        <button type="button" onClick={() => navigateTo("/")}>
          Scoreboard
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
          Sign in with Google to inspect the project universe and keep your own
          timestamped counter.
        </p>
        <div className="ffb-actions">
          <button className="ffb-primary" type="button" onClick={signIn}>
            Sign in with Google
          </button>
          <button type="button" onClick={() => navigateTo("/league")}>
            League
          </button>
        </div>
        {errorMessage ? <p className="ffb-error">{errorMessage}</p> : null}
      </section>
    </main>
  );
}

function Dashboard({
  client,
  user,
  universeState,
}: {
  client: FirebaseClient;
  user: User;
  universeState: UniverseState;
}) {
  const [isWriting, setIsWriting] = useState(false);
  const [isTestingRules, setIsTestingRules] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [rulesTestMessage, setRulesTestMessage] = useState<string | null>(null);

  const universeText = useMemo(() => {
    if (universeState.status !== "ready") {
      return "";
    }

    return JSON.stringify(universeState.value, null, 2);
  }, [universeState]);

  const counter =
    universeState.status === "ready" ? getCounter(universeState.value, user.uid) : 0;

  async function incrementCounter() {
    setIsWriting(true);
    setWriteError(null);
    setRulesTestMessage(null);

    try {
      await update(ref(client.database, `users/${user.uid}`), {
        data: {
          version: "v1",
          counter: increment(1),
        },
        displayName: user.displayName ?? "Google player",
        email: user.email,
        updatedAt: serverTimestamp(),
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Counter write failed.";
      setWriteError(message);
    } finally {
      setIsWriting(false);
    }
  }

  async function testIllegalWrite() {
    const forbiddenUid =
      user.uid === "rules-sanity-check-other-user"
        ? "rules-sanity-check-someone-else"
        : "rules-sanity-check-other-user";

    setIsTestingRules(true);
    setWriteError(null);
    setRulesTestMessage(null);

    try {
      await update(ref(client.database, `users/${forbiddenUid}`), {
        data: {
          version: "v1",
          counter: increment(1),
        },
        displayName: user.displayName ?? "Google player",
        email: user.email,
        updatedAt: serverTimestamp(),
      });
      setRulesTestMessage(`Unexpectedly wrote to /users/${forbiddenUid}. Tighten rules.`);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Firebase blocked the write.";
      setRulesTestMessage(`Blocked as expected: ${message}`);
    } finally {
      setIsTestingRules(false);
    }
  }

  return (
    <main className="ffb-page">
      <header className="ffb-header">
        <div>
          <p className="ffb-kicker">FantasyFilmBall</p>
          <h1>Universe console</h1>
        </div>
        <nav className="ffb-nav" aria-label="Primary">
          <button type="button" onClick={() => navigateTo("/league")}>
            League
          </button>
          <button type="button" onClick={() => signOut(client.auth)}>
            Sign out
          </button>
        </nav>
      </header>

      <section className="ffb-grid">
        <div className="ffb-panel">
          <p className="ffb-label">Signed in</p>
          <h2>{user.email ?? "Google player"}</h2>
          <p>{user.email}</p>
          <p className="ffb-source">Config source: {client.configSource}</p>
        </div>

        <div className="ffb-panel ffb-counter">
          <p className="ffb-label">Your folder</p>
          <strong>{counter}</strong>
          <button
            className="ffb-primary"
            type="button"
            onClick={incrementCounter}
            disabled={isWriting}
          >
            {isWriting ? "Incrementing" : "Increment counter"}
          </button>
          <button type="button" onClick={testIllegalWrite} disabled={isTestingRules}>
            {isTestingRules ? "Testing rules" : "Test illegal write"}
          </button>
          {writeError ? <p className="ffb-error">{writeError}</p> : null}
          {rulesTestMessage ? <p className="ffb-source">{rulesTestMessage}</p> : null}
        </div>
      </section>

      <section className="ffb-universe" aria-labelledby="universe-title">
        <div className="ffb-universe-head">
          <div>
            <p className="ffb-label">Realtime Database</p>
            <h2 id="universe-title">Project universe</h2>
          </div>
          <span>{universeState.status}</span>
        </div>
        {universeState.status === "error" ? (
          <p className="ffb-error">{universeState.message}</p>
        ) : universeState.status === "ready" ? (
          <pre>{universeText}</pre>
        ) : (
          <p className="ffb-muted">Waiting for Firebase data.</p>
        )}
      </section>
    </main>
  );
}

function AppShell() {
  const pathname = usePathname();
  const clientState = useFirebaseClient();
  const client = clientState.status === "ready" ? clientState.client : null;
  const authState = useAuth(client);
  const user = authState.status === "signed-in" ? authState.user : null;
  const universeState = useUniverse(client, user);

  if (pathname === "/league") {
    return <LeaguePage />;
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

  return (
    <Dashboard
      client={clientState.client}
      user={authState.user}
      universeState={universeState}
    />
  );
}

export default AppShell;
