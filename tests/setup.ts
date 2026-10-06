import { beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";

// Some Node/jsdom combinations leave localStorage undefined in the jsdom environment.
beforeEach(() => {
  if (typeof window !== "undefined" && globalThis.localStorage === undefined) {
    vi.stubGlobal("localStorage", new JSDOM("", { url: "https://test.local" }).window.localStorage);
  }
});
