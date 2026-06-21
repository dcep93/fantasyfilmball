# FantasyFilmBall League Design

## Status

Approved design for the full FantasyFilmBall app scope. The first implementation priority is the landing page, which should explain the game precisely enough for a new player to understand the league without separate instructions.

## Product Shape

FantasyFilmBall is a no-custom-backend summer movie fantasy league for 6 friends. Players draft, bid on, trade, drop, and slot theatrical films into a 10-film theater. The season uses domestic US/Canada theatrical releases from May 1 through August 31. Real-world movie data is supplied through static files that the commissioner updates from time to time.

The app uses Firebase Realtime Database only as a shared per-user log store. It has no chat, no custom server, no Cloud Functions, and no hidden centralized league state. League state is derived in the client by replaying static season files and player operation logs.

## Landing Page

The landing page is the most important v1 surface. It should be a clear rulebook-first page, roughly 1000 words, with precise language and inline tooltips for terms that deserve extra explanation. It should not be vague marketing copy.

The landing page should include these sections:

1. Hero and league summary
   - Title: FantasyFilmBall.
   - Summary: a no-backend summer movie fantasy league where friends draft films, bid stubs, fill theaters, and score from real US/Canada theatrical results.
   - Primary actions: enter league, view movie charts.
   - At-a-glance rules: 6 players, May 1-August 31, 10-film theater, 6 scoring positions, 1000 starting stubs.

2. How the season works
   - Domestic US/Canada theatrical releases only.
   - Preseason snake draft is 6 rounds and picks are free.
   - Players can hold at most 10 films in their theater.
   - Films poster on first US/Canada theatrical release date.
   - Postered films lock and can no longer be dropped or traded.
   - At season end, each player assigns 6 postered films to 6 scoring positions.

3. Stubs
   - Stubs are both currency and score.
   - Each season resets all players to 1000 starting stubs.
   - Most operations cost 1 stub.
   - Position payouts add stubs.
   - Highest final stub total wins the summer season.

4. Bidding and auctions
   - Films become auction eligible exactly 60 days before release.
   - Initial auction bid deadline is 6:00 PM ET on that day.
   - The 48-hour reveal window starts at the bid deadline.
   - Each player can have one active bid per film.
   - Submitting, editing, or withdrawing a bid costs 1 stub.
   - Active bid public logs reveal only bid activity and transaction ids, not film, amount, or stipulations.
   - Ties are broken by earliest current bid timestamp.

5. Privacy and passphrase
   - Google login identifies the player.
   - A player-managed passphrase unlocks encrypted bid payloads.
   - The app verifies the passphrase locally without knowing it.
   - The app may store the passphrase in localStorage if the user enables that convenience.
   - A saved passphrase can be shown or forgotten on request.
   - Private league content is blocked until passphrase verification and due auto-reveals complete.

6. Reveals and penalties
   - Reveals are free.
   - After an auction deadline, players have 48 hours to reveal active bids.
   - On login, the app auto-reveals any due bids that the user can decrypt.
   - Unrevealed active bids after 48 hours are invalid and cost an additional 25 stubs.
   - Original bid/edit/withdraw fees remain spent.

7. Roster operations
   - Free-agent pickup is first-come-first-served for 1 stub.
   - Only unowned films inside their 60-day window, with no pending waiver, can be picked up as free agents.
   - Dropping an unpostered film costs 1 stub and creates a 48-hour waiver auction.
   - Released/postered films cannot be dropped or traded.
   - The app warns users before actions that would invalidate outstanding bids.

8. Trades
   - Trades execute immediately once accepted.
   - No veto window.
   - No expiration.
   - Proposing a trade costs 1 stub.
   - Accepting a trade is free for the acceptor.
   - Canceling your own offer costs 1 stub.
   - Declining is free.
   - Trades can be one film for one film, one film for stubs, or stubs for one film.
   - No 2-for-1 trades and no pure stubs-for-stubs trades.
   - Only unpostered films can be traded.

9. Positions and scoring
   - Commissioner defines 6 positions and formulas for each season in static files.
   - Each player assigns one postered film to each position.
   - Each postered film can be used in at most one position.
   - Saving a changed lineup costs 1 stub.
   - Position setup UI should show the top 10 or top 20 films from last year as reference data.

10. Ledger
   - Every operation creates a transaction.
   - Transaction ids use `x.y`, where `x` is the player id in the league and `y` is that player's transaction index.
   - Logs are append-only in spirit.
   - Active bid entries hide film and amount.
   - Ended/revealed auctions unlock full bid details.

Tooltip terms:

- Theater: the player's roster of up to 10 films.
- Postered: a film has released and is locked in the theater.
- Stub: the league currency and final score unit.
- Commitment: a hash proving a hidden bid was fixed before reveal.
- Reveal: publishing a bid payload so everyone can verify it.
- Free agent: an unowned film inside its 60-day window with no pending waiver.
- Waiver: a 48-hour blind auction caused by a dropped unpostered film.
- Position: one scoring slot where a postered film earns stubs from a formula.

## Season Rules

- League size: 6 players.
- Season dates: May 1 through August 31.
- Market: domestic US/Canada theatrical releases only.
- Starting budget: 1000 stubs per player, reset every season.
- Theater size: 10 films.
- Scoring lineup size: 6 positions.
- Preseason draft: 6-round snake draft. Draft picks are free.
- Films poster on first US/Canada theatrical release date.
- Postered films are locked.
- The summer season is v1. Oscar postseason is out of scope for initial implementation.

## Operations And Fees

Views are free. Static public movie charts are free. The app has no chat.

Roster and league-state operations cost stubs:

- Submit bid: 1 stub.
- Edit bid: 1 stub.
- Withdraw bid: 1 stub.
- Free-agent pickup: 1 stub.
- Drop unpostered film: 1 stub.
- Propose trade: 1 stub.
- Accept trade: free for acceptor.
- Decline trade: free.
- Cancel own trade offer: 1 stub.
- Save changed scoring lineup: 1 stub.
- Reveal bid: free.
- Fail to reveal active bid within 48 hours: 25 stub penalty.

Fees are burned, not paid to another player.

## Static Data

The commissioner updates static files in the repository. Static data should include:

- Season configuration.
- Player order and player ids.
- Film ids, titles, release dates, eligibility dates, and status.
- Domestic US/Canada box office data.
- Letterboxd rating average and rating count.
- Position definitions, subtitles, formulas, and reference rankings.
- Draft configuration and any commissioner-controlled lock dates.

The client must treat static files as authoritative real-world data.

## Firebase Data Model

Firebase Realtime Database stores user-owned data, not centralized league truth.

Suggested top-level shape:

```json
{
  "players": {
    "$uid": {
      "profile": {
        "leaguePlayerId": "3",
        "email": "player@gmail.com",
        "displayName": "Player Name",
        "updatedAt": 1782066096342
      },
      "bidKey": {
        "version": "v1",
        "userSalt": "...",
        "verifier": {
          "algorithm": "AES-GCM",
          "iv": "...",
          "ciphertext": "..."
        }
      },
      "log": {
        "3.17": {
          "type": "bid.commit",
          "createdAt": 1782066096342,
          "commitment": "...",
          "encryptedPayload": "...",
          "publicText": "Player submitted bid 3.17"
        }
      }
    }
  }
}
```

Security rules should preserve the existing principle: users can read league data, but can only write to their own folder while logged in with verified Google/Gmail auth and correct timestamp rules.

## Passphrase And Bid Vault

Users manage a bid passphrase.

Initial setup:

1. User signs in with Google.
2. User enters passphrase.
3. App generates a random `userSalt`.
4. App derives a bid key locally:
   `bidKey = KDF(passphrase, firebaseUid + gmail + userSalt)`.
5. App stores `userSalt` and an encrypted verifier.
6. App does not send or store the passphrase unless the user enables localStorage storage.

Verification:

1. User enters passphrase or uses saved localStorage passphrase.
2. App derives candidate bid key.
3. App decrypts verifier.
4. If plaintext matches expected verifier, passphrase is accepted.
5. App keeps key in memory for the session.

Local storage:

- Offer "Remember passphrase on this device."
- If enabled, store passphrase in localStorage.
- Provide "Show saved passphrase."
- Provide "Forget saved passphrase."
- Explain that localStorage is convenience storage on that device, not secure recovery.

Private league contents remain hidden until passphrase verification completes and due reveals are attempted.

## Bid Commit-Reveal

Public active bid entries must not reveal the film id, auction id, bid amount, or drop stipulation.

Canonical bid payload includes:

```json
{
  "version": "v1",
  "transactionId": "3.17",
  "leagueId": "summer-2026",
  "playerId": "3",
  "filmId": "film/sinners-2025",
  "auctionId": "film/sinners-2025:initial",
  "bidAmount": 87,
  "dropFilmId": "film/optional-drop",
  "createdAt": 1782066096342,
  "salt": "large-random-string"
}
```

Commitment:

```text
commitment = sha256(stableJson(canonicalBidPayload))
```

The encrypted payload is the canonical bid payload encrypted with the user's bid key. It exists so the same user can recover and reveal bids from another device after entering their passphrase.

Reveal:

- Reveal logs publish plaintext canonical payload.
- App verifies hash matches commitment.
- Reveal is free.
- On login after passphrase gate, app automatically reveals any active due bids it can decrypt.
- If reveal window expired, late reveal can be logged for audit, but the bid remains invalid and penalty remains.

Bid validity at settlement:

- Commitment exists.
- Reveal exists within 48-hour reveal window.
- Hash verifies.
- Player has enough stubs.
- Player has theater room, or payload includes a valid unpostered drop film.
- Drop film is still owned by player and unpostered.
- Target film is not already owned by player.
- Player has at most one active bid per film.

Tie-breaker:

- Earliest current bid timestamp wins.
- Editing a bid creates a new transaction and replaces current bid priority.

## Auctions, Free Agents, And Waivers

Initial auction:

- Every film with known US/Canada theatrical release date becomes auction eligible exactly 60 days before release.
- Initial auction bid deadline is 6:00 PM ET on the 60-days-before-release date.
- The auction then enters a 48-hour reveal period.
- After reveal period, valid revealed bids settle deterministically.

Free agents:

- If a film is unowned, inside its 60-day window, and has no pending initial auction or waiver, it can be picked up first-come-first-served for 1 stub.
- User must have theater room.

Dropped films:

- Dropping an unpostered film costs 1 stub.
- Dropped film enters 48-hour waiver.
- Waiver uses the same commit-reveal mechanics.
- If no valid revealed waiver bid wins, the film becomes a free agent.

## Trades

Trades execute immediately on acceptance, with no veto and no expiration.

Allowed trade shapes:

- 1 film for 1 film.
- 1 film for stubs.
- Stubs for 1 film.

Disallowed:

- 2-for-1 or multi-film trades.
- Pure stubs-for-stubs trades.
- Trades involving postered films.

Trade visibility:

- Offers are private to involved players until accepted, declined, canceled, or otherwise final.
- Completed trades are public with full details in the ledger.

## Lineup And Positions

At season end, each player assigns postered films to scoring positions:

- 6 positions per season.
- Exactly one postered film per position.
- Each film can occupy at most one position.
- Saving a changed lineup costs 1 stub.
- Positions are commissioner-defined in static files.
- Position setup UI should show reference top films from previous year's data.

Current proposed position definitions:

```text
G = log10(domestic gross / 1,000,000)
B = log10(budget / 1,000,000)
R = log10(Letterboxd ratings / 1,000)
A = Letterboxd average
```

No min-max normalization. No clamp. No round. Formulas can produce decimals or negative values.

- Packed House: Rewards high domestic gross and high Letterboxd average.
  Formula: `100 * G * (A - 2)`.

- Budget Alchemy: Rewards high domestic gross with a moderate production budget.
  Formula: `250 * G / (1 + abs(B - 2))`.

- Cult Furnace: Rewards high Letterboxd average with substantial rating volume.
  Formula: `150 * (A - 3) * sqrt(R)`.

- Rotten Crowd: Rewards low Letterboxd average with substantial rating volume.
  Formula: `250 * (3 - A) * sqrt(R)`.

- Tiny Thunder: Rewards high Letterboxd average and substantial rating volume despite low domestic gross.
  Preferred formula: `200 * (A - 3) * sqrt(R) / (1 + G)`.
  This is the one approved exception to the two-variable rule because the position requires low gross, high rating, and rating volume to avoid noise.

- Disasterpiece: Rewards low Letterboxd average with high production budget.
  Formula: `175 * B * (3 - A)`.

## Derived State Engine

The client derives state by replaying:

1. Static season data.
2. Player profiles.
3. Player logs ordered by timestamp and transaction id.
4. Bid reveal validations.
5. Auction settlements.
6. Waiver settlements.
7. Trades.
8. Lineup saves.
9. Scoring formulas.

The derived state engine must explain invalid transactions. Examples:

- Insufficient stubs.
- Theater full.
- Bid not revealed.
- Commitment mismatch.
- Drop stipulation invalid.
- Film already postered.
- Film already owned.
- Trade invalid because ownership changed.

## Views

V1 full scope includes:

- Landing page/rulebook.
- Public movie charts.
- Google login.
- Passphrase setup and verification.
- Saved passphrase controls.
- Auto-reveal flow.
- Player theater.
- Draft board and snake draft state.
- Auction list.
- Bid creation/edit/withdraw.
- Free-agent pickup.
- Drop and waiver flow.
- Trade offers.
- Transaction ledger.
- Standings.
- Lineup assignment.
- Position reference rankings.
- Commissioner/static-data documentation.

Out of scope:

- Chat.
- Oscar postseason.
- Custom backend/server functions.

## Open Implementation Notes

- Stable JSON serialization is required for commitments.
- Use Web Crypto APIs for hashing, PBKDF2, and AES-GCM.
- Transaction ids require a deterministic per-player sequence.
- The app should warn users before actions that may invalidate active bids.
- Static data should be versioned so replay remains deterministic across updates.
- The landing page should be implemented before the complex league engine because it is the clearest test of whether the rules are understandable.
