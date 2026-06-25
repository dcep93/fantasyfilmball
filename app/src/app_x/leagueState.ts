import {
  decodeBidPayload,
  membershipKey,
  usernameFromEmail,
  type CommissionerLeague,
  type LeagueMember,
  type LeagueTransaction,
} from "./leagueModel";
import type { TrackedMovieFile } from "./movieData";

export type MovieStateStatus =
  | "auction-open"
  | "free-agent"
  | "future"
  | "owned"
  | "released"
  | "waiver";

export type DerivedMovieState = {
  auctionDeadline: number;
  domesticGross: number | null;
  letterboxdAverage: number | null;
  letterboxdRatingCount: number | null;
  letterboxdSlug: string | null;
  locked: boolean;
  ownerUid: string | null;
  posterUrl: string | null;
  productionBudget: number | null;
  releaseDate: string;
  status: MovieStateStatus;
  title: string;
  waiverEndsAt: number | null;
};

export type DerivedPlayerState = {
  playerId: string;
  stubs: number;
  theater: string[];
  uid: string;
};

export type DerivedAuctionState = {
  deadline: number;
  filmId: string;
  kind: "initial" | "waiver";
  status: "open" | "closed";
};

export type InvalidTransaction = {
  reason: string;
  txnId: string;
  uid: string;
};

export type TransactionWatermark = {
  count: number;
  latestCreatedAt: number | null;
  latestTxnId: string | null;
};

export type DerivedLeagueState = {
  auctions: Record<string, DerivedAuctionState>;
  invalidTransactions: InvalidTransaction[];
  movies: Record<string, DerivedMovieState>;
  players: Record<string, DerivedPlayerState>;
  todos: {
    finalScoring: "not-implemented";
    postseason: "not-implemented";
  };
};

export type LeagueSnapshot = {
  activeMemberUids: string[];
  commissionerUid: string;
  generatedAt: number;
  generatedByUid: string;
  leagueId: string;
  membershipKey: string;
  movieDataVersion: string;
  schemaVersion: 1;
  season: number;
  state: DerivedLeagueState;
  transactionWatermarks: Record<string, TransactionWatermark>;
};

type DeriveSnapshotInput = {
  generatedByUid: string;
  league: CommissionerLeague;
  movieFile: TrackedMovieFile;
  now: number;
  transactions: LeagueTransaction[];
};

type PlayerRuntime = DerivedPlayerState & {
  spent: number;
};

