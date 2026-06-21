import type { User } from "firebase/auth";
import { DEFAULT_SCORING_RULES, type ScoringRuleSet } from "./scoringRules";

export type UniverseState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; value: unknown }
  | { status: "error"; message: string };

export type LeagueMembershipStatus = "active" | "kicked" | "left" | "requested";

export type LeagueMembership = {
  commissionerUid: string;
  leagueId: string;
  requestedAt: number;
  status: LeagueMembershipStatus;
  updatedAt: number;
};

export type LeagueMember = {
  email: string;
  joinedAt: number;
  label: string;
  playerId: string;
  status: "active" | "kicked";
};

export type LeagueConfig = {
  maxPlayers: number;
  maxTheaterSize: number;
  regularSeasonEnd: string;
  regularSeasonStart: string;
  startingStubs: number;
};

export type CommissionerLeague = {
  commissionerUid: string;
  config: LeagueConfig;
  createdAt: number;
  kicked: Record<string, true>;
  leagueId: string;
  members: Record<string, LeagueMember>;
  name: string;
  scoring: ScoringRuleSet;
  season: number;
  updatedAt: number;
};

export type LeagueSummary = {
  commissionerEmail: string | null;
  commissionerLabel: string;
  commissionerUid: string;
  league: CommissionerLeague;
  membershipKey: string;
};

export type BidPayload = {
  amount: number;
  dropFilmId: string | null;
  filmId: string;
  submittedAt: number;
};

export type BaseTransaction = {
  createdAt: number;
  fee: number;
  playerId: string;
  playerLabel: string;
  playerUid: string;
  txnId: string;
};

export type BidTransaction = BaseTransaction & {
  auctionDeadline: number;
  auctionId: string;
  kind: "bid";
  obfuscatedPayload: string;
  publicText: string;
};

export type SimpleTransaction = BaseTransaction & {
  filmId: string;
  kind: "drop" | "oscarPick" | "pickup";
};

export type LineupTransaction = BaseTransaction & {
  filmId: string;
  kind: "lineup";
  position: string;
};

export type LeagueTransaction = BidTransaction | LineupTransaction | SimpleTransaction;

export const DEFAULT_LEAGUE_ID = "defaultLeagueId";
export const SELECTED_LEAGUE_STORAGE_KEY = "fantasyfilmball.selectedLeagueKey";
export const STARTING_STUBS = 1000;

const OBFUSCATION_VERSION = "v1";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function membershipKey(commissionerUid: string, leagueId: string) {
  return `${commissionerUid}__${leagueId}`;
}

export function currentSeasonYear() {
  return new Date().getFullYear();
}

export function getUsers(value: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(value) || !isRecord(value.users)) {
    return {};
  }

  return value.users as Record<string, Record<string, unknown>>;
}

export function getUserRoot(value: unknown, uid: string): Record<string, unknown> {
  return getUsers(value)[uid] ?? {};
}

export function readMemberships(value: unknown, uid: string): Record<string, LeagueMembership> {
  const root = getUserRoot(value, uid);
  const rawMemberships = isRecord(root.leagueMemberships) ? root.leagueMemberships : {};
  const memberships: Record<string, LeagueMembership> = {};

  for (const [key, raw] of Object.entries(rawMemberships)) {
    const membership = readMembership(raw);
    if (membership) {
      memberships[key] = membership;
    }
  }

  return memberships;
}

export function readLeagueSummaries(value: unknown, leagueId?: string): LeagueSummary[] {
  const summaries: LeagueSummary[] = [];

  for (const [uid, root] of Object.entries(getUsers(value))) {
    const rawLeagues = isRecord(root.leagues) ? root.leagues : {};
    const commissionerEmail = asString(root.email);

    for (const raw of Object.values(rawLeagues)) {
      const league = readCommissionerLeague(raw);

      if (!league || league.commissionerUid !== uid) {
        continue;
      }

      if (leagueId && league.leagueId !== leagueId) {
        continue;
      }

      const commissioner = league.members[uid];
      summaries.push({
        commissionerEmail,
        commissionerLabel: commissioner?.label ?? commissionerEmail?.split("@")[0] ?? "Commissioner",
        commissionerUid: uid,
        league,
        membershipKey: membershipKey(uid, league.leagueId),
      });
    }
  }

  return summaries.sort((left, right) => {
    const byName = left.league.name.localeCompare(right.league.name);
    return byName || left.commissionerLabel.localeCompare(right.commissionerLabel);
  });
}

