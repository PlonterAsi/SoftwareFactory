import { defineConfig } from "vitest/config";

// Windows runners spawn git and node slowly; a full factory run on an on-disk
// database can pass 5 s there, so give each test room.
export default defineConfig({ test: { testTimeout: 30_000 } });
