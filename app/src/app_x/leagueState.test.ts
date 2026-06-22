import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEAGUE_ID,
  STARTING_STUBS,
  membershipKey,
  obfuscateBidPayload,
  type CommissionerLeague,
  type LeagueTransaction,
} from "./leagueModel";
import { deriveLeagueSnapshot, initialAuctionDeadline } from "./leagueState";
import { resolveLeagueSnapshot, snapshotIdFor } from "./leagueSnapshots";
import { parseTrackedMovieFile, type TrackedMovieFile } from "./movieData";
import { DEFAULT_SCORING_RULES } from "./scoringRules";

const COMMISSIONER_UID = "commissioner";
const PLAYER_UID = "player";
const LEAGUE_KEY = membershipKey(COMMISSIONER_UID, DEFAULT_LEAGUE_ID);

describe("tracked movie parsing", () => {
  it("accepts a valid movie file", () => {
    const parsed = parseTrackedMovieFile(movieFile());
    expect(parsed.movies[0].id).toBe("future-film");
  });

  it("rejects malformed movie rows", () => {
    expect(() =>
      parseTrackedMovieFile({
        ...movieFile(),
        movies: [{ id: "bad", title: "Bad", releaseDate: "tomorrow" }],
      }),
    ).toThrow("Movie row metadata is invalid.");
  });
});

describe("league state derivation", () => {
  it("opens the initial auction at 6 PM ET sixty days before release", () => {
    expect(initialAuctionDeadline("2026-07-14")).toBe(Date.UTC(2026, 4, 15, 22));
  });

  it("keeps future films in open auction state before the deadline", () => {
    const snapshot = deriveLeagueSnapshot({
      generatedByUid: COMMISSIONER_UID,
      league: league(),
      movieFile: movieFile(),
      now: Date.UTC(2026, 4, 15, 21, 59),
      transactions: [],
    });

    expect(snapshot.state.movies["future-film"].status).toBe("auction-open");
  });

  it("makes unowned unreleased films free agents after the initial deadline", () => {
    const snapshot = deriveLeagueSnapshot({
      generatedByUid: COMMISSIONER_UID,
      league: league(),
      movieFile: movieFile(),
      now: Date.UTC(2026, 4, 15, 22),
      transactions: [],
    });

    expect(snapshot.state.movies["future-film"].status).toBe("free-agent");
  });

  it("locks released films", () => {
    const snapshot = deriveLeagueSnapshot({
      generatedByUid: COMMISSIONER_UID,
      league: league(),
      movieFile: movieFile(),
      now: Date.UTC(2026, 5, 2, 4),
      transactions: [],
    });

    expect(snapshot.state.movies["released-film"].locked).toBe(true);
    expect(snapshot.state.movies["released-film"].status).toBe("released");
  });

  it("charges pickup and drop fees and creates a waiver", () => {
    const now = Date.UTC(2026, 4, 16, 12);
    const transactions: LeagueTransaction[] = [
      pickup("1.1", "future-film", now),
      drop("1.2", "future-film", now + 1_000),
    ];
    const snapshot = deriveLeagueSnapshot({
      generatedByUid: COMMISSIONER_UID,
      league: league(),
      movieFile: movieFile(),
      now,
      transactions,
    });

    expect(snapshot.state.players[COMMISSIONER_UID].stubs).toBe(STARTING_STUBS - 2);
    expect(snapshot.state.movies["future-film"].status).toBe("waiver");
  });

  it("rejects pickup attempts for non-free-agent films", () => {
    const snapshot = deriveLeagueSnapshot({
      generatedByUid: COMMISSIONER_UID,
      league: league(),
      movieFile: movieFile(),
      now: Date.UTC(2026, 4, 1),
      transactions: [pickup("1.1", "future-film", Date.UTC(2026, 4, 1))],
    });

    expect(snapshot.state.invalidTransactions[0]?.reason).toBe("movie is not a free agent");
  });

  it("awards a resolved initial auction to the highest bidder", () => {
    const now = Date.UTC(2026, 4, 16, 12);
    const transactions = [
      bid("1.1", COMMISSIONER_UID, "1", "future-film", 20, now - 2_000),
      bid("2.1", PLAYER_UID, "2", "future-film", 30, now - 1_000),
    ];
    const snapshot = deriveLeagueSnapshot({
      generatedByUid: PLAYER_UID,
      league: league(),
      movieFile: movieFile(),
      now,
      transactions,
    });

    expect(snapshot.state.movies["future-film"].ownerUid).toBe(PLAYER_UID);
    expect(snapshot.state.players[PLAYER_UID].stubs).toBe(STARTING_STUBS - 31);
  });
});

