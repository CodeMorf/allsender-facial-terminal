/** PWA Marcaje — Android desde versiones viejas hasta las nuevas + iOS */

export type PwaPlatform = "android" | "ios" | "desktop" | "other";

export type AndroidBrowser =
  | "chrome"
  | "samsung"
  | "firefox"
  | "opera"
  | "edge"
  | "huawei"
  | "miui"
  | "webview"
  | "other";

export type AndroidInfo = {
  isAndroid: boolean;
  version: number | null; // major Android version e.g. 8, 10, 14
  browser: AndroidBrowser;
  browserLabel: string;
  supportsInstallPrompt: boolean; // beforeinstallprompt
  supportsServiceWorker: boolean;
  isWebView: boolean;
  guideTitle: string;
  steps: string[];
};

export function isStandaloneDisplay(): boolean {
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) return true;
    if (window.matchMedia("(display-mode: fullscreen)").matches) return true;
    if (window.matchMedia("(display-mode: minimal-ui)").matches) return true;
    const nav = window.navigator as Navigator & { standalone?: boolean };
    if (nav.standalone === true) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export function detectPlatform(): PwaPlatform {
  const ua = navigator.userAgent || "";
  const isIos =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && (navigator as any).maxTouchPoints > 1);
  if (isIos) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Mobile|Tablet/i.test(ua)) return "other";
  return "desktop";
}

