import { useMemo, useState } from "react";
import type { User } from "firebase/auth";
import { increment, ref, serverTimestamp, update } from "firebase/database";
import type { FirebaseClient } from "./firebaseClient";
import type { UniverseState } from "./LeagueConsole";

type Props = {
  client: FirebaseClient;
  onNavigate: (pathname: string) => void;
  onSignOut: () => void;
  universeState: UniverseState;
  user: User;
};

export default function DebugConsole({
  client,
  onNavigate,
  onSignOut,
  universeState,
  user,
}: Props) {
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
          <p className="ffb-muted">Debug view for the Firebase Realtime Database universe.</p>
        </div>
        <nav className="ffb-nav" aria-label="Primary">
          <button type="button" onClick={() => onNavigate("/")}>
            Rules
          </button>
          <button type="button" onClick={() => onNavigate("/app")}>
            League App
          </button>
          <button type="button" onClick={() => onNavigate("/scoring")}>
            Scoring
          </button>
          <button type="button" onClick={onSignOut}>
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
          <p className="ffb-label">Your debug folder</p>
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