describe("snapshot resolution", () => {
  it("selects the newest valid peer snapshot", () => {
    const current = Date.UTC(2026, 4, 16, 12);
    const oldSnapshot = deriveLeagueSnapshot({
      generatedByUid: COMMISSIONER_UID,
      league: league(),
      movieFile: movieFile(),
      now: current,
      transactions: [],
    });
    const newSnapshot = { ...oldSnapshot, generatedAt: current + 1_000, generatedByUid: PLAYER_UID };
    const resolution = resolveLeagueSnapshot({
      generatedByUid: COMMISSIONER_UID,
      movieFile: movieFile(),
      now: current,
      summary: summary(),
      transactions: [],
      universeValue: universeWithSnapshots([oldSnapshot, newSnapshot]),
    });

    expect(resolution.selected?.snapshot.generatedByUid).toBe(PLAYER_UID);
    expect(resolution.shouldWrite).toBe(false);
  });

  it("rejects snapshots with stale movie data versions", () => {
    const current = Date.UTC(2026, 4, 16, 12);
    const staleSnapshot = {
      ...deriveLeagueSnapshot({
        generatedByUid: COMMISSIONER_UID,
        league: league(),
        movieFile: movieFile(),
        now: current,
        transactions: [],
      }),
      movieDataVersion: "old",
    };
    const resolution = resolveLeagueSnapshot({
      generatedByUid: PLAYER_UID,
      movieFile: movieFile(),
      now: current,
      summary: summary(),
      transactions: [],
      universeValue: universeWithSnapshots([staleSnapshot]),
    });

    expect(resolution.source).toBe("regenerated");
    expect(resolution.shouldWrite).toBe(true);
  });

  it("rejects snapshots with impossible transaction watermarks", () => {
    const current = Date.UTC(2026, 4, 16, 12);
    const impossibleSnapshot = deriveLeagueSnapshot({
      generatedByUid: COMMISSIONER_UID,
      league: league(),
      movieFile: movieFile(),
      now: current,
      transactions: [],
    });
    impossibleSnapshot.transactionWatermarks[COMMISSIONER_UID] = {
      count: 99,
      latestCreatedAt: current,
      latestTxnId: "1.99",
    };
    const resolution = resolveLeagueSnapshot({
      generatedByUid: PLAYER_UID,
      movieFile: movieFile(),
      now: current,
      summary: summary(),
      transactions: [],
      universeValue: universeWithSnapshots([impossibleSnapshot]),
    });

    expect(resolution.source).toBe("regenerated");
  });

  it("recommends writing when logs changed after a valid snapshot", () => {
    const current = Date.UTC(2026, 4, 16, 12);
    const baseSnapshot = deriveLeagueSnapshot({
      generatedByUid: COMMISSIONER_UID,
      league: league(),
      movieFile: movieFile(),
      now: current,
      transactions: [],
    });
    const resolution = resolveLeagueSnapshot({
      generatedByUid: PLAYER_UID,
      movieFile: movieFile(),
      now: current,
      summary: summary(),
      transactions: [pickup("1.1", "future-film", current)],
      universeValue: universeWithSnapshots([baseSnapshot]),
    });

    expect(resolution.shouldWrite).toBe(true);
    expect(resolution.snapshot.state.movies["future-film"].ownerUid).toBe(COMMISSIONER_UID);
  });
});