export function findLeagueSummary(value: unknown, key: string | null): LeagueSummary | null {
  if (!key) {
    return null;
  }

  return readLeagueSummaries(value).find((summary) => summary.membershipKey === key) ?? null;
}

export function readTransactions(
  value: unknown,
  summary: LeagueSummary,
): LeagueTransaction[] {
  const transactions: LeagueTransaction[] = [];
  const activeUids = new Set(
    Object.entries(summary.league.members)
      .filter(([, member]) => member.status === "active")
      .map(([uid]) => uid),
  );

  for (const [uid, root] of Object.entries(getUsers(value))) {
    if (!activeUids.has(uid)) {
      continue;
    }

    const byLeague = isRecord(root.transactions) ? root.transactions : {};
    const rawTransactions = isRecord(byLeague[summary.membershipKey])
      ? (byLeague[summary.membershipKey] as Record<string, unknown>)
      : {};

    for (const [txnId, raw] of Object.entries(rawTransactions)) {
      const transaction = readTransaction(raw);
      if (transaction && transaction.txnId === txnId && transaction.playerUid === uid) {
        transactions.push(transaction);
      }
    }
  }

  return transactions.sort((left, right) => left.createdAt - right.createdAt);
}

export function readOwnTransactions(
  value: unknown,
  uid: string,
  summary: LeagueSummary,
): Record<string, LeagueTransaction> {
  const root = getUserRoot(value, uid);
  const byLeague = isRecord(root.transactions) ? root.transactions : {};
  const rawTransactions = isRecord(byLeague[summary.membershipKey])
    ? (byLeague[summary.membershipKey] as Record<string, unknown>)
    : {};
  const transactions: Record<string, LeagueTransaction> = {};

  for (const [txnId, raw] of Object.entries(rawTransactions)) {
    const transaction = readTransaction(raw);
    if (transaction && transaction.txnId === txnId) {
      transactions[txnId] = transaction;
    }
  }

  return transactions;
}

export function makeDefaultLeague(user: User, leagueName: string, leagueId = DEFAULT_LEAGUE_ID) {
  const now = Date.now();
  const email = user.email ?? "";
  const label = user.displayName || email.split("@")[0] || "Commissioner";
  const season = currentSeasonYear();

  return {
    commissionerUid: user.uid,
    config: {
      maxPlayers: 6,
      maxTheaterSize: 10,
      regularSeasonEnd: `${season}-08-31`,
      regularSeasonStart: `${season}-05-01`,
      startingStubs: STARTING_STUBS,
    },
    createdAt: now,
    kicked: {},
    leagueId,
    members: {
      [user.uid]: {
        email,
        joinedAt: now,
        label,
        playerId: "1",
        status: "active" as const,
      },
    },
    name: leagueName.trim() || "FantasyFilmBall",
    scoring: {
      ...DEFAULT_SCORING_RULES,
      season: `Summer ${season}`,
      updatedAt: now,
    },
    season,
    updatedAt: now,
  } satisfies CommissionerLeague;
}

export function nextTxnId(member: LeagueMember, ownTransactions: Record<string, LeagueTransaction>) {
  const prefix = `${member.playerId}.`;
  const nextIndex =
    Object.keys(ownTransactions)
      .filter((txnId) => txnId.startsWith(prefix))
      .map((txnId) => Number(txnId.split(".")[1]))
      .filter((value) => Number.isInteger(value) && value > 0)
      .reduce((max, value) => Math.max(max, value), 0) + 1;

  return `${member.playerId}.${nextIndex}`;
}

export function stubBalance(member: LeagueMember, transactions: LeagueTransaction[]) {
  const fees = transactions
    .filter((transaction) => transaction.playerId === member.playerId)
    .reduce((total, transaction) => total + transaction.fee, 0);

  return STARTING_STUBS - fees;
}

