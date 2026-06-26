import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { User } from "firebase/auth";
import { ref, serverTimestamp, update } from "firebase/database";
import { encodeFirebaseValue } from "./firebaseCodec";
import type { FirebaseClient } from "./firebaseClient";
import { loadHistoricalReleasedMovies } from "./historicalMovieData";
import { deriveLeagueSnapshot, type DerivedMovieState } from "./leagueState";
import { resolveLeagueSnapshot, snapshotIdFor, type SnapshotResolution } from "./leagueSnapshots";
import { ScoringRulesContent } from "./ScoringRulesContent";
import { evaluateFormula, type MovieScoreInput, type ScoringRuleSet } from "./scoringRules";
import { YearSelectorToolbar } from "./YearSelectorToolbar";
import { replaceYearQuery, yearFromSearch } from "./yearQuery";
import {
  commissionerUsername,
  decodeBidPayload,
  firebasePathKey,
  findLeagueSummaryByPath,
  getUsers,
  leaguePath,
  makeDefaultLeague,
  membershipKey,
  nextCommissionerEventId,
  nextTxnId,
  obfuscateBidPayload,
  readCommissionerEvents,
  readLeagueSummaries,
  readMemberships,
  readOwnCommissionerEvents,
  readOwnTransactions,
  readTransactions,
  usernameFromEmail,
  type BidPayload,
  type CommissionerEvent,
  type LeagueMember,
  type LeagueSummary,
  type LeagueTransaction,
  type UniverseState,
} from "./leagueModel";
import { loadTrackedMovieFile, type TrackedMovieFile } from "./movieData";

type LeagueConsoleProps = {
  client: FirebaseClient;
  pathname: string;
  previewReset?: {
    disabled: boolean;
    onReset: () => void;
  };
  snapshotOwnerUidOverride?: string;
  search: string;
  onNavigate: (pathname: string) => void;
  onSignOut: () => void;
  universeState: UniverseState;
  user: User | null;
  writerUser?: User | null;
};

type LeagueConsoleView = "league" | "scoring" | "available" | "released";
type LeagueShortcutView = LeagueConsoleView | "theater";
type LeagueRoute = {
  commissionerUsername: string;
  leagueId: string;
  playerUsername: string | null;
  section: LeagueConsoleView | "theater";
};

type DraftStatus = {
  currentUsername: string | null;
  isCurrentUserTurn: boolean;
  order: string[];
  phase: "active" | "complete" | "not-started";
  pickIndex: number;
  round: number;
  shouldFinalize: boolean;
  totalRounds: number;
};

const EMPTY_UNIVERSE = {};
const CATEGORY_ICON_BY_ID: Record<string, string> = {
  "budget-alchemy": "/category-icons/moneymaker.png",
  "cult-furnace": "/category-icons/letterboom.png",
  disasterpiece: "/category-icons/disasterpiece.png",
  "packed-house": "/category-icons/crowd-favorite.png",
  "rotten-crowd": "/category-icons/letterbust.png",
  "tiny-thunder": "/category-icons/word-of-mouth.png",
};

function timestamp() {
  return Date.now();
}

function updateEncoded(client: FirebaseClient, path: string, value: Record<string, unknown>) {
  return update(ref(client.database, path), encodeFirebaseValue(value) as Record<string, unknown>);
}

function updateUserRoot(
  client: FirebaseClient,
  targetUid: string,
  writerUser: User,
  value: Record<string, unknown>,
) {
  const now = timestamp();
  const adminFields =
    writerUser.uid === targetUid
      ? {}
      : {
          adminWrite: writerUser.email ?? "",
          currentTime: now,
        };

  return updateEncoded(client, `users/${targetUid}`, {
    ...value,
    ...adminFields,
  });
}

type CommissionerEventPayload =
  | { email: string; kind: "accept-member"; playerId: string; targetUid: string }
  | { kind: "delete-league" }
  | { kind: "finalize-draft" }
  | { kind: "kick-member"; targetUid: string }
  | { draftOrder: string[]; draftRounds: number; kind: "start-draft" }
  | { kind: "rename-league"; name: string }
  | { kind: "update-scoring"; scoring: ScoringRuleSet };

async function appendCommissionerEvent(
  client: FirebaseClient,
  writerUser: User,
  summary: LeagueSummary,
  universeValue: unknown,
  payload: CommissionerEventPayload,
) {
  const eventId = nextCommissionerEventId(
    readOwnCommissionerEvents(universeValue, summary.commissionerUid, summary),
  );
  const event = {
    ...payload,
    commissionerUid: summary.commissionerUid,
    createdAt: timestamp(),
    eventId,
    leagueId: summary.league.leagueId,
  } as CommissionerEvent;

  await updateUserRoot(client, summary.commissionerUid, writerUser, {
    [`commissionerEvents/${summary.membershipKey}/${firebasePathKey(event.eventId)}`]: event,
    updatedAt: serverTimestamp(),
  });
}

function leagueSectionLabel(section: LeagueRoute["section"] | LeagueConsoleView | null | undefined) {
  return section === "available"
    ? "Available"
    : section === "released"
      ? "Released"
      : section === "scoring"
        ? "Scoring"
        : section === "theater"
          ? "Theater"
          : "League Home";
}

