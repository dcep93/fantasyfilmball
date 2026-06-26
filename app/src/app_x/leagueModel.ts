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
  playerId: string;
};

export type LeagueConfig = {
  draftRounds: number;
  maxTheaterSize: number;
  regularSeasonEnd: string;
  regularSeasonStart: string;
  startingStubs: number;
};

export type CommissionerLeague = {
  commissionerUid: string;
  config: LeagueConfig;
  createdAt: number;
  draftCompletedAt?: number;
  draftOrder?: string[] | null;
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
  enteredByUid?: string;
  enteredByUsername?: string;
  fee: number;
  playerId: string;
  playerUid: string;
  txnId: string;
};

export type BidTransaction = BaseTransaction & {
  kind: "bid";
  obfuscatedPayload: string;
};

export type SimpleTransaction = BaseTransaction & {
  filmId: string;
  kind: "drop" | "pickup";
};

export type LeagueTransaction = BidTransaction | SimpleTransaction;

export type BaseCommissionerEvent = {
  commissionerUid: string;
  createdAt: number;
  eventId: string;
  leagueId: string;
};

export type AcceptMemberEvent = BaseCommissionerEvent & {
  email: string;
  kind: "accept-member";
  playerId: string;
  targetUid: string;
};

export type KickMemberEvent = BaseCommissionerEvent & {
  kind: "kick-member";
  targetUid: string;
};

export type StartDraftEvent = BaseCommissionerEvent & {
  draftOrder: string[];
  draftRounds: number;
  kind: "start-draft";
};

export type FinalizeDraftEvent = BaseCommissionerEvent & {
  kind: "finalize-draft";
};

export type RenameLeagueEvent = BaseCommissionerEvent & {
  kind: "rename-league";
  name: string;
};

export type UpdateScoringEvent = BaseCommissionerEvent & {
  kind: "update-scoring";
  scoring: ScoringRuleSet;
};

export type DeleteLeagueEvent = BaseCommissionerEvent & {
  kind: "delete-league";
};

export type CommissionerEvent =
  | AcceptMemberEvent
  | DeleteLeagueEvent
  | FinalizeDraftEvent
  | KickMemberEvent
  | RenameLeagueEvent
  | StartDraftEvent
  | UpdateScoringEvent;

export const DEFAULT_LEAGUE_ID = "defaultLeagueId";
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

export function commissionerUsername(summary: Pick<LeagueSummary, "commissionerEmail" | "commissionerLabel">) {
  return slugPart(usernameFromEmail(summary.commissionerEmail, summary.commissionerLabel));
}

export function leaguePath(summary: Pick<LeagueSummary, "commissionerEmail" | "commissionerLabel" | "league">) {
  return `/league/${commissionerUsername(summary)}/${slugPart(summary.league.leagueId)}`;
}

export function currentSeasonYear() {
  return new Date().getFullYear();
}

export function usernameFromEmail(email: string | null | undefined, fallback = "player") {
  return email?.split("@")[0] || fallback;
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

      const events = readCommissionerEventsFromRoot(root, membershipKey(uid, league.leagueId), uid);
      const effectiveLeague = applyCommissionerEvents(league, events);
      if (!effectiveLeague) {
        continue;
      }

      const commissioner = effectiveLeague.members[uid];
      summaries.push({
        commissionerEmail,
        commissionerLabel: commissioner
          ? usernameFromEmail(commissioner.email, "commissioner")
          : usernameFromEmail(commissionerEmail, "commissioner"),
        commissionerUid: uid,
        league: effectiveLeague,
        membershipKey: membershipKey(uid, effectiveLeague.leagueId),
      });
    }
  }

  return summaries.sort((left, right) => {
    const byName = left.league.name.localeCompare(right.league.name);
    return byName || left.commissionerLabel.localeCompare(right.commissionerLabel);
  });
}

