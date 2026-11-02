/* Konfigurasi Firebase untuk edisi cloud PT. Belgindo Raya Inventory.
   Disamakan dengan aplikasi 01 (src/services/firebase.ts): nilai bawaan,
   proyek `belgindoinventory`, dan kunci penyimpanan override yang sama
   (`belgindo_firebase_config` di localStorage) sehingga satu pengaturan
   berlaku untuk kedua aplikasi pada origin yang sama.
   Paket Spark (gratis), tanpa Firebase Auth — akses data dikendalikan
   aturan keamanan firestore.rules yang menyertai paket ini. */

export const DEFAULT_FIREBASE_CONFIG = {
  apiKey: "AIzaSyAkWT1Px2WXmCdrR-c9D0OcwB1RsZhys-4",
  authDomain: "belgindoinventory.firebaseapp.com",
  projectId: "belgindoinventory",
  storageBucket: "belgindoinventory.firebasestorage.app",
  messagingSenderId: "984368216714",
  appId: "1:984368216714:web:b0328fa7d8fae0fef3cb73",
  measurementId: "G-5FEZN7V0HJ",
};

export const CONFIG_STORAGE_KEY = "belgindo_firebase_config";

export function getStoredFirebaseConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.projectId && parsed.apiKey) return parsed;
    }
  } catch (error) {
    console.warn("Error reading stored Firebase config:", error);
  }
  return DEFAULT_FIREBASE_CONFIG;
}

export function saveFirebaseConfig(config) {
  localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
}

export const firebaseConfig = getStoredFirebaseConfig();
