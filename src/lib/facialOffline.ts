/**
 * Almacenamiento local de la terminal facial.
 *
 * MediaPipe sigue siendo el detector/liveness del flujo actual. Este módulo
 * no convierte landmarks en identidad: solo guarda plantillas SFace
 * cifradas y expone el contrato para un motor local compatible del contenedor
 * nativo. Sin ese motor, la terminal no marca offline para evitar falsos
 * positivos.
 */

export type LocalFaceTemplate = {
  employee_id: string;
  branch_id: string;
  name: string;
  code: string;
  model_name: string;
  version: number;
  updated_at: string | null;
  active: boolean;
  template_hash: string;
  embeddings: number[][];
};

export type LocalAttendanceState = {
  employee_id: string;
  work_date: string;
  events: Array<{
    event_type: LocalPunchRecord["event_type"];
    event_at: string;
  }>;
};

export type LocalPunchRecord = {
  local_event_id: string;
  employee_id: string;
  branch_id: string;
  terminal_id: string;
  device_timestamp: string;
  event_type: "entrada" | "salida" | "almuerzo" | "regreso";
  confidence: number;
  mode: "OFFLINE" | "ONLINE";
  latitude: number | null;
  longitude: number | null;
  device_metadata?: Record<string, unknown> | null;
  state: "PENDING" | "SYNCING" | "SYNCED" | "FAILED";
  retry_count: number;
  created_at: string;
  last_error?: string | null;
};

export type LocalFaceMatch = {
  employee_id: string;
  confidence: number;
  engine: string;
  name?: string;
  code?: string;
};

export type LocalAutomaticAction = {
  available: boolean;
  event_type: LocalPunchRecord["event_type"] | null;
  label: string | null;
  description: string | null;
  reason: string | null;
};

type EncryptedFaceRecord = {
  id: string;
  branch_id: string;
  ciphertext: string;
  iv: string;
};

type LocalMeta = {
  key: string;
  branch_id: string;
  faces_version: number;
  last_successful_sync: string | null;
  last_sync_attempt: string | null;
  attendance_state?: LocalAttendanceState[];
};

const DB_NAME = "allsender-facial-terminal-local";
const DB_VERSION = 1;
const FACE_STORE = "faces";
const META_STORE = "metadata";
const PUNCH_STORE = "punches";
const LOCAL_FACE_MODEL = "opencv_sface_v1";
const LOCAL_FACE_THRESHOLD = 0.363;

export function newLocalEventId(prefix: string): string {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}-${Date.now().toString(36)}-${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FACE_STORE)) {
        db.createObjectStore(FACE_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(PUNCH_STORE)) {
        const store = db.createObjectStore(PUNCH_STORE, { keyPath: "local_event_id" });
        store.createIndex("state", "state", { unique: false });
        store.createIndex("branch_id", "branch_id", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("No se pudo abrir el almacenamiento local."));
  });
}

function asBase64(bytes: Uint8Array): string {
  let value = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    value += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(value);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function storageKey(token: string, branchId: string): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Este dispositivo no permite cifrar el almacenamiento facial local.");
  }
  const material = new TextEncoder().encode(`${token}:${branchId}:allsender-facial-local-v1`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptJson(value: unknown, key: CryptoKey): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { ciphertext: asBase64(new Uint8Array(ciphertext)), iv: asBase64(iv) };
}

async function decryptJson<T>(record: EncryptedFaceRecord, key: CryptoKey): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(record.iv) },
    key,
    fromBase64(record.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("No se pudo guardar el dato local."));
    transaction.onabort = () => reject(transaction.error || new Error("La operación local fue cancelada."));
  });
}

async function readMeta(branchId: string): Promise<LocalMeta> {
  const db = await openDb();
  try {
    const tx = db.transaction(META_STORE, "readonly");
    const request = tx.objectStore(META_STORE).get(`${branchId}:faces`);
    const result = await new Promise<LocalMeta | undefined>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as LocalMeta | undefined);
      request.onerror = () => reject(request.error);
    });
    return result || {
      key: `${branchId}:faces`,
      branch_id: branchId,
      faces_version: 0,
      last_successful_sync: null,
      last_sync_attempt: null,
      attendance_state: [],
    };
  } finally {
    db.close();
  }
}

