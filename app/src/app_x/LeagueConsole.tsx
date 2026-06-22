import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { User } from "firebase/auth";
import { ref, serverTimestamp, update } from "firebase/database";
import type { FirebaseClient } from "./firebaseClient";
import { ScoringRulesContent } from "./ScoringRulesContent";
import {
  DEFAULT_LEAGUE_ID,
  SELECTED_LEAGUE_STORAGE_KEY,
  STARTING_STUBS,
  decodeBidPayload,
  findLeagueSummary,
  makeDefaultLeague,
  membershipKey,
  nextTxnId,
  obfuscateBidPayload,
  readLeagueSummaries,
  readMemberships,
  readOwnTransactions,
  readTransactions,
  stubBalance,
  type BidPayload,
  type LeagueMember,
  type LeagueSummary,
  type LeagueTransaction,
  type UniverseState,
} from "./leagueModel";

type LeagueConsoleProps = {
  client: FirebaseClient;
  onNavigate: (pathname: string) => void;
  onSignOut: () => void;
  universeState: UniverseState;
  user: User;
};

type LeagueConsoleView = "league" | "scoring";

const EMPTY_UNIVERSE = {};

function timestamp() {
  return Date.now();
}

export default function LeagueConsole({
  client,
  onNavigate,
  onSignOut,
  universeState,
  user,
}: LeagueConsoleProps) {
  const [view, setView] = useState<LeagueConsoleView>("league");
  const [selectedKey, setSelectedKey] = useState(() =>
    window.localStorage.getItem(SELECTED_LEAGUE_STORAGE_KEY),
  );
  const [message, setMessage] = useState<string | null>(null);
  const universeValue = useMemo(
    () => (universeState.status === "ready" ? universeState.value : EMPTY_UNIVERSE),
    [universeState],
  );
  const selectedLeague = useMemo(
    () => findLeagueSummary(universeValue, selectedKey),
    [selectedKey, universeValue],
  );

  function selectLeague(key: string) {
    window.localStorage.setItem(SELECTED_LEAGUE_STORAGE_KEY, key);
    setSelectedKey(key);
  }

  async function testIllegalWrite() {
    const forbiddenUid =
      user.uid === "rules-sanity-check-other-user"
        ? "rules-sanity-check-someone-else"
        : "rules-sanity-check-other-user";

    try {
      await update(ref(client.database, `users/${forbiddenUid}`), {
        league: { attemptedBy: user.uid },
        updatedAt: serverTimestamp(),
      });
      setMessage(`Unexpectedly wrote to /users/${forbiddenUid}. Tighten rules.`);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Firebase blocked the write.";
      setMessage(`Blocked as expected: ${errorMessage}`);
    }
  }

  if (universeState.status === "error") {
    return (
      <Shell activeView={view} onNavigate={onNavigate} onSignOut={onSignOut} onViewChange={setView}>
        <section className="ffb-panel">
          <p className="ffb-label">Realtime Database</p>
          <h2>Unable to load league</h2>
          <p className="ffb-error">{universeState.message}</p>
        </section>
      </Shell>
    );
  }

  if (universeState.status !== "ready") {
    return (
      <Shell activeView={view} onNavigate={onNavigate} onSignOut={onSignOut} onViewChange={setView}>
        <section className="ffb-panel">
          <p className="ffb-label">Realtime Database</p>
          <h2>Loading league log</h2>
          <p className="ffb-muted">Waiting for Firebase data.</p>
        </section>
      </Shell>
    );
  }

  return (
    <Shell activeView={view} onNavigate={onNavigate} onSignOut={onSignOut} onViewChange={setView}>
      {message ? <p className="ffb-toast">{message}</p> : null}
      {view === "scoring" ? (
        <ScoringRulesContent
          client={client}
          onChangeLeague={() => {
            window.localStorage.removeItem(SELECTED_LEAGUE_STORAGE_KEY);
            setSelectedKey(null);
            setView("league");
          }}
          onOpenLeague={() => setView("league")}
          universeState={universeState}
          user={user}
        />
      ) : selectedLeague ? (
        <LeagueDashboard
          client={client}
          onClearSelection={() => {
            window.localStorage.removeItem(SELECTED_LEAGUE_STORAGE_KEY);
            setSelectedKey(null);
          }}
          onMessage={setMessage}
          onTestIllegalWrite={testIllegalWrite}
          summary={selectedLeague}
          universeValue={universeValue}
          user={user}
        />
      ) : (
        <LeagueDiscovery
          client={client}
          onMessage={setMessage}
          onSelect={selectLeague}
          universeValue={universeValue}
          user={user}
        />
      )}
    </Shell>
  );
}