export function obfuscateBidPayload(
  payload: BidPayload,
  context: { auctionId: string; commissionerUid: string; leagueId: string; txnId: string },
) {
  const json = canonicalString(payload);
  const bytes = new TextEncoder().encode(json);
  const mask = maskBytes(context);
  const encoded = bytes.map((byte, index) => byte ^ mask[index % mask.length]);
  return `${OBFUSCATION_VERSION}:${base64UrlEncode(encoded)}`;
}

export function decodeBidPayload(
  value: string,
  context: { auctionId: string; commissionerUid: string; leagueId: string; txnId: string },
): BidPayload | null {
  const [version, encoded] = value.split(":");
  if (version !== OBFUSCATION_VERSION || !encoded) {
    return null;
  }

  try {
    const bytes = base64UrlDecode(encoded);
    const mask = maskBytes(context);
    const decoded = bytes.map((byte, index) => byte ^ mask[index % mask.length]);
    const parsed = JSON.parse(new TextDecoder().decode(decoded));
    return readBidPayload(parsed);
  } catch {
    return null;
  }
}

function readMembership(value: unknown): LeagueMembership | null {
  if (!isRecord(value)) {
    return null;
  }

  const commissionerUid = asString(value.commissionerUid);
  const leagueId = asString(value.leagueId);
  const requestedAt = asNumber(value.requestedAt);
  const updatedAt = asNumber(value.updatedAt);
  const status = asString(value.status);

  if (
    !commissionerUid ||
    !leagueId ||
    !requestedAt ||
    !updatedAt ||
    (status !== "active" && status !== "kicked" && status !== "left" && status !== "requested")
  ) {
    return null;
  }

  return { commissionerUid, leagueId, requestedAt, status, updatedAt };
}

function readCommissionerLeague(value: unknown): CommissionerLeague | null {
  if (!isRecord(value)) {
    return null;
  }

  const commissionerUid = asString(value.commissionerUid);
  const createdAt = asNumber(value.createdAt);
  const leagueId = asString(value.leagueId);
  const name = asString(value.name);
  const season = asNumber(value.season);
  const updatedAt = asNumber(value.updatedAt);
  const scoring = readScoring(value.scoring);

  if (!commissionerUid || !createdAt || !leagueId || !name || !season || !updatedAt || !scoring) {
    return null;
  }

  return {
    commissionerUid,
    config: readConfig(value.config, season),
    createdAt,
    kicked: readKicked(value.kicked),
    leagueId,
    members: readMembers(value.members),
    name,
    scoring,
    season,
    updatedAt,
  };
}

function readMembers(value: unknown): Record<string, LeagueMember> {
  if (!isRecord(value)) {
    return {};
  }

  const members: Record<string, LeagueMember> = {};

  for (const [uid, raw] of Object.entries(value)) {
    if (!isRecord(raw)) {
      continue;
    }

    const email = asString(raw.email);
    const joinedAt = asNumber(raw.joinedAt);
    const label = asString(raw.label);
    const playerId = asString(raw.playerId);
    const status = asString(raw.status);

    if (email && joinedAt && label && playerId && (status === "active" || status === "kicked")) {
      members[uid] = { email, joinedAt, label, playerId, status };
    }
  }

  return members;
}

function readKicked(value: unknown): Record<string, true> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, isKicked]) => isKicked === true)
      .map(([uid]) => [uid, true]),
  );
}

function readConfig(value: unknown, season: number): LeagueConfig {
  if (!isRecord(value)) {
    return defaultConfig(season);
  }

  const defaults = defaultConfig(season);
  return {
    maxPlayers: asNumber(value.maxPlayers) ?? defaults.maxPlayers,
    maxTheaterSize: asNumber(value.maxTheaterSize) ?? defaults.maxTheaterSize,
    regularSeasonEnd: asString(value.regularSeasonEnd) ?? defaults.regularSeasonEnd,
    regularSeasonStart: asString(value.regularSeasonStart) ?? defaults.regularSeasonStart,
    startingStubs: asNumber(value.startingStubs) ?? defaults.startingStubs,
  };
}

function defaultConfig(season: number): LeagueConfig {
  return {
    maxPlayers: 6,
    maxTheaterSize: 10,
    regularSeasonEnd: `${season}-08-31`,
    regularSeasonStart: `${season}-05-01`,
    startingStubs: STARTING_STUBS,
  };
}

