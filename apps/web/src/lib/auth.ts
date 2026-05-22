export const DASHBOARD_PASSWORD_STORAGE_KEY = "agent-hub.dashboard.password";

interface DashboardAuthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface DashboardAuthRuntime {
  username: string;
  defaultPassword?: string;
  storage: DashboardAuthStorage;
  prompt(message: string): string | null;
  encode(value: string): string;
}

interface DashboardAuthEnv {
  DEV?: boolean;
  VITE_AGENT_HUB_DASHBOARD_PASSWORD?: string;
}

export function resolveDashboardDefaultPassword(env: DashboardAuthEnv): string | undefined {
  return env.VITE_AGENT_HUB_DASHBOARD_PASSWORD ?? (env.DEV === true ? "admin" : undefined);
}

export function buildDashboardAuthHeaders(runtime: DashboardAuthRuntime): Record<string, string> {
  const cachedPassword = runtime.storage.getItem(DASHBOARD_PASSWORD_STORAGE_KEY);
  const password = runtime.defaultPassword
    ?? cachedPassword
    ?? runtime.prompt("Agent Hub dashboard password");

  if (cachedPassword === null && runtime.defaultPassword === undefined && password !== null) {
    runtime.storage.setItem(DASHBOARD_PASSWORD_STORAGE_KEY, password);
  }

  return {
    Authorization: `Basic ${runtime.encode(`${runtime.username}:${password ?? ""}`)}`,
  };
}

export function authHeaders(): Record<string, string> {
  return buildDashboardAuthHeaders({
    username: import.meta.env.VITE_AGENT_HUB_DASHBOARD_USER ?? "admin",
    defaultPassword: resolveDashboardDefaultPassword(import.meta.env),
    storage: window.sessionStorage,
    prompt: window.prompt.bind(window),
    encode: window.btoa.bind(window),
  });
}
