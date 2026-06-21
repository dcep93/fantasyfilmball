import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { User } from "firebase/auth";
import { ref, serverTimestamp, update } from "firebase/database";
import type { FirebaseClient } from "./firebaseClient";
import { normalizeRuleSet, type ScoringRuleSet } from "./scoringRules";

export type UniverseState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; value: unknown }
  | { status: "error"; message: string };

type LeagueConsoleProps = {
  client: FirebaseClient;
  user: User;
  universeState: UniverseState;
  onNavigate: (pathname: string) => void;
  onSignOut: () => void;
};

type UserRoot = {
  email?: unknown;
  league?: unknown;
};

type LeagueState = {
  profile?: LeagueProfile;
  transactions?: Record<string, LeagueTransaction>;
};

export type LeagueProfile = {
  email: string;
  playerId: string;
  playerLabel: string;
  passphraseSalt: string;
  passphraseVerifier: string;
  updatedAt: number;
};

type EncryptedPayload = {
  iv: string;
  ciphertext: string;
};

type BidPayload = {
  amount: number;
  auctionId: string;
  dropFilmId: string | null;
  filmId: string;
  salt: string;
  submittedAt: number;
};

type TransactionBase = {
  createdAt: number;
  fee: number;
  playerId: string;
  playerLabel: string;
  txnId: string;
};

type BidCommitTransaction = TransactionBase & {
  auctionDeadline: number;
  commitment: string;
  encryptedPayload: EncryptedPayload;
  kind: "bidCommit";
  revealGraceMs: number;
};

type BidRevealTransaction = TransactionBase & {
  commitment: string;
  kind: "bidReveal";
  payload: BidPayload;
  revealForTxnId: string;
};

type SimpleTransaction = TransactionBase & {
  filmId: string;
  kind: "pickup" | "drop";
};

type LineupTransaction = TransactionBase & {
  filmId: string;
  kind: "lineup";
  position: string;
};

type OscarPickTransaction = TransactionBase & {
  filmId: string;
  kind: "oscarPick";
};

type MemberAddTransaction = TransactionBase & {
  email: string;
  kind: "memberAdd";
  memberLabel: string;
  memberPlayerId: string;
};

type ScoringRulesTransaction = TransactionBase & {
  kind: "scoringRules";
  rules: ScoringRuleSet;
};

type LeagueTransaction =
  | BidCommitTransaction
  | BidRevealTransaction
  | MemberAddTransaction
  | OscarPickTransaction
  | ScoringRulesTransaction
  | SimpleTransaction
  | LineupTransaction;

type Session = {
  key: CryptoKey;
  passphrase: string;
  profile: LeagueProfile;
};

const STARTING_STUBS = 1000;
const REVEAL_GRACE_MS = 48 * 60 * 60 * 1000;
const UNREVEALED_PENALTY = 25;
const EMPTY_UNIVERSE = {};

const PASS_STORAGE_PREFIX = "fantasyfilmball.passphrase.";
const PROFILE_STORAGE_PREFIX = "fantasyfilmball.show-passphrase.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getUsers(value: unknown): Record<string, UserRoot> {
  if (!isRecord(value)) {
    return {};
  }

  const users = value.users;
  if (!isRecord(users)) {
    return {};
  }

  return users as Record<string, UserRoot>;
}

function parseLeague(value: unknown): LeagueState {
  if (!isRecord(value)) {
    return {};
  }

  const profile = parseProfile(value.profile);
  const transactions = parseTransactions(value.transactions);
  return { profile, transactions };
}

function parseProfile(value: unknown): LeagueProfile | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const email = asString(value.email);
  const playerId = asString(value.playerId);
  const playerLabel = asString(value.playerLabel);
  const passphraseSalt = asString(value.passphraseSalt);
  const passphraseVerifier = asString(value.passphraseVerifier);
  const updatedAt = asNumber(value.updatedAt);

  if (!email || !playerId || !playerLabel || !passphraseSalt || !passphraseVerifier || !updatedAt) {
    return undefined;
  }

  return {
    email,
    passphraseSalt,
    passphraseVerifier,
    playerId,
    playerLabel,
    updatedAt,
  };
}

function parseTransactions(value: unknown): Record<string, LeagueTransaction> {
  if (!isRecord(value)) {
    return {};
  }

  const transactions: Record<string, LeagueTransaction> = {};

  for (const [txnId, raw] of Object.entries(value)) {
    const transaction = parseTransaction(raw);
    if (transaction && transaction.txnId === txnId) {
      transactions[txnId] = transaction;
    }
  }

  return transactions;
}

