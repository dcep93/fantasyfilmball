import { writeFile } from "node:fs/promises";

const YEAR = 2026;
const TODAY = "2026-06-23";
const OUTPUT = new URL("./tracked_movies_2026.json", import.meta.url);
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0 Safari/537.36";

const THE_NUMBERS = "https://www.the-numbers.com";
const RELEASE_SCHEDULE_URL = `${THE_NUMBERS}/movies/release-schedule/${YEAR}`;
const TOP_GROSSING_URL = `${THE_NUMBERS}/market/${YEAR}/top-grossing-movies`;

const MONTHS = {
  Apr: "04",
  April: "04",
  Aug: "08",
  August: "08",
  Dec: "12",
  December: "12",
  Feb: "02",
  February: "02",
  Jan: "01",
  January: "01",
  Jul: "07",
  July: "07",
  Jun: "06",
  June: "06",
  Mar: "03",
  March: "03",
  May: "05",
  Nov: "11",
  November: "11",
  Oct: "10",
  October: "10",
  Sep: "09",
  September: "09",
};

const MANUAL_LETTERBOXD_SLUGS = {
  "28 Years Later: The Bone Temple": "film/28-years-later-the-bone-temple",
  "The Bride!": "film/the-bride-2026",
  "Demon Slayer: Kimetsu no Yaiba Infinity Castle 2": "film/demon-slayer-kimetsu-no-yaiba-infinity-castle-2",
  "The Super Mario Galaxy Movie": "film/the-super-mario-galaxy-movie",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  return response.text();
}

function decodeHtml(value) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&eacute;/g, "é")
    .replace(/&ouml;/g, "ö")
    .replace(/&Ouml;/g, "Ö")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–");
}

