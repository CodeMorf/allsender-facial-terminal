import { useCallback, useEffect, useRef, useState } from "react";
import {
  BatteryCharging,
  Camera,
  CameraOff,
  Check,
  Clock3,
  Coffee,
  Crosshair,
  Delete,
  Expand,
  KeyRound,
  LogIn,
  LogOut,
  MapPin,
  Moon,
  Navigation,
  RefreshCw,
  ScanFace,
  ShieldAlert,
  ShieldCheck,
  Utensils,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
} from "lucide-react";
import type { FaceLandmarker as FaceLandmarkerType } from "@mediapipe/tasks-vision";
import {
  bindBeforeInstallPrompt,
  isStandaloneDisplay,
  triggerInstallPrompt,
} from "@/lib/pwaEmpleado";
import {
  clearLocalFaceData,
  countPendingPunches,
  flushOfflinePunches,
  getLocalAutomaticAction,
  hasLocalFaceEngine,
  queueOfflinePunch,
  recognizeLocally,
  rememberOnlinePunch,
  syncFaceTemplates,
  newLocalEventId,
} from "@/lib/facialOffline";

type KioskState =
  | "idle"
  | "recognizing"
  | "recognized"
  | "success"
  | "error"
  | "out_of_zone"
  | "out_of_schedule";
type LiveFaceState = "loading" | "none" | "one" | "multiple" | "error";
type PunchType = "entrada" | "almuerzo" | "regreso" | "salida";
type PairingStep = "gps" | "pin";
type AutomaticAction = {
  enabled: boolean;
  available: boolean;
  event_type: PunchType | null;
  label: string | null;
  description: string | null;
  reason: string | null;
};
type Config = {
  terminal: {
    id: string;
    label: string;
    battery_percent: number | null;
    is_charging: boolean;
    last_seen_at: string | null;
    distance_meters?: number | null;
    within_branch_zone?: boolean | null;
  };
  branch: { id: string; name: string; radius_meters: number };
  mode: "qr_and_facial" | "facial_only" | "qr_only";
  facial_enabled: boolean;
  schedule: {
    start: string | null;
    end: string | null;
    within_schedule: boolean;
    lunch_minutes?: number | null;
  };
  automatic_punch?: {
    enabled: boolean;
    lunch_start: string | null;
    lunch_end: string | null;
  };
  battery: { alert_enabled: boolean; threshold: number };
};
type LocatedBranch = {
  id: string;
  name: string;
  distance_meters: number;
  radius_meters: number;
  within_radius: boolean;
};
type Candidate = {
  id: string;
  name: string;
  code: string;
  automatic_action?: AutomaticAction;
};

type OfflinePunchOptions = {
  confidence: number;
  device_timestamp: string;
};

type AllSenderAndroidBridge = {
  getBatteryPercent?: () => number;
  isCharging?: () => boolean;
  getPlatformLabel?: () => string;
  getAppVersion?: () => string;
  getPairingCode?: () => string;
  hasLocalFaceEngine?: () => boolean;
  clearPairingCode?: () => void;
  markPaired?: (token?: string, branchId?: string, terminalId?: string) => void;
  clearPaired?: () => void;
  clearLocalFaceData?: (branchId: string) => void;
};

function cachedTerminalConfig(): Config | null {
  try {
    const raw = localStorage.getItem("allsender_facial_terminal_config");
    return raw ? (JSON.parse(raw) as Config) : null;
  } catch {
    return null;
  }
}

const TOKEN_KEY = "codemorf_facial_terminal_token";

function getAllSenderAndroidBridge(): AllSenderAndroidBridge | null {
  return ((window as any).AllSenderAndroid as AllSenderAndroidBridge | undefined) || null;
}

function getTerminalAppVersion() {
  try {
    return getAllSenderAndroidBridge()?.getAppVersion?.() || getAllSenderAndroidBridge()?.getPlatformLabel?.() || "web-terminal-1";
  } catch {
    return "web-terminal-1";
  }
}

function getCurrentPosition(options: PositionOptions): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

function describeGeolocationError(error: unknown): string {
  const code = (error as GeolocationPositionError | undefined)?.code;
  if (code === 1) {
    return "El permiso de ubicación está bloqueado. Permite la ubicación para nomina.allsender.tech y vuelve a intentarlo.";
  }
  if (code === 2) {
    return "El dispositivo no pudo determinar su ubicación. Activa GPS/Ubicación precisa y prueba nuevamente.";
  }
  if (code === 3) {
    return "El GPS tardó demasiado en responder. Mantén la ubicación activa y vuelve a intentarlo en unos segundos.";
  }
  return "No se pudo obtener la ubicación del dispositivo. Activa GPS/Ubicación precisa y vuelve a intentarlo.";
}
const PUNCHES: Array<{
  id: PunchType;
  label: string;
  desc: string;
  icon: typeof LogIn;
  color: "emerald" | "amber" | "cyan" | "rose";
}> = [
  {
    id: "entrada",
    label: "ENTRADA",
    desc: "Inicio de jornada",
    icon: LogIn,
    color: "emerald",
  },
  {
    id: "almuerzo",
    label: "ALMUERZO",
    desc: "Salida a comer",
    icon: Utensils,
    color: "amber",
  },
  {
    id: "regreso",
    label: "REGRESO",
    desc: "Retorno de pausa",
    icon: Coffee,
    color: "cyan",
  },
  {
    id: "salida",
    label: "SALIDA",
    desc: "Fin de turno",
    icon: LogOut,
    color: "rose",
  },
] as const;
const PUNCH_STYLES: Record<
  (typeof PUNCHES)[number]["color"],
  { border: string; text: string }
> = {
  emerald: { border: "border-emerald-400", text: "text-emerald-400" },
  amber: { border: "border-amber-400", text: "text-amber-400" },
  cyan: { border: "border-cyan-400", text: "text-cyan-400" },
  rose: { border: "border-rose-400", text: "text-rose-400" },
};

const RECOGNITION_INTERVAL_MS = 1_800;
const AUTO_PUNCH_DELAY_MS = 700;
const PUNCH_COOLDOWN_MS = 8_000;

async function publicApi(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      payload.detail || payload.message || "No se pudo completar la operación.",
    ) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return payload;
}

function clockParts() {
  const now = new Date();
  return {
    time: now.toLocaleTimeString("es-DO", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    }),
    date: now.toLocaleDateString("es-DO", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
  };
}