function parseTransaction(value: unknown): LeagueTransaction | null {
  if (!isRecord(value)) {
    return null;
  }

  const kind = asString(value.kind);
  const createdAt = asNumber(value.createdAt);
  const fee = asNumber(value.fee);
  const playerId = asString(value.playerId);
  const playerLabel = asString(value.playerLabel);
  const txnId = asString(value.txnId);

  if (!kind || !createdAt || fee === null || !playerId || !playerLabel || !txnId) {
    return null;
  }

  if (kind === "bidCommit") {
    const auctionDeadline = asNumber(value.auctionDeadline);
    const commitment = asString(value.commitment);
    const revealGraceMs = asNumber(value.revealGraceMs);
    const encryptedPayload = parseEncryptedPayload(value.encryptedPayload);

    if (!auctionDeadline || !commitment || !revealGraceMs || !encryptedPayload) {
      return null;
    }

    return {
      auctionDeadline,
      commitment,
      createdAt,
      encryptedPayload,
      fee,
      kind,
      playerId,
      playerLabel,
      revealGraceMs,
      txnId,
    };
  }

  if (kind === "bidReveal") {
    const commitment = asString(value.commitment);
    const revealForTxnId = asString(value.revealForTxnId);
    const payload = parseBidPayload(value.payload);

    if (!commitment || !revealForTxnId || !payload) {
      return null;
    }

    return {
      commitment,
      createdAt,
      fee,
      kind,
      payload,
      playerId,
      playerLabel,
      revealForTxnId,
      txnId,
    };
  }

  if (kind === "pickup" || kind === "drop") {
    const filmId = asString(value.filmId);
    if (!filmId) {
      return null;
    }

    return { createdAt, fee, filmId, kind, playerId, playerLabel, txnId };
  }

  if (kind === "oscarPick") {
    const filmId = asString(value.filmId);
    if (!filmId) {
      return null;
    }

    return { createdAt, fee, filmId, kind, playerId, playerLabel, txnId };
  }

  if (kind === "lineup") {
    const filmId = asString(value.filmId);
    const position = asString(value.position);
    if (!filmId || !position) {
      return null;
    }

    return { createdAt, fee, filmId, kind, playerId, playerLabel, position, txnId };
  }

  if (kind === "memberAdd") {
    const email = asString(value.email);
    const memberLabel = asString(value.memberLabel);
    const memberPlayerId = asString(value.memberPlayerId);

    if (!email || !memberLabel || !memberPlayerId) {
      return null;
    }

    return {
      createdAt,
      email,
      fee,
      kind,
      memberLabel,
      memberPlayerId,
      playerId,
      playerLabel,
      txnId,
    };
  }

  if (kind === "scoringRules") {
    const rules = normalizeRuleSet(value.rules);

    if (!rules) {
      return null;
    }

    return {
      createdAt,
      fee,
      kind,
      playerId,
      playerLabel,
      rules,
      txnId,
    };
  }

  return null;
}

function parseEncryptedPayload(value: unknown): EncryptedPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  const iv = asString(value.iv);
  const ciphertext = asString(value.ciphertext);
  return iv && ciphertext ? { ciphertext, iv } : null;
}

function parseBidPayload(value: unknown): BidPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  const amount = asNumber(value.amount);
  const auctionId = asString(value.auctionId);
  const dropFilmId = typeof value.dropFilmId === "string" ? value.dropFilmId : null;
  const filmId = asString(value.filmId);
  const salt = asString(value.salt);
  const submittedAt = asNumber(value.submittedAt);

  if (amount === null || !auctionId || !filmId || !salt || !submittedAt) {
    return null;
  }

  return { amount, auctionId, dropFilmId, filmId, salt, submittedAt };
}

function encodeBase64(bytes: Uint8Array): string {
  return window.btoa(String.fromCharCode(...bytes));
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(window.atob(value), (char) => char.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function randomBase64(byteCount = 16): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return encodeBase64(bytes);
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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

async function sha256Hex(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  return bufferToHex(await crypto.subtle.digest("SHA-256", encoded));
}

async function deriveKey(passphrase: string, email: string, uid: string, salt: string) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      hash: "SHA-256",
      iterations: 210_000,
      name: "PBKDF2",
      salt: new TextEncoder().encode(`${uid}:${email}:${salt}`),
    },
    baseKey,
    { length: 256, name: "AES-GCM" },
    true,
    ["decrypt", "encrypt"],
  );
}

async function verifierForKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return sha256Hex(`${bufferToHex(raw)}:fantasyfilmball-verifier-v1`);
}

async function encryptPayload(key: CryptoKey, payload: BidPayload): Promise<EncryptedPayload> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  const ciphertext = await crypto.subtle.encrypt(
    { iv, name: "AES-GCM" },
    key,
    new TextEncoder().encode(canonicalString(payload)),
  );

  return {
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    iv: encodeBase64(iv),
  };
}