function Shell({
  activeView,
  children,
  onNavigate,
  onSignOut,
  onViewChange,
}: {
  activeView: LeagueConsoleView;
  children: ReactNode;
  onNavigate: (pathname: string) => void;
  onSignOut: () => void;
  onViewChange: (view: LeagueConsoleView) => void;
}) {
  return (
    <main className="ffb-page">
      <header className="ffb-header">
        <div>
          <p className="ffb-kicker">FantasyFilmBall</p>
          <h1>League console</h1>
        </div>
        <nav className="ffb-nav" aria-label="Primary">
          <button type="button" onClick={() => onNavigate("/rules")}>
            Rules
          </button>
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
          <button type="button" onClick={() => onNavigate("/debug")}>
            Debug
          </button>
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
        </nav>
      </header>
      {children}
    </main>
  );
}

function LeagueDiscovery({
  client,
  onMessage,
  onSelect,
  universeValue,
  user,
}: {
  client: FirebaseClient;
  onMessage: (message: string | null) => void;
  onSelect: (key: string) => void;
  universeValue: unknown;
  user: User;
}) {
  const [leagueName, setLeagueName] = useState("FantasyFilmBall");
  const [leagueId, setLeagueId] = useState(DEFAULT_LEAGUE_ID);
  const [searchId, setSearchId] = useState(DEFAULT_LEAGUE_ID);
  const [isWriting, setIsWriting] = useState(false);
  const memberships = readMemberships(universeValue, user.uid);
  const allLeagues = readLeagueSummaries(universeValue);
  const searchMatches = readLeagueSummaries(universeValue, searchId.trim() || DEFAULT_LEAGUE_ID);

  async function startLeague(event: FormEvent) {
    event.preventDefault();
    setIsWriting(true);
    onMessage(null);

    try {
      const cleanLeagueId = leagueId.trim() || DEFAULT_LEAGUE_ID;
      const league = makeDefaultLeague(user, leagueName, cleanLeagueId);
      const key = membershipKey(user.uid, cleanLeagueId);

      await update(ref(client.database, `users/${user.uid}`), {
        displayName: user.displayName,
        email: user.email,
        [`leagueMemberships/${key}`]: {
          commissionerUid: user.uid,
          leagueId: cleanLeagueId,
          requestedAt: timestamp(),
          status: "active",
          updatedAt: timestamp(),
        },
        [`leagues/${cleanLeagueId}`]: league,
        updatedAt: serverTimestamp(),
      });

      onSelect(key);
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

      await update(ref(client.database, `users/${user.uid}`), {
        displayName: user.displayName,
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
      onSelect(key);
      onMessage(`Requested to join ${summary.league.name}.`);
    } catch (error: unknown) {
      onMessage(error instanceof Error ? error.message : "Could not request to join.");
    } finally {
      setIsWriting(false);
    }
  }

  return (
    <>
      <section className="ffb-league-grid ffb-league-grid--forms">
        <form className="ffb-panel ffb-form" onSubmit={startLeague}>
          <p className="ffb-label">Commissioner</p>
          <h2>Start a league</h2>
          <label>
            League name
            <input value={leagueName} onChange={(event) => setLeagueName(event.target.value)} />
          </label>
          <label>
            League id
            <input value={leagueId} onChange={(event) => setLeagueId(event.target.value)} />
          </label>
          <button className="ffb-primary" disabled={isWriting} type="submit">
            {isWriting ? "Starting" : "Start League"}
          </button>
        </form>

        <div className="ffb-panel ffb-form">
          <p className="ffb-label">Player</p>
          <h2>Find a league</h2>
          <label>
            League id
            <input value={searchId} onChange={(event) => setSearchId(event.target.value)} />
          </label>
          <p className="ffb-muted">
            If multiple commissioners use the same league id, pick by commissioner and created
            date.
          </p>
        </div>

        <div className="ffb-panel">
          <p className="ffb-label">Your leagues</p>
          <h2>{Object.keys(memberships).length}</h2>
          <p>Membership pointers live in your own Firebase folder.</p>
        </div>
      </section>

      <LeagueList
        emptyText="No matching leagues yet."
        memberships={memberships}
        onRequestJoin={requestJoin}
        onSelect={onSelect}
        title="Matching leagues"
        isWriting={isWriting}
        leagues={searchMatches}
        user={user}
      />

      {allLeagues.length > searchMatches.length ? (
        <LeagueList
          emptyText="No leagues have been created yet."
          memberships={memberships}
          onRequestJoin={requestJoin}
          onSelect={onSelect}
          title="All readable leagues"
          isWriting={isWriting}
          leagues={allLeagues}
          user={user}
        />
      ) : null}
    </>
  );
}

function LeagueList({
  emptyText,
  isWriting,
  leagues,
  memberships,
  onRequestJoin,
  onSelect,
  title,
  user,
}: {
  emptyText: string;
  isWriting: boolean;
  leagues: LeagueSummary[];
  memberships: ReturnType<typeof readMemberships>;
  onRequestJoin: (summary: LeagueSummary) => Promise<void>;
  onSelect: (key: string) => void;
  title: string;
  user: User;
}) {
  return (
    <section className="ffb-log" aria-labelledby={`${title.replace(/\W+/g, "-")}-title`}>
      <div className="ffb-universe-head">
        <div>
          <p className="ffb-label">League picker</p>
          <h2 id={`${title.replace(/\W+/g, "-")}-title`}>{title}</h2>
        </div>
        <span>{leagues.length}</span>
      </div>
      <div className="ffb-card-list">
        {leagues.length > 0 ? (
          leagues.map((summary) => {
            const membership = memberships[summary.membershipKey];
            const member = summary.league.members[user.uid];
            const isKicked = summary.league.kicked[user.uid] || member?.status === "kicked";
            const isActive = member?.status === "active";

            return (
              <article className="ffb-log-item" key={summary.membershipKey}>
                <p className="ffb-log-meta">
                  {summary.league.leagueId} · {new Date(summary.league.createdAt).toLocaleDateString()}
                </p>
                <h3>{summary.league.name}</h3>
                <p className="ffb-muted">
                  Commissioner: {summary.commissionerLabel}
                  {summary.commissionerEmail ? ` (${summary.commissionerEmail})` : ""}
                </p>
                <div className="ffb-actions">
                  <button type="button" onClick={() => onSelect(summary.membershipKey)}>
                    {isActive ? "Enter" : "View"}
                  </button>
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
              </article>
            );
          })
        ) : (
          <p className="ffb-muted">{emptyText}</p>
        )}
      </div>
    </section>
  );
}

function LeagueDashboard({
  client,
  onClearSelection,
  onMessage,
  onTestIllegalWrite,
  summary,
  universeValue,
  user,
}: {
  client: FirebaseClient;
  onClearSelection: () => void;
  onMessage: (message: string | null) => void;
  onTestIllegalWrite: () => Promise<void>;
  summary: LeagueSummary;
  universeValue: unknown;
  user: User;
}) {
  const [isWriting, setIsWriting] = useState(false);
  const transactions = readTransactions(universeValue, summary);
  const ownTransactions = readOwnTransactions(universeValue, user.uid, summary);
  const currentMember = summary.league.members[user.uid];
  const isCommissioner = summary.commissionerUid === user.uid;
  const isActive = currentMember?.status === "active";
  const isKicked = Boolean(summary.league.kicked[user.uid] || currentMember?.status === "kicked");
  const pendingRequests = getPendingRequests(universeValue, summary);
  const balance = currentMember ? stubBalance(currentMember, transactions) : STARTING_STUBS;

  async function writeOwnTransaction(transaction: LeagueTransaction) {
    await update(ref(client.database, `users/${user.uid}`), {
      [`transactions/${summary.membershipKey}/${transaction.txnId}`]: transaction,
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

  return (
    <>
      <section className="ffb-league-grid">
        <div className="ffb-panel">
          <p className="ffb-label">Selected league</p>
          <h2>{summary.league.name}</h2>
          <p>
            {summary.league.leagueId} · {summary.league.season}
          </p>
          <p className="ffb-source">Commissioner: {summary.commissionerLabel}</p>
          <button type="button" onClick={onClearSelection}>
            Change League
          </button>
        </div>
        <div className="ffb-panel">
          <p className="ffb-label">Your status</p>
          <h2>{isKicked ? "Kicked" : isActive ? `Player ${currentMember.playerId}` : "Requested"}</h2>
          <p>{isActive ? currentMember.label : "Waiting for commissioner approval."}</p>
        </div>
        <div className="ffb-panel">
          <p className="ffb-label">Stubs</p>
          <strong className="ffb-stubs">{balance}</strong>
          <p className="ffb-muted">Bid details decode automatically after the deadline.</p>
        </div>
      </section>

      {isCommissioner ? (
        <CommissionerPanel
          client={client}
          isWriting={isWriting}
          onRun={runAction}
          pendingRequests={pendingRequests}
          summary={summary}
          user={user}
        />
      ) : null}

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
            summary={summary}
            user={user}
            onSubmit={(transaction) =>
              runAction(async () => {
                await writeOwnTransaction(transaction);
                return `${transaction.kind} ${transaction.txnId} logged.`;
              })
            }
          />
          <div className="ffb-panel">
            <p className="ffb-label">Rules sanity</p>
            <h2>Illegal write check</h2>
            <p>Attempts to write to a fake user folder. Firebase should reject it.</p>
            <button type="button" disabled={isWriting} onClick={onTestIllegalWrite}>
              Test illegal write
            </button>
          </div>
        </section>
      ) : (
        <section className="ffb-panel ffb-centered-panel">
          <p className="ffb-label">Read only</p>
          <h2>{isKicked ? "You cannot rejoin this league" : "Request pending"}</h2>
          <p>
            {isKicked
              ? "The commissioner marked this account as kicked."
              : "The commissioner must accept your request before you can submit transactions."}
          </p>
        </section>
      )}

      <TransactionLog summary={summary} transactions={transactions} />
    </>
  );
}

function CommissionerPanel({
  client,
  isWriting,
  onRun,
  pendingRequests,
  summary,
  user,
}: {
  client: FirebaseClient;
  isWriting: boolean;
  onRun: (action: () => Promise<string>) => void;
  pendingRequests: JoinRequest[];
  summary: LeagueSummary;
  user: User;
}) {
  const [leagueName, setLeagueName] = useState(summary.league.name);

  async function acceptRequest(request: JoinRequest) {
    const playerId = nextAvailablePlayerId(summary);
    const label = request.email?.split("@")[0] ?? `Player ${playerId}`;
    const now = timestamp();
    await update(ref(client.database, `users/${user.uid}`), {
      [`leagues/${summary.league.leagueId}/members/${request.uid}`]: {
        email: request.email ?? "",
        joinedAt: now,
        label,
        playerId,
        status: "active",
      },
      [`leagues/${summary.league.leagueId}/updatedAt`]: now,
      updatedAt: serverTimestamp(),
    });
  }

  async function kickMember(uid: string) {
    const now = timestamp();
    await update(ref(client.database, `users/${user.uid}`), {
      [`leagues/${summary.league.leagueId}/kicked/${uid}`]: true,
      [`leagues/${summary.league.leagueId}/members/${uid}/status`]: "kicked",
      [`leagues/${summary.league.leagueId}/updatedAt`]: now,
      updatedAt: serverTimestamp(),
    });
  }

  async function renameLeague(event: FormEvent) {
    event.preventDefault();
    onRun(async () => {
      await update(ref(client.database, `users/${user.uid}`), {
        [`leagues/${summary.league.leagueId}/name`]: leagueName.trim() || summary.league.name,
        [`leagues/${summary.league.leagueId}/updatedAt`]: timestamp(),
        updatedAt: serverTimestamp(),
      });
      return "League name updated.";
    });
  }

  return (
    <section className="ffb-log" aria-labelledby="commissioner-title">
      <div className="ffb-universe-head">
        <div>
          <p className="ffb-label">Commissioner</p>
          <h2 id="commissioner-title">League controls</h2>
        </div>
        <span>{pendingRequests.length} requests</span>
      </div>
      <div className="ffb-card-list">
        <form className="ffb-inline-form" onSubmit={renameLeague}>
          <label>
            League name
            <input value={leagueName} onChange={(event) => setLeagueName(event.target.value)} />
          </label>
          <button className="ffb-primary" disabled={isWriting} type="submit">
            Rename
          </button>
        </form>
        {pendingRequests.map((request) => (
          <article className="ffb-log-item" key={request.uid}>
            <p className="ffb-log-meta">{request.membership.status}</p>
            <h3>{request.email ?? request.uid}</h3>
            <div className="ffb-actions">
              <button
                className="ffb-primary"
                disabled={isWriting}
                type="button"
                onClick={() => onRun(async () => {
                  await acceptRequest(request);
                  return `Accepted ${request.email ?? request.uid}.`;
                })}
              >
                Accept
              </button>
              <button
                disabled={isWriting}
                type="button"
                onClick={() => onRun(async () => {
                  await kickMember(request.uid);
                  return `Kicked ${request.email ?? request.uid}.`;
                })}
              >
                Kick
              </button>
            </div>
          </article>
        ))}
        {Object.entries(summary.league.members)
          .filter(([uid]) => uid !== user.uid)
          .map(([uid, member]) => (
            <article className="ffb-log-item" key={uid}>
              <p className="ffb-log-meta">Player {member.playerId}</p>
              <h3>{member.label}</h3>
              <p className="ffb-muted">
                {member.email} · {member.status}
              </p>
              {member.status === "active" ? (
                <button
                  disabled={isWriting}
                  type="button"
                  onClick={() => onRun(async () => {
                    await kickMember(uid);
                    return `Kicked ${member.label}.`;
                  })}
                >
                  Kick
                </button>
              ) : null}
            </article>
          ))}
      </div>
    </section>
  );
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
  const [auctionId, setAuctionId] = useState("");
  const [amount, setAmount] = useState(25);
  const [dropFilmId, setDropFilmId] = useState("");
  const [deadline, setDeadline] = useState(() => toDatetimeLocal(timestamp() + 60 * 60 * 1000));

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
      auctionDeadline: new Date(deadline).getTime(),
      auctionId,
      createdAt: timestamp(),
      fee: 1,
      kind: "bid" as const,
      obfuscatedPayload: obfuscateBidPayload(payload, {
        auctionId,
        commissionerUid: summary.commissionerUid,
        leagueId: summary.league.leagueId,
        txnId,
      }),
      playerId: member.playerId,
      playerLabel: member.label,
      playerUid: user.uid,
      publicText: `${member.label} placed bid ${txnId}`,
      txnId,
    };

    onSubmit(transaction);
    setFilmId("");
    setAuctionId("");
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
        Auction id
        <input required value={auctionId} onChange={(event) => setAuctionId(event.target.value)} />
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
        Deadline
        <input
          required
          type="datetime-local"
          value={deadline}
          onChange={(event) => setDeadline(event.target.value)}
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
  const [positionFilmId, setPositionFilmId] = useState("");
  const [position, setPosition] = useState(summary.league.scoring.positions[0]?.name ?? "Packed House");
  const [oscarFilmId, setOscarFilmId] = useState("");

  function base(kindFee = 1) {
    const txnId = nextTxnId(member, ownTransactions);
    return {
      createdAt: timestamp(),
      fee: kindFee,
      playerId: member.playerId,
      playerLabel: member.label,
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
      <label>
        Postered film id
        <input value={positionFilmId} onChange={(event) => setPositionFilmId(event.target.value)} />
      </label>
      <label>
        Position
        <select value={position} onChange={(event) => setPosition(event.target.value)}>
          {summary.league.scoring.positions.map((scoringPosition) => (
            <option key={scoringPosition.id}>{scoringPosition.name}</option>
          ))}
        </select>
      </label>
      <button
        className="ffb-primary"
        disabled={!positionFilmId || disabled}
        type="button"
        onClick={() => onSubmit({ ...base(1), filmId: positionFilmId, kind: "lineup", position })}
      >
        Save Lineup
      </button>
      <label>
        Oscar film id
        <input value={oscarFilmId} onChange={(event) => setOscarFilmId(event.target.value)} />
      </label>
      <button
        disabled={!oscarFilmId || disabled}
        type="button"
        onClick={() => onSubmit({ ...base(0), filmId: oscarFilmId, kind: "oscarPick" })}
      >
        Record Oscar Pick
      </button>
    </div>
  );
}

function TransactionLog({
  summary,
  transactions,
}: {
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
                <h3>{transactionText(transaction, summary, now)}</h3>
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
  membership: ReturnType<typeof readMemberships>[string];
  uid: string;
};

function getPendingRequests(value: unknown, summary: LeagueSummary): JoinRequest[] {
  const requests: JoinRequest[] = [];
  const users = getUsersForRequests(value);

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

function getUsersForRequests(value: unknown): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const users = (value as { users?: unknown }).users;
  return users && typeof users === "object" && !Array.isArray(users)
    ? (users as Record<string, Record<string, unknown>>)
    : {};
}

function nextAvailablePlayerId(summary: LeagueSummary) {
  const used = new Set(Object.values(summary.league.members).map((member) => member.playerId));
  for (let index = 1; index <= summary.league.config.maxPlayers; index += 1) {
    const id = String(index);
    if (!used.has(id)) {
      return id;
    }
  }

  return String(used.size + 1);
}

function transactionText(transaction: LeagueTransaction, summary: LeagueSummary, now: number) {
  if (transaction.kind === "bid") {
    if (transaction.auctionDeadline > now) {
      return transaction.publicText;
    }

    const payload = decodeBidPayload(transaction.obfuscatedPayload, {
      auctionId: transaction.auctionId,
      commissionerUid: summary.commissionerUid,
      leagueId: summary.league.leagueId,
      txnId: transaction.txnId,
    });

    if (!payload) {
      return `${transaction.playerLabel} placed bid ${transaction.txnId}, but the payload could not be decoded.`;
    }

    const drop = payload.dropFilmId ? ` with drop ${payload.dropFilmId}` : "";
    return `${transaction.playerLabel} bid ${payload.amount} stubs on ${payload.filmId}${drop}.`;
  }

  if (transaction.kind === "pickup") {
    return `${transaction.playerLabel} picked up ${transaction.filmId}.`;
  }

  if (transaction.kind === "drop") {
    return `${transaction.playerLabel} dropped ${transaction.filmId}; 48-hour waiver begins.`;
  }

  if (transaction.kind === "lineup") {
    return `${transaction.playerLabel} assigned ${transaction.filmId} to ${transaction.position}.`;
  }

  return `${transaction.playerLabel} drafted ${transaction.filmId} for the Oscar postseason.`;
}

function toDatetimeLocal(timestamp: number): string {
  const date = new Date(timestamp);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(timestamp - offset).toISOString().slice(0, 16);
}
