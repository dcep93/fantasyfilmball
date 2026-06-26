import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import {
  DEFAULT_SCORING_RULES,
  evaluateFormula,
  formatScoringFormula,
  slugifyPosition,
  type MovieScoreInput,
  type ScoringPosition,
  type ScoringRuleSet,
} from "./scoringRules";
import type { LeagueSummary } from "./leagueModel";
import { YearSelectorToolbar } from "./YearSelectorToolbar";
import { replaceYearQuery, yearFromSearch } from "./yearQuery";

type ContentProps = {
  onChangeLeague?: () => void;
  onOpenLeague: () => void;
  onSaveRules: (rules: ScoringRuleSet) => Promise<void>;
  search: string;
  selectedLeague: LeagueSummary | null;
  user: User | null;
};

type MovieRow = {
  budget: number | null;
  domestic_gross: number | null;
  letterboxd_avg: number | null;
  letterboxd_ratings: number | null;
  letterboxd_slug: string | null;
  posterUrl: string | null;
  releaseDate: string | null;
  title: string;
};

type PosterUrlPayload = {
  posters?: Record<string, string>;
};

type ScoreYear = "2025" | "2026";

type TrackedMoviePayload = {
  movies?: TrackedMovieRow[];
};

type TrackedMovieRow = {
  domesticGross?: number | null;
  letterboxdAverage?: number | null;
  letterboxdRatingCount?: number | null;
  letterboxdSlug?: string | null;
  posterUrl?: string | null;
  productionBudget?: number | null;
  releaseDate?: string | null;
  title?: string | null;
};

const DATA_URL = "/movie_charts/2025/movie_2025_data.csv";
const POSTER_URLS_URL = "/movie_charts/2025/poster_urls_2025.json";
const TRACKED_MOVIES_2026_URL = "/movie_charts/2026/tracked_movies_2026.json";
const SCORE_YEARS: ScoreYear[] = ["2025", "2026"];
const TODAY_ISO = new Date().toISOString().slice(0, 10);
const CATEGORY_ICON_BY_ID: Record<string, string> = {
  "budget-alchemy": "/category-icons/moneymaker.png",
  "cult-furnace": "/category-icons/letterboom.png",
  disasterpiece: "/category-icons/disasterpiece.png",
  "packed-house": "/category-icons/crowd-favorite.png",
  "rotten-crowd": "/category-icons/letterbust.png",
  "tiny-thunder": "/category-icons/word-of-mouth.png",
};

const SAMPLE_INPUT: MovieScoreInput = {
  A: 3.8,
  B: 0.8,
  G: 1.5,
  R: 2.2,
};

function defaultScoreYear(): ScoreYear {
  const currentYear = String(new Date().getFullYear()) as ScoreYear;
  return SCORE_YEARS.includes(currentYear) ? currentYear : "2025";
}

function timestamp() {
  return Date.now();
}

export function ScoringRulesContent({
  onOpenLeague,
  onSaveRules,
  search,
  selectedLeague,
  user,
}: ContentProps) {
  const [movies, setMovies] = useState<MovieRow[]>([]);
  const [movieError, setMovieError] = useState<string | null>(null);
  const [posterUrls, setPosterUrls] = useState<Record<string, string>>({});
  const scoreYear = yearFromSearch(search, SCORE_YEARS, defaultScoreYear());
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    loadScoringMovies(scoreYear)
      .then((result) => {
        if (active) {
          setMovieError(null);
          setMovies(result.movies);
          setPosterUrls(result.posterUrls);
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
  }, [scoreYear]);

  const currentRules = selectedLeague?.league.scoring ?? DEFAULT_SCORING_RULES;
  const isCommissioner = Boolean(selectedLeague && user && selectedLeague.commissionerUid === user.uid);

  async function saveRules(rules: ScoringRuleSet) {
    if (!selectedLeague || !user || !isCommissioner) {
      throw new Error("Only this league's commissioner can edit scoring positions and formulas.");
    }

    await onSaveRules(rules);
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
          {message ? <p className="ffb-toast">{message}</p> : null}
          {movieError ? <p className="ffb-error">{movieError}</p> : null}

          {isCommissioner ? (
            <ScoringEditor
              key={`${currentRules.updatedAt}-${currentRules.positions.length}`}
              rules={currentRules}
              onSave={saveRules}
            />
          ) : null}

          <YearSelectorToolbar
            count={movies.length}
            value={scoreYear}
            years={SCORE_YEARS}
            onChange={(year) => {
              setMovieError(null);
              setMovies([]);
              setPosterUrls({});
              replaceYearQuery(year);
            }}
          />

          <section className="ffb-scoring-tables">
            {currentRules.positions.map((position) => (
              <PositionTable key={position.id} movies={movies} position={position} posterUrls={posterUrls} />
            ))}
          </section>
        </>
      )}
    </>
  );
}

