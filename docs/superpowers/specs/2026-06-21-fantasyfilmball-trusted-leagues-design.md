# FantasyFilmBall Trusted League Redesign

## Status

Approved design for replacing the earlier passphrase and commit-reveal model with a simpler trust-based MVP. The app still uses Firebase Realtime Database with no custom backend and preserves the rule that each signed-in user can write only to their own Firebase folder.

## Goals

FantasyFilmBall should feel like a friendly league tool, not a cryptography project. Users are trusted not to inspect raw database contents for active bids. The app should prevent casual spoilers by storing active bid details in an obfuscated reversible form, then reveal the decoded details in the UI after an auction has finished.

The redesign also makes league ownership explicit. A commissioner owns one or more league objects inside their own Firebase user folder. Players store pointers to leagues they are in or want to join. Player ids are assigned facts inside the commissioner-owned league object, not self-declared facts inside each player profile.

## Non-Goals

This MVP does not provide real bid secrecy from a motivated user who can inspect the frontend code and database. Casual obfuscation is a spoiler curtain, not a security boundary.

The app does not use passphrases, bid reveals, reveal penalties, 48-hour reveal grace periods, private bid keys, Cloud Functions, or a custom server.

The repository does not include commissioner UIDs. League discovery happens from Firebase data.

## Firebase Ownership Model

Top-level Firebase data remains user-owned:

```json
{
  "users": {
    "$uid": {
      "email": "player@gmail.com",
      "displayName": "Player",
      "leagueMemberships": {
        "abc123__defaultLeagueId": {
          "leagueId": "defaultLeagueId",
          "commissionerUid": "abc123",
          "status": "requested",
          "requestedAt": 1782066096342,
          "updatedAt": 1782066096342
        }
      },
      "leagues": {
        "defaultLeagueId": {
          "leagueId": "defaultLeagueId",
          "name": "FantasyFilmBall",
          "season": 2026,
          "commissionerUid": "$uid",
          "createdAt": 1782066096342,
          "updatedAt": 1782066096342,
          "members": {
            "$uid": {
              "email": "commissioner@gmail.com",
              "label": "Daniel",
              "playerId": "1",
              "status": "active",
              "joinedAt": 1782066096342
            }
          },
          "kicked": {},
          "scoring": {
            "positions": []
          },
          "config": {
            "startingStubs": 1000,
            "maxPlayers": 6,
            "maxTheaterSize": 10,
            "regularSeasonStart": "2026-05-01",
            "regularSeasonEnd": "2026-08-31"
          }
        }
      },
      "transactions": {
        "abc123__defaultLeagueId": {}
      }
    }
  }
}
```

Each user can write only to `users/$uid`. The commissioner cannot directly write to another player's folder. A commissioner records league decisions under `users/$commissionerUid/leagues/$leagueId`. A player records their own bids, roster moves, and league membership pointers under their own folder.

The real unique league key is `(commissionerUid, leagueId)`. The human default league id is `defaultLeagueId`, but multiple commissioners may create leagues with that same id. When the app needs a Firebase map key for a player's membership or transaction log, it should use a deterministic membership key derived from both values, such as `${commissionerUid}__${leagueId}`.

## League Creation

A signed-in user can start a league. For MVP, the default league id is `defaultLeagueId`.

When a user starts a league, the app writes `users/$uid/leagues/defaultLeagueId` with:

- `leagueId: "defaultLeagueId"`.
- `commissionerUid: auth.uid`.
- `season: currentYear`, based on the browser's current year.
- `name`, stored in the Firebase league object and editable by the commissioner.
- the commissioner as an active member with `playerId: "1"`.
- default league config.
- default scoring positions and formulas.

The app should allow the same user to be commissioner of multiple leagues. The data model should not assume only one league per commissioner.

## League Discovery And Joining

A player joins by league id:

1. User enters `defaultLeagueId`.
2. App scans readable `users/*/leagues/defaultLeagueId` objects.
3. If there is one match, the app shows that league.
4. If there are multiple matches, the app shows a picker with league name, commissioner email or label, season, and created date.
5. User requests to join a chosen `(commissionerUid, leagueId)`.
6. The request is written to the player's own `leagueMemberships/$membershipKey` entry with `status: "requested"` and the chosen `commissionerUid`.

The commissioner sees join requests by scanning player membership pointers that reference their league. The commissioner can accept a request by adding that user to their league object's `members` map and assigning a player id and label. The commissioner can reject by leaving the request untouched or marking the user as kicked if they should be blocked.

If a commissioner kicks a player, the commissioner writes that member's status as `kicked` in the league object and records the user in the league's `kicked` map. A kicked user is ineligible to rejoin that `(commissionerUid, leagueId)`.

## Commissioner Authority

Commissioner authority comes from ownership of the league object, not from a self-declared player id. If a league object lives under `users/$uid/leagues/$leagueId`, then `$uid` is the commissioner for that league.

Player ids are assigned in the commissioner-owned league object:

```json
{
  "members": {
    "$memberUid": {
      "playerId": "3",
      "email": "player@gmail.com",
      "label": "Jim",
      "status": "active"
    }
  }
}
```

