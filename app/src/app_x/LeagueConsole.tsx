import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { User } from "firebase/auth";
import { ref, serverTimestamp, update } from "firebase/database";
import { encodeFirebaseValue } from "./firebaseCodec";
import type { FirebaseClient } from "./firebaseClient";
import { deriveLeagueSnapshot } from "./leagueState";
import { resolveLeagueSnapshot, snapshotIdFor, type SnapshotResolution } from "./leagueSnapshots";
import { ScoringRulesContent } from "./ScoringRulesContent";
import {
  commissionerUsername,
  decodeBidPayload,
  findLeagueSummaryByPath,
  getUsers,
  leaguePath,
  makeDefaultLeague,
  membershipKey,
  nextTxnId,
  obfuscateBidPayload,
  readLeagueSummaries,
  readMemberships,
  readOwnTransactions,
  readTransactions,
  usernameFromEmail,
  type BidPayload,
  type LeagueMember,
  type LeagueSummary,
  type LeagueTransaction,
  type UniverseState,
} from "./leagueModel";
import { loadTrackedMovieFile, type TrackedMovieFile } from "./movieData";

type LeagueConsoleProps = {
  client: FirebaseClient;
  pathname: string;
  onNavigate: (pathname: string) => void;
  onSignOut: () => void;
  universeState: UniverseState;
  user: User;
};

type LeagueConsoleView = "league" | "scoring" | "available";
type LeagueRoute = {
  commissionerUsername: string;
  leagueId: string;
  playerUsername: string | null;
  section: LeagueConsoleView | "theater";
};

const EMPTY_UNIVERSE = {};

function timestamp() {
  return Date.now();
}

function updateEncoded(client: FirebaseClient, path: string, value: Record<string, unknown>) {
  return update(ref(client.database, path), encodeFirebaseValue(value) as Record<string, unknown>);
}

function leagueRoute(pathname: string): LeagueRoute | null {
  const [, root, commissioner, leagueId, section, playerUsername] = pathname.split("/");
  if (root !== "league" || !commissioner || !leagueId) {
    return null;
  }

  const routeSection =
    section === "scoring" || section === "available" || section === "theater" ? section : "league";

  return {
    commissionerUsername: decodeURIComponent(commissioner),
    leagueId: decodeURIComponent(leagueId),
    playerUsername:
      routeSection === "theater" && playerUsername ? decodeURIComponent(playerUsername) : null,
    section: routeSection,
  };
}

