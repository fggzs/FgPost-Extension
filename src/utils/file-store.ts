/**
 * 本地文件暂存（IndexedDB）。
 * 大文件不能塞进消息通道，改为存本地、发布时按块读取后注入目标页。
 */
const DB_NAME = "fg-post-files";
const STORE_NAME = "files";
const DB_VERSION = 1;

/** 单块大小：4MB 原始数据，base64 后约 5.3MB，消息通道压力可控 */
export const FILE_CHUNK_SIZE = 4 * 1024 * 1024;
/** 暂存文件保留时长，避免长期占用空间 */
export const FILE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface StoredFileMeta {
  id: string;
  name: string;
  type: string;
  size: number;
}

interface StoredFileRecord extends StoredFileMeta {
  blob: Blob;
  createdAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("打开本地文件库失败"));
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  const step = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

export async function putFile(file: File): Promise<StoredFileMeta> {
  const db = await openDb();
  const record: StoredFileRecord = {
    id: crypto.randomUUID(),
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    blob: file,
    createdAt: Date.now(),
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("保存文件失败"));
    });
  } finally {
    db.close();
  }
  return { id: record.id, name: record.name, type: record.type, size: record.size };
}

async function getFileRecord(id: string): Promise<StoredFileRecord | null> {
  const db = await openDb();
  try {
    return await new Promise<StoredFileRecord | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(id);
      request.onsuccess = () => resolve((request.result as StoredFileRecord) ?? null);
      request.onerror = () => reject(request.error ?? new Error("读取文件失败"));
    });
  } finally {
    db.close();
  }
}

/** 读取指定分块，done 为 true 表示已到末尾 */
export async function readFileChunk(
  id: string,
  index: number,
): Promise<{ chunk: string; done: boolean; type: string; name: string } | null> {
  if (!id || index < 0) return null;
  const record = await getFileRecord(id);
  if (!record) return null;

  const start = index * FILE_CHUNK_SIZE;
  if (start >= record.size) {
    return { chunk: "", done: true, type: record.type, name: record.name };
  }

  const end = Math.min(start + FILE_CHUNK_SIZE, record.size);
  const buffer = await record.blob.slice(start, end).arrayBuffer();
  return {
    chunk: bytesToBase64(new Uint8Array(buffer)),
    done: end >= record.size,
    type: record.type,
    name: record.name,
  };
}

export async function deleteFile(id: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("删除文件失败"));
    });
  } finally {
    db.close();
  }
}

/** 清理过期的临时文件 */
export async function pruneFiles(maxAgeMs = FILE_MAX_AGE_MS): Promise<void> {
  try {
    const db = await openDb();
    const expired: string[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const request = tx.objectStore(STORE_NAME).openCursor();
        const deadline = Date.now() - maxAgeMs;
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          const record = cursor.value as StoredFileRecord;
          if (!record.createdAt || record.createdAt < deadline) {
            expired.push(record.id);
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error ?? new Error("扫描文件失败"));
      });
    } finally {
      db.close();
    }
    for (const id of expired) {
      await deleteFile(id);
    }
  } catch (error) {
    console.warn("清理临时文件失败", error);
  }
}