function validateTemplate(value: unknown, branchId: string): value is LocalFaceTemplate {
  const item = value as Partial<LocalFaceTemplate> | null;
  return Boolean(
    item &&
      item.employee_id &&
      item.branch_id === branchId &&
      item.model_name === LOCAL_FACE_MODEL &&
      Array.isArray(item.embeddings) &&
      item.embeddings.length > 0 &&
      item.embeddings.every(
        (embedding) =>
          Array.isArray(embedding) &&
          embedding.length >= 64 &&
          embedding.every((part) => typeof part === "number" && Number.isFinite(part)),
      ),
  );
}

export async function syncFaceTemplates(token: string, branchId: string): Promise<{ version: number; upserted: number; deleted: number }> {
  const meta = await readMeta(branchId);
  const db = await openDb();
  try {
    const now = new Date().toISOString();
    const key = await storageKey(token, branchId);
    const response = await fetch(
      `/api/v1/facial/terminals/faces/sync?since_version=${encodeURIComponent(meta.faces_version)}`,
      {
        headers: {
          Accept: "application/json",
          "X-Facial-Terminal-Token": token,
        },
        cache: "no-store",
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.detail || payload.message || "No se pudo sincronizar la base facial.") as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    if (payload.branch_id !== branchId || payload.terminal_id === undefined) {
      throw new Error("La respuesta facial no corresponde a esta terminal.");
    }
    let upserted = 0;
    let deleted = 0;
    const encryptedRows: Array<EncryptedFaceRecord & { branch_id: string }> = [];
    for (const item of Array.isArray(payload.upsert) ? payload.upsert : []) {
      if (!validateTemplate(item, branchId)) {
        throw new Error("El backend devolvió una plantilla facial inválida; no se avanzó la versión local.");
      }
      const encrypted = await encryptJson(item, key);
      encryptedRows.push({
        id: `${branchId}:${item.employee_id}`,
        branch_id: branchId,
        ...encrypted,
      });
      upserted += 1;
    }
    let staleBranchFaceIds: string[] = [];
    if (payload.full_sync === true) {
      const readTransaction = db.transaction(FACE_STORE, "readonly");
      const existing = await new Promise<EncryptedFaceRecord[]>((resolve, reject) => {
        const request = readTransaction.objectStore(FACE_STORE).getAll();
        request.onsuccess = () => resolve((request.result as EncryptedFaceRecord[]) || []);
        request.onerror = () => reject(request.error);
      });
      staleBranchFaceIds = existing
        .filter((record) => record.branch_id === branchId)
        .map((record) => record.id);
    }
    const transaction = db.transaction([FACE_STORE, META_STORE], "readwrite");
    const faces = transaction.objectStore(FACE_STORE);
    staleBranchFaceIds.forEach((id) => faces.delete(id));
    encryptedRows.forEach((record) => faces.put(record));
    for (const item of Array.isArray(payload.deleted) ? payload.deleted : []) {
      if (item?.branch_id === branchId && item?.employee_id) {
        faces.delete(`${branchId}:${item.employee_id}`);
        deleted += 1;
      }
    }
    const attendanceState = Array.isArray(payload.attendance_state)
      ? normalizeAttendanceState(payload.attendance_state)
      : meta.attendance_state || [];
    transaction.objectStore(META_STORE).put({
      key: `${branchId}:faces`,
      branch_id: branchId,
      faces_version: Number(payload.version) || meta.faces_version,
      last_successful_sync: now,
      last_sync_attempt: now,
      attendance_state: attendanceState,
    } satisfies LocalMeta);
    const nativeStored = window.AllSenderAndroid?.storeFaceSync?.(JSON.stringify(payload));
    if (nativeStored === false) {
      transaction.abort();
      throw new Error("No se pudo guardar la base facial nativa.");
    }
    await transactionDone(transaction);
    return { version: Number(payload.version) || meta.faces_version, upserted, deleted };
  } finally {
    db.close();
  }
}

function normalizeAttendanceState(value: unknown): LocalAttendanceState[] {
  if (!Array.isArray(value)) return [];
  const eventTypes = new Set<LocalPunchRecord["event_type"]>(["entrada", "almuerzo", "regreso", "salida"]);
  return value.flatMap((raw) => {
    const item = raw as Partial<LocalAttendanceState> | null;
    if (!item?.employee_id || typeof item.work_date !== "string" || !Array.isArray(item.events)) return [];
    const events = item.events.flatMap((event) => {
      const candidate = event as Partial<LocalAttendanceState["events"][number]> | null;
      return candidate?.event_type && eventTypes.has(candidate.event_type) && typeof candidate.event_at === "string"
        ? [{ event_type: candidate.event_type, event_at: candidate.event_at }]
        : [];
    });
    return [{ employee_id: item.employee_id, work_date: item.work_date, events }];
  });
}

export async function listLocalFaceTemplates(token: string, branchId: string): Promise<LocalFaceTemplate[]> {
  const key = await storageKey(token, branchId);
  const db = await openDb();
  try {
    const tx = db.transaction(FACE_STORE, "readonly");
    const request = tx.objectStore(FACE_STORE).getAll();
    const records = await new Promise<EncryptedFaceRecord[]>((resolve, reject) => {
      request.onsuccess = () => resolve((request.result as EncryptedFaceRecord[]) || []);
      request.onerror = () => reject(request.error);
    });
    const output: LocalFaceTemplate[] = [];
    for (const record of records) {
      if (record.branch_id !== branchId) continue;
      try {
        const item = await decryptJson<LocalFaceTemplate>(record, key);
        if (validateTemplate(item, branchId) && item.active) output.push(item);
      } catch {
        // Una plantilla corrupta se ignora; nunca se usa como identidad.
      }
    }
    return output;
  } finally {
    db.close();
  }
}

/** Borra las plantillas y la revisión local de una sucursal desvinculada.
 * La cola de asistencia no se toca aquí para no perder eventos pendientes.
 */
export async function clearLocalFaceData(branchId: string): Promise<void> {
  if (!branchId) return;
  const db = await openDb();
  try {
    const transaction = db.transaction([FACE_STORE, META_STORE], "readwrite");
    const faces = transaction.objectStore(FACE_STORE);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("No se pudo limpiar el almacenamiento local."));
      transaction.onabort = () => reject(transaction.error || new Error("La limpieza local fue cancelada."));
      const request = faces.getAll();
      request.onsuccess = () => {
        const records = (request.result as EncryptedFaceRecord[]) || [];
        for (const record of records) {
          if (record.branch_id === branchId) faces.delete(record.id);
        }
        transaction.objectStore(META_STORE).delete(`${branchId}:faces`);
      };
      request.onerror = () => transaction.abort();
    });
    window.AllSenderAndroid?.clearLocalFaceData?.(branchId);
  } finally {
    db.close();
  }
}