function leagueRoute(pathname: string): LeagueRoute | null {
  const [, root, commissioner, leagueId, section, playerUsername] = pathname.split("/");
  if (root !== "league" || !commissioner || !leagueId) {
    return null;
  }

  const routeSection =
    section === "scoring" || section === "available" || section === "released" || section === "theater"
      ? section
      : "league";

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
  previewReset,
  snapshotOwnerUidOverride,
  search,
  onNavigate,
  onSignOut,
  universeState,
  user,
  writerUser = user,
}: LeagueConsoleProps) {
  const [view, setView] = useState<LeagueConsoleView>("league");
  const [movieFile, setMovieFile] = useState<TrackedMovieFile | null>(null);
  const [movieFileError, setMovieFileError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
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
  const actingUserResolution = useMemo(
    () => resolveActingUser(user, selectedLeague, search),
    [search, selectedLeague, user],
  );
  const actingUser = actingUserResolution.user;
  const actualAccountLabel = user ? usernameFromEmail(user.email, "player") : "Not Logged In";
  const accountLabel =
    actingUser && user && actingUser.uid !== user.uid
      ? `${usernameFromEmail(actingUser.email, actingUser.uid)} via ${actualAccountLabel}`
      : actualAccountLabel;
  const leagueMenuLabel = selectedLeague
    ? `${commissionerUsername(selectedLeague)}/${selectedLeague.league.leagueId}`
    : null;
  const routeLabel = routeLeague ? leagueSectionLabel(routeLeague.section) : null;
  const shellKicker = routeLeague ? routeLabel ?? "League Home" : "FantasyFilmBall";
  const shellTitle = selectedLeague ? selectedLeague.league.name : routeLabel ?? "League picker";
  const activeView: LeagueConsoleView = routeLeague
    ? routeLeague.section === "scoring" ||
      routeLeague.section === "available" ||
      routeLeague.section === "released"
      ? routeLeague.section
      : "league"
    : view;
  const activeShortcut: LeagueShortcutView = routeLeague?.section === "theater" ? "theater" : activeView;
  const ownMember = actingUser && selectedLeague ? selectedLeague.league.members[actingUser.uid] ?? null : null;
  const ownTheaterPath =
    selectedLeague && ownMember && actingUser
      ? `${leaguePath(selectedLeague)}/theater/${encodeURIComponent(
          usernameFromEmail(ownMember.email, actingUser.uid),
        )}`
      : null;

  function changeView(nextView: LeagueConsoleView) {
    if (!selectedLeague) {
      setView(nextView);
      return;
    }

    const basePath = leaguePath(selectedLeague);
    const nextPath = nextView === "league" ? basePath : `${basePath}/${nextView}`;
    onNavigate(nextPath);
  }

  function openOwnTheater() {
    if (ownTheaterPath) {
      onNavigate(ownTheaterPath);
    }
  }

  async function saveScoringRules(rules: ScoringRuleSet) {
    if (!selectedLeague || !user || !writerUser || selectedLeague.commissionerUid !== user.uid) {
      throw new Error("Only this league's commissioner can edit scoring positions and formulas.");
    }

    await appendCommissionerEvent(client, writerUser, selectedLeague, universeValue, {
      kind: "update-scoring",
      scoring: rules,
    });
  }

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
        activeShortcut={activeShortcut}
        accountLabel={accountLabel}
        leagueMenuLabel={leagueMenuLabel}
        ownTheaterPath={ownTheaterPath}
        kicker={shellKicker}
        previewReset={previewReset}
        title={shellTitle}
        onNavigate={onNavigate}
        onLeaguePickerClick={() => setMessage("During the inaugural season, there is only one league that exists.")}
        onOpenOwnTheater={openOwnTheater}
        onSignOut={onSignOut}
        onViewChange={changeView}
        user={user}
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

  if (!movieFile && activeView !== "scoring") {
    if (!movieFileError) {
      return <main className="ffb-page" aria-label="Loading movie data" />;
    }

    return (
      <Shell
        activeShortcut={activeShortcut}
        accountLabel={accountLabel}
        leagueMenuLabel={leagueMenuLabel}
        ownTheaterPath={ownTheaterPath}
        kicker={shellKicker}
        previewReset={previewReset}
        title={shellTitle}
        onNavigate={onNavigate}
        onLeaguePickerClick={() => setMessage("During the inaugural season, there is only one league that exists.")}
        onOpenOwnTheater={openOwnTheater}
        onSignOut={onSignOut}
        onViewChange={changeView}
        user={user}
      >
        <section className="ffb-panel">
          <p className="ffb-label">Tracked movies</p>
          <h2>Unable to load movies</h2>
          <p className="ffb-error">{movieFileError}</p>
        </section>
      </Shell>
    );
  }

  return (
    <Shell
      activeShortcut={activeShortcut}
      accountLabel={accountLabel}
      leagueMenuLabel={leagueMenuLabel}
      ownTheaterPath={ownTheaterPath}
      kicker={shellKicker}
      previewReset={previewReset}
      title={shellTitle}
      onNavigate={onNavigate}
      onLeaguePickerClick={() => setMessage("During the inaugural season, there is only one league that exists.")}
      onOpenOwnTheater={openOwnTheater}
      onSignOut={onSignOut}
      onViewChange={changeView}
      user={user}
    >
      {actingUserResolution.warning ? <p className="ffb-toast">{actingUserResolution.warning}</p> : null}
      {message ? <p className="ffb-toast">{message}</p> : null}
      {activeView === "scoring" ? (
        <ScoringRulesContent
          onChangeLeague={() => {
            onNavigate("/league");
            setView("league");
          }}
          onOpenLeague={() => changeView("league")}
          onSaveRules={saveScoringRules}
          search={search}
          selectedLeague={selectedLeague}
          user={user}
        />
      ) : selectedLeague && movieFile ? (
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
          search={search}
          summary={selectedLeague}
          universeValue={universeValue}
          user={actingUser}
          writerUser={writerUser}
          snapshotOwnerUidOverride={snapshotOwnerUidOverride}
        />
      ) : movieFile ? (
        <LeagueDiscovery
          client={client}
          onMessage={setMessage}
          onNavigate={onNavigate}
          routeLeague={routeLeague}
          movieFile={movieFile}
          universeValue={universeValue}
          user={user}
        />
      ) : null}
    </Shell>
  );
}

function resolveActingUser(actualUser: User | null, summary: LeagueSummary | null, search: string) {
  if (!actualUser || !summary) {
    return { user: actualUser, warning: null };
  }

  const login = new URLSearchParams(search).get("login")?.trim();
  if (!login || actualUser.uid !== summary.commissionerUid) {
    return { user: actualUser, warning: null };
  }

  const actingMember = Object.entries(summary.league.members).find(([uid, member]) => {
    return loginMatchesMember(login, uid, member);
  });

  if (!actingMember) {
    return {
      user: actualUser,
      warning: `No league member matches login=${login}.`,
    };
  }

  const [uid, member] = actingMember;
  return { user: userFromLeagueMember(uid, member), warning: null };
}

function loginMatchesMember(login: string, uid: string, member: LeagueMember) {
  const normalizedLogin = normalizeLoginKey(login);
  const emailLocalPart = member.email.split("@")[0] ?? "";
  const candidates = [uid, member.email, emailLocalPart, usernameFromEmail(member.email, "")];

  return candidates.some((candidate) => normalizeLoginKey(candidate) === normalizedLogin);
}

function normalizeLoginKey(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ".");
}

function userFromLeagueMember(uid: string, member: LeagueMember) {
  return {
    displayName: usernameFromEmail(member.email, uid),
    email: member.email,
    emailVerified: true,
    isAnonymous: false,
    uid,
  } as User;
}

