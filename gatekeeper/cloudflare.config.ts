import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, defineGadgetsWorker, textModules,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

/**
 * No secrets and no OAuth client: connecting runs gild's agent join flow, whose approval happens
 * on gild.gg. GILD_URL defaults to https://gild.gg in code; a self-hosted gild (celld) sets it.
 */
export default defineGadgetsWorker({
  name: "gatekeeper-gild",
  entrypoint: ".wrangler/validate/src/gild.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
  observability: OBSERVABILITY,
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
  rules: textModules(["**/*.txt"]),
} satisfies WranglerExtras;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "GildGatekeeperImpl"] },
];