async function decryptPayload(key: CryptoKey, encryptedPayload: EncryptedPayload): Promise<BidPayload> {
  const plaintext = await crypto.subtle.decrypt(
    { iv: toArrayBuffer(decodeBase64(encryptedPayload.iv)), name: "AES-GCM" },
    key,
    toArrayBuffer(decodeBase64(encryptedPayload.ciphertext)),
  );

  const parsed = JSON.parse(new TextDecoder().decode(plaintext));
  const payload = parseBidPayload(parsed);
  if (!payload) {
    throw new Error("Decrypted bid payload was not valid.");
  }

  return payload;
}

function toDatetimeLocal(timestamp: number): string {
  const date = new Date(timestamp);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(timestamp - offset).toISOString().slice(0, 16);
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function getUserLeague(universeValue: unknown, uid: string): LeagueState {
  return parseLeague(getUsers(universeValue)[uid]?.league);
}

function getAllTransactions(universeValue: unknown): LeagueTransaction[] {
  return Object.values(getUsers(universeValue))
    .flatMap((root) => Object.values(parseLeague(root.league).transactions ?? {}))
    .sort((left, right) => left.createdAt - right.createdAt);
}

function getRevealMap(transactions: LeagueTransaction[]): Map<string, BidRevealTransaction> {
  const reveals = new Map<string, BidRevealTransaction>();

  for (const transaction of transactions) {
    if (transaction.kind === "bidReveal") {
      reveals.set(transaction.revealForTxnId, transaction);
    }
  }

  return reveals;
}

function nextTxnId(profile: LeagueProfile, transactions: Record<string, LeagueTransaction>) {
  const nextIndex =
    Object.keys(transactions)
      .filter((txnId) => txnId.startsWith(`${profile.playerId}.`))
      .map((txnId) => Number(txnId.split(".")[1]))
      .filter((value) => Number.isInteger(value) && value > 0)
      .reduce((max, value) => Math.max(max, value), 0) + 1;

  return `${profile.playerId}.${nextIndex}`;
}

function feeForTransaction(transaction: LeagueTransaction) {
  return transaction.kind === "bidReveal" ? 0 : transaction.fee;
}

function computeStubBalance(profile: LeagueProfile, transactions: LeagueTransaction[], now: number) {
  const reveals = getRevealMap(transactions);
  const ownTransactions = transactions.filter((transaction) => transaction.playerId === profile.playerId);
  const fees = ownTransactions.reduce((total, transaction) => total + feeForTransaction(transaction), 0);
  const penalties = ownTransactions
    .filter(
      (transaction): transaction is BidCommitTransaction =>
        transaction.kind === "bidCommit" &&
        !reveals.has(transaction.txnId) &&
        transaction.auctionDeadline + transaction.revealGraceMs < now,
    )
    .length * UNREVEALED_PENALTY;

  return STARTING_STUBS - fees - penalties;
}

function playerLabel(user: User) {
  return user.email?.split("@")[0] ?? "player";
}

export default function LeagueConsole({
  client,
  onNavigate,
  onSignOut,
  universeState,
  user,
}: LeagueConsoleProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isTestingRules, setIsTestingRules] = useState(false);

  const universeValue = useMemo(
    () => (universeState.status === "ready" ? universeState.value : EMPTY_UNIVERSE),
    [universeState],
  );
  const league = useMemo(() => getUserLeague(universeValue, user.uid), [universeValue, user.uid]);
  const transactions = useMemo(() => getAllTransactions(universeValue), [universeValue]);

  useEffect(() => {
    if (!session || universeState.status !== "ready") {
      return;
    }

    let cancelled = false;

    const activeSession = session;

    async function revealDueBids() {
      const ownTransactions = Object.values(league.transactions ?? {});
      const reveals = getRevealMap(transactions);
      const dueCommits = ownTransactions.filter(
        (transaction): transaction is BidCommitTransaction =>
          transaction.kind === "bidCommit" &&
          transaction.auctionDeadline <= Date.now() &&
          !reveals.has(transaction.txnId),
      );

      if (dueCommits.length === 0) {
        return;
      }

      const nextTransactions = { ...(league.transactions ?? {}) };
      let wroteReveal = false;

      for (const commit of dueCommits) {
        try {
          const payload = await decryptPayload(activeSession.key, commit.encryptedPayload);
          const commitment = await sha256Hex(canonicalString(payload));

          if (commitment !== commit.commitment) {
            continue;
          }

          const txnId = nextTxnId(activeSession.profile, nextTransactions);
          nextTransactions[txnId] = {
            commitment,
            createdAt: Date.now(),
            fee: 0,
            kind: "bidReveal",
            payload,
            playerId: activeSession.profile.playerId,
            playerLabel: activeSession.profile.playerLabel,
            revealForTxnId: commit.txnId,
            txnId,
          };
          wroteReveal = true;
        } catch {
          // A wrong passphrase cannot reveal the payload; the passphrase gate should catch that first.
        }
      }

      if (!cancelled && wroteReveal) {
        await writeLeague({ transactions: nextTransactions });
        setMessage(`Revealed ${dueCommits.length} due bid${dueCommits.length === 1 ? "" : "s"}.`);
      }
    }

    revealDueBids().catch((error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : "Auto-reveal failed.";
      setMessage(errorMessage);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, universeState.status]);

  async function writeLeague(patch: Partial<LeagueState>) {
    if (!session) {
      throw new Error("Passphrase session is not unlocked.");
    }

    await update(ref(client.database, `users/${user.uid}`), {
      email: user.email,
      league: {
        ...league,
        ...patch,
      },
      updatedAt: serverTimestamp(),
    });
  }

  async function writeProfile(profile: LeagueProfile) {
    await update(ref(client.database, `users/${user.uid}`), {
      email: user.email,
      league: {
        ...league,
        profile,
      },
      updatedAt: serverTimestamp(),
    });
  }

  async function writeTransaction(transaction: LeagueTransaction) {
    await writeLeague({
      transactions: {
        ...(league.transactions ?? {}),
        [transaction.txnId]: transaction,
      },
    });
  }

  async function testIllegalWrite() {
    const forbiddenUid =
      user.uid === "rules-sanity-check-other-user"
        ? "rules-sanity-check-someone-else"
        : "rules-sanity-check-other-user";

    setIsTestingRules(true);
    setMessage(null);

    try {
      await update(ref(client.database, `users/${forbiddenUid}`), {
        email: user.email,
        league: { attemptedBy: user.uid },
        updatedAt: serverTimestamp(),
      });
      setMessage(`Unexpectedly wrote to /users/${forbiddenUid}. Tighten rules.`);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Firebase blocked the write.";
      setMessage(`Blocked as expected: ${errorMessage}`);
    } finally {
      setIsTestingRules(false);
    }
  }

  if (universeState.status === "error") {
    return (
      <Shell onNavigate={onNavigate} onSignOut={onSignOut}>
        <section className="ffb-panel">
          <p className="ffb-label">Realtime Database</p>
          <h2>Unable to load league</h2>
          <p className="ffb-error">{universeState.message}</p>
        </section>
      </Shell>
    );
  }

  if (universeState.status !== "ready") {
    return (
      <Shell onNavigate={onNavigate} onSignOut={onSignOut}>
        <section className="ffb-panel">
          <p className="ffb-label">Realtime Database</p>
          <h2>Loading league log</h2>
          <p className="ffb-muted">Waiting for Firebase data.</p>
        </section>
      </Shell>
    );
  }

  if (!session) {
    return (
      <Shell onNavigate={onNavigate} onSignOut={onSignOut}>
        <PassphraseGate
          existingProfile={league.profile}
          user={user}
          onUnlock={setSession}
          onWriteProfile={writeProfile}
        />
      </Shell>
    );
  }

  return (
    <Shell onNavigate={onNavigate} onSignOut={onSignOut}>
      <LeagueDashboard
        message={message}
        profile={session.profile}
        transactions={transactions}
        userTransactions={league.transactions ?? {}}
        onBid={async (draft) => {
          const payload: BidPayload = {
            amount: draft.amount,
            auctionId: draft.auctionId,
            dropFilmId: draft.dropFilmId,
            filmId: draft.filmId,
            salt: randomBase64(18),
            submittedAt: Date.now(),
          };
          const commitment = await sha256Hex(canonicalString(payload));
          const txnId = nextTxnId(session.profile, league.transactions ?? {});

          await writeTransaction({
            auctionDeadline: draft.auctionDeadline,
            commitment,
            createdAt: Date.now(),
            encryptedPayload: await encryptPayload(session.key, payload),
            fee: 1,
            kind: "bidCommit",
            playerId: session.profile.playerId,
            playerLabel: session.profile.playerLabel,
            revealGraceMs: REVEAL_GRACE_MS,
            txnId,
          });

          setMessage(`Sealed bid ${txnId} was committed. The film stays private until reveal.`);
        }}
        onSimpleMove={async (kind, filmId) => {
          const txnId = nextTxnId(session.profile, league.transactions ?? {});
          await writeTransaction({
            createdAt: Date.now(),
            fee: 1,
            filmId,
            kind,
            playerId: session.profile.playerId,
            playerLabel: session.profile.playerLabel,
            txnId,
          });
          setMessage(`${kind === "pickup" ? "Pickup" : "Drop"} ${txnId} logged.`);
        }}
        onLineup={async (filmId, position) => {
          const txnId = nextTxnId(session.profile, league.transactions ?? {});
          await writeTransaction({
            createdAt: Date.now(),
            fee: 1,
            filmId,
            kind: "lineup",
            playerId: session.profile.playerId,
            playerLabel: session.profile.playerLabel,
            position,
            txnId,
          });
          setMessage(`Lineup shuffle ${txnId} logged.`);
        }}
        onOscarPick={async (filmId) => {
          const txnId = nextTxnId(session.profile, league.transactions ?? {});
          await writeTransaction({
            createdAt: Date.now(),
            fee: 0,
            filmId,
            kind: "oscarPick",
            playerId: session.profile.playerId,
            playerLabel: session.profile.playerLabel,
            txnId,
          });
          setMessage(`Oscar pick ${txnId} logged for ${filmId}.`);
        }}
        onMemberAdd={async (email, memberPlayerId, memberLabel) => {
          const txnId = nextTxnId(session.profile, league.transactions ?? {});
          await writeTransaction({
            createdAt: Date.now(),
            email,
            fee: 1,
            kind: "memberAdd",
            memberLabel,
            memberPlayerId,
            playerId: session.profile.playerId,
            playerLabel: session.profile.playerLabel,
            txnId,
          });
          setMessage(`Member add ${txnId} logged for ${email}.`);
        }}
        onShowPassphrase={() => {
          window.localStorage.setItem(`${PROFILE_STORAGE_PREFIX}${user.uid}`, "shown");
          setMessage(`Saved passphrase on this device: ${session.passphrase}`);
        }}
        onForgetPassphrase={() => {
          window.localStorage.removeItem(`${PASS_STORAGE_PREFIX}${user.uid}`);
          setMessage("Forgot the saved passphrase on this device.");
        }}
        onTestIllegalWrite={testIllegalWrite}
        isTestingRules={isTestingRules}
      />
    </Shell>
  );
}

function Shell({
  children,
  onNavigate,
  onSignOut,
}: {
  children: ReactNode;
  onNavigate: (pathname: string) => void;
  onSignOut: () => void;
}) {
  return (
    <main className="ffb-page">
      <header className="ffb-header">
        <div>
          <p className="ffb-kicker">FantasyFilmBall</p>
          <h1>League console</h1>
        </div>
        <nav className="ffb-nav" aria-label="Primary">
          <button type="button" onClick={() => onNavigate("/")}>
            Rules
          </button>
          <button type="button" onClick={() => onNavigate("/league")}>
            Movie Charts
          </button>
          <button type="button" onClick={() => onNavigate("/scoring")}>
            Scoring
          </button>
          <button type="button" onClick={() => onNavigate("/debug")}>
            Debug
          </button>
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
        </nav>
      </header>
      {children}
    </main>
  );
}

function PassphraseGate({
  existingProfile,
  onUnlock,
  onWriteProfile,
  user,
}: {
  existingProfile?: LeagueProfile;
  onUnlock: (session: Session) => void;
  onWriteProfile: (profile: LeagueProfile) => Promise<void>;
  user: User;
}) {
  const savedPassphrase = window.localStorage.getItem(`${PASS_STORAGE_PREFIX}${user.uid}`) ?? "";
  const [passphrase, setPassphrase] = useState(savedPassphrase);
  const [playerId, setPlayerId] = useState(existingProfile?.playerId ?? "1");
  const [remember, setRemember] = useState(Boolean(savedPassphrase));
  const [showSaved, setShowSaved] = useState(false);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setErrorMessage(null);
    setIsUnlocking(true);

    try {
      const email = user.email ?? "";
      const salt = existingProfile?.passphraseSalt ?? randomBase64(18);
      const key = await deriveKey(passphrase, email, user.uid, salt);
      const verifier = await verifierForKey(key);

      if (existingProfile && existingProfile.passphraseVerifier !== verifier) {
        throw new Error("That passphrase does not match this league profile.");
      }

      const profile: LeagueProfile =
        existingProfile ?? {
          email,
          passphraseSalt: salt,
          passphraseVerifier: verifier,
          playerId,
          playerLabel: playerLabel(user),
          updatedAt: Date.now(),
        };

      if (!existingProfile) {
        await onWriteProfile(profile);
      }

      if (remember) {
        window.localStorage.setItem(`${PASS_STORAGE_PREFIX}${user.uid}`, passphrase);
      } else {
        window.localStorage.removeItem(`${PASS_STORAGE_PREFIX}${user.uid}`);
      }

      onUnlock({ key, passphrase, profile });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Could not unlock the league console.";
      setErrorMessage(message);
    } finally {
      setIsUnlocking(false);
    }
  }

  return (
    <section className="ffb-passphrase" aria-labelledby="passphrase-title">
      <div>
        <p className="ffb-label">Passphrase required</p>
        <h2 id="passphrase-title">
          {existingProfile ? "Unlock your bid vault" : "Create your bid vault"}
        </h2>
        <p>
          League data stays hidden until your passphrase is verified. The app can prove the
          passphrase is right, but it never stores the passphrase in Firebase.
        </p>
      </div>

      <form className="ffb-form" onSubmit={submit}>
        {!existingProfile ? (
          <label>
            Player id
            <select value={playerId} onChange={(event) => setPlayerId(event.target.value)}>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="4">4</option>
              <option value="5">5</option>
              <option value="6">6</option>
            </select>
          </label>
        ) : null}
        <label>
          Passphrase
          <input
            autoComplete="current-password"
            minLength={8}
            required
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
          />
        </label>
        <label className="ffb-check">
          <input
            checked={remember}
            type="checkbox"
            onChange={(event) => setRemember(event.target.checked)}
          />
          Remember on this device
        </label>
        <div className="ffb-actions">
          <button className="ffb-primary" disabled={isUnlocking} type="submit">
            {isUnlocking ? "Unlocking" : "Unlock"}
          </button>
          {savedPassphrase ? (
            <button type="button" onClick={() => setShowSaved((value) => !value)}>
              {showSaved ? "Hide Saved" : "Show Saved"}
            </button>
          ) : null}
        </div>
        {showSaved ? <p className="ffb-source">Saved passphrase: {savedPassphrase}</p> : null}
        {errorMessage ? <p className="ffb-error">{errorMessage}</p> : null}
      </form>
    </section>
  );
}

function LeagueDashboard({
  isTestingRules,
  message,
  onBid,
  onForgetPassphrase,
  onLineup,
  onMemberAdd,
  onOscarPick,
  onShowPassphrase,
  onSimpleMove,
  onTestIllegalWrite,
  profile,
  transactions,
  userTransactions,
}: {
  isTestingRules: boolean;
  message: string | null;
  onBid: (draft: {
    amount: number;
    auctionDeadline: number;
    auctionId: string;
    dropFilmId: string | null;
    filmId: string;
  }) => Promise<void>;
  onForgetPassphrase: () => void;
  onLineup: (filmId: string, position: string) => Promise<void>;
  onShowPassphrase: () => void;
  onOscarPick: (filmId: string) => Promise<void>;
  onSimpleMove: (kind: "pickup" | "drop", filmId: string) => Promise<void>;
  onMemberAdd: (email: string, memberPlayerId: string, memberLabel: string) => Promise<void>;
  onTestIllegalWrite: () => Promise<void>;
  profile: LeagueProfile;
  transactions: LeagueTransaction[];
  userTransactions: Record<string, LeagueTransaction>;
}) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const stubs = computeStubBalance(profile, transactions, now);
  const ownTransactions = Object.values(userTransactions).sort((left, right) => right.createdAt - left.createdAt);

  async function runAction(name: string, action: () => Promise<void>) {
    setBusyAction(name);
    try {
      await action();
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <>
      <section className="ffb-league-grid">
        <div className="ffb-panel">
          <p className="ffb-label">Player</p>
          <h2>{profile.playerLabel}</h2>
          <p>{profile.email}</p>
          <p className="ffb-source">Transaction prefix: {profile.playerId}.*</p>
        </div>
        <div className="ffb-panel">
          <p className="ffb-label">Stubs</p>
          <strong className="ffb-stubs">{stubs}</strong>
          <p className="ffb-muted">Starts at 1000. Bid commits, moves, drops, and lineup shuffles cost 1.</p>
        </div>
        <div className="ffb-panel">
          <p className="ffb-label">Bid Vault</p>
          <h2>Local passphrase</h2>
          <p>Reveal due bids auto-run after unlock. Reveals cost 0 stubs.</p>
          <div className="ffb-actions">
            <button type="button" onClick={onShowPassphrase}>
              Show Saved
            </button>
            <button type="button" onClick={onForgetPassphrase}>
              Forget Saved
            </button>
          </div>
        </div>
      </section>

      {message ? <p className="ffb-toast">{message}</p> : null}

      <section className="ffb-league-grid ffb-league-grid--forms">
        <BidForm
          busy={busyAction === "bid"}
          onSubmit={(draft) => runAction("bid", () => onBid(draft))}
        />
        <MoveForm
          busyAction={busyAction}
          onLineup={(filmId, position) => runAction("lineup", () => onLineup(filmId, position))}
          onSimpleMove={(kind, filmId) => runAction(kind, () => onSimpleMove(kind, filmId))}
        />
        <OscarForm
          busy={busyAction === "oscarPick"}
          onSubmit={(filmId) => runAction("oscarPick", () => onOscarPick(filmId))}
        />
        {profile.playerId === "1" ? (
          <MemberForm
            busy={busyAction === "memberAdd"}
            onSubmit={(email, playerId, label) =>
              runAction("memberAdd", () => onMemberAdd(email, playerId, label))
            }
          />
        ) : null}
        <div className="ffb-panel">
          <p className="ffb-label">Rules sanity</p>
          <h2>Illegal write check</h2>
          <p>Attempts to write to a fake user folder. Firebase should reject it.</p>
          <button type="button" onClick={onTestIllegalWrite} disabled={isTestingRules}>
            {isTestingRules ? "Testing" : "Test illegal write"}
          </button>
        </div>
      </section>

      <section className="ffb-log" aria-labelledby="log-title">
        <div className="ffb-universe-head">
          <div>
            <p className="ffb-label">Shared log</p>
            <h2 id="log-title">Transactions</h2>
          </div>
          <span>{transactions.length}</span>
        </div>
        <div className="ffb-log-list">
          {transactions.length > 0 ? (
            transactions
              .slice()
              .reverse()
              .map((transaction) => (
                <article className="ffb-log-item" key={transaction.txnId}>
                  <p className="ffb-log-meta">
                    {transaction.txnId} · {formatDate(transaction.createdAt)}
                  </p>
                  <h3>{transactionText(transaction, transactions, now)}</h3>
                </article>
              ))
          ) : (
            <p className="ffb-muted">No league transactions yet.</p>
          )}
        </div>
      </section>

      <section className="ffb-log" aria-labelledby="own-log-title">
        <div className="ffb-universe-head">
          <div>
            <p className="ffb-label">Your folder</p>
            <h2 id="own-log-title">Raw player log</h2>
          </div>
          <span>{ownTransactions.length}</span>
        </div>
        <pre>{JSON.stringify(ownTransactions, null, 2)}</pre>
      </section>
    </>
  );
}

function BidForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (draft: {
    amount: number;
    auctionDeadline: number;
    auctionId: string;
    dropFilmId: string | null;
    filmId: string;
  }) => Promise<void>;
}) {
  const [filmId, setFilmId] = useState("");
  const [auctionId, setAuctionId] = useState("");
  const [amount, setAmount] = useState(25);
  const [dropFilmId, setDropFilmId] = useState("");
  const [deadline, setDeadline] = useState(() => toDatetimeLocal(Date.now() + 60 * 60 * 1000));

  async function submit(event: FormEvent) {
    event.preventDefault();
    await onSubmit({
      amount,
      auctionDeadline: new Date(deadline).getTime(),
      auctionId,
      dropFilmId: dropFilmId.trim() || null,
      filmId,
    });
    setFilmId("");
    setAuctionId("");
    setDropFilmId("");
  }

  return (
    <form className="ffb-panel ffb-form" onSubmit={submit}>
      <p className="ffb-label">Sealed bid</p>
      <h2>Commit encrypted payload</h2>
      <label>
        Film id
        <input required value={filmId} onChange={(event) => setFilmId(event.target.value)} />
      </label>
      <label>
        Auction id
        <input required value={auctionId} onChange={(event) => setAuctionId(event.target.value)} />
      </label>
      <label>
        Stub bid
        <input
          min={0}
          required
          type="number"
          value={amount}
          onChange={(event) => setAmount(Number(event.target.value))}
        />
      </label>
      <label>
        Deadline
        <input
          required
          type="datetime-local"
          value={deadline}
          onChange={(event) => setDeadline(event.target.value)}
        />
      </label>
      <label>
        Drop stipulation
        <input value={dropFilmId} onChange={(event) => setDropFilmId(event.target.value)} />
      </label>
      <button className="ffb-primary" disabled={busy} type="submit">
        {busy ? "Committing" : "Commit Bid"}
      </button>
    </form>
  );
}

function MemberForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (email: string, playerId: string, label: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [playerId, setPlayerId] = useState("2");
  const [label, setLabel] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    await onSubmit(email, playerId, label || email.split("@")[0] || `Player ${playerId}`);
    setEmail("");
    setLabel("");
  }

  return (
    <form className="ffb-panel ffb-form" onSubmit={submit}>
      <p className="ffb-label">Commissioner</p>
      <h2>Add league member</h2>
      <label>
        Gmail
        <input
          required
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <label>
        Player id
        <select value={playerId} onChange={(event) => setPlayerId(event.target.value)}>
          <option value="2">2</option>
          <option value="3">3</option>
          <option value="4">4</option>
          <option value="5">5</option>
          <option value="6">6</option>
        </select>
      </label>
      <label>
        Display label
        <input value={label} onChange={(event) => setLabel(event.target.value)} />
      </label>
      <button className="ffb-primary" disabled={busy} type="submit">
        {busy ? "Adding" : "Add Member"}
      </button>
    </form>
  );
}

function OscarForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (filmId: string) => Promise<void>;
}) {
  const [filmId, setFilmId] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    await onSubmit(filmId);
    setFilmId("");
  }

  return (
    <form className="ffb-panel ffb-form" onSubmit={submit}>
      <p className="ffb-label">Oscar postseason</p>
      <h2>Record Oscar pick</h2>
      <p>After nominations, each player logs one nominated film. Awards won decide playoffs.</p>
      <label>
        Nominated film id
        <input required value={filmId} onChange={(event) => setFilmId(event.target.value)} />
      </label>
      <button className="ffb-primary" disabled={busy} type="submit">
        {busy ? "Recording" : "Record Pick"}
      </button>
    </form>
  );
}

