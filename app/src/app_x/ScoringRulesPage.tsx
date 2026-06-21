import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { ref, serverTimestamp, update } from "firebase/database";
import type { FirebaseClient } from "./firebaseClient";
import {
  DEFAULT_SCORING_RULES,
  SCORE_INPUT_HELP,
  evaluateFormula,
  normalizeRuleSet,
  slugifyPosition,
  type ScoringPosition,
  type ScoringRuleSet,
} from "./scoringRules";
import type { UniverseState } from "./LeagueConsole";

type Props = {
  client: FirebaseClient;
  onNavigate: (pathname: string) => void;
  onSignOut: () => void;
  universeState: UniverseState;
  user: User;
};

type LeagueProfile = {
  email: string;
  playerId: string;
  playerLabel: string;
};

type ScoringRulesTransaction = {
  createdAt: number;
  fee: number;
  kind: "scoringRules";
  playerId: string;
  playerLabel: string;
  rules: ScoringRuleSet;
  txnId: string;
};

type MovieRow = {
  budget: number | null;
  domestic_gross: number | null;
  letterboxd_avg: number | null;
  letterboxd_ratings: number | null;
  title: string;
};

const DATA_URL = "/movie_charts/2025/movie_2025_data.csv";

export default function ScoringRulesPage({
  client,
  onNavigate,
  onSignOut,
  universeState,
  user,
}: Props) {
  const [movies, setMovies] = useState<MovieRow[]>([]);
  const [movieError, setMovieError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    fetch(DATA_URL)
      .then((response) => {
        if (!response.ok) {
          throw new Error("Movie data failed to load.");
        }
        return response.text();
      })
      .then((text) => {
        if (active) {
          setMovies(parseCsv(text).map(toMovieRow).filter((movie) => movie.title));
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setMovieError(error instanceof Error ? error.message : "Movie data failed to load.");
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const leagueData = useMemo(
    () => readLeagueData(universeState.status === "ready" ? universeState.value : {}),
    [universeState],
  );
  const currentProfile = leagueData.profilesByUid.get(user.uid);
  const commissionerProfile = leagueData.profiles.find((profile) => profile.playerId === "1");
  const currentRules = leagueData.scoringRules ?? DEFAULT_SCORING_RULES;
  const isCommissioner = currentProfile?.playerId === "1";

  async function saveRules(rules: ScoringRuleSet) {
    if (!currentProfile || !isCommissioner) {
      throw new Error("Only the commissioner can edit scoring rules.");
    }

    const ownTransactions = leagueData.rawTransactionsByUid.get(user.uid) ?? {};
    const txnId = nextTxnId(currentProfile, ownTransactions);
    const transaction: ScoringRulesTransaction = {
      createdAt: Date.now(),
      fee: 0,
      kind: "scoringRules",
      playerId: currentProfile.playerId,
      playerLabel: currentProfile.playerLabel,
      rules,
      txnId,
    };

    await update(ref(client.database, `users/${user.uid}`), {
      league: {
        ...(leagueData.rawLeagueByUid.get(user.uid) ?? {}),
        transactions: {
          ...ownTransactions,
          [txnId]: transaction,
        },
      },
      updatedAt: serverTimestamp(),
    });
    setMessage(`Scoring rules saved as transaction ${txnId}.`);
  }

  return (
    <main className="ffb-page ffb-page--text">
      <header className="ffb-header">
        <div>
          <p className="ffb-kicker">FantasyFilmBall</p>
          <h1>Scoring rules</h1>
          <p className="ffb-muted">
            Everyone can read the active rules. Only player 1, the commissioner, can write a new
            scoring-rule transaction.
          </p>
        </div>
        <nav className="ffb-nav" aria-label="Primary">
          <button type="button" onClick={() => onNavigate("/")}>
            Rules
          </button>
          <button type="button" onClick={() => onNavigate("/app")}>
            League App
          </button>
          <button type="button" onClick={() => onNavigate("/league")}>
            Movie Charts
          </button>
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
        </nav>
      </header>

      <section className="ffb-score-summary">
        <div>
          <p className="ffb-label">Active rule set</p>
          <h2>{currentRules.season}</h2>
          <p>{SCORE_INPUT_HELP}</p>
          <p className="ffb-source">
            Commissioner: {commissionerProfile?.playerLabel ?? "not registered yet"}
          </p>
        </div>
        <div>
          <p className="ffb-label">Positions</p>
          <strong>{currentRules.positions.length}</strong>
        </div>
      </section>

      {message ? <p className="ffb-toast">{message}</p> : null}
      {movieError ? <p className="ffb-error">{movieError}</p> : null}

      {isCommissioner ? (
        <ScoringEditor
          key={`${currentRules.updatedAt}-${currentRules.positions.length}`}
          rules={currentRules}
          onSave={saveRules}
        />
      ) : (
        <section className="ffb-panel">
          <p className="ffb-label">Read only</p>
          <h2>Commissioner edits are locked</h2>
          <p>
            Your player id is {currentProfile?.playerId ?? "not registered"}. Only player 1 can
            record scoring-rule changes.
          </p>
        </section>
      )}

      <section className="ffb-scoring-tables">
        {currentRules.positions.map((position) => (
          <PositionTable
            key={position.id}
            movies={movies}
            position={position}
          />
        ))}
      </section>
    </main>
  );
}

function ScoringEditor({
  onSave,
  rules,
}: {
  onSave: (rules: ScoringRuleSet) => Promise<void>;
  rules: ScoringRuleSet;
}) {
  const [season, setSeason] = useState(rules.season);
  const [positions, setPositions] = useState(rules.positions);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setErrorMessage(null);
    setIsSaving(true);

    try {
      const normalized = positions
        .map((position) => ({
          ...position,
          id: position.id || slugifyPosition(position.name),
          formula: position.formula.trim(),
          name: position.name.trim(),
          subtitle: position.subtitle.trim(),
        }))
        .filter((position) => position.name && position.subtitle && position.formula);

      if (normalized.length === 0) {
        throw new Error("At least one scoring position is required.");
      }

      for (const position of normalized) {
        const testScore = evaluateFormula(position.formula, { A: 3.5, B: 1, G: 1, R: 1 });
        if (testScore === null) {
          throw new Error(`${position.name} has an invalid formula.`);
        }
      }

      await onSave({
        positions: normalized,
        season: season.trim() || DEFAULT_SCORING_RULES.season,
        updatedAt: Date.now(),
      });
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : "Could not save scoring rules.");
    } finally {
      setIsSaving(false);
    }
  }

  function updatePosition(index: number, patch: Partial<ScoringPosition>) {
    setPositions((current) =>
      current.map((position, positionIndex) =>
        positionIndex === index ? { ...position, ...patch } : position,
      ),
    );
  }

  return (
    <form className="ffb-scoring-editor" onSubmit={submit}>
      <div className="ffb-form">
        <p className="ffb-label">Commissioner editor</p>
        <label>
          Season
          <input value={season} onChange={(event) => setSeason(event.target.value)} />
        </label>
      </div>

      <div className="ffb-position-editor-list">
        {positions.map((position, index) => (
          <article className="ffb-position-editor" key={`${position.id}-${index}`}>
            <label>
              Name
              <input
                value={position.name}
                onChange={(event) =>
                  updatePosition(index, {
                    id: slugifyPosition(event.target.value),
                    name: event.target.value,
                  })
                }
              />
            </label>
            <label>
              Subtitle
              <input
                value={position.subtitle}
                onChange={(event) => updatePosition(index, { subtitle: event.target.value })}
              />
            </label>
            <label>
              Formula
              <input
                value={position.formula}
                onChange={(event) => updatePosition(index, { formula: event.target.value })}
              />
            </label>
            <button
              type="button"
              onClick={() => setPositions((current) => current.filter((_, itemIndex) => itemIndex !== index))}
            >
              Remove
            </button>
          </article>
        ))}
      </div>

      <div className="ffb-actions">
        <button
          type="button"
          onClick={() =>
            setPositions((current) => [
              ...current,
              {
                formula: "100 * G * (A - 2)",
                id: `position-${current.length + 1}`,
                name: `Position ${current.length + 1}`,
                subtitle: "Describe what this position rewards.",
              },
            ])
          }
        >
          Add Position
        </button>
        <button className="ffb-primary" disabled={isSaving} type="submit">
          {isSaving ? "Saving" : "Save Rules"}
        </button>
      </div>
      {errorMessage ? <p className="ffb-error">{errorMessage}</p> : null}
    </form>
  );
}

function PositionTable({
  movies,
  position,
}: {
  movies: MovieRow[];
  position: ScoringPosition;
}) {
  const rows = useMemo(
    () =>
      movies
        .map((movie) => ({
          movie,
          score: evaluateFormula(position.formula, {
            A: movie.letterboxd_avg,
            B: movie.budget === null ? null : movie.budget / 100_000_000,
            G: movie.domestic_gross === null ? null : movie.domestic_gross / 100_000_000,
            R: movie.letterboxd_ratings === null ? null : movie.letterboxd_ratings / 100_000,
          }),
        }))
        .filter((row): row is { movie: MovieRow; score: number } => row.score !== null)
        .sort((left, right) => right.score - left.score)
        .slice(0, 25),
    [movies, position.formula],
  );

  return (
    <article className="ffb-score-table">
      <div className="ffb-score-table-head">
        <div>
          <p className="ffb-label">{position.name}</p>
          <h2>{position.subtitle}</h2>
        </div>
        <code>{position.formula}</code>
      </div>
      <div className="ffb-table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Film</th>
              <th>Stubs</th>
              <th>Gross</th>
              <th>Budget</th>
              <th>Avg</th>
              <th>Ratings</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${position.id}-${row.movie.title}`}>
                <td>{index + 1}</td>
                <td>{row.movie.title}</td>
                <td>{row.score.toFixed(1)}</td>
                <td>{formatMoney(row.movie.domestic_gross)}</td>
                <td>{formatMoney(row.movie.budget)}</td>
                <td>{row.movie.letterboxd_avg?.toFixed(2) ?? "-"}</td>
                <td>{formatCount(row.movie.letterboxd_ratings)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function readLeagueData(value: unknown) {
  const users = isRecord(value) && isRecord(value.users) ? value.users : {};
  const profiles: LeagueProfile[] = [];
  const profilesByUid = new Map<string, LeagueProfile>();
  const scoringRulesTransactions: ScoringRulesTransaction[] = [];
  const rawLeagueByUid = new Map<string, Record<string, unknown>>();
  const rawTransactionsByUid = new Map<string, Record<string, unknown>>();

  for (const [uid, userRoot] of Object.entries(users)) {
    if (!isRecord(userRoot) || !isRecord(userRoot.league)) {
      continue;
    }

    rawLeagueByUid.set(uid, userRoot.league);

    const profile = readProfile(userRoot.league.profile);
    if (profile) {
      profiles.push(profile);
      profilesByUid.set(uid, profile);
    }

    const transactions = isRecord(userRoot.league.transactions) ? userRoot.league.transactions : {};
    rawTransactionsByUid.set(uid, transactions);

    if (profile?.playerId !== "1") {
      continue;
    }

    for (const rawTransaction of Object.values(transactions)) {
      const transaction = readScoringRulesTransaction(rawTransaction);
      if (transaction) {
        scoringRulesTransactions.push(transaction);
      }
    }
  }

  const scoringRules = scoringRulesTransactions.sort((left, right) => right.createdAt - left.createdAt)[0]?.rules;

  return {
    profiles,
    profilesByUid,
    rawLeagueByUid,
    rawTransactionsByUid,
    scoringRules,
  };
}

function readProfile(value: unknown): LeagueProfile | null {
  if (!isRecord(value)) {
    return null;
  }

  const email = typeof value.email === "string" ? value.email : null;
  const playerId = typeof value.playerId === "string" ? value.playerId : null;
  const playerLabel = typeof value.playerLabel === "string" ? value.playerLabel : null;

  return email && playerId && playerLabel ? { email, playerId, playerLabel } : null;
}

function readScoringRulesTransaction(value: unknown): ScoringRulesTransaction | null {
  if (!isRecord(value) || value.kind !== "scoringRules") {
    return null;
  }

  const createdAt = typeof value.createdAt === "number" ? value.createdAt : null;
  const playerId = typeof value.playerId === "string" ? value.playerId : null;
  const playerLabel = typeof value.playerLabel === "string" ? value.playerLabel : null;
  const txnId = typeof value.txnId === "string" ? value.txnId : null;
  const rules = normalizeRuleSet(value.rules);

  if (!createdAt || !playerId || !playerLabel || !txnId || !rules) {
    return null;
  }

  const fee = typeof value.fee === "number" ? value.fee : 0;

  return { createdAt, fee, kind: "scoringRules", playerId, playerLabel, rules, txnId };
}

function nextTxnId(profile: LeagueProfile, transactions: Record<string, unknown>) {
  const nextIndex =
    Object.keys(transactions)
      .filter((txnId) => txnId.startsWith(`${profile.playerId}.`))
      .map((txnId) => Number(txnId.split(".")[1]))
      .filter((value) => Number.isInteger(value) && value > 0)
      .reduce((max, value) => Math.max(max, value), 0) + 1;

  return `${profile.playerId}.${nextIndex}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function toMovieRow(row: Record<string, string>): MovieRow {
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

function formatMoney(value: number | null) {
  if (value === null) {
    return "-";
  }

  return `$${(value / 1_000_000).toFixed(value >= 100_000_000 ? 0 : 1)}M`;
}

function formatCount(value: number | null) {
  if (value === null) {
    return "-";
  }

  return Math.round(value).toLocaleString();
}
