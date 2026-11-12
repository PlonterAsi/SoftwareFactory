import { defineConfig } from "vitest/config";

// Windows runners spawn git and node slowly; a full factory run on an on-disk
// database can pass 5 s there, so give each test room.
// The real-browser screen check (factory/screencheck.ts) is off in the suite: a browser per test round
// is slow on CI; test/engine.test.ts runs it on its own.
export default defineConfig({ test: { testTimeout: 30_000, env: { SF_SCREEN_CHECK: "off" } } });