function readScoring(value: unknown): ScoringRuleSet | null {
  return isRecord(value) ? normalizeScoring(value) : null;
}

function normalizeScoring(value: Record<string, unknown>): ScoringRuleSet | null {
  const normalized = {
    positions: value.positions,
    season: value.season,
    updatedAt: value.updatedAt,
  };

  return DEFAULT_SCORING_RULES && readRuleSet(normalized);
}

function readRuleSet(value: unknown): ScoringRuleSet | null {
  if (!isRecord(value)) {
    return null;
  }

  const raw = value as { positions?: unknown; season?: unknown; updatedAt?: unknown };
  const season = asString(raw.season);
  const updatedAt = asNumber(raw.updatedAt);
  const positions = Array.isArray(raw.positions)
    ? raw.positions
        .map((position) => (isRecord(position) ? position : null))
        .filter((position): position is Record<string, unknown> => Boolean(position))
        .map((position) => ({
          formula: asString(position.formula),
          id: asString(position.id),
          name: asString(position.name),
          subtitle: asString(position.subtitle),
        }))
        .filter(
          (
            position,
          ): position is { formula: string; id: string; name: string; subtitle: string } =>
            Boolean(position.formula && position.id && position.name && position.subtitle),
        )
    : [];

  if (!season || !updatedAt || positions.length === 0) {
    return null;
  }

  return { positions, season, updatedAt };
}

function readTransaction(value: unknown): LeagueTransaction | null {
  if (!isRecord(value)) {
    return null;
  }

  const base = readBaseTransaction(value);
  const kind = asString(value.kind);
  if (!base || !kind) {
    return null;
  }

  if (kind === "bid") {
    const auctionDeadline = asNumber(value.auctionDeadline);
    const auctionId = asString(value.auctionId);
    const obfuscatedPayload = asString(value.obfuscatedPayload);
    const publicText = asString(value.publicText);

    if (!auctionDeadline || !auctionId || !obfuscatedPayload || !publicText) {
      return null;
    }

    return { ...base, auctionDeadline, auctionId, kind, obfuscatedPayload, publicText };
  }

  if (kind === "drop" || kind === "oscarPick" || kind === "pickup") {
    const filmId = asString(value.filmId);
    return filmId ? { ...base, filmId, kind } : null;
  }

  if (kind === "lineup") {
    const filmId = asString(value.filmId);
    const position = asString(value.position);
    return filmId && position ? { ...base, filmId, kind, position } : null;
  }

  return null;
}

function readBaseTransaction(value: Record<string, unknown>): BaseTransaction | null {
  const createdAt = asNumber(value.createdAt);
  const fee = asNumber(value.fee);
  const playerId = asString(value.playerId);
  const playerLabel = asString(value.playerLabel);
  const playerUid = asString(value.playerUid);
  const txnId = asString(value.txnId);

  if (!createdAt || fee === null || !playerId || !playerLabel || !playerUid || !txnId) {
    return null;
  }

  return { createdAt, fee, playerId, playerLabel, playerUid, txnId };
}

function readBidPayload(value: unknown): BidPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  const amount = asNumber(value.amount);
  const dropFilmId = typeof value.dropFilmId === "string" ? value.dropFilmId : null;
  const filmId = asString(value.filmId);
  const submittedAt = asNumber(value.submittedAt);

  if (amount === null || !filmId || !submittedAt) {
    return null;
  }

  return { amount, dropFilmId, filmId, submittedAt };
}

function canonicalString(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalString(item)).join(",")}]`;
  }

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalString(item)}`)
    .join(",")}}`;
}

function maskBytes(context: {
  auctionId: string;
  commissionerUid: string;
  leagueId: string;
  txnId: string;
}) {
  const seed = `${OBFUSCATION_VERSION}|${context.commissionerUid}|${context.leagueId}|${context.auctionId}|${context.txnId}|fantasyfilmball`;
  const bytes = new TextEncoder().encode(seed);
  return bytes.map((byte, index) => (byte + index * 31 + seed.length) % 256);
}

function base64UrlEncode(bytes: Uint8Array) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(window.atob(padded), (char) => char.charCodeAt(0));
}