type BidRuntime = {
  amount: number;
  createdAt: number;
  dropFilmId: string | null;
  filmId: string;
  transaction: LeagueTransaction & { kind: "bid" };
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WAIVER_MS = 48 * 60 * 60 * 1000;

export function deriveLeagueSnapshot({
  generatedByUid,
  league,
  movieFile,
  now,
  transactions,
}: DeriveSnapshotInput): LeagueSnapshot {
  const activeMembers = activeLeagueMembers(league);
  const players = initialPlayers(activeMembers, league.config.startingStubs);
  const movieEntries = movieFile.movies.map((movie) => [
    movie.id,
    {
      auctionDeadline: initialAuctionDeadline(movie.releaseDate),
      domesticGross: movie.domesticGross,
      letterboxdAverage: movie.letterboxdAverage,
      letterboxdRatingCount: movie.letterboxdRatingCount,
      letterboxdSlug: movie.letterboxdSlug,
      locked: false,
      ownerUid: null,
      posterUrl: movie.posterUrl,
      productionBudget: movie.productionBudget,
      releaseDate: movie.releaseDate,
      status: "future" as MovieStateStatus,
      title: movie.title,
      waiverEndsAt: null,
    },
  ]);
  const movies: Record<string, DerivedMovieState> = Object.fromEntries(movieEntries);
  const auctions: Record<string, DerivedAuctionState> = {};
  const invalidTransactions: InvalidTransaction[] = [];
  const bids: BidRuntime[] = [];
  const draftCompletedAt = draftCompletedAtForLeague(league);
  const maxDraftPickCount = Object.keys(activeMembers).length * league.config.draftRounds;
  let draftPickIndex = 0;

  applyDraftCompletionWaivers(movies, draftCompletedAt);

  for (const transaction of sortTransactions(transactions)) {
    const player = players[transaction.playerUid];
    if (!player) {
      invalidTransactions.push(invalid(transaction, "player is not active in this league"));
      continue;
    }

    if (isCompletedDraftPickup(transaction, league, draftCompletedAt, draftPickIndex, maxDraftPickCount)) {
      if (
        applyDraftPickup(
          transaction as LeagueTransaction & { filmId: string; kind: "pickup" },
          player,
          league.config.maxTheaterSize,
          movies,
          transaction.createdAt,
          invalidTransactions,
        )
      ) {
        draftPickIndex += 1;
      }
      continue;
    }

    const draftState = transactionDraftState(league, draftPickIndex);
    if (draftState.phase === "not-started") {
      invalidTransactions.push(invalid(transaction, "league draft has not started"));
      continue;
    }

    if (draftState.phase === "active") {
      if (transaction.kind !== "pickup" || transaction.fee !== 0) {
        invalidTransactions.push(invalid(transaction, "only draft picks are allowed during the draft"));
        continue;
      }

      const username = usernameFromEmail(activeMembers[transaction.playerUid]?.email, transaction.playerUid);
      if (username !== draftState.currentUsername) {
        invalidTransactions.push(invalid(transaction, "player is not on the clock"));
        continue;
      }

      if (
        applyDraftPickup(
          transaction as LeagueTransaction & { filmId: string; kind: "pickup" },
          player,
          league.config.maxTheaterSize,
          movies,
          transaction.createdAt,
          invalidTransactions,
        )
      ) {
        draftPickIndex += 1;
      }
      continue;
    }

    if (transaction.kind === "pickup" || transaction.kind === "drop") {
      if (transaction.fee !== 1) {
        invalidTransactions.push(invalid(transaction, "operation fee must be 1 stub"));
        continue;
      }
    }

    if (!charge(player, transaction.fee, league.config.startingStubs)) {
      invalidTransactions.push(invalid(transaction, "player cannot pay operation fee"));
      continue;
    }

    if (transaction.kind === "bid") {
      const payload = decodeBidPayload(transaction.obfuscatedPayload, {
        commissionerUid: league.commissionerUid,
        leagueId: league.leagueId,
        txnId: transaction.txnId,
      });

      if (!payload) {
        invalidTransactions.push(invalid(transaction, "bid payload could not be decoded"));
        continue;
      }

      bids.push({
        amount: payload.amount,
        createdAt: transaction.createdAt,
        dropFilmId: payload.dropFilmId,
        filmId: payload.filmId,
        transaction,
      });
      continue;
    }

    if (transaction.kind === "pickup") {
      applyPickup(
        transaction as LeagueTransaction & { filmId: string; kind: "pickup" },
        player,
        league.config.maxTheaterSize,
        movies,
        transaction.createdAt,
        invalidTransactions,
      );
      continue;
    }

    if (transaction.kind === "drop") {
      applyDrop(
        transaction as LeagueTransaction & { filmId: string; kind: "drop" },
        player,
        movies,
        transaction.createdAt,
        invalidTransactions,
      );
      continue;
    }
  }

  awardResolvedWaiverAuctions(bids, players, movies, league, now, invalidTransactions);
  awardResolvedInitialAuctions(bids, players, movies, league, now, invalidTransactions);
  refreshClockState(movies, auctions, now);

  return {
    activeMemberUids: Object.keys(activeMembers).sort(),
    commissionerUid: league.commissionerUid,
    generatedAt: now,
    generatedByUid,
    leagueId: league.leagueId,
    membershipKey: membershipKey(league.commissionerUid, league.leagueId),
    movieDataVersion: movieFile.movieDataVersion,
    schemaVersion: 1,
    season: league.season,
    state: {
      auctions,
      invalidTransactions,
      movies,
      players: stripRuntimePlayers(players),
      todos: {
        finalScoring: "not-implemented",
        postseason: "not-implemented",
      },
    },
    transactionWatermarks: transactionWatermarks(transactions),
  };
}

function transactionDraftState(league: CommissionerLeague, draftPickIndex: number) {
  if (league.draftOrder === undefined) {
    return { phase: "not-started" as const };
  }

  if (league.draftOrder === null) {
    return { phase: "complete" as const };
  }

  if (draftPickIndex >= league.draftOrder.length) {
    return { phase: "complete" as const };
  }

  return {
    currentUsername: league.draftOrder[draftPickIndex],
    phase: "active" as const,
  };
}

function draftCompletedAtForLeague(league: CommissionerLeague) {
  if (typeof league.draftCompletedAt === "number") {
    return league.draftCompletedAt;
  }

  return league.draftOrder === null ? league.updatedAt : null;
}

function isCompletedDraftPickup(
  transaction: LeagueTransaction,
  league: CommissionerLeague,
  draftCompletedAt: number | null,
  draftPickIndex: number,
  maxDraftPickCount: number,
) {
  return (
    league.draftOrder === null &&
    draftCompletedAt !== null &&
    draftPickIndex < maxDraftPickCount &&
    transaction.kind === "pickup" &&
    transaction.fee === 0 &&
    transaction.createdAt <= draftCompletedAt
  );
}

function applyDraftCompletionWaivers(
  movies: Record<string, DerivedMovieState>,
  draftCompletedAt: number | null,
) {
  if (draftCompletedAt === null) {
    return;
  }

  for (const movie of Object.values(movies)) {
    if (releaseLockTime(movie.releaseDate) <= draftCompletedAt) {
      continue;
    }

    movie.status = "waiver";
    movie.waiverEndsAt = draftCompletedAt + WAIVER_MS;
  }
}

export function initialAuctionDeadline(releaseDate: string) {
  const release = parseIsoDate(releaseDate);
  const deadlineDate = new Date(Date.UTC(release.year, release.month - 1, release.day) - 60 * DAY_MS);
  return easternDateTimeToMs(formatIsoDate(deadlineDate), 18);
}

export function releaseLockTime(releaseDate: string) {
  return easternDateTimeToMs(releaseDate, 0);
}

export function activeLeagueMembers(league: CommissionerLeague): Record<string, LeagueMember> {
  return league.members;
}

function initialPlayers(
  members: Record<string, LeagueMember>,
  startingStubs: number,
): Record<string, PlayerRuntime> {
  return Object.fromEntries(
    Object.entries(members).map(([uid, member]) => [
      uid,
      {
        playerId: member.playerId,
        spent: 0,
        stubs: startingStubs,
        theater: [],
        uid,
      },
    ]),
  );
}

function applyPickup(
  transaction: LeagueTransaction & { kind: "pickup" },
  player: PlayerRuntime,
  maxTheaterSize: number,
  movies: Record<string, DerivedMovieState>,
  now: number,
  invalidTransactions: InvalidTransaction[],
) {
  const movie = movies[transaction.filmId];
  if (!movie) {
    invalidTransactions.push(invalid(transaction, "movie is not tracked"));
    return;
  }

  refreshOneMovie(movie, now);
  if (movie.status !== "free-agent") {
    invalidTransactions.push(invalid(transaction, "movie is not a free agent"));
    return;
  }

  if (player.theater.length >= maxTheaterSize) {
    invalidTransactions.push(invalid(transaction, "player theater is full"));
    return;
  }

  movie.ownerUid = transaction.playerUid;
  movie.status = "owned";
  movie.waiverEndsAt = null;
  player.theater.push(transaction.filmId);
}

function applyDraftPickup(
  transaction: LeagueTransaction & { kind: "pickup" },
  player: PlayerRuntime,
  maxTheaterSize: number,
  movies: Record<string, DerivedMovieState>,
  now: number,
  invalidTransactions: InvalidTransaction[],
) {
  const movie = movies[transaction.filmId];
  if (!movie) {
    invalidTransactions.push(invalid(transaction, "movie is not tracked"));
    return false;
  }

  refreshOneMovie(movie, now);
  if (movie.ownerUid || movie.locked) {
    invalidTransactions.push(invalid(transaction, "movie is not draftable"));
    return false;
  }

  if (player.theater.length >= maxTheaterSize) {
    invalidTransactions.push(invalid(transaction, "player theater is full"));
    return false;
  }

  movie.ownerUid = transaction.playerUid;
  movie.status = "owned";
  movie.waiverEndsAt = null;
  player.theater.push(transaction.filmId);
  return true;
}

function applyDrop(
  transaction: LeagueTransaction & { kind: "drop" },
  player: PlayerRuntime,
  movies: Record<string, DerivedMovieState>,
  now: number,
  invalidTransactions: InvalidTransaction[],
) {
  const movie = movies[transaction.filmId];
  if (!movie) {
    invalidTransactions.push(invalid(transaction, "movie is not tracked"));
    return;
  }

  refreshOneMovie(movie, now);
  if (movie.ownerUid !== transaction.playerUid || !player.theater.includes(transaction.filmId)) {
    invalidTransactions.push(invalid(transaction, "player does not own movie"));
    return;
  }

  if (movie.locked) {
    invalidTransactions.push(invalid(transaction, "released movie is locked"));
    return;
  }

  movie.ownerUid = null;
  movie.status = "waiver";
  movie.waiverEndsAt = transaction.createdAt + WAIVER_MS;
  player.theater = player.theater.filter((filmId) => filmId !== transaction.filmId);
}

function awardResolvedInitialAuctions(
  bids: BidRuntime[],
  players: Record<string, PlayerRuntime>,
  movies: Record<string, DerivedMovieState>,
  league: CommissionerLeague,
  now: number,
  invalidTransactions: InvalidTransaction[],
) {
  const byFilm = new Map<string, BidRuntime[]>();

  for (const bid of bids) {
    const movie = movies[bid.filmId];
    if (!movie) {
      invalidTransactions.push(invalid(bid.transaction, "bid movie is not tracked"));
      continue;
    }

    if (now < movie.auctionDeadline) {
      continue;
    }

    const list = byFilm.get(bid.filmId) ?? [];
    list.push(bid);
    byFilm.set(bid.filmId, list);
  }

  for (const [filmId, filmBids] of byFilm.entries()) {
    const movie = movies[filmId];
    if (!movie || movie.ownerUid || movie.waiverEndsAt || releaseLockTime(movie.releaseDate) <= now) {
      continue;
    }

    const ranked = filmBids
      .slice()
      .sort((left, right) => right.amount - left.amount || left.createdAt - right.createdAt);

    for (const bid of ranked) {
      if (awardBid(bid, movie, filmId, players, movies, league, now, invalidTransactions)) {
        break;
      }
    }
  }
}

function awardResolvedWaiverAuctions(
  bids: BidRuntime[],
  players: Record<string, PlayerRuntime>,
  movies: Record<string, DerivedMovieState>,
  league: CommissionerLeague,
  now: number,
  invalidTransactions: InvalidTransaction[],
) {
  for (const [filmId, movie] of Object.entries(movies)) {
    if (!movie.waiverEndsAt || movie.ownerUid || releaseLockTime(movie.releaseDate) <= now) {
      continue;
    }

    const waiverStartedAt = movie.waiverEndsAt - WAIVER_MS;
    if (now < movie.waiverEndsAt) {
      continue;
    }

    const ranked = bids
      .filter((bid) => {
        return (
          bid.filmId === filmId &&
          bid.createdAt >= waiverStartedAt &&
          bid.createdAt < (movie.waiverEndsAt ?? 0)
        );
      })
      .sort((left, right) => right.amount - left.amount || left.createdAt - right.createdAt);

    let awarded = false;
    for (const bid of ranked) {
      if (awardBid(bid, movie, filmId, players, movies, league, now, invalidTransactions)) {
        awarded = true;
        break;
      }
    }

    if (!awarded) {
      movie.waiverEndsAt = null;
      refreshOneMovie(movie, now);
    }
  }
}

function awardBid(
  bid: BidRuntime,
  movie: DerivedMovieState,
  filmId: string,
  players: Record<string, PlayerRuntime>,
  movies: Record<string, DerivedMovieState>,
  league: CommissionerLeague,
  now: number,
  invalidTransactions: InvalidTransaction[],
) {
  const player = players[bid.transaction.playerUid];
  if (!player) {
    return false;
  }

  if (player.spent + bid.amount > league.config.startingStubs) {
    invalidTransactions.push(invalid(bid.transaction, "player cannot pay winning bid"));
    return false;
  }

  if (player.theater.length >= league.config.maxTheaterSize) {
    if (!bid.dropFilmId || !dropForBid(bid, player, movies, now)) {
      invalidTransactions.push(invalid(bid.transaction, "winning bid has no valid roster room"));
      return false;
    }
  }

  charge(player, bid.amount, league.config.startingStubs);
  player.theater.push(filmId);
  movie.ownerUid = bid.transaction.playerUid;
  movie.status = "owned";
  movie.waiverEndsAt = null;
  return true;
}

function dropForBid(
  bid: BidRuntime,
  player: PlayerRuntime,
  movies: Record<string, DerivedMovieState>,
  now: number,
) {
  const filmId = bid.dropFilmId;
  const movie = filmId ? movies[filmId] : null;
  if (!filmId || !movie || movie.ownerUid !== player.uid) {
    return false;
  }

  refreshOneMovie(movie, now);
  if (movie.locked) {
    return false;
  }

  movie.ownerUid = null;
  movie.status = "waiver";
  movie.waiverEndsAt = bid.createdAt + WAIVER_MS;
  player.theater = player.theater.filter((ownedFilmId) => ownedFilmId !== filmId);
  return true;
}

function refreshClockState(
  movies: Record<string, DerivedMovieState>,
  auctions: Record<string, DerivedAuctionState>,
  now: number,
) {
  for (const [movieId, movie] of Object.entries(movies)) {
    refreshOneMovie(movie, now);

    if (movie.status === "auction-open") {
      auctions[`initial:${movieId}`] = {
        deadline: movie.auctionDeadline,
        filmId: movieId,
        kind: "initial",
        status: "open",
      };
    }

    if (movie.status === "waiver" && movie.waiverEndsAt) {
      auctions[`waiver:${movieId}:${movie.waiverEndsAt}`] = {
        deadline: movie.waiverEndsAt,
        filmId: movieId,
        kind: "waiver",
        status: movie.waiverEndsAt > now ? "open" : "closed",
      };
    }
  }
}

function refreshOneMovie(movie: DerivedMovieState, now: number) {
  if (releaseLockTime(movie.releaseDate) <= now) {
    movie.locked = true;
    movie.status = "released";
    return;
  }

  if (movie.ownerUid) {
    movie.status = "owned";
    return;
  }

  if (movie.waiverEndsAt && movie.waiverEndsAt > now) {
    movie.status = "waiver";
    return;
  }

  if (movie.auctionDeadline > now) {
    movie.status = "auction-open";
    return;
  }

  movie.status = "free-agent";
  movie.waiverEndsAt = null;
}

function charge(player: PlayerRuntime, amount: number, startingStubs: number) {
  if (amount < 0 || player.spent + amount > startingStubs) {
    return false;
  }

  player.spent += amount;
  player.stubs = startingStubs - player.spent;
  return true;
}

function invalid(transaction: LeagueTransaction, reason: string): InvalidTransaction {
  return {
    reason,
    txnId: transaction.txnId,
    uid: transaction.playerUid,
  };
}

function stripRuntimePlayers(players: Record<string, PlayerRuntime>): Record<string, DerivedPlayerState> {
  return Object.fromEntries(
    Object.entries(players).map(([uid, player]) => [
      uid,
      {
        playerId: player.playerId,
        stubs: player.stubs,
        theater: player.theater,
        uid,
      },
    ]),
  );
}

function transactionWatermarks(transactions: LeagueTransaction[]) {
  const watermarks: Record<string, TransactionWatermark> = {};

  for (const transaction of sortTransactions(transactions)) {
    const watermark = watermarks[transaction.playerUid] ?? {
      count: 0,
      latestCreatedAt: null,
      latestTxnId: null,
    };
    watermark.count += 1;
    watermark.latestCreatedAt = transaction.createdAt;
    watermark.latestTxnId = transaction.txnId;
    watermarks[transaction.playerUid] = watermark;
  }

  return watermarks;
}

export function sortTransactions(transactions: LeagueTransaction[]) {
  return transactions.slice().sort((left, right) => {
    return (
      left.createdAt - right.createdAt ||
      left.playerId.localeCompare(right.playerId) ||
      left.txnId.localeCompare(right.txnId)
    );
  });
}

function parseIsoDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return { day, month, year };
}

function formatIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function easternDateTimeToMs(date: string, hour: number) {
  const { day, month, year } = parseIsoDate(date);
  const firstGuess = Date.UTC(year, month - 1, day, hour + 5);
  const offset = easternOffsetMinutes(firstGuess);
  return Date.UTC(year, month - 1, day, hour) - offset * 60_000;
}

function easternOffsetMinutes(timestamp: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(timestamp));
  const offset = parts.find((part) => part.type === "timeZoneName")?.value;
  const match = offset?.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);

  if (!match) {
    return -300;
  }

  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? 0);
  return sign * (hours * 60 + minutes);
}