function movieFile(): TrackedMovieFile {
  return parseTrackedMovieFile({
    movies: [
      movie("future-film", "Future Film", "2026-07-14"),
      movie("released-film", "Released Film", "2026-06-01"),
    ],
    movieDataVersion: "test-version",
    schemaVersion: 1,
    season: 2026,
    updatedAt: "2026-06-22",
  });
}

function movie(id: string, title: string, releaseDate: string) {
  return {
    domesticGross: null,
    id,
    letterboxdAverage: null,
    letterboxdRatingCount: null,
    letterboxdSlug: null,
    productionBudget: null,
    releaseDate,
    sourceNotes: ["test"],
    title,
    updatedAt: "2026-06-22",
  };
}

function league(): CommissionerLeague {
  return {
    commissionerUid: COMMISSIONER_UID,
    config: {
      maxPlayers: 6,
      maxTheaterSize: 10,
      regularSeasonEnd: "2026-08-31",
      regularSeasonStart: "2026-05-01",
      startingStubs: STARTING_STUBS,
    },
    createdAt: 1,
    kicked: {},
    leagueId: DEFAULT_LEAGUE_ID,
    members: {
      [COMMISSIONER_UID]: {
        email: "commissioner@gmail.com",
        joinedAt: 1,
        label: "Commissioner",
        playerId: "1",
        status: "active",
      },
      [PLAYER_UID]: {
        email: "player@gmail.com",
        joinedAt: 1,
        label: "Player",
        playerId: "2",
        status: "active",
      },
    },
    name: "Test League",
    scoring: DEFAULT_SCORING_RULES,
    season: 2026,
    updatedAt: 1,
  };
}

function summary() {
  return {
    commissionerEmail: "commissioner@gmail.com",
    commissionerLabel: "Commissioner",
    commissionerUid: COMMISSIONER_UID,
    league: league(),
    membershipKey: LEAGUE_KEY,
  };
}

function pickup(txnId: string, filmId: string, createdAt: number): LeagueTransaction {
  return {
    createdAt,
    fee: 1,
    filmId,
    kind: "pickup",
    playerId: "1",
    playerLabel: "Commissioner",
    playerUid: COMMISSIONER_UID,
    txnId,
  };
}

function drop(txnId: string, filmId: string, createdAt: number): LeagueTransaction {
  return {
    createdAt,
    fee: 1,
    filmId,
    kind: "drop",
    playerId: "1",
    playerLabel: "Commissioner",
    playerUid: COMMISSIONER_UID,
    txnId,
  };
}

function bid(
  txnId: string,
  uid: string,
  playerId: string,
  filmId: string,
  amount: number,
  createdAt: number,
): LeagueTransaction {
  const auctionId = `initial:${filmId}`;
  return {
    auctionDeadline: initialAuctionDeadline("2026-07-14"),
    auctionId,
    createdAt,
    fee: 1,
    kind: "bid",
    obfuscatedPayload: obfuscateBidPayload(
      { amount, dropFilmId: null, filmId, submittedAt: createdAt },
      {
        auctionId,
        commissionerUid: COMMISSIONER_UID,
        leagueId: DEFAULT_LEAGUE_ID,
        txnId,
      },
    ),
    playerId,
    playerLabel: uid === COMMISSIONER_UID ? "Commissioner" : "Player",
    playerUid: uid,
    publicText: `Player placed bid ${txnId}`,
    txnId,
  };
}

function universeWithSnapshots(snapshots: ReturnType<typeof deriveLeagueSnapshot>[]) {
  const users: Record<string, unknown> = {
    [COMMISSIONER_UID]: { snapshots: { [LEAGUE_KEY]: {} } },
    [PLAYER_UID]: { snapshots: { [LEAGUE_KEY]: {} } },
  };

  snapshots.forEach((snapshot, index) => {
    const uid = snapshot.generatedByUid;
    const root = users[uid] as { snapshots: Record<string, Record<string, unknown>> };
    root.snapshots[LEAGUE_KEY][snapshotIdFor(snapshot) || `snapshot-${index}`] = snapshot;
  });

  return { users };
}