async function loadScoringMovies(year: ScoreYear) {
  if (year === "2026") {
    const response = await fetch(TRACKED_MOVIES_2026_URL);
    if (!response.ok) {
      throw new Error("2026 movie data failed to load.");
    }
    const payload = (await response.json()) as TrackedMoviePayload;
    return {
      movies: (payload.movies ?? [])
        .map(toMovieRowFromTrackedMovie)
        .filter((movie) => movie.title && isReleasedMovie(movie, year)),
      posterUrls: {},
    };
  }

  const movieResponse = await fetch(DATA_URL);
  if (!movieResponse.ok) {
    throw new Error("2025 movie data failed to load.");
  }

  const movies = parseCsv(await movieResponse.text())
    .map(toMovieRow)
    .filter((movie) => movie.title && isReleasedMovie(movie, year));
  let posterUrls: Record<string, string> = {};

  try {
    const posterResponse = await fetch(POSTER_URLS_URL);
    if (posterResponse.ok) {
      const payload = (await posterResponse.json()) as PosterUrlPayload;
      posterUrls = payload.posters ?? {};
    }
  } catch {
    posterUrls = {};
  }

  return { movies, posterUrls };
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
      <div className="ffb-scoring-editor-head">
        <div>
          <p className="ffb-label">Commissioner editor</p>
          <h2>Edit scoring categories</h2>
          <p>
            Keep formulas in terms of G, B, A, and R. The preview uses a sample film so invalid
            formulas are visible before saving.
          </p>
        </div>
        <label>
          Season name
          <input value={season} onChange={(event) => setSeason(event.target.value)} />
        </label>
      </div>

      <div className="ffb-position-editor-list">
        {positions.map((position, index) => {
          const sampleScore = evaluateFormula(position.formula, SAMPLE_INPUT);

          return (
            <article className="ffb-position-editor" key={`${position.id}-${index}`}>
              <CategoryIcon position={position} />
              <div className="ffb-position-editor-fields">
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
                  Description
                  <input
                    value={position.subtitle}
                    onChange={(event) => updatePosition(index, { subtitle: event.target.value })}
                  />
                </label>
                <label className="ffb-formula-field">
                  Formula
                  <input
                    value={position.formula}
                    onChange={(event) => updatePosition(index, { formula: event.target.value })}
                  />
                </label>
              </div>
              <div className="ffb-position-editor-side">
                <span
                  className={
                    sampleScore === null
                      ? "ffb-position-editor-status ffb-position-editor-status--bad"
                      : "ffb-position-editor-status"
                  }
                >
                  {sampleScore === null ? "Invalid formula" : `Sample ${sampleScore.toFixed(1)} pts`}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setPositions((current) => current.filter((_, itemIndex) => itemIndex !== index))
                  }
                >
                  Remove
                </button>
              </div>
            </article>
          );
        })}
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
  posterUrls,
  position,
}: {
  movies: MovieRow[];
  posterUrls: Record<string, string>;
  position: ScoringPosition;
}) {
  const rows = useMemo(
    () =>
      movies
        .map((movie) => {
          const letterboxdSlug = normalizeLetterboxdSlug(movie.letterboxd_slug);

          return {
            movie: {
              ...movie,
              letterboxd_slug: letterboxdSlug,
              posterUrl: movie.posterUrl ?? (letterboxdSlug ? posterUrls[letterboxdSlug] : null) ?? null,
            },
            score: evaluateFormula(position.formula, {
              A: movie.letterboxd_avg,
              B: movie.budget === null ? null : movie.budget / 100_000_000,
              G: movie.domestic_gross === null ? null : movie.domestic_gross / 100_000_000,
              R: movie.letterboxd_ratings === null ? null : movie.letterboxd_ratings / 100_000,
            }),
          };
        })
        .filter((row): row is { movie: MovieRow; score: number } => row.score !== null)
        .sort((left, right) => right.score - left.score)
        .slice(0, 25),
    [movies, position.formula, posterUrls],
  );

  return (
    <article className="ffb-score-table">
      <div className="ffb-score-table-head">
        <div className="ffb-score-table-title">
          <CategoryIcon position={position} />
          <div>
            <p className="ffb-label">{position.name}</p>
            <h2>{position.subtitle}</h2>
          </div>
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
            {rows.length > 0 ? (
              rows.map((row, index) => (
                <tr key={`${position.id}-${row.movie.title}`}>
                  <td className="ffb-score-rank">{index + 1}</td>
                  <td>
                    <ScoreFilmCell movie={row.movie} />
                  </td>
                  <td className="ffb-score-points">{row.score.toFixed(1)}</td>
                  <td>{formatMoney(row.movie.domestic_gross)}</td>
                  <td>{formatMoney(row.movie.budget)}</td>
                  <td>{row.movie.letterboxd_avg?.toFixed(2) ?? "-"}</td>
                  <td>{formatCount(row.movie.letterboxd_ratings)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7}>No eligible 2025 movies have enough data for this formula yet.</td>
              </tr>
            )}
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
    letterboxd_slug: row.letterboxd_slug?.trim() || row.wikidata_letterboxd_slug?.trim() || null,
    posterUrl: row.posterUrl?.trim() || row.poster_url?.trim() || row.image?.trim() || null,
    releaseDate: isoDateCell(row.releaseDate) || isoDateCell(row.release_date) || isoDateCell(row.wikidata_release_date),
    title: row.title?.trim() ?? "",
  };
}

function toMovieRowFromTrackedMovie(movie: TrackedMovieRow): MovieRow {
  return {
    budget: nullableNumber(movie.productionBudget),
    domestic_gross: nullableNumber(movie.domesticGross),
    letterboxd_avg: nullableNumber(movie.letterboxdAverage),
    letterboxd_ratings: nullableNumber(movie.letterboxdRatingCount),
    letterboxd_slug: movie.letterboxdSlug?.trim() || null,
    posterUrl: movie.posterUrl?.trim() || null,
    releaseDate: isoDateCell(movie.releaseDate),
    title: movie.title?.trim() ?? "",
  };
}

function isReleasedMovie(movie: MovieRow, year: ScoreYear) {
  const currentYear = TODAY_ISO.slice(0, 4);
  if (year < currentYear) {
    return true;
  }

  return movie.releaseDate !== null && movie.releaseDate <= TODAY_ISO;
}

function ScoreFilmCell({ movie }: { movie: MovieRow }) {
  const url = letterboxdUrl(movie.letterboxd_slug);

  return (
    <div className="ffb-score-film">
      {movie.posterUrl ? (
        <img alt="" src={movie.posterUrl} />
      ) : (
        <span aria-hidden="true">{movie.title.trim().charAt(0) || "F"}</span>
      )}
      {url ? (
        <a className="ffb-score-film-link" href={url} rel="noreferrer" target="_blank">
          {movie.title}
        </a>
      ) : (
        <strong>{movie.title}</strong>
      )}
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
  ) : (
    <span aria-hidden="true" className="ffb-category-icon ffb-category-icon--fallback">
      {position.name.trim().charAt(0) || "?"}
    </span>
  );
}

function letterboxdUrl(slug: string | null | undefined) {
  const normalized = normalizeLetterboxdSlug(slug);
  return normalized ? `https://letterboxd.com/${normalized}/` : null;
}

function normalizeLetterboxdSlug(slug: string | null | undefined) {
  const clean = slug?.trim().replace(/^https?:\/\/letterboxd\.com\//, "").replace(/^\/+|\/+$/g, "");
  if (!clean) {
    return null;
  }
  return clean.startsWith("film/") ? clean : `film/${clean}`;
}

function numberCell(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoDateCell(value: string | null | undefined) {
  const match = value?.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function nullableNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
