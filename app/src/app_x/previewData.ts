import type { User } from "firebase/auth";
import {
  makeDefaultLeague,
  membershipKey,
  obfuscateBidPayload,
  type CommissionerEvent,
  type CommissionerLeague,
  type LeagueMember,
  type LeagueTransaction,
} from "./leagueModel";

export const PREVIEW_LEAGUE_ID = "preview";
export const PREVIEW_OWNER_UID = "dcep93.apps";
export const PREVIEW_OWNER_EMAIL = "dcep93.apps@gmail.com";
export const PREVIEW_LEAGUE_PATH = "/league/dcep93-apps/preview";

export type PreviewPlayer = {
  email: string;
  playerId: string;
  uid: string;
  username: string;
};

export const PREVIEW_PLAYERS: PreviewPlayer[] = [
  {
    email: PREVIEW_OWNER_EMAIL,
    playerId: "1",
    uid: PREVIEW_OWNER_UID,
    username: "dcep93.apps",
  },
  {
    email: "playerX@gmail.com",
    playerId: "2",
    uid: "preview-player-x",
    username: "playerX",
  },
  {
    email: "playerY@gmail.com",
    playerId: "3",
    uid: "preview-player-y",
    username: "playerY",
  },
  {
    email: "playerZ@gmail.com",
    playerId: "4",
    uid: "preview-player-z",
    username: "playerZ",
  },
];

const PREVIEW_CREATED_AT = Date.parse("2026-06-12T18:00:00Z");
const PREVIEW_DRAFT_STARTED_AT = Date.parse("2026-06-14T22:00:00Z");
const PREVIEW_DRAFT_FINALIZED_AT = Date.parse("2026-06-14T23:00:00Z");
const PREVIEW_UPDATED_AT = Date.parse("2026-06-25T20:00:00Z");

export function previewUser(username: string | null): User | null {
  const player = username
    ? PREVIEW_PLAYERS.find((candidate) => candidate.username.toLowerCase() === username.toLowerCase())
    : null;

  return player
    ? ({
        displayName: player.username,
        email: player.email,
        emailVerified: true,
        isAnonymous: false,
        uid: player.uid,
      } as User)
    : null;
}

export function previewSeedUsers() {
  const league = previewSeedLeague();
  const key = membershipKey(PREVIEW_OWNER_UID, PREVIEW_LEAGUE_ID);
  const users: Record<string, Record<string, unknown>> = {};

  for (const player of PREVIEW_PLAYERS) {
    users[player.uid] = {
      email: PREVIEW_OWNER_EMAIL,
      leagueMemberships: {
        [key]: {
          commissionerUid: PREVIEW_OWNER_UID,
          leagueId: PREVIEW_LEAGUE_ID,
          requestedAt: PREVIEW_CREATED_AT,
          status: "active",
          updatedAt: PREVIEW_UPDATED_AT,
        },
      },
      transactions: {
        [key]: previewTransactionsForPlayer(player, league),
      },
      updatedAt: PREVIEW_UPDATED_AT,
    };
  }

  users[PREVIEW_OWNER_UID] = {
    ...users[PREVIEW_OWNER_UID],
    commissionerEvents: {
      [key]: previewCommissionerEvents(league),
    },
    leagues: {
      [PREVIEW_LEAGUE_ID]: league,
    },
  };

  return users;
}

export function previewUniverseWithFallback(value: unknown) {
  const base = isRecord(value) ? value : {};
  const baseUsers = isRecord(base.users) ? base.users : {};
  const seededUsers = previewSeedUsers();
  const mergedUsers = { ...baseUsers };

  for (const [uid, seedRoot] of Object.entries(seededUsers)) {
    mergedUsers[uid] = mergeRecords(seedRoot, isRecord(baseUsers[uid]) ? baseUsers[uid] : {});
  }

  return {
    ...base,
    users: mergedUsers,
  };
}

export function previewRootUids() {
  return PREVIEW_PLAYERS.map((player) => player.uid);
}

function previewSeedLeague(): CommissionerLeague {
  const commissioner = previewUser("dcep93.apps") as User;
  const league = makeDefaultLeague(commissioner, "Preview League", PREVIEW_LEAGUE_ID);

  return {
    ...league,
    config: {
      ...league.config,
      draftRounds: 2,
      regularSeasonEnd: "2026-11-08",
      regularSeasonStart: "2026-07-16",
    },
    createdAt: PREVIEW_CREATED_AT,
    members: {
      [PREVIEW_OWNER_UID]: league.members[PREVIEW_OWNER_UID],
    },
    name: "Preview League",
    updatedAt: PREVIEW_CREATED_AT,
  };
}

