/// <reference lib="dom" />

const DB_NAME = "image-metahub-preferences";
const DB_VERSION = 5;
const STORE_NAME = "folderPreferences";

export interface FolderPreference {
  path: string; // The absolute path of the folder, used as the key
  color?: string; // The hex color code
}

let isPersistenceDisabled = false;

const getIndexedDB = () => {
  if (typeof indexedDB === "undefined") {
    if (!isPersistenceDisabled) {
      console.warn(
        "IndexedDB is not available in this environment. Folder preferences persistence is disabled.",
      );
      isPersistenceDisabled = true;
    }
    return null;
  }
  return indexedDB;
};

async function openDatabase(): Promise<IDBDatabase | null> {
  if (isPersistenceDisabled) {
    return null;
  }

  const idb = getIndexedDB();
  if (!idb) {
    return null;
  }

  return new Promise<IDBDatabase | null>((resolve) => {
    const request = idb.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "path" });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      console.error("Failed to open folder preferences storage", request.error);
      resolve(null);
    };
  });
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