export function findLeagueSummaryByPath(
  value: unknown,
  commissionerSlug: string,
  leagueId: string,
): LeagueSummary | null {
  const cleanCommissioner = slugPart(commissionerSlug);
  const cleanLeagueId = slugPart(leagueId);
  return (
    readLeagueSummaries(value).find(
      (summary) =>
        commissionerUsername(summary) === cleanCommissioner &&
        slugPart(summary.league.leagueId) === cleanLeagueId,
    ) ?? null
  );
}

function slugPart(value: string | null | undefined) {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function firebasePathKey(value: string) {
  return encodeURIComponent(value).replace(/\./g, "%2E");
}

function keyMatchesId(key: string, id: string) {
  return key === id || key === firebasePathKey(id);
}

export function readTransactions(
  value: unknown,
  summary: LeagueSummary,
): LeagueTransaction[] {
  const transactions: LeagueTransaction[] = [];
  const activeUids = new Set(Object.keys(summary.league.members));

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
      if (transaction && keyMatchesId(txnId, transaction.txnId) && transaction.playerUid === uid) {
        transactions.push(transaction);
      }
    }
  }

  transactions.push(...readProxyTransactions(value, summary));

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
    if (transaction && keyMatchesId(txnId, transaction.txnId) && transaction.playerUid === uid) {
      transactions[transaction.txnId] = transaction;
    }
  }

  for (const transaction of readProxyTransactions(value, summary).filter(
    (candidate) => candidate.playerUid === uid,
  )) {
    transactions[transaction.txnId] = transaction;
  }

  return transactions;
}

function readProxyTransactions(value: unknown, summary: LeagueSummary): LeagueTransaction[] {
  const transactions: LeagueTransaction[] = [];
  const activeUids = new Set(Object.keys(summary.league.members));
  const root = getUserRoot(value, summary.commissionerUid);
  const byLeague = isRecord(root.proxyTransactions) ? root.proxyTransactions : {};
  const rawTransactions = isRecord(byLeague[summary.membershipKey])
    ? (byLeague[summary.membershipKey] as Record<string, unknown>)
    : {};

  for (const [txnId, raw] of Object.entries(rawTransactions)) {
    const transaction = readTransaction(raw);
    if (
      transaction &&
      keyMatchesId(txnId, transaction.txnId) &&
      transaction.enteredByUid === summary.commissionerUid &&
      activeUids.has(transaction.playerUid) &&
      summary.league.members[transaction.playerUid]?.playerId === transaction.playerId
    ) {
      transactions.push(transaction);
    }
  }

  return transactions;
}

export function readCommissionerEvents(value: unknown, summary: LeagueSummary): CommissionerEvent[] {
  const root = getUserRoot(value, summary.commissionerUid);
  return readCommissionerEventsFromRoot(root, summary.membershipKey, summary.commissionerUid).filter(
    (event) => event.leagueId === summary.league.leagueId,
  );
}

export function readOwnCommissionerEvents(
  value: unknown,
  uid: string,
  summary: LeagueSummary,
): Record<string, CommissionerEvent> {
  if (uid !== summary.commissionerUid) {
    return {};
  }

  return Object.fromEntries(readCommissionerEvents(value, summary).map((event) => [event.eventId, event]));
}

export function nextCommissionerEventId(events: Record<string, CommissionerEvent>) {
  const nextIndex =
    Object.keys(events)
      .filter((eventId) => eventId.startsWith("c."))
      .map((eventId) => Number(eventId.split(".")[1]))
      .filter((value) => Number.isInteger(value) && value > 0)
      .reduce((max, value) => Math.max(max, value), 0) + 1;

  return `c.${nextIndex}`;
}

