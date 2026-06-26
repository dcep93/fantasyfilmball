import type { DerivedMovieState } from "./leagueState";

export type HistoricalMovieYear = "2025";
export type HistoricalReleasedMovie = {
  filmId: string;
  movie: DerivedMovieState;
};

const HISTORICAL_MOVIE_URLS: Record<HistoricalMovieYear, string> = {
  "2025": "/movie_charts/2025/movie_2025_data.csv",
};
const HISTORICAL_POSTER_URLS: Record<HistoricalMovieYear, string> = {
  "2025": "/movie_charts/2025/poster_urls_2025.json",
};
const MONTHS: Record<string, string> = {
  Apr: "04",
  Aug: "08",
  Dec: "12",
  Feb: "02",
  Jan: "01",
  Jul: "07",
  Jun: "06",
  Mar: "03",
  May: "05",
  Nov: "11",
  Oct: "10",
  Sep: "09",
};

type PosterPayload = {
  posters?: Record<string, string>;
};

export async function loadHistoricalReleasedMovies(year: HistoricalMovieYear) {
  const [movieResponse, posterUrls] = await Promise.all([
    fetch(HISTORICAL_MOVIE_URLS[year]),
    loadHistoricalPosterUrls(year),
  ]);
  if (!movieResponse.ok) {
    throw new Error(`${year} movie data failed to load.`);
  }

  return parseCsv(await movieResponse.text())
    .map((row, index) => toHistoricalMovie(row, posterUrls, year, index))
    .filter((movie): movie is HistoricalReleasedMovie => movie !== null);
}

async function loadHistoricalPosterUrls(year: HistoricalMovieYear) {
  try {
    const response = await fetch(HISTORICAL_POSTER_URLS[year]);
    if (!response.ok) {
      return {};
    }
    const payload = (await response.json()) as PosterPayload;
    return payload.posters ?? {};
  } catch {
    return {};
  }
}

function toHistoricalMovie(
  row: Record<string, string>,
  posterUrls: Record<string, string>,
  year: HistoricalMovieYear,
  index: number,
): HistoricalReleasedMovie | null {
  const title = row.title?.trim();
  if (!title) {
    return null;
  }

  const letterboxdSlug = normalizeLetterboxdSlug(row.letterboxd_slug || row.wikidata_letterboxd_slug);
  const releaseDate =
    isoDateCell(row.releaseDate) ||
    isoDateCell(row.release_date) ||
    isoDateCell(row.wikidata_release_date) ||
    boxOfficeOpenDate(row.boxoffice_open, year) ||
    `${year}-12-31`;

  return {
    filmId: `${slugify(title)}-${index + 1}`,
    movie: {
      auctionDeadline: 0,
      domesticGross: numberCell(row.domestic_gross),
      letterboxdAverage: numberCell(row.letterboxd_avg),
      letterboxdRatingCount: numberCell(row.letterboxd_ratings),
      letterboxdSlug,
      locked: true,
      ownerUid: null,
      posterUrl: letterboxdSlug ? posterUrls[letterboxdSlug] ?? null : null,
      productionBudget: numberCell(row.budget),
      releaseDate,
      status: "released",
      title,
      waiverEndsAt: null,
    },
  };
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  const headers = parseCsvLine(lines[0] ?? "");

  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
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

function normalizeLetterboxdSlug(slug: string | null | undefined) {
  const clean = slug?.trim().replace(/^https?:\/\/letterboxd\.com\//, "").replace(/^\/+|\/+$/g, "");
  if (!clean) {
    return null;
  }
  return clean.startsWith("film/") ? clean : `film/${clean}`;
}

function isoDateCell(value: string | null | undefined) {
  const match = value?.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function boxOfficeOpenDate(value: string | null | undefined, year: HistoricalMovieYear) {
  const match = value?.trim().match(/^([A-Z][a-z]{2})\s+(\d{1,2})$/);
  const month = match ? MONTHS[match[1]] : null;
  return month && match ? `${year}-${month}-${match[2].padStart(2, "0")}` : null;
}

function numberCell(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "film"
  );
}