export default function LeagueConsole({
  client,
  pathname,
  onNavigate,
  onSignOut,
  universeState,
  user,
}: LeagueConsoleProps) {
  const [view, setView] = useState<LeagueConsoleView>("league");
  const accountLabel = usernameFromEmail(user.email, "player");
  const [movieFile, setMovieFile] = useState<TrackedMovieFile | null>(null);
  const [movieFileError, setMovieFileError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [readyRouteKey, setReadyRouteKey] = useState<string | null>(null);
  const universeValue = useMemo(
    () => (universeState.status === "ready" ? universeState.value : EMPTY_UNIVERSE),
    [universeState],
  );
  const routeLeague = useMemo(() => leagueRoute(pathname), [pathname]);
  const selectedLeague = useMemo(
    () =>
      routeLeague
        ? findLeagueSummaryByPath(universeValue, routeLeague.commissionerUsername, routeLeague.leagueId)
        : null,
    [routeLeague, universeValue],
  );
  const routeKey = routeLeague ? `${routeLeague.commissionerUsername}/${routeLeague.leagueId}` : null;
  const directRouteReady = !routeKey || readyRouteKey === routeKey;
  const leagueMenuLabel = selectedLeague
    ? `${commissionerUsername(selectedLeague)}/${selectedLeague.league.leagueId}`
    : null;
  const activeView: LeagueConsoleView = routeLeague
    ? routeLeague.section === "scoring" || routeLeague.section === "available"
      ? routeLeague.section
      : "league"
    : view;

  function changeView(nextView: LeagueConsoleView) {
    setView(nextView);
    if (!selectedLeague) {
      return;
    }

    const basePath = leaguePath(selectedLeague);
    onNavigate(nextView === "league" ? basePath : `${basePath}/${nextView}`);
  }

  useEffect(() => {
    if (!routeKey) {
      return;
    }

    const timeoutId = window.setTimeout(() => setReadyRouteKey(routeKey), 400);
    return () => window.clearTimeout(timeoutId);
  }, [routeKey]);

  useEffect(() => {
    let active = true;
    loadTrackedMovieFile()
      .then((trackedMovies) => {
        if (active) {
          setMovieFile(trackedMovies);
          setMovieFileError(null);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setMovieFileError(
            error instanceof Error ? error.message : "Unable to load tracked movie data.",
          );
        }
      });

    return () => {
      active = false;
    };
  }, []);

  if (universeState.status === "error") {
    return (
      <Shell
        activeView={activeView}
        accountLabel={accountLabel}
        leagueMenuLabel={leagueMenuLabel}
        title="League Home"
        onNavigate={onNavigate}
        onSignOut={onSignOut}
        onViewChange={changeView}
      >
        <section className="ffb-panel">
          <p className="ffb-label">Realtime Database</p>
          <h2>Unable to load league</h2>
          <p className="ffb-error">{universeState.message}</p>
        </section>
      </Shell>
    );
  }

  if (universeState.status !== "ready") {
    return <main className="ffb-page" aria-label="Loading league" />;
  }

  if (!movieFile) {
    if (!movieFileError) {
      return <main className="ffb-page" aria-label="Loading movie data" />;
    }

    return (
      <Shell activeView={activeView} accountLabel={accountLabel} leagueMenuLabel={leagueMenuLabel} title="League picker" onNavigate={onNavigate} onSignOut={onSignOut} onViewChange={changeView}>
        <section className="ffb-panel">
          <p className="ffb-label">Tracked movies</p>
          <h2>Unable to load movies</h2>
          <p className="ffb-error">{movieFileError}</p>
        </section>
      </Shell>
    );
  }

  if (routeLeague && !selectedLeague && !directRouteReady) {
    return <main className="ffb-page" aria-label="Loading league" />;
  }

  return (
    <Shell
      activeView={activeView}
      accountLabel={accountLabel}
      leagueMenuLabel={leagueMenuLabel}
      title={selectedLeague ? selectedLeague.league.name : "League picker"}
      onNavigate={onNavigate}
      onSignOut={onSignOut}
      onViewChange={changeView}
    >
      {message ? <p className="ffb-toast">{message}</p> : null}
      {activeView === "scoring" ? (
        <ScoringRulesContent
          client={client}
          onChangeLeague={() => {
            onNavigate("/league");
            setView("league");
          }}
          onOpenLeague={() => changeView("league")}
          selectedLeague={selectedLeague}
          user={user}
        />
      ) : selectedLeague ? (
        <LeagueDashboard
          client={client}
          onClearSelection={() => {
            onNavigate("/league");
          }}
          movieFile={movieFile}
          onMessage={setMessage}
          onNavigate={onNavigate}
          routeSection={routeLeague?.section ?? "league"}
          playerUsername={routeLeague?.playerUsername ?? null}
          summary={selectedLeague}
          universeValue={universeValue}
          user={user}
        />
      ) : (
        <LeagueDiscovery
          client={client}
          onMessage={setMessage}
          onNavigate={onNavigate}
          routeLeague={routeLeague}
          movieFile={movieFile}
          universeValue={universeValue}
          user={user}
        />
      )}
    </Shell>
  );
}

function Shell({
  accountLabel,
  activeView,
  children,
  leagueMenuLabel,
  onNavigate,
  onSignOut,
  onViewChange,
  title,
}: {
  accountLabel: string;
  activeView: LeagueConsoleView;
  children?: ReactNode;
  leagueMenuLabel: string | null;
  onNavigate: (pathname: string) => void;
  onSignOut: () => void;
  onViewChange: (view: LeagueConsoleView) => void;
  title: string;
}) {
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isAccountMenuOpen) {
      return;
    }

    function closeOnOutsidePointer(event: PointerEvent) {
      if (
        accountMenuRef.current &&
        event.target instanceof Node &&
        !accountMenuRef.current.contains(event.target)
      ) {
        setIsAccountMenuOpen(false);
      }
    }

    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [isAccountMenuOpen]);

  return (
    <main className="ffb-page">
      <header className="ffb-header">
        <div>
          <p className="ffb-kicker">{title === "League picker" ? "FantasyFilmBall" : "League Home"}</p>
          <h1>{title}</h1>
        </div>
        <nav className="ffb-app-nav" aria-label={title}>
          <div className="ffb-app-tools" role="group" aria-label="Account and help">
            <div className="ffb-account-menu" ref={accountMenuRef}>
              <button
                aria-expanded={isAccountMenuOpen}
                className="ffb-account-chip"
                type="button"
                onClick={() => setIsAccountMenuOpen((isOpen) => !isOpen)}
              >
                {accountLabel}
              </button>
              {isAccountMenuOpen ? (
                <div className="ffb-account-menu-popover" role="menu">
                  <div className="ffb-account-menu-row" role="menuitem">
                    {leagueMenuLabel ?? "No league selected"}
                  </div>
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setIsAccountMenuOpen(false);
                      onNavigate("/league");
                    }}
                  >
                    League Picker
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setIsAccountMenuOpen(false);
                      onSignOut();
                    }}
                  >
                    Sign Out
                  </button>
                </div>
              ) : null}
            </div>
            <button type="button" onClick={() => onNavigate("/rules")}>
              Rules
            </button>
          </div>
          <div className="ffb-app-tabs" role="group" aria-label="League views">
            <button
              aria-pressed={activeView === "league"}
              type="button"
              onClick={() => onViewChange("league")}
            >
              League
            </button>
            <button
              aria-pressed={activeView === "scoring"}
              type="button"
              onClick={() => onViewChange("scoring")}
            >
              Scoring
            </button>
            <button
              aria-pressed={activeView === "available"}
              type="button"
              onClick={() => onViewChange("available")}
            >
              Available
            </button>
          </div>
        </nav>
      </header>
      {children}
    </main>
  );
}