function stripTags(value) {
  return decodeHtml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function money(value) {
  const clean = stripTags(value).replace(/[^\d]/g, "");
  return clean ? Number(clean) : null;
}

function slugify(value) {
  return decodeHtml(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function dateFromId(id) {
  return /^\d{4}-\d{2}-\d{2}$/.test(id) ? id : null;
}

function isoFromMonthDay(monthName, day) {
  const month = MONTHS[monthName];
  return month ? `${YEAR}-${month}-${String(day).padStart(2, "0")}` : null;
}

function isExcludedRelease(title, suffix, href) {
  const text = `${title} ${suffix} ${href}`.toLowerCase();
  return (
    !href.includes(`(${YEAR}`) ||
    /\bre-?release\b/.test(text) ||
    /\bspecial engagement\b/.test(text) ||
    /\bstudio ghibli fest\b/.test(text) ||
    /\bimax\b/.test(text) ||
    /\bexpands wide\b/.test(text) ||
    /\bexpansion\b/.test(text) ||
    /\bencore\b/.test(text) ||
    /\blive\b/.test(text) ||
    /\bconcert\b/.test(text) ||
    /\bmore than ever imagined\b/.test(text) ||
    /\bthousand-year blood war\b/.test(text) ||
    /\bseason \d+\b/.test(text) ||
    /\bepisode\b/.test(text) ||
    /\bepisodes\b/.test(text)
  );
}

function parseReleaseSchedule(html) {
  const rows = [...html.matchAll(/<tr(?:\s+[^>]*)?>([\s\S]*?)<\/tr>/g)].map((match) => match[1]);
  const movies = [];
  let currentDate = null;

  for (const row of rows) {
    const idDate = row.match(/id="(\d{4}-\d{2}-\d{2})"/)?.[1] ?? null;
    const cells = [...row.matchAll(/<td(?:\s+[^>]*)?>([\s\S]*?)<\/td>/g)].map((match) => match[1]);
    if (cells.length !== 4) {
      continue;
    }

    const dateText = stripTags(cells[0]);
    if (idDate) {
      currentDate = idDate;
    } else {
      const parsedDate = dateText.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
      if (parsedDate) {
        currentDate = isoFromMonthDay(parsedDate[1], Number(parsedDate[2]));
      }
    }

    const link = cells[1].match(/<a href="([^"]+)">([\s\S]*?)<\/a>/);
    if (!link || !currentDate) {
      continue;
    }

    const href = link[1];
    const title = stripTags(link[2]);
    const suffix = stripTags(cells[1].replace(link[0], ""));
    if (isExcludedRelease(title, suffix, href)) {
      continue;
    }

    const gross = money(cells[3]);
    const releaseType = suffix.replace(/[()]/g, "").trim() || null;
    if (!gross && !(currentDate > TODAY && releaseType === "Wide")) {
      continue;
    }

    movies.push({
      domesticGross: gross,
      href,
      releaseDate: currentDate,
      releaseType,
      sourceNotes: ["the-numbers-release-schedule"],
      title,
    });
  }

  return movies;
}

function parseTopGrossing(html) {
  const rows = [...html.matchAll(/<tr>\s*<td class="data">(\d+)<\/td>([\s\S]*?)<\/tr>/g)];
  const movies = [];
  for (const [, , row] of rows) {
    const link = row.match(/<td><b><a href="([^"]+)">([\s\S]*?)<\/a><\/b><\/td>/);
    const date = row.match(/<td><a href="\/box-office-chart\/daily\/(\d{4})\/(\d{2})\/(\d{2})">/);
    const grossCells = [...row.matchAll(/<td class="data(?:[^"]*)?">([\s\S]*?)<\/td>/g)];
    if (!link || !date || grossCells.length < 1 || Number(date[1]) !== YEAR) {
      continue;
    }
    movies.push({
      domesticGross: money(grossCells[0][1]),
      href: link[1],
      releaseDate: `${date[1]}-${date[2]}-${date[3]}`,
      sourceNotes: ["the-numbers-top-grossing"],
      title: stripTags(link[2]),
    });
  }
  return movies;
}

function mergeMovies(scheduleMovies, grossMovies) {
  const byKey = new Map();
  for (const movie of [...scheduleMovies, ...grossMovies]) {
    const key = `${movie.href}|${movie.releaseDate}`;
    const prior = byKey.get(key);
    if (!prior) {
      byKey.set(key, { ...movie });
      continue;
    }
    prior.domesticGross = Math.max(prior.domesticGross ?? 0, movie.domesticGross ?? 0) || null;
    prior.sourceNotes = [...new Set([...prior.sourceNotes, ...movie.sourceNotes])];
  }
  return [...byKey.values()].sort((left, right) => {
    return (
      left.releaseDate.localeCompare(right.releaseDate) ||
      (right.domesticGross ?? -1) - (left.domesticGross ?? -1) ||
      left.title.localeCompare(right.title)
    );
  });
}

async function fetchBudget(href) {
  try {
    const html = await fetchText(`${THE_NUMBERS}${href}`);
    const match = html.match(/Production&nbsp;Budget:\s*<\/b>\s*<\/td>\s*<td[^>]*>\s*(\$[\d,]+)/);
    return match ? money(match[1]) : null;
  } catch {
    return null;
  }
}

function letterboxdCandidateSlugs(title) {
  const clean = title
    .replace(/\s+\(\d{4}\)$/g, "")
    .replace(/\s+Part\s+(One|Two|Three)$/i, " Part $1");
  const base = slugify(clean);
  const slugs = [
    MANUAL_LETTERBOXD_SLUGS[title],
    `film/${base}`,
    `film/${base}-${YEAR}`,
    `film/${base}-1`,
  ].filter(Boolean);
  return [...new Set(slugs)];
}

function parseLetterboxdJson(html) {
  const match = html.match(/<script type="application\/ld\+json">\s*\/\* <!\[CDATA\[ \*\/\s*([\s\S]*?)\s*\/\* \]\]> \*\/\s*<\/script>/);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function letterboxdYear(data) {
  const events = Array.isArray(data?.releasedEvent) ? data.releasedEvent : [];
  for (const event of events) {
    const year = String(event.startDate ?? "").match(/\b(20\d{2})\b/)?.[1];
    if (year) {
      return Number(year);
    }
  }
  return null;
}

async function fetchLetterboxd(movie) {
  for (const slug of letterboxdCandidateSlugs(movie.title)) {
    try {
      const html = await fetchText(`https://letterboxd.com/${slug}/`);
      const data = parseLetterboxdJson(html);
      const title = data?.name;
      const year = letterboxdYear(data);
      if (!title || slugify(title) !== slugify(movie.title)) {
        continue;
      }
      if (year && Math.abs(year - YEAR) > 1) {
        continue;
      }
      const rating = data.aggregateRating;
      return {
        letterboxdAverage:
          typeof rating?.ratingValue === "number" ? Number(rating.ratingValue.toFixed(2)) : null,
        letterboxdRatingCount:
          typeof rating?.ratingCount === "number" ? Math.trunc(rating.ratingCount) : null,
        letterboxdSlug: slug,
      };
    } catch {
      // Try the next plausible slug.
    }
  }
  return {
    letterboxdAverage: null,
    letterboxdRatingCount: null,
    letterboxdSlug: null,
  };
}

async function main() {
  const [scheduleHtml, topGrossingHtml] = await Promise.all([
    fetchText(RELEASE_SCHEDULE_URL),
    fetchText(TOP_GROSSING_URL),
  ]);
  const movies = mergeMovies(parseReleaseSchedule(scheduleHtml), parseTopGrossing(topGrossingHtml));
  const outputMovies = [];

  for (const [index, movie] of movies.entries()) {
    const productionBudget = await fetchBudget(movie.href);
    const letterboxd =
      movie.releaseDate <= TODAY || movie.domesticGross
        ? await fetchLetterboxd(movie)
        : { letterboxdAverage: null, letterboxdRatingCount: null, letterboxdSlug: null };

    if (letterboxd.letterboxdSlug) {
      movie.sourceNotes.push("letterboxd");
    }
    if (productionBudget !== null) {
      movie.sourceNotes.push("the-numbers-budget");
    }

    outputMovies.push({
      id: slugify(movie.title),
      title: movie.title,
      releaseDate: movie.releaseDate,
      domesticGross: movie.domesticGross,
      productionBudget,
      letterboxdSlug: letterboxd.letterboxdSlug,
      letterboxdAverage: letterboxd.letterboxdAverage,
      letterboxdRatingCount: letterboxd.letterboxdRatingCount,
      sourceNotes: [...new Set(movie.sourceNotes)],
      updatedAt: TODAY,
    });

    if ((index + 1) % 25 === 0) {
      console.log(`Processed ${index + 1}/${movies.length}`);
    }
    await sleep(60);
  }

  const payload = {
    schemaVersion: 1,
    season: YEAR,
    movieDataVersion: TODAY,
    updatedAt: TODAY,
    movies: outputMovies,
  };

  await writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote ${outputMovies.length} movies to ${OUTPUT.pathname}`);
}

await main();