export default function FacialTerminal() {
  const [token, setToken] = useState(
    () => localStorage.getItem(TOKEN_KEY) || "",
  );
  const [config, setConfig] = useState<Config | null>(() => cachedTerminalConfig());
  const [pairingStep, setPairingStep] = useState<PairingStep>("gps");
  const [pairingLocation, setPairingLocation] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [detectedBranch, setDetectedBranch] = useState<LocatedBranch | null>(null);
  const [pin, setPin] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingMessage, setPairingMessage] = useState(
    "Código temporal de seis dígitos",
  );
  const [state, setState] = useState<KioskState>("idle");
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [authToken, setAuthToken] = useState("");
  const [punchType, setPunchType] =
    useState<(typeof PUNCHES)[number]["id"]>("entrada");
  const [message, setMessage] = useState(
    "Acércate a la pantalla para marcar tu asistencia",
  );
  const [clock, setClock] = useState(clockParts());
  const [battery, setBattery] = useState<number | null>(null);
  const [charging, setCharging] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "ok" | "error">("idle");
  const [pendingOffline, setPendingOffline] = useState(0);
  const [localFaceEngine, setLocalFaceEngine] = useState(hasLocalFaceEngine);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [liveFaceState, setLiveFaceState] = useState<LiveFaceState>("none");
  const [liveFaceMessage, setLiveFaceMessage] = useState(
    "Acércate a la cámara para registrar tu asistencia",
  );
  const [audio, setAudio] = useState(false);
  const [installReady, setInstallReady] = useState(false);
  const [installed, setInstalled] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const faceLandmarkerRef = useRef<FaceLandmarkerType | null>(null);
  const faceRafRef = useRef<number | null>(null);
  const latestFaceLandmarksRef = useRef<Array<{ x: number; y: number }> | null>(null);
  const liveFaceStateRef = useRef<LiveFaceState>("none");
  const recognizeTimer = useRef<number | null>(null);
  const busyRecognition = useRef(false);
  const punchTimerRef = useRef<number | null>(null);
  const punchCooldownUntilRef = useRef(0);
  const lastSpokenMessageRef = useRef("");
  const nativePairingAttempted = useRef(false);
  const nativePairingCodeRef = useRef("");
  const batteryRef = useRef<number | null>(null);
  const chargingRef = useRef(false);
  const locationRef = useRef<{ latitude: number; longitude: number } | null>(null);
  const localSyncBusyRef = useRef(false);
  const facialEnabled = Boolean(config?.facial_enabled);

  const updateBatteryReading = useCallback(
    (value: number | null, isCharging: boolean) => {
      if (value !== null && value >= 0 && value <= 100) {
        batteryRef.current = value;
        setBattery(value);
      }
      chargingRef.current = isCharging;
      setCharging(isCharging);
    },
    [],
  );

  const updateLiveFace = useCallback((next: LiveFaceState, nextMessage: string) => {
    if (liveFaceStateRef.current !== next) {
      liveFaceStateRef.current = next;
      setLiveFaceState(next);
    }
    setLiveFaceMessage((current) => (current === nextMessage ? current : nextMessage));
  }, []);

  const statusMessage =
    state === "idle" ? liveFaceMessage : message;

  useEffect(() => {
    if (!token || !audio || !statusMessage || !("speechSynthesis" in window)) {
      return;
    }
    if (lastSpokenMessageRef.current === statusMessage) return;
    lastSpokenMessageRef.current = statusMessage;
    const spokenText = statusMessage
      .replace(/[✅·…]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!spokenText) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(spokenText);
    utterance.lang = "es-DO";
    utterance.rate = 0.95;
    utterance.pitch = 1;
    utterance.volume = 1;
    window.speechSynthesis.speak(utterance);
  }, [audio, statusMessage, token]);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraOn(false);
  }, []);
  const startCamera = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error(
          "Este dispositivo no permite usar la cámara desde el navegador.",
        );
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraOn(true);
      setCameraError("");
    } catch (cause) {
      setCameraOn(false);
      setCameraError(
        cause instanceof Error ? cause.message : "No se pudo abrir la cámara.",
      );
    }
  }, []);

  const loadConfig = useCallback(
    async (value = token) => {
      if (!value) return null;
      const result = await publicApi("/api/v1/facial/terminals/config", {
        headers: { "X-Facial-Terminal-Token": value },
      });
      setConfig(result);
      localStorage.setItem("allsender_facial_terminal_config", JSON.stringify(result));
      setOnline(true);
      if (batteryRef.current === null) {
        updateBatteryReading(
          result.terminal?.battery_percent ?? null,
          !!result.terminal?.is_charging,
        );
      }
      const withinBranch = result.terminal?.within_branch_zone !== false;
      const withinSchedule = Boolean(result.schedule?.within_schedule);
      setState(!withinBranch ? "out_of_zone" : withinSchedule ? "idle" : "out_of_schedule");
      setMessage(
        !withinBranch
          ? "Alerta · la tablet está fuera de la sucursal autorizada"
          : withinSchedule
            ? "Acércate a la pantalla para marcar tu asistencia"
            : "Terminal fuera del horario operativo",
      );
      return result as Config;
    },
    [token, updateBatteryReading],
  );

  useEffect(() => {
    const timer = window.setInterval(() => setClock(clockParts()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    setInstalled(isStandaloneDisplay());
    return bindBeforeInstallPrompt(() =>
      setInstallReady(Boolean((window as any).__pwaDeferredPrompt)),
    );
  }, []);
  useEffect(() => {
    document.title = "AllSender Facial · Terminal";
    let manifest = document.querySelector(
      'link[rel="manifest"]',
    ) as HTMLLinkElement | null;
    if (!manifest) {
      manifest = document.createElement("link");
      manifest.rel = "manifest";
      document.head.appendChild(manifest);
    }
    manifest.href = "/manifest-facial.json?v=20260830";
    const theme = document.querySelector(
      'meta[name="theme-color"]',
    ) as HTMLMetaElement | null;
    if (theme) theme.content = "#050811";
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw-empleado.js", { scope: "/", updateViaCache: "none" })
        .then((registration) => registration.update())
        .catch(() => undefined);
    }
    return () => {
      document.title = "AllSender Nómina";
    };
  }, []);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  useEffect(() => {
    if (token) {
      loadConfig().catch((cause) => {
        const status = (cause as Error & { status?: number })?.status;
        if (status === 401 || status === 403 || status === 409) {
          const previousBranchId = cachedTerminalConfig()?.branch?.id || "";
          void clearLocalFaceData(previousBranchId).catch(() => undefined);
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem("allsender_facial_terminal_config");
          setToken("");
          setConfig(null);
          return;
        }
        setOnline(false);
        setMessage("Sin conexión con el backend · se conserva la configuración local de esta terminal.");
      });
    }
  }, [loadConfig, token]);
  useEffect(() => {
    if (token && config && !cameraOn) startCamera().catch(() => undefined);
    return () => undefined;
  }, [token, config]);
  useEffect(() => () => stopCamera(), [stopCamera]);
  useEffect(
    () => () => {
      if (punchTimerRef.current !== null) {
        window.clearTimeout(punchTimerRef.current);
        punchTimerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    if (!cameraOn || !facialEnabled) {
      if (faceRafRef.current !== null) {
        cancelAnimationFrame(faceRafRef.current);
        faceRafRef.current = null;
      }
      try {
        faceLandmarkerRef.current?.close();
      } catch {
        /* La cámara puede continuar aunque el detector ya se haya cerrado. */
      }
      faceLandmarkerRef.current = null;
      liveFaceStateRef.current = "none";
      setLiveFaceState("none");
      setLiveFaceMessage("Acércate a la cámara para registrar tu asistencia");
      return;
    }

    let cancelled = false;
    const startFaceDetector = async () => {
      updateLiveFace("loading", "Preparando detección facial en tiempo real…");
      try {
        const mp = await import("@mediapipe/tasks-vision");
        const createLandmarker = async (delegate: "GPU" | "CPU") => {
          const vision = await mp.FilesetResolver.forVisionTasks("/mediapipe/wasm");
          return mp.FaceLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: "/mediapipe/face_landmarker.task",
              delegate,
            },
            runningMode: "VIDEO",
            numFaces: 2,
            outputFaceBlendshapes: false,
          });
        };

        let landmarker: FaceLandmarkerType;
        try {
          landmarker = await createLandmarker("GPU");
        } catch {
          landmarker = await createLandmarker("CPU");
        }
        if (cancelled) {
          landmarker.close();
          return;
        }
        faceLandmarkerRef.current = landmarker;

        const loop = () => {
          if (cancelled) return;
          const video = videoRef.current;
          if (!video || video.readyState < 2) {
            faceRafRef.current = requestAnimationFrame(loop);
            return;
          }
          try {
            const result = landmarker.detectForVideo(video, performance.now());
            const count = result.faceLandmarks?.length || 0;
            if (count === 1) {
              const face = result.faceLandmarks[0];
              const point = (index: number) => face?.[index];
              const average = (first: number, second: number) => {
                const a = point(first);
                const b = point(second);
                return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
              };
              const landmarks = [
                average(33, 133),
                average(362, 263),
                point(1),
                point(61),
                point(291),
              ];
              latestFaceLandmarksRef.current = landmarks.every(Boolean)
                ? landmarks as Array<{ x: number; y: number }>
                : null;
              updateLiveFace("one", "Rostro detectado · verificando autorización…");
            } else if (count > 1) {
              latestFaceLandmarksRef.current = null;
              updateLiveFace("multiple", "Solo debe aparecer una persona frente a la cámara");
            } else {
              latestFaceLandmarksRef.current = null;
              updateLiveFace("none", "Acércate a la cámara para registrar tu asistencia");
            }
          } catch {
            latestFaceLandmarksRef.current = null;
            updateLiveFace("error", "Detección en vivo no disponible · verificando en servidor…");
          }
          faceRafRef.current = requestAnimationFrame(loop);
        };
        loop();
      } catch {
        if (!cancelled) {
          updateLiveFace("error", "Detección en vivo no disponible · verificando en servidor…");
        }
      }
    };

    void startFaceDetector();
    return () => {
      cancelled = true;
      if (faceRafRef.current !== null) {
        cancelAnimationFrame(faceRafRef.current);
        faceRafRef.current = null;
      }
      try {
        faceLandmarkerRef.current?.close();
      } catch {
        /* */
      }
      faceLandmarkerRef.current = null;
      latestFaceLandmarksRef.current = null;
    };
  }, [cameraOn, facialEnabled, updateLiveFace]);

  const sendHeartbeat = useCallback(async () => {
    if (!token) return;
    try {
      const result = await publicApi("/api/v1/facial/terminals/heartbeat", {
        method: "POST",
        headers: { "X-Facial-Terminal-Token": token },
        body: JSON.stringify({
          battery_percent: batteryRef.current ?? battery,
          is_charging: chargingRef.current,
          app_version: getTerminalAppVersion(),
          latitude: locationRef.current?.latitude ?? null,
          longitude: locationRef.current?.longitude ?? null,
        }),
      });
      setConfig(result.config);
      localStorage.setItem("allsender_facial_terminal_config", JSON.stringify(result.config));
      setOnline(true);
      if (batteryRef.current === null && result.config?.terminal?.battery_percent != null) {
        updateBatteryReading(
          result.config.terminal.battery_percent,
          !!result.config.terminal.is_charging,
        );
      }
      if (result.config?.terminal?.within_branch_zone === false) {
        setState("out_of_zone");
        setMessage("Alerta · la tablet está fuera de la sucursal autorizada.");
      } else if (result.config?.schedule && !result.config.schedule.within_schedule) {
        setState("out_of_schedule");
        setMessage("Terminal fuera del horario operativo");
      } else if (result.config?.terminal?.within_branch_zone === true) {
        setState((current) => (current === "out_of_zone" ? "idle" : current));
      }
    } catch (cause) {
      const status = (cause as Error & { status?: number })?.status;
      if (status === 401 || status === 403 || status === 409) {
        const previousBranchId = config?.branch.id || "";
        void clearLocalFaceData(previousBranchId).catch(() => undefined);
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem("allsender_facial_terminal_config");
        setToken("");
        setConfig(null);
        setSyncState("error");
        return;
      }
      setOnline(false);
    }
  }, [config, token, updateBatteryReading]);

  const branchId = config?.branch.id || "";
  const syncLocalData = useCallback(async () => {
    if (!token || !branchId || localSyncBusyRef.current) return;
    localSyncBusyRef.current = true;
    setLocalFaceEngine(hasLocalFaceEngine());
    setSyncState("syncing");
    try {
      // Primero se entrega lo que la tablet pudo registrar offline; después
      // se refresca la autorización facial y se hace un segundo drenaje por
      // si durante la sincronización nació otro evento pendiente.
      await flushOfflinePunches(token, branchId);
      await syncFaceTemplates(token, branchId);
      await flushOfflinePunches(token, branchId);
      setPendingOffline(await countPendingPunches(branchId));
      setOnline(true);
      setSyncState("ok");
    } catch (cause) {
      setPendingOffline(await countPendingPunches(branchId).catch(() => 0));
      setSyncState("error");
      const status = (cause as Error & { status?: number })?.status;
      if (status === 401 || status === 403 || status === 409) {
        void clearLocalFaceData(branchId).catch(() => undefined);
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem("allsender_facial_terminal_config");
        setToken("");
        setConfig(null);
        return;
      }
      setOnline(false);
    } finally {
      localSyncBusyRef.current = false;
    }
  }, [branchId, token]);

  useEffect(() => {
    if (!token || !branchId) return;
    void syncLocalData();
    const interval = window.setInterval(() => void syncLocalData(), 5 * 60_000);
    const onOnline = () => void syncLocalData();
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("online", onOnline);
    };
  }, [branchId, syncLocalData, token]);

  useEffect(() => {
    if (!token) return;
    const initialTimer = window.setTimeout(() => void sendHeartbeat(), 750);
    const timer = window.setInterval(() => void sendHeartbeat(), 60_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [token, sendHeartbeat]);
  useEffect(() => {
    const bridge = getAllSenderAndroidBridge();
    const syncNativeBattery = () => {
      try {
        const value = bridge?.getBatteryPercent?.() ?? -1;
        const isCharging = bridge?.isCharging ? Boolean(bridge.isCharging()) : false;
        if (value >= 0 && value <= 100) {
          updateBatteryReading(value, isCharging);
        }
      } catch {
        // La PWA continúa usando Battery API cuando el contenedor no expone puente nativo.
      }
    };
    syncNativeBattery();
    const nativeTimer = bridge?.getBatteryPercent
      ? window.setInterval(syncNativeBattery, 30_000)
      : null;
    const anyNavigator = navigator as Navigator & {
      getBattery?: () => Promise<any>;
    };
    if (!anyNavigator.getBattery) {
      return () => {
        if (nativeTimer) window.clearInterval(nativeTimer);
      };
    }
    let batteryManager: any;
    let readBattery: (() => void) | null = null;
    let mounted = true;
    anyNavigator
      .getBattery()
      .then((manager) => {
        batteryManager = manager;
        const read = () => {
          if (mounted) {
            updateBatteryReading(Math.round(manager.level * 100), !!manager.charging);
          }
        };
        readBattery = read;
        read();
        manager.addEventListener("levelchange", read);
        manager.addEventListener("chargingchange", read);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
      if (nativeTimer) window.clearInterval(nativeTimer);
      if (batteryManager && readBattery) {
        batteryManager.removeEventListener("levelchange", readBattery);
        batteryManager.removeEventListener("chargingchange", readBattery);
      }
    };
  }, [updateBatteryReading]);
  useEffect(() => {
    if (!navigator.geolocation) return;
    const watch = navigator.geolocation.watchPosition(
      (position) => {
        locationRef.current = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        };
      },
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 60_000, timeout: 15_000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, []);

  const pair = useCallback(async (payload: Record<string, unknown>) => {
    setPairingBusy(true);
    setPairingMessage("Validando vinculación…");
    try {
      const result = await publicApi("/api/v1/facial/terminals/pair", {
        method: "POST",
        body: JSON.stringify({
          label: "Tablet Facial",
          app_version: getTerminalAppVersion(),
          ...payload,
        }),
      });
      localStorage.setItem(TOKEN_KEY, result.terminal_token);
      setToken(result.terminal_token);
      setConfig(result.config);
      setPairingLocation(null);
      setDetectedBranch(null);
      setPairingStep("gps");
      setPin("");
      try {
        const bridge = getAllSenderAndroidBridge();
        bridge?.markPaired?.(
          result.terminal_token,
          result.config?.branch?.id,
          result.config?.terminal?.id,
        );
        bridge?.clearPairingCode?.();
      } catch {
        // El navegador continúa operando si no existe el puente Android.
      }
      setPairingMessage(`Tablet vinculada a ${result.config.branch.name}`);
      setState("idle");
    } catch (cause) {
      setPairingMessage(
        cause instanceof Error
          ? cause.message
          : "No se pudo vincular la tablet.",
      );
    } finally {
      setPairingBusy(false);
    }
  }, []);
  useEffect(() => {
    if (token || pairingBusy || nativePairingAttempted.current) return;
    let nativeCode = "";
    try {
      nativeCode = getAllSenderAndroidBridge()?.getPairingCode?.() || "";
    } catch {
      nativeCode = "";
    }
    if (!/^\d{6}$/.test(nativeCode)) return;
    nativePairingAttempted.current = true;
    // La aplicación nativa puede entregar el PIN, pero la ubicación de la
    // tablet debe validarse antes de completar la vinculación.
    nativePairingCodeRef.current = nativeCode;
    setPairingMessage("PIN listo. Primero permite la ubicación de la tablet.");
  }, [token, pairingBusy, pair]);
  function pressPin(digit: string) {
    if (pin.length < 6) setPin((old) => old + digit);
  }
  useEffect(() => {
    if (pin.length === 6 && !pairingBusy) {
      const value = pin;
      setPin("");
      if (!pairingLocation) {
        setPairingStep("gps");
        setPairingMessage("Primero valida la ubicación GPS de la tablet.");
        return;
      }
      void pair({ code: value, ...pairingLocation });
    }
  }, [pin, pairingBusy, pair]);
  async function useGps() {
    setPairingBusy(true);
    setPairingMessage("Obteniendo coordenadas…");
    if (!navigator.geolocation) {
      setPairingBusy(false);
      setPairingMessage("Este dispositivo no permite vinculación por GPS.");
      return;
    }
    try {
      let position: GeolocationPosition;
      try {
        position = await getCurrentPosition({
          enableHighAccuracy: true,
          maximumAge: 15_000,
          timeout: 15_000,
        });
      } catch (firstError) {
        const firstCode = (firstError as GeolocationPositionError | undefined)?.code;
        if (firstCode === 1) throw firstError;
        setPairingMessage(
          "La señal GPS está tardando. Intentando la ubicación del dispositivo…",
        );
        position = await getCurrentPosition({
          enableHighAccuracy: false,
          maximumAge: 120_000,
          timeout: 20_000,
        });
      }
      const location = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      };
      locationRef.current = location;
      setPairingLocation(location);
      setPairingStep("pin");
      try {
        const nearby = await publicApi("/api/v1/facial/terminals/locate", {
          method: "POST",
          body: JSON.stringify(location),
        });
        const branch = (nearby.branch || null) as LocatedBranch | null;
        setDetectedBranch(branch);
        setPairingMessage(
          branch
            ? branch.within_radius
              ? `Sucursal detectada: ${branch.name}. Introduce el PIN de esta sucursal.`
              : `Sucursal más cercana: ${branch.name}, pero está a ${Math.round(branch.distance_meters)} m. El máximo permitido es ${Math.round(branch.radius_meters)} m.`
            : nearby.message || "No encontramos una sucursal facial cerca de esta ubicación.",
        );
      } catch {
        setDetectedBranch(null);
        setPairingMessage("GPS obtenido. No se pudo consultar la sucursal cercana; introduce el PIN para continuar.");
      }
      const nativeCode = nativePairingCodeRef.current;
      if (/^\d{6}$/.test(nativeCode)) {
        nativePairingCodeRef.current = "";
        setPin(nativeCode);
      }
    } catch (error) {
      setPairingMessage(describeGeolocationError(error));
    } finally {
      setPairingBusy(false);
    }
  }

  const resetTerminal = useCallback((delayMs: number) => {
    if (punchTimerRef.current !== null) {
      window.clearTimeout(punchTimerRef.current);
    }
    punchTimerRef.current = window.setTimeout(() => {
      setCandidate(null);
      setAuthToken("");
      setState("idle");
      setMessage("Acércate a la cámara para registrar tu asistencia");
      punchTimerRef.current = null;
    }, delayMs);
  }, []);

  const recordPunch = useCallback(
    async (
      employee: Candidate,
      credential: string,
      eventType: PunchType,
      offlineOptions?: OfflinePunchOptions,
    ) => {
      if ((!credential && !offlineOptions) || !token || !config) return;
      const eventLabel = PUNCHES.find((item) => item.id === eventType)?.label || eventType.toUpperCase();
      setState("recognizing");
      setMessage(`Rostro autorizado · registrando ${eventLabel.toLowerCase()} automáticamente…`);
      try {
        if (offlineOptions) {
          await queueOfflinePunch({
            local_event_id: newLocalEventId(`offline-${config.terminal.id}`),
            employee_id: employee.id,
            branch_id: config.branch.id,
            terminal_id: config.terminal.id,
            device_timestamp: offlineOptions.device_timestamp,
            event_type: eventType,
            confidence: offlineOptions.confidence,
            mode: "OFFLINE",
            latitude: locationRef.current?.latitude ?? null,
            longitude: locationRef.current?.longitude ?? null,
            device_metadata: { app_version: getTerminalAppVersion(), source: "pwa" },
          });
          setPendingOffline(await countPendingPunches(config.branch.id));
          punchCooldownUntilRef.current = Date.now() + PUNCH_COOLDOWN_MS;
          setOnline(false);
          setState("success");
          setMessage(`${eventLabel} guardada localmente. Se sincronizará cuando vuelva la conexión.`);
          resetTerminal(4_000);
          return;
        }
        const result = await publicApi("/api/v1/facial/terminals/punch", {
          method: "POST",
          headers: { "X-Facial-Terminal-Token": token },
          body: JSON.stringify({
            employee_id: employee.id,
            auth_token: credential,
            event_type: eventType,
          }),
        });
        await rememberOnlinePunch({
          local_event_id: newLocalEventId(`online-${config.terminal.id}`),
          employee_id: employee.id,
          branch_id: config.branch.id,
          terminal_id: config.terminal.id,
          device_timestamp: new Date().toISOString(),
          event_type: eventType,
          confidence: 0,
          mode: "ONLINE",
          latitude: locationRef.current?.latitude ?? null,
          longitude: locationRef.current?.longitude ?? null,
          device_metadata: { app_version: getTerminalAppVersion(), source: "pwa" },
        }).catch(() => undefined);
        punchCooldownUntilRef.current = Date.now() + PUNCH_COOLDOWN_MS;
        setState("success");
        setMessage(result.message || `${eventLabel} registrada correctamente.`);
        resetTerminal(4_000);
      } catch (cause) {
        setState("error");
        setMessage(
          cause instanceof Error
            ? cause.message
            : "No se pudo registrar el marcaje.",
        );
        resetTerminal(2_500);
      }
    },
    [config, resetTerminal, token],
  );

  const recognize = useCallback(async () => {
    if (
      !token ||
      !cameraOn ||
      !config?.facial_enabled ||
      state !== "idle" ||
      busyRecognition.current ||
      !videoRef.current ||
      !canvasRef.current ||
      (online && !config.schedule.within_schedule) ||
      Date.now() < punchCooldownUntilRef.current ||
      (liveFaceState !== "one" && liveFaceState !== "error")
    ) {
      return;
    }
    const video = videoRef.current;
    if (video.videoWidth < 2) return;
    busyRecognition.current = true;
    setState("recognizing");
    setMessage("Rostro detectado · verificando autorización en tiempo real…");
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    const image = canvas.toDataURL("image/jpeg", 0.82);
    const handleLocalRecognition = async (): Promise<boolean> => {
      if (!config || !hasLocalFaceEngine()) return false;
      const local = await recognizeLocally(image, {
        token,
        branchId: config.branch.id,
        imageWidth: video.videoWidth,
        imageHeight: video.videoHeight,
        landmarks: latestFaceLandmarksRef.current || undefined,
      });
      if (!local) return false;
      const localAction = await getLocalAutomaticAction(
        local.employee_id,
        config.branch.id,
        config.schedule,
        config.automatic_punch,
      );
      const automaticAction: AutomaticAction = {
        enabled: true,
        available: localAction.available,
        event_type: localAction.event_type,
        label: localAction.label,
        description: localAction.description,
        reason: localAction.reason,
      };
      const employee = {
        id: local.template.employee_id,
        name: local.template.name,
        code: local.template.code,
        automatic_action: automaticAction,
      } as Candidate;
      setCandidate(employee);
      setAuthToken("");
      if (localAction.event_type) setPunchType(localAction.event_type);
      setState("recognized");
      if (localAction.available && localAction.event_type) {
        setMessage(
          `✅ ${employee.name} · rostro autorizado localmente · ${localAction.label}. Guardando sin conexión…`,
        );
        punchTimerRef.current = window.setTimeout(() => {
          void recordPunch(employee, "", localAction.event_type as PunchType, {
            confidence: local.confidence,
            device_timestamp: new Date().toISOString(),
          });
        }, AUTO_PUNCH_DELAY_MS);
      } else {
        setMessage(`✅ ${employee.name} · autorizado localmente. ${localAction.reason || "No hay que marcar ahora."}`);
        punchCooldownUntilRef.current = Date.now() + 4_500;
        resetTerminal(4_500);
      }
      return true;
    };
    try {
      if (!online) {
        if (await handleLocalRecognition()) return;
        setState("error");
        setMessage(
          hasLocalFaceEngine()
            ? "No se pudo reconocer el rostro localmente. Intenta con mejor luz."
            : "Sin Internet · esta terminal aún no tiene un motor facial local compatible.",
        );
        resetTerminal(2_500);
        return;
      }
      const result = await publicApi("/api/v1/facial/terminals/identify", {
        method: "POST",
        headers: { "X-Facial-Terminal-Token": token },
        body: JSON.stringify({ image }),
      });
      if (result.status === "recognized") {
        const automaticAction = result.automatic_action as
          | AutomaticAction
          | undefined;
        const nextEvent = automaticAction?.event_type;
        const employee = { ...result.employee, automatic_action: automaticAction } as Candidate;
        setCandidate(employee);
        setAuthToken(result.auth_token);
        if (nextEvent) setPunchType(nextEvent);
        setState("recognized");

        if (automaticAction?.enabled && automaticAction.available && nextEvent) {
          setMessage(
            `✅ ${employee.name} · rostro autorizado · ${automaticAction.label}. Registrando automáticamente…`,
          );
          punchTimerRef.current = window.setTimeout(() => {
            void recordPunch(employee, result.auth_token, nextEvent);
          }, AUTO_PUNCH_DELAY_MS);
        } else if (automaticAction?.enabled) {
          setMessage(
            `✅ ${employee.name} · rostro autorizado. ${automaticAction.reason || "No hay que marcar ahora."}`,
          );
          punchCooldownUntilRef.current = Date.now() + 4_500;
          resetTerminal(4_500);
        } else {
          setMessage("Identidad confirmada · selecciona el tipo de marcaje.");
        }
      } else if (result.status === "out_of_schedule") {
        setState("out_of_schedule");
        setMessage(result.message);
      } else if (result.status === "not_recognized") {
        setState("error");
        setMessage(`Alerta · ${result.message || "Rostro no reconocido. Intenta con buena luz."}`);
        resetTerminal(2_200);
      } else {
        setState("error");
        setMessage(result.message || "No se pudo reconocer el rostro.");
        resetTerminal(2_200);
      }
    } catch (cause) {
      setOnline(false);
      try {
        if (await handleLocalRecognition()) return;
      } catch {
        // El fallo del motor local no debe ocultar el error operativo.
      }
      setState("error");
      setMessage(
        cause instanceof Error
          ? cause.message
          : "No se pudo verificar el rostro.",
      );
      resetTerminal(2_200);
    } finally {
      busyRecognition.current = false;
    }
  }, [cameraOn, config, liveFaceState, online, recordPunch, resetTerminal, state, token]);

  useEffect(() => {
    if (!token || !cameraOn) return;
    recognizeTimer.current = window.setInterval(() => void recognize(), RECOGNITION_INTERVAL_MS);
    return () => {
      if (recognizeTimer.current) window.clearInterval(recognizeTimer.current);
    };
  }, [token, cameraOn, recognize]);

  function punch() {
    if (!candidate || !authToken) return;
    void recordPunch(candidate, authToken, punchType);
  }
  function lock() {
    const previousBranchId = config?.branch.id || "";
    stopCamera();
    void clearLocalFaceData(previousBranchId).catch(() => undefined);
    localStorage.removeItem(TOKEN_KEY);
    try {
      getAllSenderAndroidBridge()?.clearPaired?.();
    } catch {
      // La PWA continúa permitiendo el bloqueo sin puente nativo.
    }
    setToken("");
    setConfig(null);
    setPairingLocation(null);
    setDetectedBranch(null);
    setPairingStep("gps");
    setPin("");
    setCandidate(null);
    setAuthToken("");
    setState("idle");
    setPairingMessage("Código temporal de seis dígitos");
  }
  function toggleFullscreen() {
    if (!document.fullscreenElement)
      void document.documentElement.requestFullscreen().catch(() => undefined);
    else void document.exitFullscreen().catch(() => undefined);
  }

  const selected = PUNCHES.find((item) => item.id === punchType) || PUNCHES[0];
  const automaticMode = Boolean(config?.automatic_punch?.enabled);
  const statusColor =
    state === "success"
      ? "border-emerald-400 shadow-emerald-500/30"
      : state === "error"
        ? "border-rose-500 shadow-rose-500/30"
      : state === "out_of_zone"
        ? "border-rose-500 shadow-rose-500/30"
      : state === "out_of_schedule"
          ? "border-slate-600"
          : state === "recognized"
            ? "border-emerald-400 shadow-emerald-500/30"
            : liveFaceState === "multiple"
              ? "border-rose-400 shadow-rose-500/20"
            : "border-cyan-500/40 shadow-cyan-500/20";

  if (!token || !config)
    return (
      <div className="min-h-screen bg-[#050811] text-slate-100 flex items-center justify-center p-4">
        <div className="w-full max-w-lg rounded-3xl border-2 border-cyan-500/40 bg-slate-900/95 p-6 text-center shadow-2xl shadow-cyan-950/80 sm:p-8">
          <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl border border-cyan-400/30 bg-cyan-500/10">
            <ShieldCheck className="text-cyan-400" size={32} />
          </div>
          <p className="text-[11px] font-mono font-bold tracking-widest text-cyan-400">
            VINCULACIÓN DE TERMINAL
          </p>
          <h1 className="mt-2 text-2xl font-black">
            Activar tablet en sucursal
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Primero valida la ubicación GPS de la tablet y después introduce el
            código temporal de seis dígitos generado para esa sucursal.
          </p>
          <div className="mt-6 grid grid-cols-2 gap-2">
            <div className={`rounded-xl border p-3 text-left ${pairingStep === "gps" ? "border-cyan-400/70 bg-cyan-500/10" : "border-emerald-400/40 bg-emerald-500/10"}`}>
              <div className="flex items-center gap-2 text-xs font-bold text-cyan-300">
                <MapPin size={15} /> 1 · UBICACIÓN
              </div>
              <p className="mt-1 text-[11px] text-slate-400">
                {pairingLocation ? "Ubicación verificada" : "Confirma dónde está la tablet"}
              </p>
            </div>
            <div className={`rounded-xl border p-3 text-left ${pairingStep === "pin" ? "border-cyan-400/70 bg-cyan-500/10" : "border-slate-800 bg-slate-950/50"}`}>
              <div className="flex items-center gap-2 text-xs font-bold text-cyan-300">
                <KeyRound size={15} /> 2 · PIN
              </div>
              <p className="mt-1 text-[11px] text-slate-400">
                PIN de la sucursal detectada
              </p>
            </div>
          </div>
          {pairingStep === "pin" ? (
            <>
              <div className={`mt-5 rounded-xl border px-3 py-3 text-left text-xs ${detectedBranch?.within_radius ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-300" : detectedBranch ? "border-amber-400/40 bg-amber-500/10 text-amber-200" : "border-cyan-400/30 bg-cyan-500/10 text-cyan-200"}`}>
                <MapPin className="mr-1 inline" size={14} />
                {detectedBranch ? (
                  <>
                    <span className="font-bold">
                      {detectedBranch.within_radius ? "Sucursal detectada" : "Sucursal más cercana"}
                    </span>
                    <p className="mt-1 text-sm font-black text-white">{detectedBranch.name}</p>
                    <p className="mt-1 text-[11px] opacity-90">
                      {Math.round(detectedBranch.distance_meters)} m de distancia · radio permitido {Math.round(detectedBranch.radius_meters)} m
                    </p>
                    <p className="mt-2">
                      {detectedBranch.within_radius
                        ? "Introduce el PIN temporal de esta sucursal."
                        : "La ubicación está fuera del radio; corrige la ubicación de la sucursal o acércate antes de vincular."}
                    </p>
                  </>
                ) : (
                  "Ubicación obtenida. Introduce el PIN de la sucursal autorizada."
                )}
              </div>
              <div className="my-5 flex justify-center gap-2">
                {Array.from({ length: 6 }, (_, index) => (
                  <span
                    key={index}
                    className={`h-4 w-4 rounded-full border-2 ${index < pin.length ? "border-cyan-300 bg-cyan-300 shadow-[0_0_12px_#22d3ee]" : "border-slate-700"}`}
                  />
                ))}
              </div>
              <div className="mx-auto grid max-w-xs grid-cols-3 gap-2">
                {[
                  "1",
                  "2",
                  "3",
                  "4",
                  "5",
                  "6",
                  "7",
                  "8",
                  "9",
                  "clear",
                  "0",
                  "back",
                ].map((digit) => (
                  <button
                    key={digit}
                    className="rounded-xl border border-slate-700 bg-slate-800 py-3 font-mono text-lg font-bold hover:bg-slate-700"
                    onClick={() =>
                      digit === "clear"
                        ? setPin("")
                        : digit === "back"
                          ? setPin((old) => old.slice(0, -1))
                          : pressPin(digit)
                    }
                  >
                    {digit === "clear" ? (
                      "C"
                    ) : digit === "back" ? (
                      <Delete size={18} className="mx-auto" />
                    ) : (
                      digit
                    )}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="mt-3 text-xs font-semibold text-slate-400 underline underline-offset-2"
                onClick={() => {
                  setPairingLocation(null);
                  setDetectedBranch(null);
                  setPairingStep("gps");
                  setPin("");
                  setPairingMessage("Código temporal de seis dígitos");
                }}
              >
                Volver a validar ubicación
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={useGps}
              disabled={pairingBusy}
              className="mt-6 w-full rounded-2xl bg-gradient-to-r from-cyan-600 to-blue-600 py-3.5 font-bold disabled:opacity-50"
            >
              <Navigation className="mr-2 inline" size={18} />
              {pairingBusy
                ? "Validando coordenadas…"
                : "Permitir y validar ubicación"}
            </button>
          )}
          <p
            className={`mt-4 min-h-6 text-xs ${pairingMessage.includes("vinculada") ? "text-emerald-400" : "text-slate-400"}`}
          >
            {pairingMessage}
          </p>
          {!installed && installReady && (
            <button
              type="button"
              className="mt-3 w-full rounded-xl border border-cyan-400/40 bg-cyan-500/10 py-2 text-xs font-bold text-cyan-300"
              onClick={() => void triggerInstallPrompt()}
            >
              <ScanFace className="mr-1 inline" size={15} />
              Instalar terminal en esta tablet
            </button>
          )}
          <p className="mt-5 text-[11px] text-slate-500">
            La tablet quedará limitada a la sucursal cuya ubicación y PIN sean
            válidos. No se usa un PIN fijo ni datos demostrativos.
          </p>
        </div>
      </div>
    );

  return (
    <div className="relative flex h-screen w-screen select-none flex-col overflow-hidden bg-[#050811] font-sans text-slate-100">
      <div className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-cyan-600/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-blue-600/10 blur-3xl" />
      <header className="z-20 flex w-full items-center justify-between border-b border-cyan-500/20 bg-slate-950/75 px-4 py-3 shadow-2xl backdrop-blur-xl sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-tr from-cyan-600 to-blue-500">
            <div className="grid h-full w-full place-items-center rounded-[10px] bg-slate-950">
              <ScanFace className="text-cyan-400" size={23} />
            </div>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-[10px] font-mono font-bold uppercase tracking-widest text-cyan-400">
                {config.terminal.label}
              </span>
              <span className="hidden rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 sm:inline-flex">
                <span className="mr-1.5 h-1.5 w-1.5 animate-ping rounded-full bg-emerald-400" />
                EN LÍNEA
              </span>
            </div>
            <h1 className="truncate text-base font-extrabold sm:text-xl">
              {config.branch.name}
            </h1>
          </div>
        </div>
        <div className="hidden rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-1 text-center md:block">
          <div className="font-mono text-2xl font-black text-cyan-100">
            {clock.time}
          </div>
          <p className="text-[10px] uppercase tracking-wide text-slate-400">
            {clock.date}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-1 rounded-xl border border-slate-800 bg-slate-900/80 px-2 py-1.5 text-xs sm:inline-flex">
            {online ? (
              <Wifi className="text-emerald-400" size={15} />
            ) : (
              <WifiOff className="text-rose-400" size={15} />
            )}
            {online ? "Online" : "Offline"}
          </span>
          <span
            title="Estado de sincronización local"
            className={`hidden items-center gap-1 rounded-xl border px-2 py-1.5 text-[10px] font-semibold sm:inline-flex ${syncState === "syncing" ? "border-cyan-400/40 text-cyan-300" : pendingOffline > 0 ? "border-amber-400/40 text-amber-300" : syncState === "error" ? "border-rose-400/40 text-rose-300" : "border-slate-800 text-slate-400"}`}
          >
            {syncState === "syncing" ? "SINCRONIZANDO" : pendingOffline > 0 ? `${pendingOffline} PENDIENTE${pendingOffline === 1 ? "" : "S"}` : localFaceEngine ? "LOCAL LISTO" : "LOCAL NO DISPONIBLE"}
          </span>
          <span className="flex items-center gap-1 rounded-xl border border-slate-800 bg-slate-900/80 px-2 py-1.5 text-xs">
            <BatteryCharging
              className={
                battery !== null && battery <= config.battery.threshold
                  ? "text-rose-400"
                  : "text-emerald-400"
              }
              size={16}
            />
            {battery === null ? "—" : `${battery}%`}
          </span>
          <button
            title="Bloquear terminal"
            onClick={lock}
            className="rounded-xl border border-slate-800 bg-slate-900/80 p-2 text-slate-300 hover:text-amber-300"
          >
            <ShieldAlert size={17} />
          </button>
          <button
            title="Sonido"
            onClick={() => setAudio((value) => !value)}
            className="hidden rounded-xl border border-slate-800 bg-slate-900/80 p-2 text-slate-300 sm:block"
          >
            {audio ? <Volume2 size={17} /> : <VolumeX size={17} />}
          </button>
          <button
            title="Pantalla completa"
            onClick={toggleFullscreen}
            className="rounded-xl border border-slate-800 bg-slate-900/80 p-2 text-slate-300"
          >
            <Expand size={17} />
          </button>
        </div>
      </header>
      <main className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden p-3 sm:p-5">
        <div
          className={`relative flex h-[52vh] max-h-[650px] w-full max-w-3xl items-center justify-center overflow-hidden rounded-3xl border-2 bg-slate-950/70 shadow-2xl transition-all ${statusColor}`}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`absolute inset-0 h-full w-full object-cover ${cameraOn ? "block" : "hidden"}`}
          />
          <canvas ref={canvasRef} className="hidden" />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-slate-950/35 via-transparent to-slate-950/80" />
          {!cameraOn && (
            <div className="z-10 flex flex-col items-center p-6 text-center">
              <CameraOff className="mb-3 text-rose-400" size={42} />
              <h2 className="text-lg font-bold">Cámara en espera</h2>
              <p className="mt-1 max-w-sm text-xs text-slate-400">
                {cameraError ||
                  "Activa la cámara para iniciar el reconocimiento real."}
              </p>
              <button
                onClick={() => void startCamera()}
                className="mt-4 rounded-xl bg-cyan-600 px-4 py-2 text-xs font-bold text-slate-950"
              >
                <Camera className="mr-1 inline" size={16} />
                Activar cámara
              </button>
            </div>
          )}
          <div
              className={`relative z-10 flex h-64 w-52 items-center justify-center rounded-[42px] border-2 sm:h-80 sm:w-64 ${state === "success" ? "border-emerald-400 shadow-[0_0_40px_rgba(34,197,94,.45)]" : state === "error" || state === "out_of_zone" ? "border-rose-500 shadow-[0_0_40px_rgba(244,63,94,.35)]" : state === "recognized" ? "border-emerald-300 shadow-[0_0_40px_rgba(52,211,153,.45)]" : liveFaceState === "multiple" ? "border-rose-400" : "border-dashed border-cyan-400/50"}`}
          >
            <div className="absolute inset-7 rounded-full border border-cyan-300/30" />
            <div
              className={`h-24 w-24 rounded-full border ${state === "success" || state === "recognized" ? "border-emerald-300 bg-emerald-400/20" : state === "error" || state === "out_of_zone" || liveFaceState === "multiple" ? "border-rose-400 bg-rose-400/15" : "border-cyan-300 bg-cyan-400/10"} ${state === "recognizing" ? "animate-pulse" : ""}`}
            >
              <ScanFace
                className={`m-auto mt-7 ${state === "error" || state === "out_of_zone" || liveFaceState === "multiple" ? "text-rose-300" : state === "success" || state === "recognized" ? "text-emerald-300" : "text-cyan-300"}`}
                size={38}
              />
            </div>
            <span className="absolute -bottom-4 rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-[10px] font-mono text-cyan-300">
              {state === "success"
                ? "MARCADO"
                : state === "recognized"
                  ? "AUTORIZADO"
                : state === "recognizing"
                    ? "VERIFICANDO"
                    : state === "out_of_zone"
                      ? "ALERTA · FUERA DE ZONA"
                    : state === "error"
                      ? "ALERTA · NO RECONOCIDO"
                      : state === "out_of_schedule"
                        ? "FUERA DE HORARIO"
                      : "SENSOR EN ESPERA"}
            </span>
          </div>
          {state === "out_of_schedule" && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-slate-950/90 p-5 text-center">
              <Moon className="mb-3 text-cyan-400" size={48} />
              <h2 className="text-2xl font-black">Fuera de horario</h2>
              <p className="mt-2 text-sm text-slate-400">
                Horario facial: {config.schedule.start || "—"}–
                {config.schedule.end || "—"}
              </p>
            </div>
          )}
          {state === "out_of_zone" && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-slate-950/90 p-5 text-center">
              <MapPin className="mb-3 text-rose-400" size={48} />
              <h2 className="text-2xl font-black">Tablet fuera de zona</h2>
              <p className="mt-2 max-w-md text-sm text-slate-400">
                Acerca la tablet a {config.branch.name} para volver a habilitar
                el marcaje facial.
              </p>
            </div>
          )}
          {(state === "recognized" || state === "success") && candidate && (
            <div className="absolute inset-x-3 bottom-3 z-30 rounded-2xl border border-emerald-400/70 bg-slate-950/90 p-4 text-center shadow-lg">
              <p className="text-[10px] uppercase tracking-widest text-emerald-300">
                {state === "success"
                  ? "Marcaje confirmado"
                  : "Empleado autorizado"}
              </p>
              <h2 className="mt-1 text-xl font-black">{candidate.name}</h2>
              <p className="text-xs text-cyan-300">
                Código {candidate.code} · {config.branch.name}
              </p>
            </div>
          )}
        </div>
        <div className="mt-3 flex items-center gap-3 rounded-2xl border border-cyan-500/30 bg-slate-950/75 px-5 py-2 text-center shadow-lg">
          <span
            className={`h-3 w-3 rounded-full ${state === "error" || state === "out_of_zone" || liveFaceState === "multiple" ? "bg-rose-400" : state === "success" ? "bg-emerald-400" : "bg-cyan-400 animate-pulse"}`}
          />{" "}
          <p aria-live="assertive" className="text-sm font-medium sm:text-base">
            {statusMessage}
          </p>
        </div>
      </main>
      <footer className="z-20 w-full px-3 pb-3 sm:px-6">
        <div className="mx-auto max-w-5xl">
          {automaticMode && (
            <div className="rounded-2xl border border-indigo-400/40 bg-indigo-950/50 p-4 text-center">
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-indigo-300">
                MODO FÁCIL ACTIVADO
              </p>
              <p className="mt-1 text-xs text-slate-300">
                La tablet elegirá el siguiente paso según tu asistencia y el
                horario.
              </p>
            </div>
          )}
          {!automaticMode && (
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
              {PUNCHES.map((item) => {
                const Icon = item.icon;
                const style = PUNCH_STYLES[item.color];
                const active = punchType === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={pairingBusy}
                    aria-pressed={active}
                    onClick={() => setPunchType(item.id)}
                    className={`rounded-2xl border-2 p-3 text-left transition active:scale-95 ${active ? `${style.border} bg-slate-900/90` : "border-slate-800 bg-slate-900/60"} ${pairingBusy ? "cursor-not-allowed opacity-45" : "hover:border-slate-600"}`}
                  >
                    <Icon className={`mb-1 ${style.text}`} size={20} />
                    <p className="text-sm font-black">{item.label}</p>
                    <p className="text-[10px] text-slate-400">{item.desc}</p>
                  </button>
                );
              })}
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Crosshair size={14} className="text-cyan-400" />
              {config.mode === "facial_only" ? "Solo Facial" : "QR + Facial"} ·
              Horario {config.schedule.start || "—"}–
              {config.schedule.end || "—"}
              {config.terminal.within_branch_zone === false ? " · Tablet fuera de zona" : " · Tablet en zona"}
            </div>
            {state === "recognized" && !automaticMode && candidate && (
                <button
                  onClick={() => void punch()}
                  className="rounded-xl bg-emerald-500 px-4 py-2 text-xs font-black text-slate-950"
                >
                  <Check className="mr-1 inline" size={15} />
                  Confirmar {selected.label}
                </button>
              )}
            <span className="text-[10px] text-slate-500">
              {config.battery.alert_enabled
                ? `Alerta ≤${config.battery.threshold}%`
                : "Alertas de batería apagadas"}
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