function LeagueDiscovery({
  client,
  onMessage,
  onNavigate,
  movieFile,
  routeLeague,
  universeValue,
  user,
}: {
  client: FirebaseClient;
  onMessage: (message: string | null) => void;
  onNavigate: (pathname: string) => void;
  movieFile: TrackedMovieFile;
  routeLeague: LeagueRoute | null;
  universeValue: unknown;
  user: User;
}) {
  const [leagueName, setLeagueName] = useState("FantasyFilmBall");
  const [isWriting, setIsWriting] = useState(false);
  const memberships = readMemberships(universeValue, user.uid);
  const ownLeagues = readLeagueSummaries(universeValue).filter(
    (summary) => Boolean(memberships[summary.membershipKey]) || summary.commissionerUid === user.uid,
  );
  const routeMatches = routeLeague
    ? readLeagueSummaries(universeValue, routeLeague.leagueId).filter(
        (summary) => commissionerUsername(summary) === routeLeague.commissionerUsername,
      )
    : [];

  async function startLeague(event: FormEvent) {
    event.preventDefault();

    setIsWriting(true);
    onMessage(null);

    try {
      const now = timestamp();
      const cleanLeagueId = String(Math.floor(now / 1000));
      const league = makeDefaultLeague(user, leagueName, cleanLeagueId);
      const key = membershipKey(user.uid, cleanLeagueId);
      const snapshot = deriveLeagueSnapshot({
        generatedByUid: user.uid,
        league,
        movieFile,
        now,
        transactions: [],
      });

      await updateEncoded(client, `users/${user.uid}`, {
        email: user.email,
        [`leagueMemberships/${key}`]: {
          commissionerUid: user.uid,
          leagueId: cleanLeagueId,
          requestedAt: timestamp(),
          status: "active",
          updatedAt: timestamp(),
        },
        [`leagues/${cleanLeagueId}`]: league,
        [`snapshots/${key}/${snapshotIdFor(snapshot)}`]: snapshot,
        updatedAt: serverTimestamp(),
      });

      onNavigate(leaguePath({
        commissionerEmail: user.email,
        commissionerLabel: usernameFromEmail(league.members[user.uid]?.email ?? user.email, "commissioner"),
        league,
      }));
      onMessage(`Started ${league.name}.`);
    } catch (error: unknown) {
      onMessage(error instanceof Error ? error.message : "Could not start league.");
    } finally {
      setIsWriting(false);
    }
  }

  async function requestJoin(summary: LeagueSummary) {
    setIsWriting(true);
    onMessage(null);

    try {
      const key = summary.membershipKey;
      const now = timestamp();

      await updateEncoded(client, `users/${user.uid}`, {
        email: user.email,
        [`leagueMemberships/${key}`]: {
          commissionerUid: summary.commissionerUid,
          leagueId: summary.league.leagueId,
          requestedAt: now,
          status: "requested",
          updatedAt: now,
        },
        updatedAt: serverTimestamp(),
      });
      onNavigate(leaguePath(summary));
      onMessage(`Requested to join ${summary.league.name}.`);
    } catch (error: unknown) {
      onMessage(error instanceof Error ? error.message : "Could not request to join.");
    } finally {
      setIsWriting(false);
    }
  }

  const list = routeLeague ? (
    <LeagueList
      emptyText="No league exists at this path."
      memberships={memberships}
      onRequestJoin={requestJoin}
      onNavigate={onNavigate}
      title="Direct league"
      isWriting={isWriting}
      leagues={routeMatches}
      user={user}
    />
  ) : (
    <LeagueList
      emptyText="You are not in any leagues yet."
      memberships={memberships}
      onRequestJoin={requestJoin}
      onNavigate={onNavigate}
      title="Your leagues"
      isWriting={isWriting}
      leagues={ownLeagues}
      user={user}
    />
  );

  return (
    <section className="ffb-picker-grid">
      {list}
      <div>
        <form className="ffb-panel ffb-form" onSubmit={startLeague}>
          <p className="ffb-label">Commissioner</p>
          <h2>Start a league</h2>
          <label>
            League name
            <input value={leagueName} onChange={(event) => setLeagueName(event.target.value)} />
          </label>
          <button className="ffb-primary" disabled={isWriting} type="submit">
            {isWriting ? "Starting" : "Start League"}
          </button>
        </form>
      </div>
    </section>
  );
}

function LeagueList({
  emptyText,
  isWriting,
  leagues,
  memberships,
  onNavigate,
  onRequestJoin,
  title,
  user,
}: {
  emptyText: string;
  isWriting: boolean;
  leagues: LeagueSummary[];
  memberships: ReturnType<typeof readMemberships>;
  onNavigate: (pathname: string) => void;
  onRequestJoin: (summary: LeagueSummary) => Promise<void>;
  title: string;
  user: User;
}) {
  return (
    <section className="ffb-log" aria-labelledby={`${title.replace(/\W+/g, "-")}-title`}>
      <h2 className="ffb-sr-only" id={`${title.replace(/\W+/g, "-")}-title`}>{title}</h2>
      <div className="ffb-card-list">
        {leagues.length > 0 ? (
          leagues.map((summary) => {
            const membership = memberships[summary.membershipKey];
            const member = summary.league.members[user.uid];
            const isKicked = Boolean(summary.league.kicked[user.uid]);
            const isActive = Boolean(member);
            const route = `${commissionerUsername(summary)}/${summary.league.leagueId}`;
            const createdDate = new Date(summary.league.createdAt).toLocaleDateString();

            return (
              <article className="ffb-league-row" key={summary.membershipKey}>
                <button
                  className="ffb-league-row-button"
                  type="button"
                  onClick={() => onNavigate(leaguePath(summary))}
                >
                  {summary.league.name} · {route} · {createdDate}
                </button>
                {!isActive || isKicked ? (
                  <div className="ffb-actions">
                  {!isActive && !isKicked ? (
                    <button
                      className="ffb-primary"
                      disabled={isWriting || membership?.status === "requested"}
                      type="button"
                      onClick={() => onRequestJoin(summary)}
                    >
                      {membership?.status === "requested" ? "Requested" : "Request to Join"}
                    </button>
                  ) : null}
                  {isKicked ? <span className="ffb-badge">Kicked</span> : null}
                  </div>
                ) : null}
              </article>
            );
          })
        ) : (
          <div className="ffb-empty-state">
            <h3>No leagues yet</h3>
            <p>{emptyText}</p>
            <p>Start a league here, or open one from its direct URL.</p>
          </div>
        )}
      </div>
    </section>
  );
}