export function isMobileDevice(): boolean {
  const p = detectPlatform();
  if (p === "android" || p === "ios" || p === "other") return true;
  try {
    if (window.matchMedia("(pointer: coarse)").matches && window.innerWidth < 900) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** Parse Android version from UA: "Android 9" / "Android 14" / "Android 4.4.2" */
export function getAndroidVersion(ua = navigator.userAgent): number | null {
  const m = ua.match(/Android\s+([\d.]+)/i);
  if (!m) return null;
  const major = parseInt(m[1].split(".")[0], 10);
  return Number.isFinite(major) ? major : null;
}

export function detectAndroidBrowser(ua = navigator.userAgent): AndroidBrowser {
  // Order matters
  if (/; wv\)|WebView|Version\/\d+\.\d+ Chrome\/\d+/i.test(ua) && /Android/i.test(ua) && !/Chrome\/\d+\.\d+\.\d+\.\d+ Mobile/i.test(ua)) {
    // rough webview
  }
  if (/\bwv\b|; wv\)/i.test(ua) || (/Android/i.test(ua) && /Version\/\d+\.\d+/i.test(ua) && /Chrome\//i.test(ua) && !/Chrome\/\d+\.\d+\.\d+\.\d+/i.test(ua))) {
    return "webview";
  }
  // Facebook/Instagram/WhatsApp in-app browsers
  if (/FBAN|FBAV|Instagram|Line\/|WhatsApp|MicroMessenger|Twitter/i.test(ua)) {
    return "webview";
  }
  if (/SamsungBrowser/i.test(ua)) return "samsung";
  if (/HuaweiBrowser|HBPC|HMSCore/i.test(ua)) return "huawei";
  if (/MiuiBrowser|XiaoMi/i.test(ua)) return "miui";
  if (/EdgA|Edg\//i.test(ua)) return "edge";
  if (/OPR\/|Opera/i.test(ua)) return "opera";
  if (/Firefox|FxiOS/i.test(ua)) return "firefox";
  if (/Chrome|CriOS/i.test(ua)) return "chrome";
  return "other";
}

export function getAndroidInfo(): AndroidInfo {
  const ua = navigator.userAgent || "";
  const isAndroid = /Android/i.test(ua);
  const version = isAndroid ? getAndroidVersion(ua) : null;
  const browser = isAndroid ? detectAndroidBrowser(ua) : "other";
  const supportsServiceWorker = "serviceWorker" in navigator;
  // beforeinstallprompt roughly Chrome 68+ / Android 5+ with modern Chrome
  const supportsInstallPrompt =
    isAndroid &&
    (browser === "chrome" || browser === "edge" || browser === "samsung" || browser === "opera") &&
    (version == null || version >= 5);

  const isWebView = browser === "webview";
  let browserLabel = "Navegador";
  const labels: Record<AndroidBrowser, string> = {
    chrome: "Google Chrome",
    samsung: "Samsung Internet",
    firefox: "Firefox",
    opera: "Opera",
    edge: "Microsoft Edge",
    huawei: "Navegador Huawei",
    miui: "Navegador Xiaomi",
    webview: "App interna (WhatsApp/Facebook)",
    other: "Navegador Android",
  };
  browserLabel = labels[browser];

  let guideTitle = "Instalar en Android";
  let steps: string[] = [];

  if (isWebView) {
    guideTitle = "Abre esto en Chrome (importante)";
    steps = [
      "Arriba a la derecha toca ⋮ o el menú",
      "Toca «Abrir en Chrome» o «Abrir en el navegador»",
      "Si no sale: copia el enlace y ábrelo en la app Chrome",
      "Luego vuelve aquí y toca INSTALAR AHORA",
    ];
  } else if (browser === "chrome" || browser === "edge") {
    if (version != null && version <= 7) {
      guideTitle = "Android antiguo — instalar fácil";
      steps = [
        "Arriba a la derecha toca los 3 puntitos ⋮",
        "Toca «Añadir a pantalla de inicio» o «Add to Home screen»",
        "Toca «Añadir» o «Instalar»",
        "Ve a tu pantalla de inicio y abre el icono «Marcaje»",
      ];
    } else {
      guideTitle = "Android — instalar con 1 toque";
      steps = [
        "Toca el botón verde INSTALAR AHORA",
        "En la ventanita toca «Instalar»",
        "Si no sale ventanita: ⋮ → «Instalar aplicación»",
        "Cierra Chrome y abre el icono «Marcaje»",
      ];
    }
  } else if (browser === "samsung") {
    guideTitle = "Samsung Internet — instalar";
    steps = [
      "Abajo o arriba toca el menú ☰ o ⋮",
      "Toca «Añadir página a» → «Pantalla de inicio»",
      "O toca «Instalar» si aparece",
      "Abre el icono «Marcaje» desde tu pantalla",
    ];
  } else if (browser === "firefox") {
    guideTitle = "Firefox Android — instalar";
    steps = [
      "Toca los 3 puntitos ⋮",
      "Toca «Instalar» o «Añadir a pantalla de inicio»",
      "Confirma «Añadir»",
      "Abre el icono «Marcaje»",
    ];
  } else if (browser === "opera") {
    guideTitle = "Opera Android — instalar";
    steps = [
      "Toca el logo O abajo a la derecha",
      "Toca «Añadir a» → «Pantalla de inicio»",
      "Confirma",
      "Abre el icono «Marcaje»",
    ];
  } else if (browser === "huawei" || browser === "miui") {
    guideTitle = `${browserLabel} — instalar`;
    steps = [
      "Toca el menú ⋮",
      "Busca «Añadir a pantalla de inicio» o «Instalar»",
      "Confirma «Añadir»",
      "Abre el icono «Marcaje»",
    ];
  } else {
    guideTitle = "Instalar en tu Android";
    steps = [
      "Toca el menú del navegador (⋮ o ☰)",
      "Busca «Añadir a pantalla de inicio» o «Instalar aplicación»",
      "Toca «Añadir» o «Instalar»",
      "Abre el icono «Marcaje» en tu teléfono",
    ];
  }

  return {
    isAndroid,
    version,
    browser,
    browserLabel,
    supportsInstallPrompt,
    supportsServiceWorker,
    isWebView,
    guideTitle,
    steps,
  };
}

export function ensureEmpleadoPwaHead(): void {
  document.title = "Marcaje · AllSender";

  const setMeta = (name: string, content: string) => {
    let el = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null;
    if (!el) {
      el = document.createElement("meta");
      el.name = name;
      document.head.appendChild(el);
    }
    el.content = content;
  };

  setMeta("theme-color", "#0f172a");
  setMeta("mobile-web-app-capable", "yes");
  setMeta("apple-mobile-web-app-capable", "yes");
  setMeta("apple-mobile-web-app-status-bar-style", "black-translucent");
  setMeta("apple-mobile-web-app-title", "Marcaje");
  setMeta("application-name", "Marcaje AllSender");
  setMeta("format-detection", "telephone=no");
  setMeta(
    "viewport",
    "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
  );

  let manifest = document.querySelector('link[rel="manifest"]') as HTMLLinkElement | null;
  if (!manifest) {
    manifest = document.createElement("link");
    manifest.rel = "manifest";
    document.head.appendChild(manifest);
  }
  // cache-bust for all Android
  manifest.href = "/manifest-empleado.json?v=20260722192536";

  // multi-size icons for old launchers
  const iconSizes = [48, 72, 96, 144, 192, 512];
  for (const s of iconSizes) {
    const rel = "icon";
    const href = `/pwa/icon-${s}.png`;
    let link = document.querySelector(`link[rel="${rel}"][sizes="${s}x${s}"]`) as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.rel = rel;
      link.setAttribute("sizes", `${s}x${s}`);
      link.type = "image/png";
      document.head.appendChild(link);
    }
    link.href = href;
  }
  let apple = document.querySelector('link[rel="apple-touch-icon"]') as HTMLLinkElement | null;
  if (!apple) {
    apple = document.createElement("link");
    apple.rel = "apple-touch-icon";
    document.head.appendChild(apple);
  }
  apple.href = "/pwa/apple-touch-icon.png";
}

export async function registerEmpleadoServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    // older Android Chrome: register without updateViaCache if fails
    let reg: ServiceWorkerRegistration;
    try {
      reg = await navigator.serviceWorker.register("/sw-empleado.js", {
        scope: "/",
        updateViaCache: "none",
      });
    } catch {
      reg = await navigator.serviceWorker.register("/sw-empleado.js", { scope: "/" });
    }
    try {
      reg.update();
    } catch {
      /* ignore */
    }
    return reg;
  } catch (e) {
    console.warn("[PWA] SW register failed", e);
    return null;
  }
}

type BIPEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

let deferredPrompt: BIPEvent | null = null;
const bipListeners = new Set<(e: BIPEvent | null) => void>();

export function getDeferredInstallPrompt(): BIPEvent | null {
  const w = window as any;
  if (deferredPrompt) return deferredPrompt;
  if (w.__pwaDeferredPrompt) {
    deferredPrompt = w.__pwaDeferredPrompt as BIPEvent;
    return deferredPrompt;
  }
  return null;
}

export function onInstallPromptAvailable(cb: (e: BIPEvent | null) => void): () => void {
  bipListeners.add(cb);
  const p = getDeferredInstallPrompt();
  if (p) cb(p);
  return () => bipListeners.delete(cb);
}

export function bindBeforeInstallPrompt(): () => void {
  const handler = (e: Event) => {
    e.preventDefault();
    deferredPrompt = e as BIPEvent;
    (window as any).__pwaDeferredPrompt = e;
    bipListeners.forEach((cb) => cb(deferredPrompt));
  };
  const installed = () => {
    deferredPrompt = null;
    (window as any).__pwaDeferredPrompt = null;
    bipListeners.forEach((cb) => cb(null));
  };
  const early = (window as any).__pwaDeferredPrompt;
  if (early) {
    deferredPrompt = early as BIPEvent;
    setTimeout(() => bipListeners.forEach((cb) => cb(deferredPrompt)), 0);
  }
  window.addEventListener("beforeinstallprompt", handler);
  window.addEventListener("appinstalled", installed);
  window.addEventListener("pwa-prompt-ready", () => {
    const p = (window as any).__pwaDeferredPrompt;
    if (p) {
      deferredPrompt = p as BIPEvent;
      bipListeners.forEach((cb) => cb(deferredPrompt));
    }
  });
  return () => {
    window.removeEventListener("beforeinstallprompt", handler);
    window.removeEventListener("appinstalled", installed);
  };
}

export async function triggerInstallPrompt(): Promise<"accepted" | "dismissed" | "unavailable"> {
  // refresh from early capture
  const p = getDeferredInstallPrompt();
  if (!p) return "unavailable";
  try {
    await p.prompt();
    const choice = await p.userChoice;
    deferredPrompt = null;
    (window as any).__pwaDeferredPrompt = null;
    bipListeners.forEach((cb) => cb(null));
    return choice.outcome;
  } catch {
    return "unavailable";
  }
}

export function copyInstallLink(): boolean {
  try {
    const url = window.location.origin + "/empleado-check";
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url);
      return true;
    }
    const ta = document.createElement("textarea");
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return true;
  } catch {
    return false;
  }
}