export function hasLocalFaceEngine(): boolean {
  if (typeof window === "undefined") return false;
  const provider = window.AllSenderFacialLocal;
  if (!provider?.recognize) return false;
  // The Android wrapper exposes the capability explicitly. Do not let the
  // mere presence of a JS shim turn offline mode on when the native model is
  // absent or still loading.
  if (window.AllSenderAndroid?.hasLocalFaceEngine && !window.AllSenderAndroid.hasLocalFaceEngine()) {
    return false;
  }
  return true;
}

export async function recognizeLocally(
  imageDataUrl: string,
  context: {
    token: string;
    branchId: string;
    imageWidth?: number;
    imageHeight?: number;
    landmarks?: Array<{ x: number; y: number }>;
  },
): Promise<(LocalFaceMatch & { template: LocalFaceTemplate }) | null> {
  const provider = typeof window !== "undefined" ? window.AllSenderFacialLocal : undefined;
  if (!provider?.recognize) return null;
  const templates = await listLocalFaceTemplates(context.token, context.branchId);
  const raw = await provider.recognize(imageDataUrl, {
    branch_id: context.branchId,
    image_width: context.imageWidth,
    image_height: context.imageHeight,
    landmarks: context.landmarks,
  });
  if (!raw || !raw.employee_id || !Number.isFinite(raw.confidence) || raw.confidence < LOCAL_FACE_THRESHOLD) return null;
  const template = templates.find((item) => item.employee_id === raw.employee_id) || {
    employee_id: raw.employee_id,
    branch_id: context.branchId,
    name: raw.name || raw.employee_id,
    code: raw.code || "",
    model_name: LOCAL_FACE_MODEL,
    version: 0,
    updated_at: null,
    active: true,
    template_hash: "",
    embeddings: [],
  } satisfies LocalFaceTemplate;
  return {
    employee_id: template.employee_id,
    confidence: raw.confidence,
    engine: raw.engine || template.model_name,
    template,
  };
}