export function makeDefaultLeague(user: User, leagueName: string, leagueId = DEFAULT_LEAGUE_ID) {
  const now = Date.now();
  const email = user.email ?? "";
  const season = currentSeasonYear();

  return {
    commissionerUid: user.uid,
    config: {
      draftRounds: 2,
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
        playerId: "1",
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
  context: { commissionerUid: string; leagueId: string; txnId: string },
) {
  const json = canonicalString(payload);
  const bytes = new TextEncoder().encode(json);
  const mask = maskBytes(context);
  const encoded = bytes.map((byte, index) => byte ^ mask[index % mask.length]);
  return `${OBFUSCATION_VERSION}:${base64UrlEncode(encoded)}`;
}

export function decodeBidPayload(
  value: string,
  context: { commissionerUid: string; leagueId: string; txnId: string },
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
    draftCompletedAt: asNumber(value.draftCompletedAt) ?? undefined,
    draftOrder: readDraftOrder(value),
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
    const playerId = asString(raw.playerId);
    const status = asString(raw.status);

    if (email && joinedAt && playerId && status !== "kicked") {
      members[uid] = { email, joinedAt, playerId };
    }
  }

  return members;
}

function readDraftOrder(value: Record<string, unknown>): string[] | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(value, "draftOrder")) {
    return undefined;
  }

  if (value.draftOrder === null) {
    return null;
  }

  if (!Array.isArray(value.draftOrder)) {
    return undefined;
  }

  const usernames = value.draftOrder
    .map((username) => (typeof username === "string" ? username.trim() : ""))
    .filter(Boolean);

  return usernames.length > 0 ? usernames : undefined;
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
    draftRounds: asNumber(value.draftRounds) ?? defaults.draftRounds,
    maxTheaterSize: asNumber(value.maxTheaterSize) ?? defaults.maxTheaterSize,
    regularSeasonEnd: asString(value.regularSeasonEnd) ?? defaults.regularSeasonEnd,
    regularSeasonStart: asString(value.regularSeasonStart) ?? defaults.regularSeasonStart,
    startingStubs: asNumber(value.startingStubs) ?? defaults.startingStubs,
  };
}

function defaultConfig(season: number): LeagueConfig {
  return {
    draftRounds: 2,
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
    const obfuscatedPayload = asString(value.obfuscatedPayload);

    if (!obfuscatedPayload) {
      return null;
    }

    return { ...base, kind, obfuscatedPayload };
  }

  if (kind === "drop" || kind === "pickup") {
    const filmId = asString(value.filmId);
    return filmId ? { ...base, filmId, kind } : null;
  }

  return null;
}

function readCommissionerEventsFromRoot(
  root: Record<string, unknown>,
  key: string,
  commissionerUid: string,
): CommissionerEvent[] {
  const byLeague = isRecord(root.commissionerEvents) ? root.commissionerEvents : {};
  const rawEvents = isRecord(byLeague[key]) ? (byLeague[key] as Record<string, unknown>) : {};
  const events: CommissionerEvent[] = [];

  for (const [eventId, raw] of Object.entries(rawEvents)) {
    const event = readCommissionerEvent(raw);
    if (event && keyMatchesId(eventId, event.eventId) && event.commissionerUid === commissionerUid) {
      events.push(event);
    }
  }

  return sortCommissionerEvents(events);
}

function applyCommissionerEvents(league: CommissionerLeague, events: CommissionerEvent[]) {
  let isDeleted = false;
  const effective: CommissionerLeague = {
    ...league,
    config: { ...league.config },
    kicked: { ...league.kicked },
    members: { ...league.members },
    scoring: cloneScoring(league.scoring),
  };

  for (const event of sortCommissionerEvents(events)) {
    if (event.leagueId !== league.leagueId || event.commissionerUid !== league.commissionerUid) {
      continue;
    }

    effective.updatedAt = Math.max(effective.updatedAt, event.createdAt);

    if (event.kind === "accept-member") {
      effective.members[event.targetUid] = {
        email: event.email,
        joinedAt: event.createdAt,
        playerId: event.playerId,
      };
      delete effective.kicked[event.targetUid];
      continue;
    }

    if (event.kind === "kick-member") {
      delete effective.members[event.targetUid];
      effective.kicked[event.targetUid] = true;
      continue;
    }

    if (event.kind === "start-draft") {
      effective.config.draftRounds = event.draftRounds;
      effective.draftOrder = event.draftOrder;
      delete effective.draftCompletedAt;
      continue;
    }

    if (event.kind === "finalize-draft") {
      effective.draftOrder = null;
      effective.draftCompletedAt = event.createdAt;
      continue;
    }

    if (event.kind === "rename-league") {
      effective.name = event.name;
      continue;
    }

    if (event.kind === "update-scoring") {
      effective.scoring = cloneScoring(event.scoring);
      continue;
    }

    if (event.kind === "delete-league") {
      isDeleted = true;
    }
  }

  return isDeleted ? null : effective;
}