function LeagueDashboard({
  client,
  movieFile,
  onClearSelection,
  onMessage,
  onNavigate,
  playerUsername: selectedPlayerUsername,
  routeSection,
  summary,
  universeValue,
  user,
}: {
  client: FirebaseClient;
  movieFile: TrackedMovieFile;
  onClearSelection: () => void;
  onMessage: (message: string | null) => void;
  onNavigate: (pathname: string) => void;
  playerUsername: string | null;
  routeSection: LeagueRoute["section"];
  summary: LeagueSummary;
  universeValue: unknown;
  user: User;
}) {
  const [isWriting, setIsWriting] = useState(false);
  const [renderNow] = useState(() => timestamp());
  const transactions = useMemo(
    () => readTransactions(universeValue, summary),
    [summary, universeValue],
  );
  const ownTransactions = useMemo(
    () => readOwnTransactions(universeValue, user.uid, summary),
    [summary, universeValue, user.uid],
  );
  const snapshotResolution = useMemo(
    () =>
      resolveLeagueSnapshot({
        generatedByUid: user.uid,
        movieFile,
        now: renderNow,
        summary,
        transactions,
        universeValue,
      }),
    [movieFile, renderNow, summary, transactions, universeValue, user.uid],
  );
  const currentMember = summary.league.members[user.uid];
  const isCommissioner = summary.commissionerUid === user.uid;
  const isActive = Boolean(currentMember);
  const isKicked = Boolean(summary.league.kicked[user.uid]);
  const pendingRequests = getPendingRequests(universeValue, summary);
  const kickedRequests = getKickedRequests(universeValue, summary);

  useEffect(() => {
    if (!isActive || !snapshotResolution.shouldWrite) {
      return;
    }

    let active = true;
    const snapshot = snapshotResolution.snapshot;
    updateEncoded(client, `users/${user.uid}`, {
      [`snapshots/${summary.membershipKey}/${snapshotIdFor(snapshot)}`]: snapshot,
      updatedAt: serverTimestamp(),
    })
      .catch((error: unknown) => {
        if (active) {
          onMessage(
            error instanceof Error ? `Snapshot save failed: ${error.message}` : "Snapshot save failed.",
          );
        }
      });

    return () => {
      active = false;
    };
  }, [
    client,
    isActive,
    snapshotResolution.shouldWrite,
    snapshotResolution.snapshot,
    onMessage,
    summary.membershipKey,
    user.uid,
  ]);

  async function writeOwnTransaction(transaction: LeagueTransaction) {
    await updateEncoded(client, `users/${user.uid}`, {
      [`transactions/${summary.membershipKey}/${transaction.txnId}`]: transaction,
      updatedAt: serverTimestamp(),
    });
  }

  async function requestJoin() {
    if (isKicked) {
      throw new Error("You cannot rejoin this league.");
    }

    const now = timestamp();
    await updateEncoded(client, `users/${user.uid}`, {
      email: user.email,
      [`leagueMemberships/${summary.membershipKey}`]: {
        commissionerUid: summary.commissionerUid,
        leagueId: summary.league.leagueId,
        requestedAt: now,
        status: "requested",
        updatedAt: now,
      },
      updatedAt: serverTimestamp(),
    });
  }

  async function runAction(action: () => Promise<string>) {
    setIsWriting(true);
    onMessage(null);
    try {
      onMessage(await action());
    } catch (error: unknown) {
      onMessage(error instanceof Error ? error.message : "Action failed.");
    } finally {
      setIsWriting(false);
    }
  }

  async function acceptRequest(request: JoinRequest) {
    if (!isCommissioner) {
      throw new Error("Only the commissioner can accept join requests.");
    }

    const playerId = nextAvailablePlayerId(summary);
    const now = timestamp();
    await updateEncoded(client, `users/${user.uid}`, {
      [`leagues/${summary.league.leagueId}/members/${request.uid}`]: {
        email: request.email ?? "",
        joinedAt: now,
        playerId,
      },
      [`leagues/${summary.league.leagueId}/kicked/${request.uid}`]: null,
      [`leagues/${summary.league.leagueId}/updatedAt`]: now,
      updatedAt: serverTimestamp(),
    });
  }

  async function kickRequest(request: JoinRequest) {
    if (!isCommissioner) {
      throw new Error("Only the commissioner can kick join requests.");
    }

    const now = timestamp();
    await updateEncoded(client, `users/${user.uid}`, {
      [`leagues/${summary.league.leagueId}/kicked/${request.uid}`]: true,
      [`leagues/${summary.league.leagueId}/updatedAt`]: now,
      updatedAt: serverTimestamp(),
    });
  }

  return (
    <>
      {routeSection === "theater" && selectedPlayerUsername ? (
        <PlayerDetailPanel
          playerUsername={selectedPlayerUsername}
          resolution={snapshotResolution}
          summary={summary}
        />
      ) : routeSection === "available" ? (
        <AvailableFilmsPanel resolution={snapshotResolution} />
      ) : (
        <>
      <TheatersPanel
        disabled={isWriting}
        isCommissioner={isCommissioner}
        onAcceptRequest={(request) =>
          runAction(async () => {
            await acceptRequest(request);
            return `Accepted ${usernameFromEmail(request.email, request.uid)}.`;
          })
        }
        onKickRequest={(request) =>
          runAction(async () => {
            await kickRequest(request);
            return `Kicked ${usernameFromEmail(request.email, request.uid)}.`;
          })
        }
        kickedRequests={kickedRequests}
        onNavigate={onNavigate}
        pendingRequests={pendingRequests}
        resolution={snapshotResolution}
        summary={summary}
        transactions={transactions}
        user={user}
      />

      {isActive ? (
        <section className="ffb-league-grid ffb-league-grid--forms">
          <BidForm
            disabled={isWriting}
            member={currentMember}
            ownTransactions={ownTransactions}
            summary={summary}
            user={user}
            onSubmit={(transaction) =>
              runAction(async () => {
                await writeOwnTransaction(transaction);
                return `Bid ${transaction.txnId} logged.`;
              })
            }
          />
          <MoveForm
            disabled={isWriting}
            member={currentMember}
            ownTransactions={ownTransactions}
            user={user}
            onSubmit={(transaction) =>
              runAction(async () => {
                await writeOwnTransaction(transaction);
                return `${transaction.kind} ${transaction.txnId} logged.`;
              })
            }
          />
        </section>
      ) : (
        <section className="ffb-panel ffb-centered-panel">
          <p className="ffb-label">Read only</p>
          <h2>{isKicked ? "You cannot rejoin this league" : currentMember ? "Request pending" : "Join this league"}</h2>
          <p>
            {isKicked
              ? "The commissioner marked this account as kicked."
              : currentMember
                ? "The commissioner must accept your request before you can submit transactions."
                : "Ask the commissioner to add you to this league."}
          </p>
          {!currentMember && !isKicked ? (
            <button
              className="ffb-primary"
              disabled={isWriting}
              type="button"
              onClick={() =>
                runAction(async () => {
                  await requestJoin();
                  return `Requested to join ${summary.league.name}.`;
                })
              }
            >
              Request to Join
            </button>
          ) : null}
        </section>
      )}

      <TransactionLog resolution={snapshotResolution} summary={summary} transactions={transactions} />

      {isCommissioner ? (
        <CommissionerPanel
          client={client}
          isWriting={isWriting}
          onDeleted={onClearSelection}
          onRun={runAction}
          summary={summary}
          user={user}
        />
      ) : null}
        </>
      )}
    </>
  );
}