function localDayKey(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santo_Domingo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function localClock(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Santo_Domingo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export async function getLocalAutomaticAction(
  employeeId: string,
  branchId: string,
  schedule: {
    start: string | null;
    end: string | null;
    lunch_minutes?: number | null;
  },
  automaticLunch: { lunch_start?: string | null; lunch_end?: string | null } = {},
  at = new Date(),
): Promise<LocalAutomaticAction> {
  const meta = await readMeta(branchId);
  const db = await openDb();
  try {
    const transaction = db.transaction(PUNCH_STORE, "readonly");
    const request = transaction.objectStore(PUNCH_STORE).getAll();
    const records = await new Promise<LocalPunchRecord[]>((resolve, reject) => {
      request.onsuccess = () => resolve((request.result as LocalPunchRecord[]) || []);
      request.onerror = () => reject(request.error);
    });
    const today = localDayKey(at);
    const serverEvents = (meta.attendance_state || [])
      .find((item) => item.employee_id === employeeId && item.work_date === today)
      ?.events.map((item) => ({
        event_type: item.event_type,
        device_timestamp: item.event_at,
      })) || [];
    const localEvents = records
      .filter(
        (item) =>
          item.employee_id === employeeId &&
          item.branch_id === branchId &&
          ["PENDING", "SYNCING", "SYNCED"].includes(item.state) &&
          localDayKey(item.device_timestamp) === today,
      )
      .sort((left, right) => left.device_timestamp.localeCompare(right.device_timestamp));
    const events = [...serverEvents, ...localEvents].sort((left, right) => left.device_timestamp.localeCompare(right.device_timestamp));
    const has = (eventType: LocalPunchRecord["event_type"]) => events.some((item) => item.event_type === eventType);
    const lastLunch = [...events].reverse().find((item) => item.event_type === "almuerzo");
    const lastReturn = [...events].reverse().find((item) => item.event_type === "regreso");
    if (!has("entrada")) return { available: true, event_type: "entrada", label: "ENTRADA", description: "Inicio de jornada", reason: "No existe una entrada local para hoy." };
    if (has("salida")) return { available: false, event_type: null, label: null, description: null, reason: "La jornada local de hoy ya está completa." };
    if (lastLunch && (!lastReturn || lastReturn.device_timestamp < lastLunch.device_timestamp)) {
      return { available: true, event_type: "regreso", label: "REGRESO", description: "Retorno de pausa", reason: "Hay un almuerzo abierto." };
    }
    const clock = localClock(at);
    if (schedule.end && clock >= schedule.end) return { available: true, event_type: "salida", label: "SALIDA", description: "Fin de jornada", reason: "Llegó el final del horario de la sucursal." };
    let lunchStart = automaticLunch.lunch_start || null;
    if (!lunchStart && schedule.start && schedule.end) {
      const startMinutes = Number(schedule.start.slice(0, 2)) * 60 + Number(schedule.start.slice(3));
      const endMinutes = Number(schedule.end.slice(0, 2)) * 60 + Number(schedule.end.slice(3));
      const duration = (endMinutes >= startMinutes ? endMinutes - startMinutes : endMinutes + 1440 - startMinutes);
      lunchStart = `${Math.floor((startMinutes + (duration - Number(schedule.lunch_minutes || 60)) / 2) / 60) % 24}`.padStart(2, "0") + ":" + `${Math.floor((startMinutes + (duration - Number(schedule.lunch_minutes || 60)) / 2) % 60)}`.padStart(2, "0");
    }
    if (lunchStart && clock >= lunchStart) return { available: true, event_type: "almuerzo", label: "ALMUERZO", description: "Salida a comer", reason: "Llegó el horario automático de almuerzo." };
    return { available: false, event_type: null, label: null, description: null, reason: lunchStart ? `El almuerzo estará disponible a las ${lunchStart}.` : "No hay un siguiente marcaje automático configurado." };
  } finally {
    db.close();
  }
}

async function putPunch(record: LocalPunchRecord): Promise<void> {
  const db = await openDb();
  try {
    const transaction = db.transaction(PUNCH_STORE, "readwrite");
    transaction.objectStore(PUNCH_STORE).put(record);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

export async function rememberOnlinePunch(input: Omit<LocalPunchRecord, "state" | "retry_count" | "created_at">): Promise<void> {
  await putPunch({ ...input, state: "SYNCED", retry_count: 0, created_at: new Date().toISOString() });
}

export async function queueOfflinePunch(input: Omit<LocalPunchRecord, "state" | "retry_count" | "created_at">): Promise<void> {
  const db = await openDb();
  try {
    const transaction = db.transaction(PUNCH_STORE, "readwrite");
    const store = transaction.objectStore(PUNCH_STORE);
    const existingRequest = store.get(input.local_event_id);
    existingRequest.onsuccess = () => {
      if (!existingRequest.result) {
        const record = { ...input, state: "PENDING" as const, retry_count: 0, created_at: new Date().toISOString() } satisfies LocalPunchRecord;
        store.put(record);
        window.AllSenderAndroid?.queueOfflinePunch?.(JSON.stringify(record));
      }
    };
    existingRequest.onerror = () => transaction.abort();
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

export async function countPendingPunches(branchId?: string): Promise<number> {
  const db = await openDb();
  try {
    const tx = db.transaction(PUNCH_STORE, "readonly");
    const request = tx.objectStore(PUNCH_STORE).getAll();
    const records = await new Promise<LocalPunchRecord[]>((resolve, reject) => {
      request.onsuccess = () => resolve((request.result as LocalPunchRecord[]) || []);
      request.onerror = () => reject(request.error);
    });
    return records.filter((item) => ["PENDING", "SYNCING"].includes(item.state) && (!branchId || item.branch_id === branchId)).length;
  } finally {
    db.close();
  }
}

async function updatePunches(
  records: LocalPunchRecord[],
): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(PUNCH_STORE, "readwrite");
    const store = tx.objectStore(PUNCH_STORE);
    records.forEach((record) => store.put(record));
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

export async function flushOfflinePunches(token: string, branchId: string): Promise<{ synced: number; failed: number; pending: number }> {
  const db = await openDb();
  let records: LocalPunchRecord[];
  try {
    const tx = db.transaction(PUNCH_STORE, "readonly");
    const request = tx.objectStore(PUNCH_STORE).getAll();
    records = await new Promise<LocalPunchRecord[]>((resolve, reject) => {
      request.onsuccess = () => resolve((request.result as LocalPunchRecord[]) || []);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
  // Los rechazos de negocio quedan FAILED para revisión; solo los eventos
  // PENDING/SYNCING vuelven solos, incluidos los reintentos de transporte.
  const pending = records.filter((item) => item.branch_id === branchId && ["PENDING", "SYNCING"].includes(item.state));
  const batch = pending.slice(0, 100);
  if (!batch.length) return { synced: 0, failed: 0, pending: 0 };
  const syncing = batch.map((item) => ({ ...item, state: "SYNCING" as const }));
  await updatePunches(syncing);
  try {
    const response = await fetch("/api/v1/facial/terminals/offline-punches/sync", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Facial-Terminal-Token": token },
      body: JSON.stringify({ events: syncing.map(({ state: _state, retry_count: _retry, created_at: _created, last_error: _error, ...event }) => event) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || payload.message || "No se pudo sincronizar la cola facial.");
    const byId = new Map<string, LocalPunchRecord>(syncing.map((item) => [item.local_event_id, item]));
    for (const item of Array.isArray(payload.items) ? payload.items : []) {
      const previous = byId.get(item.local_event_id);
      if (!previous) continue;
      byId.set(item.local_event_id, {
        ...previous,
        state: item.status === "SYNCED" ? "SYNCED" : item.retryable === true ? "PENDING" : "FAILED",
        retry_count: item.status === "SYNCED" ? previous.retry_count : previous.retry_count + 1,
        last_error: item.status === "SYNCED" ? null : item.message || "El backend rechazó el marcaje.",
      });
    }
    const result = [...byId.values()];
    await updatePunches(result);
    return {
      synced: result.filter((item) => item.state === "SYNCED").length,
      failed: result.filter((item) => item.state === "FAILED").length,
      pending: await countPendingPunches(branchId),
    };
  } catch (error) {
    await updatePunches(syncing.map((item) => ({
      ...item,
      state: "PENDING" as const,
      retry_count: item.retry_count + 1,
      last_error: error instanceof Error ? error.message : "Sin conexión con el backend.",
    })));
    return { synced: 0, failed: batch.length, pending: await countPendingPunches(branchId) };
  }
}

declare global {
  interface Window {
    AllSenderAndroid?: {
      hasLocalFaceEngine?: () => boolean;
      storeFaceSync?: (payloadJson: string) => boolean;
      queueOfflinePunch?: (payloadJson: string) => boolean;
      clearLocalFaceData?: (branchId: string) => void;
    };
    AllSenderFacialLocal?: {
      recognize?: (
        imageDataUrl: string,
        context: {
          branch_id: string;
          image_width?: number;
          image_height?: number;
          landmarks?: Array<{ x: number; y: number }>;
        },
      ) => Promise<{ employee_id: string; confidence: number; engine?: string; name?: string; code?: string } | null> | { employee_id: string; confidence: number; engine?: string; name?: string; code?: string } | null;
    };
  }
}
