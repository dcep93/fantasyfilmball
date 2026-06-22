import { asString, isRecord } from "./leagueModel";

export type TrackedMovie = {
  id: string;
  title: string;
  releaseDate: string;
  domesticGross: number | null;
  productionBudget: number | null;
  letterboxdSlug: string | null;
  letterboxdAverage: number | null;
  letterboxdRatingCount: number | null;
  sourceNotes: string[];
  updatedAt: string;
};

export type TrackedMovieFile = {
  schemaVersion: 1;
  season: number;
  movieDataVersion: string;
  updatedAt: string;
  movies: TrackedMovie[];
};

const TRACKED_MOVIES_URL = "/movie_charts/2026/tracked_movies_2026.json";
let movieFilePromise: Promise<TrackedMovieFile> | null = null;

export function parseTrackedMovieFile(value: unknown): TrackedMovieFile {
  if (!isRecord(value)) {
    throw new Error("Movie file must be an object.");
  }

  const schemaVersion = value.schemaVersion;
  const season = value.season;
  const movieDataVersion = asString(value.movieDataVersion);
  const updatedAt = asString(value.updatedAt);
  const rawMovies = Array.isArray(value.movies) ? value.movies : null;

  if (schemaVersion !== 1 || typeof season !== "number" || !movieDataVersion || !updatedAt || !rawMovies) {
    throw new Error("Movie file metadata is invalid.");
  }

  const movies = rawMovies.map(parseTrackedMovie);
  const ids = new Set<string>();
  for (const movie of movies) {
    if (ids.has(movie.id)) {
      throw new Error(`Duplicate tracked movie id: ${movie.id}`);
    }
    ids.add(movie.id);
  }

  return {
    movies,
    movieDataVersion,
    schemaVersion,
    season,
    updatedAt,
  };
}

export async function loadTrackedMovieFile() {
  movieFilePromise ??= fetch(TRACKED_MOVIES_URL, { headers: { accept: "application/json" } })
    .then((response) => {
      if (!response.ok) {
        throw new Error("Unable to load tracked movies.");
      }
      return response.json();
    })
    .then(parseTrackedMovieFile);

  return movieFilePromise;
}

function parseTrackedMovie(value: unknown): TrackedMovie {
  if (!isRecord(value)) {
    throw new Error("Movie row must be an object.");
  }

  const id = asString(value.id);
  const title = asString(value.title);
  const releaseDate = asString(value.releaseDate);
  const updatedAt = asString(value.updatedAt);
  const sourceNotes = Array.isArray(value.sourceNotes)
    ? value.sourceNotes.filter((note): note is string => typeof note === "string" && Boolean(note))
    : null;

  if (!id || !title || !releaseDate || !isIsoDate(releaseDate) || !updatedAt || !sourceNotes) {
    throw new Error("Movie row metadata is invalid.");
  }

  return {
    domesticGross: nullableNumber(value.domesticGross, "domesticGross"),
    id,
    letterboxdAverage: nullableNumber(value.letterboxdAverage, "letterboxdAverage"),
    letterboxdRatingCount: nullableNumber(value.letterboxdRatingCount, "letterboxdRatingCount"),
    letterboxdSlug: nullableString(value.letterboxdSlug, "letterboxdSlug"),
    productionBudget: nullableNumber(value.productionBudget, "productionBudget"),
    releaseDate,
    sourceNotes,
    title,
    updatedAt,
  };
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null) {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  throw new Error(`${field} must be a number or null.`);
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }

  if (typeof value === "string" && value.trim()) {
    return value;
  }

  throw new Error(`${field} must be a string or null.`);
}

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}