function CommissionerPanel({
  client,
  isWriting,
  onDeleted,
  onRun,
  summary,
  user,
}: {
  client: FirebaseClient;
  isWriting: boolean;
  onDeleted: () => void;
  onRun: (action: () => Promise<string>) => void;
  summary: LeagueSummary;
  user: User;
}) {
  const [leagueName, setLeagueName] = useState(summary.league.name);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");

  async function renameLeague(event: FormEvent) {
    event.preventDefault();
    onRun(async () => {
      await updateEncoded(client, `users/${user.uid}`, {
        [`leagues/${summary.league.leagueId}/name`]: leagueName.trim() || summary.league.name,
        [`leagues/${summary.league.leagueId}/updatedAt`]: timestamp(),
        updatedAt: serverTimestamp(),
      });
      return "League name updated.";
    });
  }

  async function deleteLeague(event: FormEvent) {
    event.preventDefault();
    onRun(async () => {
      await updateEncoded(client, `users/${user.uid}`, {
        [`leagueMemberships/${summary.membershipKey}`]: null,
        [`leagues/${summary.league.leagueId}`]: null,
        [`snapshots/${summary.membershipKey}`]: null,
        [`transactions/${summary.membershipKey}`]: null,
        updatedAt: serverTimestamp(),
      });
      onDeleted();
      return `${summary.league.name} deleted.`;
    });
  }

  return (
    <section className="ffb-commissioner-panel" aria-labelledby="commissioner-title">
      <div className="ffb-universe-head">
        <div>
          <h2 id="commissioner-title">Commissioner Settings</h2>
        </div>
      </div>
      <div className="ffb-commissioner-grid">
        <form className="ffb-commissioner-card ffb-form" onSubmit={renameLeague}>
          <div>
            <h3>League name</h3>
          </div>
          <input value={leagueName} onChange={(event) => setLeagueName(event.target.value)} />
          <button className="ffb-primary" disabled={isWriting} type="submit">
            Rename
          </button>
        </form>

        <form className="ffb-commissioner-card ffb-danger-panel ffb-form" onSubmit={deleteLeague}>
          <div>
            <h3>Delete league</h3>
          </div>
          <input
            placeholder={`Type ${summary.league.leagueId} to confirm`}
            value={deleteConfirmation}
            onChange={(event) => setDeleteConfirmation(event.target.value)}
          />
          <button
            className="ffb-danger-button"
            disabled={isWriting || deleteConfirmation !== summary.league.leagueId}
            type="submit"
          >
            Delete League
          </button>
        </form>
      </div>
    </section>
  );
}

