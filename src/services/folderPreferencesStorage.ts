/// <reference lib="dom" />

import { openDatabase, isPersistenceDisabled } from './folderSelectionStorage';

const STORE_NAME = "folderPreferences";

export interface FolderPreference {
  path: string; // The absolute path of the folder, used as the key
  emoji?: string; // The emoji
}

export async function loadFolderPreferences(): Promise<FolderPreference[]> {
  const db = await openDatabase();
  if (!db) {
    return [];
  }

  return new Promise((resolve) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
      resolve(request.result || []);
    };

    request.onerror = () => {
      console.error("Failed to load folder preferences", request.error);
      resolve([]);
    };
  });
}

export async function saveFolderPreference(
  pref: FolderPreference,
): Promise<void> {
  const db = await openDatabase();
  if (!db) {
    return;
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(pref);

    request.onsuccess = () => resolve();
    request.onerror = () => {
      console.error("Failed to save folder preference", request.error);
      reject(request.error);
    };
  });
}

export async function deleteFolderPreference(path: string): Promise<void> {
  const db = await openDatabase();
  if (!db) {
    return;
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(path);

    request.onsuccess = () => resolve();
    request.onerror = () => {
      console.error("Failed to delete folder preference", request.error);
      reject(request.error);
    };
  });
}
