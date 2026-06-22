import {
  asString,
  getUsers,
  isRecord,
  membershipKey,
  type LeagueSummary,
  type LeagueTransaction,
} from "./leagueModel";
import {
  activeLeagueMembers,
  deriveLeagueSnapshot,
  type LeagueSnapshot,
  type TransactionWatermark,
} from "./leagueState";
import type { TrackedMovieFile } from "./movieData";

export type SnapshotCandidate = {
  ownerUid: string;
  snapshot: LeagueSnapshot;
  snapshotId: string;
};

export type SnapshotResolution = {
  selected: SnapshotCandidate | null;
  shouldWrite: boolean;
  snapshot: LeagueSnapshot;
  source: "commissioner" | "current-user" | "peer" | "regenerated";
  writeReason: string | null;
};

type ResolveInput = {
  generatedByUid: string;
  movieFile: TrackedMovieFile;
  now: number;
  summary: LeagueSummary;
  transactions: LeagueTransaction[];
  universeValue: unknown;
};

export function resolveLeagueSnapshot({
  generatedByUid,
  movieFile,
  now,
  summary,
  transactions,
  universeValue,
}: ResolveInput): SnapshotResolution {
  const candidates = readSnapshotCandidates(universeValue, summary);
  const selected =
    candidates
      .filter((candidate) =>
        validateSnapshot(candidate.snapshot, {
          movieFile,
          summary,
          transactions,
        }),
      )
      .sort((left, right) => right.snapshot.generatedAt - left.snapshot.generatedAt)[0] ?? null;
  const derived = deriveLeagueSnapshot({
    generatedByUid,
    league: summary.league,
    movieFile,
    now,
    transactions,
  });

  if (!selected) {
    return {
      selected,
      shouldWrite: true,
      snapshot: derived,
      source: "regenerated",
      writeReason: "no valid peer snapshot",
    };
  }

  if (!snapshotEquivalent(selected.snapshot, derived)) {
    return {
      selected,
      shouldWrite: true,
      snapshot: derived,
      source: sourceFor(selected, summary, generatedByUid),
      writeReason: "snapshot needed replay or clock update",
    };
  }

  return {
    selected,
    shouldWrite: false,
    snapshot: selected.snapshot,
    source: sourceFor(selected, summary, generatedByUid),
    writeReason: null,
  };
}

export function readSnapshotCandidates(value: unknown, summary: LeagueSummary): SnapshotCandidate[] {
  const users = getUsers(value);
  const activeUids = new Set(Object.keys(activeLeagueMembers(summary.league)));
  const candidates: SnapshotCandidate[] = [];

  for (const [uid, root] of Object.entries(users)) {
    if (!activeUids.has(uid)) {
      continue;
    }

    const snapshotsRoot = isRecord(root.snapshots) ? root.snapshots : {};
    const leagueSnapshots = isRecord(snapshotsRoot[summary.membershipKey])
      ? (snapshotsRoot[summary.membershipKey] as Record<string, unknown>)
      : {};

    for (const [snapshotId, rawSnapshot] of Object.entries(leagueSnapshots)) {
      const snapshot = readLeagueSnapshot(rawSnapshot);
      if (snapshot) {
        candidates.push({ ownerUid: uid, snapshot, snapshotId });
      }
    }
  }

  return candidates;
}

export function snapshotIdFor(snapshot: LeagueSnapshot) {
  return `${snapshot.generatedAt}-${snapshot.generatedByUid}`;
}

export function validateSnapshot(
  snapshot: LeagueSnapshot,
  {
    movieFile,
    summary,
    transactions,
  }: {
    movieFile: TrackedMovieFile;
    summary: LeagueSummary;
    transactions: LeagueTransaction[];
  },
) {
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.commissionerUid !== summary.commissionerUid ||
    snapshot.leagueId !== summary.league.leagueId ||
    snapshot.membershipKey !== membershipKey(summary.commissionerUid, summary.league.leagueId) ||
    snapshot.season !== summary.league.season ||
    snapshot.movieDataVersion !== movieFile.movieDataVersion
  ) {
    return false;
  }

  const expectedMembers = Object.keys(activeLeagueMembers(summary.league)).sort();
  if (stableString(snapshot.activeMemberUids.slice().sort()) !== stableString(expectedMembers)) {
    return false;
  }

  const actual = actualWatermarks(transactions);
  for (const [uid, watermark] of Object.entries(snapshot.transactionWatermarks)) {
    if (!expectedMembers.includes(uid)) {
      return false;
    }

    const actualWatermark = actual[uid] ?? {
      count: 0,
      latestCreatedAt: null,
      latestTxnId: null,
    };
    if (
      watermark.count > actualWatermark.count ||
      (watermark.latestCreatedAt !== null &&
        actualWatermark.latestCreatedAt !== null &&
        watermark.latestCreatedAt > actualWatermark.latestCreatedAt)
    ) {
      return false;
    }
  }

  return isRecord(snapshot.state.movies) && isRecord(snapshot.state.players);
}