function MoveForm({
  busyAction,
  onLineup,
  onSimpleMove,
}: {
  busyAction: string | null;
  onLineup: (filmId: string, position: string) => Promise<void>;
  onSimpleMove: (kind: "pickup" | "drop", filmId: string) => Promise<void>;
}) {
  const [filmId, setFilmId] = useState("");
  const [positionFilmId, setPositionFilmId] = useState("");
  const [position, setPosition] = useState("Packed House");

  return (
    <div className="ffb-panel ffb-form">
      <p className="ffb-label">Operations</p>
      <h2>Write to your log</h2>
      <label>
        Film id
        <input value={filmId} onChange={(event) => setFilmId(event.target.value)} />
      </label>
      <div className="ffb-actions">
        <button
          disabled={!filmId || busyAction === "pickup"}
          type="button"
          onClick={() => onSimpleMove("pickup", filmId)}
        >
          {busyAction === "pickup" ? "Picking Up" : "Pickup"}
        </button>
        <button
          disabled={!filmId || busyAction === "drop"}
          type="button"
          onClick={() => onSimpleMove("drop", filmId)}
        >
          {busyAction === "drop" ? "Dropping" : "Drop"}
        </button>
      </div>
      <label>
        Postered film id
        <input value={positionFilmId} onChange={(event) => setPositionFilmId(event.target.value)} />
      </label>
      <label>
        Position
        <select value={position} onChange={(event) => setPosition(event.target.value)}>
          <option>Packed House</option>
          <option>Budget Alchemy</option>
          <option>Cult Furnace</option>
          <option>Rotten Crowd</option>
          <option>Tiny Thunder</option>
          <option>Disasterpiece</option>
        </select>
      </label>
      <button
        className="ffb-primary"
        disabled={!positionFilmId || busyAction === "lineup"}
        type="button"
        onClick={() => onLineup(positionFilmId, position)}
      >
        {busyAction === "lineup" ? "Saving" : "Save Lineup"}
      </button>
    </div>
  );
}

