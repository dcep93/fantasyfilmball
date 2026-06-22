# FantasyFilmBall Snapshot State Design

## Status

Approved design for adding a static 2026 movie file, a pure league-state derivation engine, and validated peer snapshots. The app remains a no-custom-backend Firebase Realtime Database app. Static movie files are the final data update model; there is no movie data admin UI. The anti-cheat model remains social trust, Firebase folder ownership, and transparent logs.

## Goals

FantasyFilmBall should render a league quickly while preserving logs as the source of truth. Any active player may store a derived snapshot in their own Firebase folder. Other clients may use that snapshot as a cache if it validates against the commissioner league object, static movie data, active member set, and transaction watermarks.

The app must always be able to regenerate league state from scratch by replaying the commissioner league object, static movie file, and all active member transaction logs.

The first implementation should cover regular-season market and roster state only. Final scoring and postseason allocation remain TODOs.

## Non-Goals

This design does not add a backend, Cloud Functions, server-side adjudication, or a movie data admin UI.

This design does not try to provide robust anti-cheat. A player who can inspect app code and Firebase data can understand how the app works. The app should make moves auditable and avoid casual mistakes, not create a hostile security model for a friend league.

This design does not implement the final scoring engine or postseason Oscar engine. Those should be represented in derived state as explicit TODO or unavailable sections.

## Static Movie File

Add a static file for tracked 2026 films:

```text
app/public/movie_charts/2026/tracked_movies_2026.json
```

The file should include real data for new theatrical feature releases only:

- released 2026 domestic films with public box office reporting;
- future 2026 domestic theatrical releases with announced release dates;
- wide releases and notable limited theatrical feature releases;
- no re-releases, anniversary screenings, festival-only screenings, Fathom/event-only screenings, concert events, or other non-feature events.

Use best judgment to avoid noise while still covering movies that a league would reasonably track. Unknown values must be `null`, not guessed.

Each movie record should use stable ids and durable fields:

```json
{
  "id": "toy-story-5",
  "title": "Toy Story 5",
  "releaseDate": "2026-06-19",
  "domesticGross": 160000000,
  "productionBudget": 250000000,
  "letterboxdSlug": "film/toy-story-5",
  "letterboxdAverage": 3.7,
  "letterboxdRatingCount": 12345,
  "sourceNotes": ["box-office-mojo", "letterboxd"],
  "updatedAt": "2026-06-22"
}
```

The top-level file should include metadata:

```json
{
  "schemaVersion": 1,
  "season": 2026,
  "movieDataVersion": "2026-06-22",
  "updatedAt": "2026-06-22",
  "movies": []
}
```

The `movieDataVersion` is part of snapshot validation. When the static file changes, old snapshots with a different movie data version are invalid and should be regenerated from logs.

## Data Sources

The initial file should be built from public sources such as Box Office Mojo domestic year and calendar pages, The Numbers domestic box office reporting, and Letterboxd film pages or API-compatible public data when reasonably available.

Letterboxd fields are enrichment. The movie remains tracked if Letterboxd data is missing. Missing Letterboxd data should be stored as `null`.

## Membership Key

The real league identity is `(commissionerUid, leagueId)`. The `membershipKey` is a deterministic internal map key:

```text
${commissionerUid}__${leagueId}
```

It is used under each user's folder for league pointers, transaction logs, and snapshots:

```text
users/$uid/leagueMemberships/$membershipKey
users/$uid/transactions/$membershipKey
users/$uid/snapshots/$membershipKey
```

The key is not user-facing. It prevents collisions when multiple commissioners use the same human league id, such as `defaultLeagueId`.

## Source Of Truth

The source of truth for league state is:

1. the commissioner-owned league object;
2. the static movie file for the season;
3. all active member transaction logs.

Snapshots are caches only. They may be stale, missing, malformed, or wrong. If a snapshot does not validate, the client must ignore it and regenerate from source data.

## Snapshot Location

Any active league member may write snapshots under their own Firebase folder:

```text
users/$uid/snapshots/$membershipKey/$snapshotId
```

The commissioner writes the initial snapshot when the league is created. When another player renders the league, that player may write a newer snapshot in their own folder if the derived state changed.

The Firebase rules already allow users to write only their own folders. This design works within that constraint.

## Snapshot Shape

A snapshot should include enough metadata to validate it and enough derived state to render the league without replaying all logs every time:

```json
{
  "schemaVersion": 1,
  "leagueId": "defaultLeagueId",
  "commissionerUid": "abc123",
  "membershipKey": "abc123__defaultLeagueId",
  "season": 2026,
  "movieDataVersion": "2026-06-22",
  "generatedAt": 1782066096342,
  "generatedByUid": "playerUid",
  "activeMemberUids": ["abc123", "playerUid"],
  "transactionWatermarks": {
    "abc123": {
      "count": 2,
      "latestTxnId": "1.2",
      "latestCreatedAt": 1782066096342
    }
  },
  "state": {
    "movies": {},
    "players": {},
    "auctions": {},
    "invalidTransactions": [],
    "todos": {
      "finalScoring": "not-implemented",
      "postseason": "not-implemented"
    }
  }
}
```