function readLeagueSnapshot(value: unknown): LeagueSnapshot | null {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return null;
  }

  const activeMemberUids = Array.isArray(value.activeMemberUids)
    ? value.activeMemberUids.filter((uid): uid is string => typeof uid === "string")
    : null;
  const commissionerUid = asString(value.commissionerUid);
  const generatedAt = typeof value.generatedAt === "number" ? value.generatedAt : null;
  const generatedByUid = asString(value.generatedByUid);
  const leagueId = asString(value.leagueId);
  const memberKey = asString(value.membershipKey);
  const movieDataVersion = asString(value.movieDataVersion);
  const season = typeof value.season === "number" ? value.season : null;
  const transactionWatermarks = readWatermarks(value.transactionWatermarks);
  const state = isRecord(value.state) ? value.state : null;

  if (
    !activeMemberUids ||
    !commissionerUid ||
    !generatedAt ||
    !generatedByUid ||
    !leagueId ||
    !memberKey ||
    !movieDataVersion ||
    !season ||
    !transactionWatermarks ||
    !state ||
    !isRecord(state.movies) ||
    !isRecord(state.players) ||
    !isRecord(state.auctions) ||
    !Array.isArray(state.invalidTransactions) ||
    !isRecord(state.todos)
  ) {
    return null;
  }

  return {
    activeMemberUids,
    commissionerUid,
    generatedAt,
    generatedByUid,
    leagueId,
    membershipKey: memberKey,
    movieDataVersion,
    schemaVersion: 1,
    season,
    state: state as LeagueSnapshot["state"],
    transactionWatermarks,
  };
}

function readWatermarks(value: unknown): Record<string, TransactionWatermark> | null {
  if (!isRecord(value)) {
    return null;
  }

  const watermarks: Record<string, TransactionWatermark> = {};
  for (const [uid, raw] of Object.entries(value)) {
    if (!isRecord(raw)) {
      return null;
    }

    const count = typeof raw.count === "number" ? raw.count : null;
    const latestCreatedAt = raw.latestCreatedAt === null || typeof raw.latestCreatedAt === "number"
      ? raw.latestCreatedAt
      : undefined;
    const latestTxnId = raw.latestTxnId === null || typeof raw.latestTxnId === "string"
      ? raw.latestTxnId
      : undefined;

    if (count === null || latestCreatedAt === undefined || latestTxnId === undefined) {
      return null;
    }

    watermarks[uid] = { count, latestCreatedAt, latestTxnId };
  }

  return watermarks;
}

function actualWatermarks(transactions: LeagueTransaction[]) {
  const watermarks: Record<string, TransactionWatermark> = {};
  const sorted = transactions.slice().sort((left, right) => left.createdAt - right.createdAt);

  for (const transaction of sorted) {
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

function snapshotEquivalent(left: LeagueSnapshot, right: LeagueSnapshot) {
  return (
    left.movieDataVersion === right.movieDataVersion &&
    stableString(left.state) === stableString(right.state) &&
    stableString(left.transactionWatermarks) === stableString(right.transactionWatermarks)
  );
}

function sourceFor(
  candidate: SnapshotCandidate,
  summary: LeagueSummary,
  currentUid: string,
): SnapshotResolution["source"] {
  if (candidate.ownerUid === currentUid) {
    return "current-user";
  }

  if (candidate.ownerUid === summary.commissionerUid) {
    return "commissioner";
  }

  return "peer";
}

function stableString(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortKeys(nested)]),
  );
}
