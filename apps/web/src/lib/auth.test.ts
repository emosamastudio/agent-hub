import { describe, expect, test, vi } from "vitest";
import { buildDashboardAuthHeaders, resolveDashboardDefaultPassword } from "./auth";

function createStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) {
    values.set("agent-hub.dashboard.password", initial);
  }
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

describe("dashboard auth headers", () => {
  test("uses the development password only outside production builds", () => {
    expect(resolveDashboardDefaultPassword({ DEV: true })).toBe("admin");
    expect(resolveDashboardDefaultPassword({ DEV: false })).toBeUndefined();
    expect(resolveDashboardDefaultPassword({ DEV: false, VITE_AGENT_HUB_DASHBOARD_PASSWORD: "secret" })).toBe("secret");
  });

  test("uses a configured default password without prompting", () => {
    const storage = createStorage();
    const prompt = vi.fn(() => "secret-password");

    const headers = buildDashboardAuthHeaders({
      username: "admin",
      defaultPassword: "admin",
      storage,
      prompt,
      encode: (value) => btoa(value),
    });

    expect(headers.Authorization).toBe("Basic YWRtaW46YWRtaW4=");
    expect(prompt).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  test("prompts and caches when no default password is configured", () => {
    const storage = createStorage();
    const prompt = vi.fn(() => "secret-password");

    const headers = buildDashboardAuthHeaders({
      username: "admin",
      storage,
      prompt,
      encode: (value) => btoa(value),
    });

    expect(headers.Authorization).toBe("Basic YWRtaW46c2VjcmV0LXBhc3N3b3Jk");
    expect(prompt).toHaveBeenCalledOnce();
    expect(storage.setItem).toHaveBeenCalledWith(
      "agent-hub.dashboard.password",
      "secret-password",
    );
  });

  test("reuses the session password without prompting again", () => {
    const storage = createStorage("cached-password");
    const prompt = vi.fn(() => "wrong-password");

    const headers = buildDashboardAuthHeaders({
      username: "admin",
      storage,
      prompt,
      encode: (value) => btoa(value),
    });

    expect(headers.Authorization).toBe("Basic YWRtaW46Y2FjaGVkLXBhc3N3b3Jk");
    expect(prompt).not.toHaveBeenCalled();
  });

  test("uses the configured default password before stale session storage", () => {
    const storage = createStorage("stale-password");
    const prompt = vi.fn(() => "wrong-password");

    const headers = buildDashboardAuthHeaders({
      username: "admin",
      defaultPassword: "admin",
      storage,
      prompt,
      encode: (value) => btoa(value),
    });

    expect(headers.Authorization).toBe("Basic YWRtaW46YWRtaW4=");
    expect(prompt).not.toHaveBeenCalled();
  });
});