function transactionText(
  transaction: LeagueTransaction,
  transactions: LeagueTransaction[],
  now: number,
) {
  const reveals = getRevealMap(transactions);

  if (transaction.kind === "bidCommit") {
    const reveal = reveals.get(transaction.txnId);
    if (reveal) {
      return `${transaction.playerLabel} bid ${reveal.payload.amount} stubs on ${reveal.payload.filmId}.`;
    }

    if (transaction.auctionDeadline + transaction.revealGraceMs < now) {
      return `${transaction.playerLabel} failed to reveal bid ${transaction.txnId}; ${UNREVEALED_PENALTY}-stub penalty applies.`;
    }

    return `${transaction.playerLabel} placed a sealed bid ${transaction.txnId}.`;
  }

  if (transaction.kind === "bidReveal") {
    return `${transaction.playerLabel} revealed bid ${transaction.revealForTxnId} for ${transaction.payload.filmId}.`;
  }

  if (transaction.kind === "pickup") {
    return `${transaction.playerLabel} picked up ${transaction.filmId}.`;
  }

  if (transaction.kind === "drop") {
    return `${transaction.playerLabel} dropped ${transaction.filmId}; 48-hour waiver begins.`;
  }

  if (transaction.kind === "oscarPick") {
    return `${transaction.playerLabel} drafted ${transaction.filmId} for the Oscar postseason.`;
  }

  if (transaction.kind === "memberAdd") {
    return `${transaction.playerLabel} added ${transaction.memberLabel} as player ${transaction.memberPlayerId}.`;
  }

  if (transaction.kind === "scoringRules") {
    return `${transaction.playerLabel} published ${transaction.rules.positions.length} scoring positions for ${transaction.rules.season}.`;
  }

  if (transaction.kind === "lineup") {
    return `${transaction.playerLabel} assigned ${transaction.filmId} to ${transaction.position}.`;
  }

  return `${transaction.playerLabel} logged ${transaction.txnId}.`;
}
