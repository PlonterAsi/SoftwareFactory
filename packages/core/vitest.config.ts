import { defineConfig } from "vitest/config";

// Windows runners spawn git and node slowly; a full factory run on an on-disk
// database can pass 5 s there, so give each test room.
// The real-browser screen check (factory/screencheck.ts) is off in the suite: a browser per test round
// is slow on CI; test/engine.test.ts runs it on its own.
export default defineConfig({ test: { // A test that runs a whole factory run takes 2 s alone and has passed 30 s on the Windows runner when every file runs at once.
  testTimeout: 90_000, env: { SF_SCREEN_CHECK: "off", SF_LINK_CHECK: "off" } } });