function Shell({
  accountLabel,
  activeShortcut,
  children,
  kicker,
  leagueMenuLabel,
  onLeaguePickerClick,
  onNavigate,
  onOpenOwnTheater,
  onSignOut,
  onViewChange,
  ownTheaterPath,
  previewReset,
  title,
  user,
}: {
  accountLabel: string;
  activeShortcut: LeagueShortcutView;
  children?: ReactNode;
  kicker: string;
  leagueMenuLabel: string | null;
  onLeaguePickerClick?: () => void;
  onNavigate: (pathname: string) => void;
  onOpenOwnTheater: () => void;
  onSignOut: () => void;
  onViewChange: (view: LeagueConsoleView) => void;
  ownTheaterPath: string | null;
  previewReset?: {
    disabled: boolean;
    onReset: () => void;
  };
  title: string;
  user: User | null;
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
          <p className="ffb-kicker">{kicker}</p>
          <h1>{title}</h1>
        </div>
        <nav className="ffb-app-nav" aria-label={title}>
          <div className="ffb-app-tools" role="group" aria-label="Account">
            {previewReset ? (
              <button
                className="ffb-preview-reset-button"
                disabled={previewReset.disabled}
                type="button"
                onClick={previewReset.onReset}
              >
                Reset
              </button>
            ) : null}
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
                      onNavigate("/");
                    }}
                  >
                    Home
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setIsAccountMenuOpen(false);
                      onNavigate("/rules");
                    }}
                  >
                    Rules
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setIsAccountMenuOpen(false);
                      onLeaguePickerClick?.();
                    }}
                  >
                    League Picker
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setIsAccountMenuOpen(false);
                      if (user) {
                        onSignOut();
                      } else {
                        onNavigate("/league");
                      }
                    }}
                  >
                    {user ? "Sign Out" : "Sign In"}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          <div className="ffb-app-tabs" role="group" aria-label="League views">
            <button
              aria-pressed={activeShortcut === "scoring"}
              type="button"
              onClick={() => onViewChange("scoring")}
            >
              Scoring
            </button>
            <button
              aria-pressed={activeShortcut === "league"}
              type="button"
              onClick={() => onViewChange("league")}
            >
              League
            </button>
            <button
              aria-pressed={activeShortcut === "available"}
              type="button"
              onClick={() => onViewChange("available")}
            >
              Available
            </button>
            <button
              aria-pressed={activeShortcut === "released"}
              type="button"
              onClick={() => onViewChange("released")}
            >
              Released
            </button>
            <button
              aria-pressed={activeShortcut === "theater"}
              disabled={!ownTheaterPath}
              type="button"
              onClick={onOpenOwnTheater}
            >
              Theater
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
  user: User | null;
}) {
  const [leagueName, setLeagueName] = useState("FantasyFilmBall");
  const [isWriting, setIsWriting] = useState(false);
  const memberships = user ? readMemberships(universeValue, user.uid) : {};
  const ownLeagues = readLeagueSummaries(universeValue).filter(
    (summary) => Boolean(user && (memberships[summary.membershipKey] || summary.commissionerUid === user.uid)),
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
      if (!user) {
        throw new Error("Sign in before starting a league.");
      }

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
        [`snapshots/${key}/${firebasePathKey(snapshotIdFor(snapshot))}`]: snapshot,
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
      if (!user) {
        throw new Error("Sign in before requesting to join.");
      }

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
          <button className="ffb-primary" disabled={isWriting || !user} type="submit">
            {user ? (isWriting ? "Starting" : "Start League") : "Sign in to start a league"}
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
  user: User | null;
}) {
  return (
    <section className="ffb-log" aria-labelledby={`${title.replace(/\W+/g, "-")}-title`}>
      <h2 className="ffb-sr-only" id={`${title.replace(/\W+/g, "-")}-title`}>{title}</h2>
      <div className="ffb-card-list">
        {leagues.length > 0 ? (
          leagues.map((summary) => {
            const membership = memberships[summary.membershipKey];
            const member = user ? summary.league.members[user.uid] : null;
            const isKicked = Boolean(user && summary.league.kicked[user.uid]);
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
                <div className="ffb-actions">
                  <button
                    className="ffb-primary"
                    disabled={!user || isWriting || isActive || isKicked || membership?.status === "requested"}
                    type="button"
                    onClick={() => onRequestJoin(summary)}
                  >
                    {!user
                      ? "Sign in to request"
                      : isActive
                        ? "Joined"
                        : membership?.status === "requested"
                          ? "Requested"
                          : "Request to Join"}
                  </button>
                  {isKicked ? <span className="ffb-badge">Kicked</span> : null}
                </div>
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
  search,
  snapshotOwnerUidOverride,
  summary,
  universeValue,
  user,
  writerUser = user,
}: {
  client: FirebaseClient;
  movieFile: TrackedMovieFile;
  onClearSelection: () => void;
  onMessage: (message: string | null) => void;
  onNavigate: (pathname: string) => void;
  playerUsername: string | null;
  routeSection: LeagueRoute["section"];
  search: string;
  snapshotOwnerUidOverride?: string;
  summary: LeagueSummary;
  universeValue: unknown;
  user: User | null;
  writerUser?: User | null;
}) {
  const [isWriting, setIsWriting] = useState(false);
  const [renderNow] = useState(() => timestamp());
  const finalizingDraftRef = useRef<string | null>(null);
  const viewerUid = user?.uid ?? null;
  const commissionerEvents = useMemo(
    () => readCommissionerEvents(universeValue, summary),
    [summary, universeValue],
  );
  const transactions = useMemo(
    () => readTransactions(universeValue, summary),
    [summary, universeValue],
  );
  const ownTransactions = useMemo(
    () => (viewerUid ? readOwnTransactions(universeValue, viewerUid, summary) : {}),
    [summary, universeValue, viewerUid],
  );
  const snapshotResolution = useMemo(
    () =>
      resolveLeagueSnapshot({
        generatedByUid: viewerUid ?? "signed-out",
        movieFile,
        now: renderNow,
        summary,
        transactions,
        universeValue,
      }),
    [movieFile, renderNow, summary, transactions, universeValue, viewerUid],
  );
  const currentMember = viewerUid ? summary.league.members[viewerUid] : undefined;
  const isCommissioner = Boolean(
    (viewerUid && summary.commissionerUid === viewerUid) ||
      (writerUser && summary.commissionerUid === writerUser.uid),
  );
  const isCommissionerProxyAction = Boolean(
    user &&
      writerUser &&
      user.uid !== writerUser.uid &&
      writerUser.uid === summary.commissionerUid &&
      summary.league.members[user.uid],
  );
  const isActive = Boolean(currentMember);
  const isKicked = Boolean(viewerUid && summary.league.kicked[viewerUid]);
  const isActionDisabled = isWriting || !writerUser;
  const pendingRequests = getPendingRequests(universeValue, summary);
  const kickedRequests = getKickedRequests(universeValue, summary);
  const draftStatus = getDraftStatus(summary, transactions, snapshotResolution, user);

  useEffect(() => {
    if (!user || !isActive || !snapshotResolution.shouldWrite) {
      return;
    }

    let active = true;
    const snapshot = snapshotResolution.snapshot;
    const writer = writerUser;
    if (!writer) {
      return;
    }

    const snapshotOwnerUid = snapshotOwnerUidOverride ?? (isCommissionerProxyAction ? summary.commissionerUid : user.uid);
    const snapshotKey = firebasePathKey(snapshotIdFor(snapshot));
    const snapshotPath = `snapshots/${summary.membershipKey}/${snapshotKey}`;
    const snapshotUpdate = {
      [snapshotPath]: snapshot,
      updatedAt: serverTimestamp(),
    };
    updateUserRoot(client, snapshotOwnerUid, writer, snapshotUpdate)
      .catch((error: unknown) => {
        if (active) {
          const debug = snapshotWriteDebug({
            error,
            isCommissionerProxyAction,
            snapshot,
            snapshotOwnerUid,
            snapshotPath,
            writer,
          });
          console.error("Snapshot save failed", {
            ...debug,
            update: snapshotUpdate,
          });
          onMessage(
            `Snapshot save failed: ${debug.message}`,
          );
        }
      });

    return () => {
      active = false;
    };
  }, [
    client,
    isActive,
    isCommissionerProxyAction,
    snapshotResolution.shouldWrite,
    snapshotResolution.snapshot,
    onMessage,
    snapshotOwnerUidOverride,
    summary.commissionerUid,
    summary.membershipKey,
    user,
    writerUser,
  ]);

  async function writeOwnTransaction(transaction: LeagueTransaction) {
    if (!user) {
      throw new Error("Sign in before submitting transactions.");
    }

    if (!writerUser) {
      throw new Error("Sign in with an account that can write preview data.");
    }

    const transactionWithAudit = isCommissionerProxyAction
      ? {
          ...transaction,
          enteredByUid: writerUser.uid,
          enteredByUsername: usernameFromEmail(writerUser.email, writerUser.uid),
        }
      : transaction;
    const writeUid = isCommissionerProxyAction ? summary.commissionerUid : user.uid;
    const writePath = isCommissionerProxyAction
      ? `proxyTransactions/${summary.membershipKey}/${firebasePathKey(transaction.txnId)}`
      : `transactions/${summary.membershipKey}/${firebasePathKey(transaction.txnId)}`;

    await updateUserRoot(client, writeUid, writerUser, {
      [writePath]: transactionWithAudit,
      updatedAt: serverTimestamp(),
    });
  }

  async function requestJoin() {
    if (!user) {
      throw new Error("Sign in before requesting to join.");
    }

    if (isKicked) {
      throw new Error("You cannot rejoin this league.");
    }

    if (!writerUser) {
      throw new Error("Sign in with an account that can write preview data.");
    }

    const now = timestamp();
    await updateUserRoot(client, user.uid, writerUser, {
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

  async function writeCommissionerEvent(payload: CommissionerEventPayload) {
    if (!user || !writerUser || !isCommissioner) {
      throw new Error("Only the commissioner can change league settings.");
    }

    await appendCommissionerEvent(client, writerUser, summary, universeValue, payload);
  }

  async function acceptRequest(request: JoinRequest) {
    if (!user || !isCommissioner) {
      throw new Error("Only the commissioner can accept join requests.");
    }

    const playerId = nextAvailablePlayerId(summary);
    await writeCommissionerEvent({
      email: request.email ?? "",
      kind: "accept-member",
      playerId,
      targetUid: request.uid,
    });
  }

  async function kickRequest(request: JoinRequest) {
    if (!user || !isCommissioner) {
      throw new Error("Only the commissioner can kick join requests.");
    }

    await writeCommissionerEvent({
      kind: "kick-member",
      targetUid: request.uid,
    });
  }

  async function startDraft(rounds: number) {
    if (!user || !isCommissioner) {
      throw new Error("Only the commissioner can begin the draft.");
    }

    if (summary.league.draftOrder !== undefined) {
      throw new Error("This league has already started or completed its draft.");
    }

    const draftOrder = buildSnakeDraftOrder(summary, rounds);
    if (draftOrder.length === 0) {
      throw new Error("A draft needs at least one member.");
    }

    await writeCommissionerEvent({
      draftOrder,
      draftRounds: rounds,
      kind: "start-draft",
    });
  }

  useEffect(() => {
    if (!writerUser || !isCommissioner || !draftStatus.shouldFinalize) {
      return;
    }

    const finalizeKey = `${summary.membershipKey}:${draftStatus.pickIndex}`;
    if (finalizingDraftRef.current === finalizeKey) {
      return;
    }

    finalizingDraftRef.current = finalizeKey;
    appendCommissionerEvent(client, writerUser, summary, universeValue, {
      kind: "finalize-draft",
    }).catch((error: unknown) => {
      finalizingDraftRef.current = null;
      onMessage(error instanceof Error ? `Draft finalization failed: ${error.message}` : "Draft finalization failed.");
    });
  }, [
    client,
    draftStatus.pickIndex,
    draftStatus.shouldFinalize,
    isCommissioner,
    onMessage,
    summary,
    universeValue,
    writerUser,
  ]);

  return (
    <>
      {routeSection === "theater" && selectedPlayerUsername ? (
        <PlayerDetailPanel
          playerUsername={selectedPlayerUsername}
          resolution={snapshotResolution}
          summary={summary}
        />
      ) : routeSection === "available" ? (
          <AvailableFilmsPanel
          disabled={isActionDisabled}
          draftStatus={draftStatus}
          isCommissioner={isCommissioner}
          member={currentMember ?? null}
          ownTransactions={ownTransactions}
          resolution={snapshotResolution}
          summary={summary}
          user={user}
          onSubmit={(transaction) =>
            runAction(async () => {
              await writeOwnTransaction(transaction);
              return `${transaction.kind} ${transaction.txnId} logged.`;
            })
          }
          onStartDraft={(rounds) =>
            runAction(async () => {
              await startDraft(rounds);
              return `Started ${rounds}-round snake draft.`;
            })
          }
        />
      ) : routeSection === "released" ? (
        <ReleasedFilmsPanel resolution={snapshotResolution} search={search} summary={summary} />
      ) : (
        <>
      <TheatersPanel
        disabled={isActionDisabled}
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

      {isActive && user && currentMember ? (
        <MyTheaterActionsPanel
          disabled={isActionDisabled}
          draftStatus={draftStatus}
          member={currentMember}
          ownTransactions={ownTransactions}
          resolution={snapshotResolution}
          user={user}
          onDrop={(transaction) =>
            runAction(async () => {
              await writeOwnTransaction(transaction);
              return `Drop ${transaction.txnId} logged.`;
            })
          }
        />
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
          <button
            className="ffb-primary"
            disabled={isActionDisabled || Boolean(currentMember) || isKicked}
            type="button"
            onClick={() =>
              user
                ? runAction(async () => {
                    await requestJoin();
                    return `Requested to join ${summary.league.name}.`;
                  })
                : onNavigate("/league")
            }
          >
            {!user
              ? "Sign in to request access"
              : isKicked
                ? "Kicked"
                : currentMember
                  ? "Request Pending"
                  : "Request to Join"}
          </button>
        </section>
      )}

      <TransactionLog
        commissionerEvents={commissionerEvents}
        resolution={snapshotResolution}
        summary={summary}
        transactions={transactions}
      />

      <CommissionerPanel
        canEdit={Boolean(isCommissioner && user)}
        isWriting={isActionDisabled}
        onDelete={() =>
          runAction(async () => {
            await writeCommissionerEvent({ kind: "delete-league" });
            onClearSelection();
            return `${summary.league.name} deleted.`;
          })
        }
        onRename={(name) =>
          runAction(async () => {
            await writeCommissionerEvent({ kind: "rename-league", name });
            return "League name updated.";
          })
        }
        summary={summary}
      />
        </>
      )}
    </>
  );
}

function CommissionerPanel({
  canEdit,
  isWriting,
  onDelete,
  onRename,
  summary,
}: {
  canEdit: boolean;
  isWriting: boolean;
  onDelete: () => void;
  onRename: (name: string) => void;
  summary: LeagueSummary;
}) {
  const [leagueName, setLeagueName] = useState(summary.league.name);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const isDisabled = isWriting || !canEdit;

  async function renameLeague(event: FormEvent) {
    event.preventDefault();
    if (isDisabled) {
      return;
    }

    onRename(leagueName.trim() || summary.league.name);
  }

  async function deleteLeague(event: FormEvent) {
    event.preventDefault();
    if (isDisabled || deleteConfirmation !== summary.league.leagueId) {
      return;
    }

    onDelete();
  }

  return (
    <section
      className={`ffb-commissioner-panel${canEdit ? "" : " ffb-commissioner-panel-disabled"}`}
      aria-disabled={!canEdit}
      aria-labelledby="commissioner-title"
    >
      <div className="ffb-universe-head">
        <div>
          <h2 id="commissioner-title">Commissioner Settings</h2>
          {!canEdit ? <p className="ffb-muted">Only the commissioner can change these settings.</p> : null}
        </div>
      </div>
      <div className="ffb-commissioner-grid">
        <form className="ffb-commissioner-card ffb-form" onSubmit={renameLeague}>
          <div>
            <h3>League name</h3>
          </div>
          <input disabled={isDisabled} value={leagueName} onChange={(event) => setLeagueName(event.target.value)} />
          <button className="ffb-primary" disabled={isDisabled} type="submit">
            Rename
          </button>
        </form>

        <form className="ffb-commissioner-card ffb-danger-panel ffb-form" onSubmit={deleteLeague}>
          <div>
            <h3>Delete league</h3>
          </div>
          <input
            disabled={isDisabled}
            placeholder={`Type ${summary.league.leagueId} to confirm`}
            value={deleteConfirmation}
            onChange={(event) => setDeleteConfirmation(event.target.value)}
          />
          <button
            className="ffb-danger-button"
            disabled={isDisabled || deleteConfirmation !== summary.league.leagueId}
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
  user: User | null;
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
  const earnedPointsByPlayer = releasedPointsByPlayer(summary, resolution);

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
          const isCurrentPlayer = Boolean(user && player.uid === user.uid);
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
              <span role="cell">
                {released.length}/{formatSummaryPoints(earnedPointsByPlayer[player.uid] ?? 0)}
              </span>
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
              <button disabled type="button" onClick={() => onKickRequest(request)}>
                Kick
              </button>
              <span className="ffb-inline-state">kicked</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

type ReleasedSortKey =
  | "budget"
  | "gross"
  | "lbAverage"
  | "lbRatings"
  | "maxPoints"
  | "owner"
  | "releaseDate"
  | "title";

type ReleasedSort = {
  direction: "asc" | "desc";
  key: ReleasedSortKey;
};

type ReleasedYear = "2025" | "2026";

const RELEASED_YEARS: ReleasedYear[] = ["2025", "2026"];

function defaultReleasedYear(): ReleasedYear {
  const currentYear = String(new Date().getFullYear()) as ReleasedYear;
  return RELEASED_YEARS.includes(currentYear) ? currentYear : "2025";
}

function ReleasedFilmsPanel({
  resolution,
  search,
  summary,
}: {
  resolution: SnapshotResolution;
  search: string;
  summary: LeagueSummary;
}) {
  const [sort, setSort] = useState<ReleasedSort>({ direction: "desc", key: "maxPoints" });
  const releasedYear = yearFromSearch(search, RELEASED_YEARS, defaultReleasedYear());
  const [historicalMovies, setHistoricalMovies] = useState<
    { filmId: string; movie: DerivedMovieState }[]
  >([]);
  const [historicalMovieError, setHistoricalMovieError] = useState<string | null>(null);
  const state = resolution.snapshot.state;
  const ownerPoints = releasedPointsByPlayer(summary, resolution);
  const movieEntries =
    releasedYear === "2025"
      ? historicalMovies.map(({ filmId, movie }) => [filmId, movie] as const)
      : Object.entries(state.movies).filter(
          ([, movie]) => movie.locked && movie.releaseDate.startsWith(`${releasedYear}-`),
        );
  const rows = movieEntries
    .map(([filmId, movie]) => {
      const owner =
        releasedYear === "2025"
          ? "Unowned"
          : movie.ownerUid
            ? playerUsername(summary, movie.ownerUid, movie.ownerUid)
            : "Unowned";
      const strongestCategory = strongestMovieCategory(movie, summary.league.scoring);
      const maxPoints = strongestCategory?.score ?? 0;

      return {
        filmId,
        maxPoints,
        movie,
        owner,
        ownerPoints: movie.ownerUid ? ownerPoints[movie.ownerUid] ?? 0 : Number.NEGATIVE_INFINITY,
        strongestCategory,
      };
    })
    .sort((left, right) => compareReleasedRows(left, right, sort));

  useEffect(() => {
    let active = true;

    if (releasedYear !== "2025") {
      return () => {
        active = false;
      };
    }

    loadHistoricalReleasedMovies("2025")
      .then((movies) => {
        if (active) {
          setHistoricalMovieError(null);
          setHistoricalMovies(movies);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setHistoricalMovieError(
            error instanceof Error ? error.message : "Historical movie data failed to load.",
          );
          setHistoricalMovies([]);
        }
      });

    return () => {
      active = false;
    };
  }, [releasedYear]);

  function changeSort(key: ReleasedSortKey) {
    setSort((current) => {
      if (key === "owner") {
        return { direction: "desc", key };
      }

      return {
        direction: current.key === key && current.direction === "desc" ? "asc" : "desc",
        key,
      };
    });
  }

  return (
    <>
      <YearSelectorToolbar
        count={rows.length}
        value={releasedYear}
        years={RELEASED_YEARS}
        onChange={(year) => {
          setHistoricalMovieError(null);
          if (year !== "2025") {
            setHistoricalMovies([]);
          }
          replaceYearQuery(year);
        }}
      />
      {historicalMovieError ? <p className="ffb-error">{historicalMovieError}</p> : null}
      <section className="ffb-player-detail ffb-released-panel" aria-label="Released films">
        {rows.length > 0 ? (
          <div className="ffb-released-table" role="table" aria-label="Released films">
            <div className="ffb-released-row ffb-released-row--head" role="row">
              <span role="columnheader">#</span>
              <SortHeader activeSort={sort} label="Film" sortKey="title" onSort={changeSort} />
              <SortHeader activeSort={sort} label="Max Pts" sortKey="maxPoints" onSort={changeSort} />
              <SortHeader activeSort={sort} label="Release Day" sortKey="releaseDate" onSort={changeSort} />
              <SortHeader activeSort={sort} label="Owner" sortKey="owner" onSort={changeSort} />
              <SortHeader activeSort={sort} label="Gross" sortKey="gross" onSort={changeSort} />
              <SortHeader activeSort={sort} label="Budget" sortKey="budget" onSort={changeSort} />
              <SortHeader activeSort={sort} label="LB Avg" sortKey="lbAverage" onSort={changeSort} />
              <SortHeader activeSort={sort} label="LB Ratings" sortKey="lbRatings" onSort={changeSort} />
            </div>
            {rows.map(({ filmId, maxPoints, movie, owner, strongestCategory }, index) => (
              <div className="ffb-released-row" key={filmId} role="row">
                <span className="ffb-released-index" role="cell">
                  {index + 1}
                </span>
                <div role="cell">
                  <FilmTitle movie={movie} />
                </div>
                <strong className="ffb-max-points-cell" role="cell">
                  {formatPoints(maxPoints)}
                  {strongestCategory ? (
                    <img alt="" src={strongestCategory.iconSrc} title={strongestCategory.name} />
                  ) : null}
                </strong>
                <span role="cell">{formatReleaseDay(movie.releaseDate)}</span>
                <span role="cell">{owner}</span>
                <span role="cell">{formatMoney(movie.domesticGross)}</span>
                <span role="cell">{formatMoney(movie.productionBudget)}</span>
                <span role="cell">{formatRating(movie.letterboxdAverage)}</span>
                <span role="cell">{formatCount(movie.letterboxdRatingCount)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="ffb-muted">No tracked films have released yet.</p>
        )}
      </section>
    </>
  );
}

function SortHeader({
  activeSort,
  label,
  onSort,
  sortKey,
}: {
  activeSort: ReleasedSort;
  label: string;
  onSort: (key: ReleasedSortKey) => void;
  sortKey: ReleasedSortKey;
}) {
  const isActive = activeSort.key === sortKey;
  const direction = isActive ? activeSort.direction : null;

  return (
    <button
      aria-label={`Sort by ${label}${direction ? `, currently ${direction}` : ""}`}
      type="button"
      onClick={() => onSort(sortKey)}
    >
      {label}
      {direction ? <span aria-hidden="true">{direction === "desc" ? "↓" : "↑"}</span> : null}
    </button>
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
        {films.length === 0 ? (
          <p className="ffb-muted ffb-theater-empty-inline">No films in this theater yet.</p>
        ) : null}
        <span>{player.stubs} stubs</span>
      </div>
      {films.length > 0 ? (
        <div className="ffb-player-film-list">
          {films.map((movie) => (
            <article key={`${player.uid}-${movie.title}`}>
              <FilmTitle movie={movie} />
              <p className="ffb-film-meta">
                {movie.releaseDate} · {movie.locked ? "Released" : "Unreleased"}
              </p>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function DraftPanel({
  disabled,
  draftStatus,
  isCommissioner,
  onStart,
  playerCount,
}: {
  disabled: boolean;
  draftStatus: DraftStatus;
  isCommissioner: boolean;
  onStart: (rounds: number) => void;
  playerCount: number;
}) {
  const [rounds, setRounds] = useState(2);

  if (draftStatus.phase === "complete") {
    return null;
  }

  return (
    <section className={`ffb-player-detail ffb-draft-panel${draftStatus.isCurrentUserTurn ? " ffb-draft-panel--turn" : ""}`}>
      <div className="ffb-universe-head">
        <div>
          <p className="ffb-label">Draft</p>
          <h2>{draftStatus.phase === "active" ? "Snake draft active" : "Draft not started"}</h2>
        </div>
        {draftStatus.phase === "active" ? (
          <span>
            Round {draftStatus.round}/{draftStatus.totalRounds}
          </span>
        ) : null}
      </div>
      {draftStatus.phase === "not-started" ? (
        <div className="ffb-draft-start">
          <div>
            <p>Only the commissioner can begin a random-order snake draft.</p>
            <div className="ffb-draft-start-meta">
              <label>
                <span>Rounds</span>
                <input
                  min={1}
                  max={12}
                  type="number"
                  value={rounds}
                  onChange={(event) => setRounds(Math.max(1, Number(event.target.value) || 1))}
                />
              </label>
              <span>
                {playerCount} {playerCount === 1 ? "player" : "players"}
              </span>
            </div>
          </div>
          <button
            className="ffb-draft-start-button"
            disabled={disabled || !isCommissioner}
            type="button"
            onClick={() => onStart(rounds)}
          >
            Start Draft
          </button>
        </div>
      ) : (
        <>
          <p>
            {draftStatus.isCurrentUserTurn
              ? "You're on the clock. Draft a film from the available list."
              : `${draftStatus.currentUsername} is on the clock.`}
          </p>
          <ol className="ffb-draft-order">
            {draftStatus.order.map((username, index) => (
              <li
                className={index === draftStatus.pickIndex ? "ffb-draft-order-current" : ""}
                key={`${username}-${index}`}
              >
                {username}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function FilmTitle({
  movie,
}: {
  movie: { letterboxdSlug?: string | null; posterUrl?: string | null; title: string };
}) {
  const url = letterboxdUrl(movie.letterboxdSlug);

  return (
    <div className="ffb-film-title">
      {movie.posterUrl ? (
        <img alt="" src={movie.posterUrl} />
      ) : (
        <span aria-hidden="true">{movie.title.trim().charAt(0) || "F"}</span>
      )}
      <h3>
        {url ? (
          <a href={url} target="_blank" rel="noreferrer">
            {movie.title}
          </a>
        ) : (
          movie.title
        )}
      </h3>
    </div>
  );
}

function letterboxdUrl(slug: string | null | undefined) {
  if (!slug) {
    return null;
  }

  const path = slug.startsWith("film/") ? slug : `film/${slug}`;
  return `https://letterboxd.com/${path.replace(/^\/+|\/+$/g, "")}/`;
}

function MyTheaterActionsPanel({
  disabled,
  draftStatus,
  member,
  onDrop,
  ownTransactions,
  resolution,
  user,
}: {
  disabled: boolean;
  draftStatus: DraftStatus;
  member: LeagueMember;
  onDrop: (transaction: LeagueTransaction) => void;
  ownTransactions: Record<string, LeagueTransaction>;
  resolution: SnapshotResolution;
  user: User;
}) {
  const state = resolution.snapshot.state;
  const player = state.players[user.uid];
  const films = (player?.theater ?? [])
    .map((filmId) => ({ filmId, movie: state.movies[filmId] }))
    .filter((row): row is { filmId: string; movie: NonNullable<typeof row.movie> } => Boolean(row.movie))
    .sort((left, right) => left.movie.releaseDate.localeCompare(right.movie.releaseDate));

  function dropFilm(filmId: string, title: string) {
    if (!window.confirm(`Drop ${title}? This will put it into a 48-hour waiver auction.`)) {
      return;
    }

    onDrop(simpleTransaction(member, ownTransactions, user, filmId, "drop"));
  }

  return (
    <section className="ffb-player-detail" aria-labelledby="my-theater-title">
      <div className="ffb-universe-head">
        <div>
          <p className="ffb-label">My theater</p>
          <h2 id="my-theater-title">My Films</h2>
        </div>
        <span>{player?.stubs ?? 0} stubs</span>
      </div>
      {films.length > 0 ? (
        <div className="ffb-player-film-list ffb-compact-film-list">
          {films.map(({ filmId, movie }) => (
            <article key={`${user.uid}-${filmId}`}>
              <FilmTitle movie={movie} />
              <p className="ffb-film-meta">
                {movie.releaseDate} · {movie.locked ? "Released" : "Unreleased"}
              </p>
              <button
                disabled={disabled || movie.locked || draftStatus.phase !== "complete"}
                type="button"
                onClick={() => dropFilm(filmId, movie.title)}
              >
                Drop
              </button>
            </article>
          ))}
        </div>
      ) : (
        <p className="ffb-muted">No films in your theater yet.</p>
      )}
    </section>
  );
}

function AvailableFilmsPanel({
  disabled,
  draftStatus,
  isCommissioner,
  member,
  onStartDraft,
  onSubmit,
  ownTransactions,
  resolution,
  summary,
  user,
}: {
  disabled: boolean;
  draftStatus: DraftStatus;
  isCommissioner: boolean;
  member: LeagueMember | null;
  onStartDraft: (rounds: number) => void;
  onSubmit: (transaction: LeagueTransaction) => void;
  ownTransactions: Record<string, LeagueTransaction>;
  resolution: SnapshotResolution;
  summary: LeagueSummary;
  user: User | null;
}) {
  const [bidFilmId, setBidFilmId] = useState<string | null>(null);
  const state = resolution.snapshot.state;
  const player = user ? state.players[user.uid] ?? null : null;
  const isTheaterFull = Boolean(player && player.theater.length >= summary.league.config.maxTheaterSize);
  const canDraft = Boolean(member && draftStatus.phase === "active" && draftStatus.isCurrentUserTurn);
  const ownedFilms = (player?.theater ?? [])
    .map((filmId) => ({ filmId, movie: state.movies[filmId] }))
    .filter((row): row is { filmId: string; movie: NonNullable<typeof row.movie> } => Boolean(row.movie))
    .sort((left, right) => left.movie.title.localeCompare(right.movie.title));
  const movies = Object.entries(state.movies)
    .filter(([, movie]) => !movie.ownerUid && !movie.locked)
    .map(([filmId, movie]) => ({ filmId, movie }))
    .sort((left, right) => {
      return (
        left.movie.releaseDate.localeCompare(right.movie.releaseDate) ||
        left.movie.title.localeCompare(right.movie.title)
      );
    });
  const bidFilm = bidFilmId ? movies.find(({ filmId }) => filmId === bidFilmId) ?? null : null;

  function pickupFilm(filmId: string) {
    if (!member || !user) {
      return;
    }

    onSubmit(simpleTransaction(member, ownTransactions, user, filmId, "pickup"));
  }

  function draftFilm(filmId: string) {
    if (!member || !user) {
      return;
    }

    onSubmit(simpleTransaction(member, ownTransactions, user, filmId, "pickup", 0));
  }

  function availableFilmAction(filmId: string, status: string) {
    if (draftStatus.phase === "active" || draftStatus.phase === "not-started") {
      return {
        disabled: disabled || draftStatus.phase !== "active" || !canDraft || isTheaterFull,
        label: draftStatus.phase === "not-started" ? "Predraft" : "Draft",
        onClick: () => draftFilm(filmId),
      };
    }

    if (status === "free-agent") {
      return {
        disabled: disabled || !member || isTheaterFull,
        label: "Pickup",
        onClick: () => pickupFilm(filmId),
      };
    }

    return {
      disabled: disabled || !isAuctionStatus(status) || !member,
      label: "Bid",
      onClick: () => setBidFilmId(filmId),
    };
  }

  return (
    <>
      <DraftPanel
        disabled={disabled}
        draftStatus={draftStatus}
        isCommissioner={isCommissioner}
        onStart={onStartDraft}
        playerCount={Object.keys(summary.league.members).length}
      />
      <section
        className={`ffb-player-detail${draftStatus.isCurrentUserTurn ? " ffb-draft-panel--turn" : ""}`}
        aria-labelledby="available-films-title"
      >
        <div className="ffb-universe-head">
          <div>
            <p className="ffb-label">Market</p>
            <h2 id="available-films-title">Available Films</h2>
          </div>
          <span>{movies.length} films</span>
        </div>
        {movies.length > 0 ? (
          <div className="ffb-player-film-list ffb-available-film-list">
            {movies.map(({ filmId, movie }) => {
              const action = availableFilmAction(filmId, movie.status);

              return (
                <article key={filmId}>
                  <FilmTitle movie={movie} />
                  <p className="ffb-film-meta">
                    {movie.releaseDate} · {availableStatusLabel(movie.status)}
                  </p>
                  <button disabled={action.disabled} type="button" onClick={action.onClick}>
                    {action.label}
                  </button>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="ffb-muted">No films are available right now.</p>
        )}
        {bidFilm && member && user ? (
          <BidModal
            disabled={disabled}
            filmId={bidFilm.filmId}
            movieTitle={bidFilm.movie.title}
            member={member}
            ownTransactions={ownTransactions}
            ownedFilms={ownedFilms}
            summary={summary}
            user={user}
            onClose={() => setBidFilmId(null)}
            onSubmit={(transaction) => {
              onSubmit(transaction);
              setBidFilmId(null);
            }}
          />
        ) : null}
      </section>
    </>
  );
}

function isAuctionStatus(status: string) {
  return status === "auction-open" || status === "waiver";
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

function BidModal({
  disabled,
  filmId,
  member,
  movieTitle,
  onClose,
  onSubmit,
  ownTransactions,
  ownedFilms,
  summary,
  user,
}: {
  disabled: boolean;
  filmId: string;
  member: LeagueMember;
  movieTitle: string;
  onClose: () => void;
  onSubmit: (transaction: LeagueTransaction) => void;
  ownTransactions: Record<string, LeagueTransaction>;
  ownedFilms: Array<{ filmId: string; movie: { title: string } }>;
  summary: LeagueSummary;
  user: User;
}) {
  const [amount, setAmount] = useState(25);
  const [dropFilmId, setDropFilmId] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit(bidTransaction(member, ownTransactions, user, summary, filmId, amount, dropFilmId || null));
  }

  return (
    <div className="ffb-modal-backdrop" role="presentation">
      <div className="ffb-modal" role="dialog" aria-modal="true" aria-labelledby="bid-modal-title">
        <form className="ffb-form" onSubmit={submit}>
          <div>
            <p className="ffb-label">Bid</p>
            <h2 id="bid-modal-title">{movieTitle}</h2>
          </div>
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
            <select value={dropFilmId} onChange={(event) => setDropFilmId(event.target.value)}>
              <option value="">No drop stipulation</option>
              {ownedFilms.map(({ filmId: ownedFilmId, movie }) => (
                <option key={ownedFilmId} value={ownedFilmId}>
                  {movie.title}
                </option>
              ))}
            </select>
          </label>
          <div className="ffb-actions">
            <button className="ffb-primary" disabled={disabled} type="submit">
              Submit Bid
            </button>
            <button disabled={disabled} type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function simpleTransaction(
  member: LeagueMember,
  ownTransactions: Record<string, LeagueTransaction>,
  user: User,
  filmId: string,
  kind: "drop" | "pickup",
  fee = 1,
): LeagueTransaction {
  return {
    ...transactionBase(member, ownTransactions, user, fee),
    filmId,
    kind,
  };
}

function bidTransaction(
  member: LeagueMember,
  ownTransactions: Record<string, LeagueTransaction>,
  user: User,
  summary: LeagueSummary,
  filmId: string,
  amount: number,
  dropFilmId: string | null,
): LeagueTransaction {
  const base = transactionBase(member, ownTransactions, user);
  const payload: BidPayload = {
    amount,
    dropFilmId,
    filmId,
    submittedAt: timestamp(),
  };

  return {
    ...base,
    kind: "bid",
    obfuscatedPayload: obfuscateBidPayload(payload, {
      commissionerUid: summary.commissionerUid,
      leagueId: summary.league.leagueId,
      txnId: base.txnId,
    }),
  };
}

function transactionBase(
  member: LeagueMember,
  ownTransactions: Record<string, LeagueTransaction>,
  user: User,
  fee = 1,
) {
  return {
    createdAt: timestamp(),
    fee,
    playerId: member.playerId,
    playerUid: user.uid,
    txnId: nextTxnId(member, ownTransactions),
  };
}

function TransactionLog({
  commissionerEvents,
  resolution,
  summary,
  transactions,
}: {
  commissionerEvents: CommissionerEvent[];
  resolution: SnapshotResolution;
  summary: LeagueSummary;
  transactions: LeagueTransaction[];
}) {
  const [now] = useState(() => timestamp());
  const timelineItems = combinedTimeline(transactions, commissionerEvents);

  return (
    <section className="ffb-log" aria-labelledby="log-title">
      <div className="ffb-universe-head">
        <div>
          <p className="ffb-label">Shared log</p>
          <h2 id="log-title">Timeline</h2>
        </div>
        <span>{timelineItems.length}</span>
      </div>
      <div className="ffb-log-list">
        {timelineItems.length > 0 ? (
          timelineItems.map((item) => (
              <article className="ffb-log-item" key={item.key}>
                <p className="ffb-log-meta">
                  {item.id} · {new Date(item.createdAt).toLocaleString()}
                </p>
                <h3>
                  {item.kind === "commissioner"
                    ? commissionerEventText(item.event, summary)
                    : transactionText(item.transaction, resolution, summary, now)}
                </h3>
              </article>
            ))
        ) : (
          <p className="ffb-muted">No league events yet.</p>
        )}
      </div>
    </section>
  );
}

type TimelineItem =
  | {
      createdAt: number;
      event: CommissionerEvent;
      id: string;
      key: string;
      kind: "commissioner";
    }
  | {
      createdAt: number;
      id: string;
      key: string;
      kind: "player";
      transaction: LeagueTransaction;
    };

function combinedTimeline(
  transactions: LeagueTransaction[],
  commissionerEvents: CommissionerEvent[],
): TimelineItem[] {
  return [
    ...transactions.map((transaction) => ({
      createdAt: transaction.createdAt,
      id: transaction.txnId,
      key: `player:${transaction.enteredByUid ?? transaction.playerUid}:${transaction.playerUid}:${transaction.txnId}`,
      kind: "player" as const,
      transaction,
    })),
    ...commissionerEvents.map((event) => ({
      createdAt: event.createdAt,
      event,
      id: event.eventId,
      key: `commissioner:${event.commissionerUid}:${event.eventId}`,
      kind: "commissioner" as const,
    })),
  ].sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
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

function getDraftStatus(
  summary: LeagueSummary,
  transactions: LeagueTransaction[],
  resolution: SnapshotResolution,
  user: User | null,
): DraftStatus {
  const totalRounds = summary.league.config.draftRounds;
  const draftOrder = summary.league.draftOrder;
  const base = {
    order: Array.isArray(draftOrder) ? draftOrder : [],
    pickIndex: 0,
    round: 0,
    shouldFinalize: false,
    totalRounds,
  };

  if (draftOrder === undefined) {
    return {
      ...base,
      currentUsername: null,
      isCurrentUserTurn: false,
      phase: "not-started",
    };
  }

  if (draftOrder === null) {
    return {
      ...base,
      currentUsername: null,
      isCurrentUserTurn: false,
      phase: "complete",
    };
  }

  const invalidKeys = new Set(
    resolution.snapshot.state.invalidTransactions.map((transaction) => `${transaction.uid}:${transaction.txnId}`),
  );
  const pickIndex = transactions
    .slice()
    .sort((left, right) => left.createdAt - right.createdAt || left.txnId.localeCompare(right.txnId))
    .filter(
      (transaction) =>
        transaction.kind === "pickup" &&
        transaction.fee === 0 &&
        !invalidKeys.has(`${transaction.playerUid}:${transaction.txnId}`),
    ).length;

  if (pickIndex >= draftOrder.length) {
    return {
      ...base,
      currentUsername: null,
      isCurrentUserTurn: false,
      phase: "complete",
      pickIndex,
      round: totalRounds,
      shouldFinalize: true,
    };
  }

  const usernamesPerRound = Math.max(1, Math.round(draftOrder.length / Math.max(1, totalRounds)));
  const round = Math.floor(pickIndex / usernamesPerRound) + 1;
  const currentUsername = draftOrder[pickIndex] ?? null;
  const userUsername = user ? usernameFromEmail(summary.league.members[user.uid]?.email, user.uid) : null;

  return {
    ...base,
    currentUsername,
    isCurrentUserTurn: Boolean(userUsername && currentUsername === userUsername),
    phase: "active",
    pickIndex,
    round,
  };
}

function buildSnakeDraftOrder(summary: LeagueSummary, rounds: number) {
  const usernames = Object.values(summary.league.members)
    .slice()
    .sort((left, right) => left.playerId.localeCompare(right.playerId))
    .map((member) => usernameFromEmail(member.email, member.playerId));
  const shuffled = usernames.slice();

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return Array.from({ length: rounds }, (_, roundIndex) =>
    roundIndex % 2 === 0 ? shuffled : shuffled.slice().reverse(),
  ).flat();
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

function releasedPointsByPlayer(summary: LeagueSummary, resolution: SnapshotResolution) {
  const state = resolution.snapshot.state;
  const totals: Record<string, number> = {};

  for (const player of Object.values(state.players)) {
    const releasedMovies = player.theater
      .map((filmId) => state.movies[filmId])
      .filter((movie): movie is DerivedMovieState => Boolean(movie?.locked));

    totals[player.uid] = bestReleasedScore(releasedMovies, summary.league.scoring);
  }

  return totals;
}

function bestReleasedScore(movies: DerivedMovieState[], scoring: ScoringRuleSet) {
  const scores = scoring.positions.map((position) =>
    movies.map((movie) => scoreMovieForPosition(movie, position.formula) ?? Number.NEGATIVE_INFINITY),
  );
  const memo = new Map<string, number>();

  function search(positionIndex: number, usedFilmIndexes: Set<number>): number {
    if (positionIndex >= scoring.positions.length) {
      return 0;
    }

    const key = `${positionIndex}:${Array.from(usedFilmIndexes).sort((left, right) => left - right).join(",")}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }

    let best = search(positionIndex + 1, usedFilmIndexes);
    for (let movieIndex = 0; movieIndex < movies.length; movieIndex += 1) {
      if (usedFilmIndexes.has(movieIndex)) {
        continue;
      }

      const score = scores[positionIndex]?.[movieIndex];
      if (score === undefined || !Number.isFinite(score)) {
        continue;
      }

      usedFilmIndexes.add(movieIndex);
      best = Math.max(best, score + search(positionIndex + 1, usedFilmIndexes));
      usedFilmIndexes.delete(movieIndex);
    }

    memo.set(key, best);
    return best;
  }

  return search(0, new Set());
}

function strongestMovieCategory(movie: DerivedMovieState, scoring: ScoringRuleSet) {
  const categories = scoring.positions
    .map((position) => {
      const score = scoreMovieForPosition(movie, position.formula);
      const iconSrc = CATEGORY_ICON_BY_ID[position.id];

      return score !== null && Number.isFinite(score) && iconSrc
        ? { iconSrc, name: position.name, score }
        : null;
    })
    .filter((category): category is { iconSrc: string; name: string; score: number } => Boolean(category));

  return categories.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))[0] ?? null;
}

function scoreMovieForPosition(movie: DerivedMovieState, formula: string) {
  return evaluateFormula(formula, scoreInputForMovie(movie));
}

function scoreInputForMovie(movie: DerivedMovieState): MovieScoreInput {
  return {
    A: numberOrNull(movie.letterboxdAverage),
    B: scaledNumberOrNull(movie.productionBudget, 100_000_000),
    G: scaledNumberOrNull(movie.domesticGross, 100_000_000),
    R: scaledNumberOrNull(movie.letterboxdRatingCount, 100_000),
  };
}

function scaledNumberOrNull(value: number | null | undefined, divisor: number) {
  return typeof value === "number" && Number.isFinite(value) ? value / divisor : null;
}

function numberOrNull(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compareReleasedRows(
  left: {
    maxPoints: number;
    movie: DerivedMovieState;
    owner: string;
    ownerPoints: number;
  },
  right: {
    maxPoints: number;
    movie: DerivedMovieState;
    owner: string;
    ownerPoints: number;
  },
  sort: ReleasedSort,
) {
  const multiplier = sort.direction === "asc" ? 1 : -1;

  if (sort.key === "owner") {
    return (
      numberCompare(left.ownerPoints, right.ownerPoints, -1) ||
      numberCompare(left.maxPoints, right.maxPoints, -1) ||
      left.owner.localeCompare(right.owner) ||
      left.movie.title.localeCompare(right.movie.title)
    );
  }

  const compared =
    sort.key === "title"
      ? left.movie.title.localeCompare(right.movie.title)
      : sort.key === "releaseDate"
        ? left.movie.releaseDate.localeCompare(right.movie.releaseDate)
        : sort.key === "gross"
          ? numberCompare(left.movie.domesticGross, right.movie.domesticGross, multiplier)
          : sort.key === "budget"
            ? numberCompare(left.movie.productionBudget, right.movie.productionBudget, multiplier)
            : sort.key === "lbAverage"
              ? numberCompare(left.movie.letterboxdAverage, right.movie.letterboxdAverage, multiplier)
              : sort.key === "lbRatings"
                ? numberCompare(left.movie.letterboxdRatingCount, right.movie.letterboxdRatingCount, multiplier)
                : numberCompare(left.maxPoints, right.maxPoints, multiplier);

  const baseCompared = sort.key === "title" || sort.key === "releaseDate" ? compared * multiplier : compared;

  return (
    baseCompared ||
    numberCompare(left.maxPoints, right.maxPoints, -1) ||
    left.movie.title.localeCompare(right.movie.title)
  );
}

function numberCompare(left: number | null, right: number | null, multiplier: 1 | -1) {
  const leftValue = left ?? Number.NEGATIVE_INFINITY;
  const rightValue = right ?? Number.NEGATIVE_INFINITY;
  return leftValue === rightValue ? 0 : leftValue > rightValue ? multiplier : -multiplier;
}

function formatMoney(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }

  return `$${Math.round(value / 1_000_000).toLocaleString()}M`;
}

function formatCount(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }

  return value >= 1000 ? `${Math.round(value / 1000).toLocaleString()}k` : value.toLocaleString();
}

function formatPoints(value: number) {
  return Number.isFinite(value) ? value.toFixed(1) : "0.0";
}

function formatSummaryPoints(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(1)).toLocaleString() : "0";
}

function formatRating(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

function formatReleaseDay(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) {
    return value;
  }

  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function snapshotWriteDebug({
  error,
  isCommissionerProxyAction,
  snapshot,
  snapshotOwnerUid,
  snapshotPath,
  writer,
}: {
  error: unknown;
  isCommissionerProxyAction: boolean;
  snapshot: SnapshotResolution["snapshot"];
  snapshotOwnerUid: string;
  snapshotPath: string;
  writer: User;
}) {
  const message = error instanceof Error ? error.message : "Permission denied.";
  const metadata = {
    activeMemberUids: snapshot.activeMemberUids,
    commissionerUid: snapshot.commissionerUid,
    generatedAt: snapshot.generatedAt,
    generatedByUid: snapshot.generatedByUid,
    isCommissionerProxyAction,
    leagueId: snapshot.leagueId,
    membershipKey: snapshot.membershipKey,
    movieDataVersion: snapshot.movieDataVersion,
    snapshotPath: `users/${snapshotOwnerUid}/${snapshotPath}`,
    targetOwnerUid: snapshotOwnerUid,
    transactionWatermarks: snapshot.transactionWatermarks,
    writerEmail: writer.email,
    writerUid: writer.uid,
  };

  return {
    ...metadata,
    message: `${message}. Tried users/${snapshotOwnerUid}/${snapshotPath}; writer=${writer.uid}; generatedBy=${snapshot.generatedByUid}; members=${snapshot.activeMemberUids.join(", ")}.`,
  };
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
  const auditSuffix = transaction.enteredByUsername
    ? ` (entered by ${transaction.enteredByUsername})`
    : "";

  if (transaction.kind === "bid") {
    const payload = decodeBidPayload(transaction.obfuscatedPayload, {
      commissionerUid: summary.commissionerUid,
      leagueId: summary.league.leagueId,
      txnId: transaction.txnId,
    });

    if (!payload) {
      return `${player} placed bid ${transaction.txnId}, but the payload could not be decoded${auditSuffix}.`;
    }

    const movie = resolution.snapshot.state.movies[payload.filmId];
    if (movie && movie.auctionDeadline > now) {
      return `${player} placed bid ${transaction.txnId}${auditSuffix}`;
    }

    const drop = payload.dropFilmId ? ` with drop ${payload.dropFilmId}` : "";
    return `${player} bid ${payload.amount} stubs on ${payload.filmId}${drop}${auditSuffix}.`;
  }

  if (transaction.kind === "pickup") {
    return `${player} picked up ${transaction.filmId}${auditSuffix}.`;
  }

  if (transaction.kind === "drop") {
    return `${player} dropped ${transaction.filmId}; 48-hour waiver begins${auditSuffix}.`;
  }

  return `${player} recorded ${transaction.filmId}${auditSuffix}.`;
}

function commissionerEventText(event: CommissionerEvent, summary: LeagueSummary) {
  const commissioner = usernameFromEmail(
    summary.league.members[event.commissionerUid]?.email ?? summary.commissionerEmail,
    summary.commissionerLabel,
  );

  if (event.kind === "accept-member") {
    return `${commissioner} accepted ${usernameFromEmail(event.email, event.targetUid)} into the league.`;
  }

  if (event.kind === "kick-member") {
    return `${commissioner} kicked ${event.targetUid} from the league.`;
  }

  if (event.kind === "start-draft") {
    return `${commissioner} started a ${event.draftRounds}-round snake draft.`;
  }

  if (event.kind === "finalize-draft") {
    return `${commissioner} finalized the draft.`;
  }

  if (event.kind === "rename-league") {
    return `${commissioner} renamed the league to ${event.name}.`;
  }

  if (event.kind === "update-scoring") {
    return `${commissioner} updated scoring rules.`;
  }

  if (event.kind === "delete-league") {
    return `${commissioner} deleted the league.`;
  }

  return `${commissioner} changed league settings.`;
}
