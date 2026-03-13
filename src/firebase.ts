// bot-worker/src/firebase.ts
// Firebase Admin SDK initialization for the bot worker process

import { initializeApp, getApps, cert, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import dotenv from 'dotenv';

dotenv.config();

let app: App | undefined;

export function initFirebase(): Firestore {
  if (app) return getFirestore(app);

  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!base64) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 is not set');
  }

  const serviceAccount = JSON.parse(
    Buffer.from(base64, 'base64').toString('utf-8')
  );

  const existing = getApps().find((a) => a.name === 'bot-worker');
  app =
    existing ||
    initializeApp(
      { credential: cert(serviceAccount) },
      'bot-worker'
    );

  return getFirestore(app);
}
