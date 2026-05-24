import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import type { Page, DashboardLanguage } from "../lib/types.js";
import { getTranslations } from "../i18n/translations.js";

interface DashboardContextValue {
  page: Page;
  setPage: (page: Page) => void;
  projectScope: string | null;
  setProjectScope: (id: string | null) => void;
  language: DashboardLanguage;
  setLanguage: (lang: DashboardLanguage) => void;
  t: (key: string) => string;
  socketStatus: "connected" | "disconnected" | "connecting";
  setSocketStatus: (s: "connected" | "disconnected" | "connecting") => void;
}

const Ctx = createContext<DashboardContextValue | null>(null);

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<Page>(() => (window.location.hash.slice(1) as Page) || "overview");
  const [projectScope, setProjectScope] = useState<string | null>(null);
  const [language, setLanguage] = useState<DashboardLanguage>(() => {
    const stored = localStorage.getItem("agent-hub.dashboard.language");
    return (stored === "zh" || stored === "en") ? stored : "zh";
  });
  const [socketStatus, setSocketStatus] = useState<"connected" | "disconnected" | "connecting">("connecting");

  const translations = getTranslations(language);
  const t = useCallback((key: string) => translations[key] ?? key, [translations]);

  const setPageWrapped = useCallback((p: Page) => {
    setPage(p);
    window.location.hash = p;
  }, []);

  return (
    <Ctx.Provider value={{ page, setPage: setPageWrapped, projectScope, setProjectScope, language, setLanguage, t, socketStatus, setSocketStatus }}>
      {children}
    </Ctx.Provider>
  );
}

export function useDashboard(): DashboardContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDashboard must be used within DashboardProvider");
  return ctx;
}
