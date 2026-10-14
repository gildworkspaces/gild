/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { TestHooks } from "./workerd/worker.js";
import type { UserAccount } from "../src/gild.js";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
      USER_ACCOUNT: DurableObjectNamespace<UserAccount>;
      BASE_URL: string;
      GILD_URL: string;
    }
  }
}
