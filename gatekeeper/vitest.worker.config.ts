import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

/**
 * The workerd project: the account, user and gatekeeper facet against a fake gild faked at
 * `fetch` (fake-gild.ts). The facet is reached through a `TestHooks` Durable Object, the way the
 * overseer instantiates it (ctx.facets).
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        compatibilityDate: "2026-09-04",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
        modulesRules: [{ type: "Text", include: ["**/*.txt"] }],
        durableObjects: {
          USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
          GILD_GATEKEEPER: { className: "GildGatekeeperImpl", useSQLite: true },
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
        },
        bindings: {
          BASE_URL: "http://localhost:8787/gatekeeper/gild",
          GILD_URL: "https://gild.test",
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
});