function sortCommissionerEvents(events: CommissionerEvent[]) {
  return events.slice().sort((left, right) => {
    return left.createdAt - right.createdAt || left.eventId.localeCompare(right.eventId);
  });
}

function cloneScoring(scoring: ScoringRuleSet): ScoringRuleSet {
  return {
    ...scoring,
    positions: scoring.positions.map((position) => ({ ...position })),
  };
}

function readCommissionerEvent(value: unknown): CommissionerEvent | null {
  if (!isRecord(value)) {
    return null;
  }

  const base = readBaseCommissionerEvent(value);
  const kind = asString(value.kind);
  if (!base || !kind) {
    return null;
  }

  if (kind === "accept-member") {
    const email = typeof value.email === "string" ? value.email : "";
    const playerId = asString(value.playerId);
    const targetUid = asString(value.targetUid);
    return playerId && targetUid ? { ...base, email, kind, playerId, targetUid } : null;
  }

  if (kind === "kick-member") {
    const targetUid = asString(value.targetUid);
    return targetUid ? { ...base, kind, targetUid } : null;
  }

  if (kind === "start-draft") {
    const draftRounds = asNumber(value.draftRounds);
    const draftOrder = Array.isArray(value.draftOrder)
      ? value.draftOrder
          .map((username) => (typeof username === "string" ? username.trim() : ""))
          .filter(Boolean)
      : [];
    return draftRounds && draftOrder.length > 0 ? { ...base, draftOrder, draftRounds, kind } : null;
  }

  if (kind === "finalize-draft" || kind === "delete-league") {
    return { ...base, kind };
  }

  if (kind === "rename-league") {
    const name = asString(value.name);
    return name ? { ...base, kind, name } : null;
  }

  if (kind === "update-scoring") {
    const scoring = readScoring(value.scoring);
    return scoring ? { ...base, kind, scoring } : null;
  }

  return null;
}

function readBaseCommissionerEvent(value: Record<string, unknown>): BaseCommissionerEvent | null {
  const commissionerUid = asString(value.commissionerUid);
  const createdAt = asNumber(value.createdAt);
  const eventId = asString(value.eventId);
  const leagueId = asString(value.leagueId);

  if (!commissionerUid || !createdAt || !eventId || !leagueId) {
    return null;
  }

  return { commissionerUid, createdAt, eventId, leagueId };
}

function readBaseTransaction(value: Record<string, unknown>): BaseTransaction | null {
  const createdAt = asNumber(value.createdAt);
  const enteredByUid = asString(value.enteredByUid);
  const enteredByUsername = asString(value.enteredByUsername);
  const fee = asNumber(value.fee);
  const playerId = asString(value.playerId);
  const playerUid = asString(value.playerUid);
  const txnId = asString(value.txnId);

  if (!createdAt || fee === null || !playerId || !playerUid || !txnId) {
    return null;
  }

  return {
    createdAt,
    ...(enteredByUid ? { enteredByUid } : {}),
    ...(enteredByUsername ? { enteredByUsername } : {}),
    fee,
    playerId,
    playerUid,
    txnId,
  };
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

function maskBytes(context: { commissionerUid: string; leagueId: string; txnId: string }) {
  const seed = `${OBFUSCATION_VERSION}|${context.commissionerUid}|${context.leagueId}|${context.txnId}|fantasyfilmball`;
  const bytes = new TextEncoder().encode(seed);
  return bytes.map((byte, index) => (byte + index * 31 + seed.length) % 256);
}

function base64UrlEncode(bytes: Uint8Array) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}