Clients must ignore player id claims from player-owned membership pointers when determining authority. A user's own folder may say what leagues they are in, but the commissioner-owned league object decides whether that user is an active member and what player id they have.

## Commissioner Actions

Commissioners can:

- create a league;
- edit league name;
- accept join requests;
- assign player ids and labels;
- kick players;
- edit scoring positions and formulas;
- edit league config fields that are part of the MVP.

"Set season-specific scoring rules" and "edit scoring positions/formulas" mean the same thing. The product should use the clearer phrase "edit scoring positions and formulas."

Commissioner writes still go only to the commissioner's own Firebase folder.

## Player Actions

Players can:

- request to join a league;
- leave a league from their own membership pointer;
- submit bids;
- edit bids before the auction deadline;
- withdraw bids before the auction deadline;
- pick up eligible free agents;
- drop unpostered films;
- propose or accept supported trades;
- assign postered films to scoring positions;
- record an Oscar postseason pick when that stage is available.

Player actions are written to `users/$playerUid/transactions/$membershipKey`, where `$membershipKey` is derived from `(commissionerUid, leagueId)`. The current league state is derived by reading the commissioner league object and all member transaction logs.

## Bid Storage

Bids are no longer encrypted with a user passphrase and no longer require reveal transactions.

A bid transaction contains public metadata and an obfuscated payload:

```json
{
  "kind": "bid",
  "txnId": "2.14",
  "createdAt": 1782066096342,
  "auctionId": "auction:film123",
  "auctionDeadline": 1782100800000,
  "obfuscatedPayload": "v1:...",
  "publicText": "Jim placed bid 2.14"
}
```

The decoded payload includes:

```json
{
  "filmId": "film123",
  "amount": 72,
  "dropFilmId": "film456",
  "submittedAt": 1782066096342
}
```

The app should use casual reversible obfuscation. A reasonable MVP implementation is:

1. canonical JSON stringify of the bid payload;
2. derive a repeated byte mask from public values such as `leagueId`, `commissionerUid`, `auctionId`, `txnId`, and app version;
3. XOR UTF-8 payload bytes with the mask;
4. base64url encode the result with a version prefix.

This is not cryptographic secrecy. It prevents accidental spoilers when someone opens the database and sees raw JSON. A motivated user can decode active bids by inspecting the frontend code.

## Bid Visibility

Before the auction deadline, the UI shows only:

- player label;
- transaction id;
- action type, such as placed, edited, or withdrew bid;
- timestamp.

It must not show film id, amount, or drop stipulation for active auctions.

After the auction deadline, the UI decodes and displays bid details. No player action is required. There is no reveal grace period and no unrevealed-bid penalty.

Editing a bid before deadline costs 1 stub and replaces the player's current bid for that auction in derived state. Ties are broken by earliest current bid timestamp. Editing resets tie priority.

## Scoring Rules Page

The scoring rules page is tied to a selected `(commissionerUid, leagueId)`.

Everyone who can read the database can view the active scoring positions and formulas. Only the commissioner of that selected league can edit scoring positions and formulas.

The page shows a table of the top 25 films from last year's movie data for each active position. Tables use the same formula evaluator as the scoring UI. Formula inputs remain:

- `G`: domestic US/Canada gross divided by 100,000,000.
- `B`: production budget divided by 100,000,000.
- `A`: Letterboxd average.
- `R`: Letterboxd rating count divided by 100,000.

Formula editing remains true-value based. The system should not use min-max normalization for position formulas.

## Static Data

Static files supplied through the repository provide real-world movie and Oscar details. The user will periodically update:

- movie ids;
- titles;
- release dates;
- domestic US/Canada box office;
- budgets;
- Letterboxd averages;
- Letterboxd rating counts;
- Oscar nominees;
- Oscar winners.

The app should treat static movie and Oscar files as authoritative real-world inputs. Commissioners do not manually enter box office, Letterboxd, or Oscar result data in Firebase.

## Routes

- `/`: public rulebook landing page. It must remove passphrase, reveal, and 48-hour grace-period language.
- `/league`: public movie charts.
- `/app`: signed-in league dashboard with league picker, start league, join request, roster operations, and bid tools.
- `/scoring`: signed-in scoring rules page for the selected league.
- `/debug`: signed-in raw Firebase universe console.

If a signed-in user has no selected league, `/app` and `/scoring` should show league discovery/start controls before league-specific controls.

## Migration

No migration is required. Existing passphrase, bid commit, and bid reveal data can be ignored by the new MVP implementation.

The implementation should remove or stop using:

- passphrase gate;
- localStorage passphrase storage;
- bid key derivation;
- encrypted bid payloads;
- bid commit transactions;
- bid reveal transactions;
- reveal grace logic;
- unrevealed-bid penalties.

## Risks And Tradeoffs

The database rules still allow a user to rewrite their own folder. This MVP relies on trust among friends and client-side replay. It is suitable for a casual private league, not an adversarial cash game.

Casual bid obfuscation is intentionally weak. The landing page and any developer-facing notes should not imply active bids are secure from determined inspection.

Commissioner-owned league objects solve the fake-commissioner problem without committing commissioner UIDs to the repository. The tradeoff is that duplicate human league ids can exist, so the app must support a league picker.
