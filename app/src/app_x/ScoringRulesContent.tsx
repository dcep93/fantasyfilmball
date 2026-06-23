import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { ref, serverTimestamp, update } from "firebase/database";
import { encodeFirebaseValue } from "./firebaseCodec";
import type { FirebaseClient } from "./firebaseClient";
import {
  DEFAULT_SCORING_RULES,
  SCORE_INPUT_HELP,
  evaluateFormula,
  formatScoringFormula,
  slugifyPosition,
  type ScoringPosition,
  type ScoringRuleSet,
} from "./scoringRules";
import type { LeagueSummary } from "./leagueModel";

type ContentProps = {
  client: FirebaseClient;
  onChangeLeague?: () => void;
  onOpenLeague: () => void;
  selectedLeague: LeagueSummary | null;
  user: User;
};

type MovieRow = {
  budget: number | null;
  domestic_gross: number | null;
  letterboxd_avg: number | null;
  letterboxd_ratings: number | null;
  title: string;
};

const DATA_URL = "/movie_charts/2025/movie_2025_data.csv";

function timestamp() {
  return Date.now();
}

export function ScoringRulesContent({
  client,
  onChangeLeague,
  onOpenLeague,
  selectedLeague,
  user,
}: ContentProps) {
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

  const currentRules = selectedLeague?.league.scoring ?? DEFAULT_SCORING_RULES;
  const isCommissioner = Boolean(selectedLeague && selectedLeague.commissionerUid === user.uid);

  async function saveRules(rules: ScoringRuleSet) {
    if (!selectedLeague || !isCommissioner) {
      throw new Error("Only this league's commissioner can edit scoring positions and formulas.");
    }

    await update(ref(client.database, `users/${user.uid}`), encodeFirebaseValue({
      [`leagues/${selectedLeague.league.leagueId}/scoring`]: rules,
      [`leagues/${selectedLeague.league.leagueId}/updatedAt`]: timestamp(),
      updatedAt: serverTimestamp(),
    }) as Record<string, unknown>);
    setMessage("Scoring positions and formulas saved.");
  }

  return (
    <>
      {!selectedLeague ? (
        <section className="ffb-panel ffb-centered-panel">
          <p className="ffb-label">No league selected</p>
          <h2>Choose a league first</h2>
          <p>Use the league console to start a league, request to join, or select a readable league.</p>
          <button type="button" onClick={onOpenLeague}>
            Open League Console
          </button>
        </section>
      ) : (
        <>
          <section className="ffb-score-summary">
            <div>
              <p className="ffb-label">Active rule set</p>
              <h2>{selectedLeague.league.name}</h2>
              <p>{SCORE_INPUT_HELP}</p>
              <p className="ffb-source">
                Commissioner: {selectedLeague.commissionerLabel}
                {selectedLeague.commissionerEmail ? ` (${selectedLeague.commissionerEmail})` : ""}
              </p>
            </div>
            <div>
              <p className="ffb-label">Positions</p>
              <strong>{currentRules.positions.length}</strong>
            </div>
          </section>

          {message ? <p className="ffb-toast">{message}</p> : null}
          {movieError ? <p className="ffb-error">{movieError}</p> : null}

          <section className="ffb-panel ffb-info-panel">
            <p className="ffb-label">Heads up</p>
            <h2>This page needs a lot of work</h2>
            <p>
              The current scoring controls and previews are useful for checking the default categories,
              but the league scoring experience is still rough.
            </p>
          </section>

          {isCommissioner ? (
            <ScoringEditor
              key={`${currentRules.updatedAt}-${currentRules.positions.length}`}
              rules={currentRules}
              onSave={saveRules}
            />
          ) : (
            <section className="ffb-panel ffb-centered-panel">
              <p className="ffb-label">Read only</p>
              <h2>Commissioner edits are locked</h2>
              <p>
                This page is using {selectedLeague.league.name}. Only {selectedLeague.commissionerLabel}
                can edit its scoring positions and formulas.
              </p>
              <button
                type="button"
                onClick={() => {
                  onChangeLeague?.();
                }}
              >
                Change League
              </button>
            </section>
          )}

          <section className="ffb-scoring-tables">
            {currentRules.positions.map((position) => (
              <PositionTable key={position.id} movies={movies} position={position} />
            ))}
          </section>
        </>
      )}
    </>
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
        updatedAt: timestamp(),
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
        <code>{formatScoringFormula(position.formula)}</code>
      </div>
      <div className="ffb-table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Film</th>
              <th>Points</th>
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