function previewCommissionerEvents(league: CommissionerLeague): Record<string, CommissionerEvent> {
  const acceptedPlayers = PREVIEW_PLAYERS.slice(1).map((player, index) => {
    return [
      `c.${index + 1}`,
      {
        commissionerUid: PREVIEW_OWNER_UID,
        createdAt: PREVIEW_CREATED_AT + (index + 1) * 60_000,
        email: player.email,
        eventId: `c.${index + 1}`,
        kind: "accept-member",
        leagueId: league.leagueId,
        playerId: player.playerId,
        targetUid: player.uid,
      } satisfies CommissionerEvent,
    ] as const;
  });

  return Object.fromEntries([
    ...acceptedPlayers,
    [
      "c.4",
      {
        commissionerUid: PREVIEW_OWNER_UID,
        createdAt: PREVIEW_DRAFT_STARTED_AT,
        draftOrder: [
          "dcep93.apps",
          "playerX",
          "playerY",
          "playerZ",
          "playerZ",
          "playerY",
          "playerX",
          "dcep93.apps",
        ],
        draftRounds: 2,
        eventId: "c.4",
        kind: "start-draft",
        leagueId: league.leagueId,
      } satisfies CommissionerEvent,
    ],
    [
      "c.5",
      {
        commissionerUid: PREVIEW_OWNER_UID,
        createdAt: PREVIEW_DRAFT_FINALIZED_AT,
        eventId: "c.5",
        kind: "finalize-draft",
        leagueId: league.leagueId,
      } satisfies CommissionerEvent,
    ],
  ]);
}

function previewTransactionsForPlayer(
  player: PreviewPlayer,
  league: CommissionerLeague,
): Record<string, LeagueTransaction> {
  const member: LeagueMember = {
    email: player.email,
    joinedAt: PREVIEW_CREATED_AT,
    playerId: player.playerId,
  };
  const rows: LeagueTransaction[] = [];

  const draftFilms: Record<string, string[]> = {
    "dcep93.apps": ["send-help", "the-odyssey"],
    playerX: ["iron-lung", "minions-and-monsters"],
    playerY: ["mercy", "young-washington"],
    playerZ: ["primate", "paw-patrol-the-dino-movie"],
  };

  (draftFilms[player.username] ?? []).forEach((filmId, index) => {
    rows.push(simplePreviewTransaction(member, player, `draft-${index + 1}`, filmId, "pickup", 0));
  });

  if (player.username === "playerX") {
    rows.push(simplePreviewTransaction(member, player, "drop-1", "minions-and-monsters", "drop", 1));
    rows.push(bidPreviewTransaction(member, player, league, "bid-1", "coyote-vs-acme", 55, null));
  }

  if (player.username === "playerY") {
    rows.push(bidPreviewTransaction(member, player, league, "bid-1", "coyote-vs-acme", 72, null));
  }

  if (player.username === "dcep93.apps") {
    rows.push(simplePreviewTransaction(member, player, "pickup-1", "moana", "pickup", 1));
  }

  return Object.fromEntries(rows.map((transaction) => [transaction.txnId, transaction]));
}

function simplePreviewTransaction(
  member: LeagueMember,
  player: PreviewPlayer,
  suffix: string,
  filmId: string,
  kind: "drop" | "pickup",
  fee: number,
): LeagueTransaction {
  return {
    createdAt: previewTransactionTime(suffix),
    fee,
    filmId,
    kind,
    playerId: member.playerId,
    playerUid: player.uid,
    txnId: `${member.playerId}.${previewTransactionIndex(suffix)}`,
  };
}

function bidPreviewTransaction(
  member: LeagueMember,
  player: PreviewPlayer,
  league: CommissionerLeague,
  suffix: string,
  filmId: string,
  amount: number,
  dropFilmId: string | null,
): LeagueTransaction {
  const txnId = `${member.playerId}.${previewTransactionIndex(suffix)}`;
  const createdAt = previewTransactionTime(suffix);

  return {
    createdAt,
    fee: 1,
    kind: "bid",
    obfuscatedPayload: obfuscateBidPayload(
      {
        amount,
        dropFilmId,
        filmId,
        submittedAt: createdAt,
      },
      {
        commissionerUid: league.commissionerUid,
        leagueId: league.leagueId,
        txnId,
      },
    ),
    playerId: member.playerId,
    playerUid: player.uid,
    txnId,
  };
}

function previewTransactionIndex(suffix: string) {
  if (suffix.startsWith("draft-")) {
    return Number(suffix.replace("draft-", ""));
  }

  if (suffix === "pickup-1" || suffix === "drop-1") {
    return 3;
  }

  return 4;
}

function previewTransactionTime(suffix: string) {
  if (suffix.startsWith("draft-")) {
    return PREVIEW_DRAFT_STARTED_AT + previewTransactionIndex(suffix) * 5 * 60_000;
  }

  if (suffix === "pickup-1") {
    return Date.parse("2026-06-20T18:00:00Z");
  }

  if (suffix === "drop-1") {
    return Date.parse("2026-06-25T18:00:00Z");
  }

  return Date.parse("2026-06-25T19:00:00Z");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeRecords(
  seed: Record<string, unknown>,
  actual: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...seed };

  for (const [key, actualValue] of Object.entries(actual)) {
    const seedValue = merged[key];
    merged[key] =
      isRecord(seedValue) && isRecord(actualValue)
        ? mergeRecords(seedValue, actualValue)
        : actualValue;
  }

  return merged;
}