function TheatersPanel({
  disabled,
  isCommissioner,
  kickedRequests,
  onAcceptRequest,
  onKickRequest,
  onNavigate,
  pendingRequests,
  resolution,
  summary,
  transactions,
  user,
}: {
  disabled: boolean;
  isCommissioner: boolean;
  kickedRequests: JoinRequest[];
  onAcceptRequest: (request: JoinRequest) => void;
  onKickRequest: (request: JoinRequest) => void;
  onNavigate: (pathname: string) => void;
  pendingRequests: JoinRequest[];
  resolution: SnapshotResolution;
  summary: LeagueSummary;
  transactions: LeagueTransaction[];
  user: User;
}) {
  const state = resolution.snapshot.state;
  const players = Object.values(state.players).sort((left, right) => {
    if (left.uid === summary.commissionerUid) {
      return -1;
    }
    if (right.uid === summary.commissionerUid) {
      return 1;
    }
    return left.playerId.localeCompare(right.playerId);
  });
  const spentByPlayer = unreleasedSpendByPlayer(summary, resolution, transactions);

  return (
    <section className="ffb-theaters-panel" aria-labelledby="theaters-title">
      <div className="ffb-universe-head">
        <div>
          <h2 id="theaters-title">Theaters</h2>
        </div>
        <span>{players.length + pendingRequests.length + kickedRequests.length} players</span>
      </div>
      <div className="ffb-theater-table" role="table" aria-label="Theaters">
        <div className="ffb-theater-row ffb-theater-row--head" role="row">
          <span role="columnheader">Player</span>
          <span role="columnheader">Stubs</span>
          <span role="columnheader">Unreleased</span>
          <span role="columnheader">Released</span>
        </div>
        {players.map((player) => {
          const username = playerUsername(summary, player.uid, player.uid);
          const unreleased = player.theater.filter((filmId) => !state.movies[filmId]?.locked);
          const released = player.theater.filter((filmId) => state.movies[filmId]?.locked);
          const isCurrentPlayer = player.uid === user.uid;
          return (
            <button
              className={`ffb-theater-row ffb-theater-row--button${
                isCurrentPlayer ? " ffb-theater-row--current" : ""
              }`}
              key={player.uid}
              role="row"
              type="button"
              onClick={() => onNavigate(`${leaguePath(summary)}/theater/${encodeURIComponent(username)}`)}
            >
              <span className="ffb-player-name" role="cell">
                {username}
              </span>
              <span role="cell">{player.stubs}</span>
              <span role="cell">
                {unreleased.length}/{spentByPlayer[player.uid] ?? 0}
              </span>
              <span role="cell">{released.length}/0</span>
            </button>
          );
        })}
        {pendingRequests.map((request) => (
          <div className="ffb-theater-row ffb-theater-row--pending" key={request.uid} role="row">
            <strong role="cell">{usernameFromEmail(request.email, request.uid)}</strong>
            <span className="ffb-theater-action" role="cell">
              <button
                className="ffb-primary"
                disabled={disabled || !isCommissioner}
                type="button"
                onClick={() => onAcceptRequest(request)}
              >
                Accept
              </button>
              <button
                disabled={disabled || !isCommissioner}
                type="button"
                onClick={() => onKickRequest(request)}
              >
                Kick
              </button>
            </span>
          </div>
        ))}
        {kickedRequests.map((request) => (
          <div className="ffb-theater-row ffb-theater-row--pending" key={request.uid} role="row">
            <strong role="cell">
              {usernameFromEmail(request.email, request.uid)}
              <span className="ffb-inline-state">kicked</span>
            </strong>
            <span className="ffb-theater-action" role="cell">
              <button
                className="ffb-primary"
                disabled={disabled || !isCommissioner}
                type="button"
                onClick={() => onAcceptRequest(request)}
              >
                Accept
              </button>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function PlayerDetailPanel({
  playerUsername: selectedPlayerUsername,
  resolution,
  summary,
}: {
  playerUsername: string;
  resolution: SnapshotResolution;
  summary: LeagueSummary;
}) {
  const state = resolution.snapshot.state;
  const player = Object.values(state.players).find(
    (candidate) => playerUsername(summary, candidate.uid, candidate.uid) === selectedPlayerUsername,
  );

  if (!player) {
    return (
      <section className="ffb-player-detail" aria-label="Player theater">
        <p className="ffb-label">Player</p>
        <h2>{selectedPlayerUsername}</h2>
        <p className="ffb-muted">No active player matches this league path.</p>
      </section>
    );
  }

  const username = playerUsername(summary, player.uid, player.uid);
  const films = player.theater
    .map((filmId) => state.movies[filmId])
    .filter((movie): movie is NonNullable<typeof movie> => Boolean(movie))
    .sort((left, right) => left.releaseDate.localeCompare(right.releaseDate));

  return (
    <section className="ffb-player-detail" aria-labelledby="player-detail-title">
      <div className="ffb-universe-head">
        <div>
          <p className="ffb-label">Player theater</p>
          <h2 id="player-detail-title">{username}</h2>
        </div>
        <span>{player.stubs} stubs</span>
      </div>
      {films.length > 0 ? (
        <div className="ffb-player-film-list">
          {films.map((movie) => (
            <article key={`${player.uid}-${movie.title}`}>
              <h3>{movie.title}</h3>
              <p>
                {movie.releaseDate} · {movie.locked ? "Released" : "Unreleased"}
              </p>
            </article>
          ))}
        </div>
      ) : (
        <p className="ffb-muted">No films in this theater yet.</p>
      )}
    </section>
  );
}

function AvailableFilmsPanel({ resolution }: { resolution: SnapshotResolution }) {
  const movies = Object.values(resolution.snapshot.state.movies)
    .filter((movie) => !movie.ownerUid && !movie.locked)
    .sort((left, right) => {
      return left.releaseDate.localeCompare(right.releaseDate) || left.title.localeCompare(right.title);
    });

  return (
    <section className="ffb-player-detail" aria-labelledby="available-films-title">
      <div className="ffb-universe-head">
        <div>
          <p className="ffb-label">Market</p>
          <h2 id="available-films-title">Available Films</h2>
        </div>
        <span>{movies.length} films</span>
      </div>
      {movies.length > 0 ? (
        <div className="ffb-player-film-list ffb-available-film-list">
          {movies.map((movie) => (
            <article key={`${movie.releaseDate}-${movie.title}`}>
              <h3>{movie.title}</h3>
              <p>
                {movie.releaseDate} · {availableStatusLabel(movie.status)}
              </p>
            </article>
          ))}
        </div>
      ) : (
        <p className="ffb-muted">No films are available right now.</p>
      )}
    </section>
  );
}

function availableStatusLabel(status: string) {
  if (status === "free-agent") {
    return "Free agent";
  }
  if (status === "auction-open") {
    return "Initial auction";
  }
  if (status === "waiver") {
    return "Waiver";
  }
  return "Future";
}

function BidForm({
  disabled,
  member,
  onSubmit,
  ownTransactions,
  summary,
  user,
}: {
  disabled: boolean;
  member: LeagueMember;
  onSubmit: (transaction: LeagueTransaction) => void;
  ownTransactions: Record<string, LeagueTransaction>;
  summary: LeagueSummary;
  user: User;
}) {
  const [filmId, setFilmId] = useState("");
  const [amount, setAmount] = useState(25);
  const [dropFilmId, setDropFilmId] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    const txnId = nextTxnId(member, ownTransactions);
    const payload: BidPayload = {
      amount,
      dropFilmId: dropFilmId.trim() || null,
      filmId,
      submittedAt: timestamp(),
    };
    const transaction = {
      createdAt: timestamp(),
      fee: 1,
      kind: "bid" as const,
      obfuscatedPayload: obfuscateBidPayload(payload, {
        commissionerUid: summary.commissionerUid,
        leagueId: summary.league.leagueId,
        txnId,
      }),
      playerId: member.playerId,
      playerUid: user.uid,
      txnId,
    };

    onSubmit(transaction);
    setFilmId("");
    setDropFilmId("");
  }

  return (
    <form className="ffb-panel ffb-form" onSubmit={submit}>
      <p className="ffb-label">Bid</p>
      <h2>Submit obfuscated bid</h2>
      <label>
        Film id
        <input required value={filmId} onChange={(event) => setFilmId(event.target.value)} />
      </label>
      <label>
        Stub bid
        <input
          min={0}
          required
          type="number"
          value={amount}
          onChange={(event) => setAmount(Number(event.target.value))}
        />
      </label>
      <label>
        Drop stipulation
        <input value={dropFilmId} onChange={(event) => setDropFilmId(event.target.value)} />
      </label>
      <button className="ffb-primary" disabled={disabled} type="submit">
        Submit Bid
      </button>
    </form>
  );
}

function MoveForm({
  disabled,
  member,
  onSubmit,
  ownTransactions,
  user,
}: {
  disabled: boolean;
  member: LeagueMember;
  onSubmit: (transaction: LeagueTransaction) => void;
  ownTransactions: Record<string, LeagueTransaction>;
  user: User;
}) {
  const [filmId, setFilmId] = useState("");

  function base(kindFee = 1) {
    const txnId = nextTxnId(member, ownTransactions);
    return {
      createdAt: timestamp(),
      fee: kindFee,
      playerId: member.playerId,
      playerUid: user.uid,
      txnId,
    };
  }

  return (
    <div className="ffb-panel ffb-form">
      <p className="ffb-label">Operations</p>
      <h2>Write to your log</h2>
      <label>
        Film id
        <input value={filmId} onChange={(event) => setFilmId(event.target.value)} />
      </label>
      <div className="ffb-actions">
        <button
          disabled={!filmId || disabled}
          type="button"
          onClick={() => onSubmit({ ...base(1), filmId, kind: "pickup" })}
        >
          Pickup
        </button>
        <button
          disabled={!filmId || disabled}
          type="button"
          onClick={() => onSubmit({ ...base(1), filmId, kind: "drop" })}
        >
          Drop
        </button>
      </div>
    </div>
  );
}

function TransactionLog({
  resolution,
  summary,
  transactions,
}: {
  resolution: SnapshotResolution;
  summary: LeagueSummary;
  transactions: LeagueTransaction[];
}) {
  const [now] = useState(() => timestamp());

  return (
    <section className="ffb-log" aria-labelledby="log-title">
      <div className="ffb-universe-head">
        <div>
          <p className="ffb-label">Shared log</p>
          <h2 id="log-title">Transactions</h2>
        </div>
        <span>{transactions.length}</span>
      </div>
      <div className="ffb-log-list">
        {transactions.length > 0 ? (
          transactions
            .slice()
            .reverse()
            .map((transaction) => (
              <article className="ffb-log-item" key={`${transaction.playerUid}-${transaction.txnId}`}>
                <p className="ffb-log-meta">
                  {transaction.txnId} · {new Date(transaction.createdAt).toLocaleString()}
                </p>
                <h3>{transactionText(transaction, resolution, summary, now)}</h3>
              </article>
            ))
        ) : (
          <p className="ffb-muted">No league transactions yet.</p>
        )}
      </div>
    </section>
  );
}

type JoinRequest = {
  email: string | null;
  membership?: ReturnType<typeof readMemberships>[string];
  uid: string;
};

function getPendingRequests(value: unknown, summary: LeagueSummary): JoinRequest[] {
  const requests: JoinRequest[] = [];
  const users = getUsers(value);

  for (const [uid, root] of Object.entries(users)) {
    if (summary.league.members[uid] || summary.league.kicked[uid]) {
      continue;
    }

    const memberships = readMemberships(value, uid);
    const membership = memberships[summary.membershipKey];
    if (membership?.status === "requested") {
      requests.push({
        email: typeof root.email === "string" ? root.email : null,
        membership,
        uid,
      });
    }
  }

  return requests;
}

function getKickedRequests(value: unknown, summary: LeagueSummary): JoinRequest[] {
  const users = getUsers(value);

  return Object.keys(summary.league.kicked)
    .filter((uid) => !summary.league.members[uid])
    .map((uid) => {
      const root = users[uid] ?? {};
      const memberships = readMemberships(value, uid);
      return {
        email: typeof root.email === "string" ? root.email : null,
        membership: memberships[summary.membershipKey],
        uid,
      };
    });
}

function nextAvailablePlayerId(summary: LeagueSummary) {
  const used = new Set(Object.values(summary.league.members).map((member) => member.playerId));
  for (let index = 1; ; index += 1) {
    const id = String(index);
    if (!used.has(id)) {
      return id;
    }
  }

  return String(used.size + 1);
}

function unreleasedSpendByPlayer(
  summary: LeagueSummary,
  resolution: SnapshotResolution,
  transactions: LeagueTransaction[],
) {
  const state = resolution.snapshot.state;
  const totals: Record<string, number> = {};
  const ownedUnreleased = new Set<string>();

  for (const player of Object.values(state.players)) {
    for (const filmId of player.theater) {
      if (!state.movies[filmId]?.locked) {
        ownedUnreleased.add(`${player.uid}:${filmId}`);
      }
    }
  }

  for (const transaction of transactions) {
    if (transaction.kind === "pickup") {
      const key = `${transaction.playerUid}:${transaction.filmId}`;
      if (ownedUnreleased.has(key)) {
        totals[transaction.playerUid] = (totals[transaction.playerUid] ?? 0) + transaction.fee;
      }
      continue;
    }

    if (transaction.kind === "bid") {
      const payload = decodeBidPayload(transaction.obfuscatedPayload, {
        commissionerUid: summary.commissionerUid,
        leagueId: summary.league.leagueId,
        txnId: transaction.txnId,
      });
      const key = payload ? `${transaction.playerUid}:${payload.filmId}` : null;
      if (payload && key && ownedUnreleased.has(key)) {
        totals[transaction.playerUid] = (totals[transaction.playerUid] ?? 0) + payload.amount;
      }
    }
  }

  return totals;
}

function playerUsername(summary: LeagueSummary, uid: string, fallback: string) {
  const member = summary.league.members[uid];
  return usernameFromEmail(member?.email, fallback);
}

function transactionText(
  transaction: LeagueTransaction,
  resolution: SnapshotResolution,
  summary: LeagueSummary,
  now: number,
) {
  const player = playerUsername(summary, transaction.playerUid, transaction.playerUid);

  if (transaction.kind === "bid") {
    const payload = decodeBidPayload(transaction.obfuscatedPayload, {
      commissionerUid: summary.commissionerUid,
      leagueId: summary.league.leagueId,
      txnId: transaction.txnId,
    });

    if (!payload) {
      return `${player} placed bid ${transaction.txnId}, but the payload could not be decoded.`;
    }

    const movie = resolution.snapshot.state.movies[payload.filmId];
    if (movie && movie.auctionDeadline > now) {
      return `${player} placed bid ${transaction.txnId}`;
    }

    const drop = payload.dropFilmId ? ` with drop ${payload.dropFilmId}` : "";
    return `${player} bid ${payload.amount} stubs on ${payload.filmId}${drop}.`;
  }

  if (transaction.kind === "pickup") {
    return `${player} picked up ${transaction.filmId}.`;
  }

  if (transaction.kind === "drop") {
    return `${player} dropped ${transaction.filmId}; 48-hour waiver begins.`;
  }

  return `${player} recorded ${transaction.filmId}.`;
}
