# FantasyFilmBall

Vite React app for a Firebase-hosted fantasy film scoreboard.

## Local Development

```sh
npm install
npm run dev
```

When running locally, set the standard `VITE_FIREBASE_*` variables if you want
to exercise Google Auth and Realtime Database. Deployed Firebase Hosting uses
`/__/firebase/init.json`, so the GitHub workflow only needs the service account
secret used by the deployment script.

For local deploys, place the service account JSON at `../SA_KEY.json` from this
app directory, which is the repo root `SA_KEY.json`. That file is gitignored.

## Routes

- `/` shows Google sign-in, then the Firebase database universe and your own
  timestamped counter.
- `/league` shows placeholder league text.
