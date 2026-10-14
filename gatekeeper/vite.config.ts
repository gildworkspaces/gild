import { defineConfig } from "vite-plus";
import { vitestTask } from "@gadgets/scripts/vitest-task";

/**
 * Vite+ settings: a two-pass `test` task -- pure logic (git objects and packs, checked against
 * the real `git`) in Node, and the gatekeeper facet against a fake gild in workerd.
 */
export default defineConfig({
  run: {
    tasks: {
      test: vitestTask(["vitest run", "vitest run -c vitest.worker.config.ts"]),
    },
  },
});
