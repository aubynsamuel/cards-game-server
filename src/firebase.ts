import {
  getApps,
  initializeApp,
  App,
  cert,
  ServiceAccount,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import serviceAccount from "../serviceAccountKey.json";

let cachedApp: App | null = null;

export function getFirebaseAdminApp() {
  if (cachedApp) {
    return cachedApp;
  }

  if (getApps().length > 0) {
    cachedApp = getApps()[0]!;
    return cachedApp;
  }

  cachedApp = initializeApp({
    credential: cert(serviceAccount as ServiceAccount),
  });

  return cachedApp;
}

export const firebaseAuth = getAuth(getFirebaseAdminApp());
export const firestore = getFirestore(getFirebaseAdminApp());
