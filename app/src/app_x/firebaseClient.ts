import { getApps, initializeApp, type FirebaseOptions } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getDatabase, type Database } from "firebase/database";

export type FirebaseClient = {
  auth: Auth;
  database: Database;
  configSource: "hosting" | "vite-env";
};

type HostedConfig = FirebaseOptions & {
  databaseURL?: string;
};

let clientPromise: Promise<FirebaseClient> | null = null;

function readViteConfig(): HostedConfig | null {
  const config = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
    measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  };

  if (!config.apiKey || !config.projectId) {
    return null;
  }

  return config;
}

async function readHostingConfig(): Promise<HostedConfig | null> {
  if (window.location.hostname === "localhost") {
    return null;
  }

  const response = await fetch("/__/firebase/init.json", {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as HostedConfig;
}

async function createFirebaseClient(): Promise<FirebaseClient> {
  const envConfig = readViteConfig();
  const hostedConfig = envConfig ? null : await readHostingConfig();
  const config = envConfig ?? hostedConfig;
  const configSource = envConfig ? "vite-env" : "hosting";

  if (!config) {
    throw new Error(
      "Deploy to Firebase Hosting or set VITE_FIREBASE_API_KEY and VITE_FIREBASE_PROJECT_ID for local development.",
    );
  }

  const app = getApps()[0] ?? initializeApp(config);

  return {
    auth: getAuth(app),
    database: getDatabase(app, config.databaseURL),
    configSource,
  };
}

export function getFirebaseClient(): Promise<FirebaseClient> {
  clientPromise ??= createFirebaseClient();
  return clientPromise;
}