Use map shapes for derived movie, player, and auction state so UI lookup is simple and deterministic.

## Snapshot Validation

Before using a peer snapshot, validate:

- schema version matches the current app snapshot schema;
- commissioner uid, league id, membership key, and season match the selected league;
- movie data version matches the loaded static movie file;
- active member uid set matches the current commissioner league object;
- transaction watermarks do not reference unknown players;
- transaction watermarks do not exceed the actual readable logs;
- required top-level state fields are present;
- no clock-derived state is impossible for the current timestamp.

If validation fails, discard the snapshot and try the next newest snapshot. If no snapshot validates, regenerate from all logs.

## Render-Time Flow

When rendering a league:

1. Load the commissioner league object, active member list, static movie file, and all active member transaction logs.
2. Read snapshots for the selected `membershipKey` from active member folders.
3. Choose the newest valid snapshot by `generatedAt`.
4. Replay transactions that occur after the chosen snapshot's watermarks.
5. Apply clock-derived transitions:
   - initial auctions open at 6:00 PM ET on the date 60 days before release;
   - dropped unreleased films enter a 48-hour waiver auction;
   - films become released and locked on their first eligible US/Canada theatrical release date.
6. If no snapshot validates, derive from scratch by applying all logs to an initial state.
7. If replay or clock transitions change the state, write a new snapshot under the current user's folder.

The write should be best-effort. If snapshot writing fails, the app can still render the derived state.

## Derived State

The derived state engine should be pure and independent from React and Firebase. It should accept plain objects and return plain objects.

It should derive:

- tracked movie statuses: future, auction pending, auction open, free agent, waiver, owned, released;
- active auction state for 60-day initial auctions;
- waiver auction state after drops;
- current theater holdings by player;
- released/locked status for owned films;
- stub balances, including operation fees;
- invalid transaction explanations;
- transaction watermarks by player;
- TODO placeholders for final scoring and postseason.

Transactions should be processed in deterministic order: created timestamp first, then player id, then transaction id. Invalid transactions should not mutate state, but should be preserved in `invalidTransactions` with an explanation.

## Transaction Rules For This Phase

This phase should validate enough operations to make the league console useful:

- Bid transactions cost 1 stub.
- Pickup transactions cost 1 stub and are valid only for unowned free-agent films.
- Drop transactions cost 1 stub and are valid only for films owned by the player and not yet released.
- Dropping an unreleased film creates a 48-hour waiver auction.
- Released films remain locked in the player's theater.
- A player's theater cannot exceed the league's configured max theater size.
- A bid with a drop stipulation is valid only if the named drop film is owned by the bidder and unreleased.

Final auction award mechanics should be implemented for regular-season market state. Final scoring and postseason remain TODO.

## UI Integration

The league console should render from derived snapshot state rather than raw logs where possible. It should still show the shared transaction log for transparency.

The UI should show:

- the loaded snapshot source: current user, peer, commissioner, or regenerated;
- whether the app saved a newer snapshot;
- player theaters and stubs;
- current auctions, waivers, and free agents;
- invalid transaction warnings.

The existing debug route may continue to show raw Firebase data.

## Tests

Add a JavaScript/TypeScript test runner such as Vitest. Tests should target pure functions, not Firebase or React rendering.

Required tests:

- static movie parsing accepts valid records and rejects malformed records;
- 60-day auction opens at the correct 6:00 PM ET boundary;
- future films remain pending before auction time;
- released films become locked;
- bid, pickup, and drop fees reduce stubs;
- pickups fail when the film is not a free agent;
- drops fail when the film is released or not owned by the player;
- waiver auctions are created for valid drops;
- newest valid peer snapshot is selected;
- invalid snapshots are rejected for movie data version mismatch;
- invalid snapshots are rejected for transaction watermarks beyond actual logs;
- missing transactions after a snapshot are replayed;
- clock-only changes produce a recommendation to write a new snapshot;
- from-scratch regeneration produces the same state as a valid snapshot plus replayed transactions.

## Implementation Boundaries

Suggested module boundaries:

- `movieData.ts`: static movie schema, parsing, validation, and fetch helper.
- `leagueState.ts`: pure state derivation from league object, movie file, logs, and timestamp.
- `leagueSnapshots.ts`: snapshot validation, selection, replay planning, and write recommendation.
- `LeagueConsole.tsx`: React integration and UI rendering only.

Keep final scoring and postseason in explicit TODO fields so they cannot be mistaken for implemented behavior.
