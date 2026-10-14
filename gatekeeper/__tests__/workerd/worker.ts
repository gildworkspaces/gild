// Test worker: re-exports the production entrypoints so miniflare binds the Durable Objects, and
// adds TestHooks, which instantiates the gatekeeper as a facet (as the overseer does) and forwards
// calls to it and to the sessions it hands out. Results ride back as plain data.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { ActionDescription, ConnectHandoff, GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import type { GildGatekeeperImpl, GildGatekeeperProps } from "../../src/gild-gatekeeper.js";
import { GildUser as ProductionGildUser, GildVerifier as ProductionGildVerifier } from "../../src/gild.js";

export { default } from "../../src/gild.js";
export * from "../../src/gild.js";

/**
 * Under the capnweb-validate vite plugin, decorated `WorkerEntrypoint` exports are not registered
 * in `ctx.exports` (the production build registers them). An undecorated subclass under the same
 * name is, with the exact production behaviour, and shadows the `export *` above, so production
 * code reaching `ctx.exports.GildUser` gets it.
 */
export class GildUser extends ProductionGildUser {}
export class GildVerifier extends ProductionGildVerifier {}

/** The Workshop's connect callback, persisted by the account like the real one. */
export class TestCallback extends WorkerEntrypoint {
  async complete(_user: Fetcher<GatekeeperUser>): Promise<ConnectHandoff> {
    return { targetOrigin: "http://localhost:8787", ticket: "ticket-complete" };
  }
  async reconnectComplete(stageId: string): Promise<ConnectHandoff> {
    return { targetOrigin: "http://localhost:8787", ticket: stageId };
  }
  async credentialsExpired(): Promise<void> {}
  async credentialsRestored(): Promise<void> {}
}

/** The overseer's approval queue: records observations and submitted actions. */
export class RecordingQueue extends RpcTarget {
  readonly submitted: Array<{ id: number; description: ActionDescription }> = [];
  readonly observations: string[] = [];
  async authorizeObservation(description: { title: string }): Promise<void> {
    this.observations.push(description.title);
  }
  async submitAction(id: number, description: ActionDescription): Promise<void> {
    this.submitted.push({ id, description });
  }
}

export type Outcome<T> = { ok: T } | { error: string };

async function outcome<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: await fn() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

type Session = Record<string, (...args: unknown[]) => Promise<unknown>>;

export class TestHooks extends DurableObject<Cloudflare.Env> {
  #queues = new Map<string, RecordingQueue>();
  #sessions = new Map<string, Session>();

  #facet(name: string, props: GildGatekeeperProps): GildGatekeeperImpl {
    return this.ctx.facets.get<GildGatekeeperImpl>(name, () => ({
      class: (this.ctx.exports as unknown as {
        GildGatekeeperImpl(o: { props: GildGatekeeperProps }): DurableObjectClass<GildGatekeeperImpl>;
      }).GildGatekeeperImpl({ props }),
    })) as unknown as GildGatekeeperImpl;
  }

  #queue(name: string): RecordingQueue {
    let queue = this.#queues.get(name);
    if (!queue) this.#queues.set(name, queue = new RecordingQueue());
    return queue;
  }

  async #session(name: string, props: GildGatekeeperProps): Promise<Session> {
    let session = this.#sessions.get(name);
    if (!session) {
      session = await this.#facet(name, props).startSession(new RpcStub(this.#queue(name)) as never) as unknown as Session;
      this.#sessions.set(name, session);
    }
    return session;
  }

  /** Calls a session method, as an agent's `executeCode` would. */
  async call(name: string, props: GildGatekeeperProps, method: string, args: unknown[]): Promise<Outcome<unknown>> {
    return outcome(async () => {
      const result = await (await this.#session(name, props))[method]!(...args);
      return result === undefined ? null : JSON.parse(JSON.stringify(result));
    });
  }

  async apply(name: string, props: GildGatekeeperProps, id: number): Promise<Outcome<null>> {
    return outcome(async () => {
      await this.#facet(name, props).applyAction(id);
      return null;
    });
  }

  async reject(name: string, props: GildGatekeeperProps, id: number): Promise<Outcome<null>> {
    return outcome(async () => {
      await this.#facet(name, props).rejectAction(id);
      return null;
    });
  }

  queueLog(name: string): { submitted: Array<{ id: number; title: string; complete: boolean }>; observations: string[] } {
    const queue = this.#queue(name);
    return {
      submitted: queue.submitted.map(s => ({ id: s.id, title: s.description.title, complete: s.description.descriptionIsComplete === true })),
      observations: [...queue.observations],
    };
  }

  /** `GildUser.getGatekeeperClassFor(url)`: the narrowing check, by outcome. */
  async attach(userObjectId: string, url: string): Promise<Outcome<string>> {
    const user = (this.ctx.exports as unknown as { GildUser(o: { props: { userObjectId: string } }): GatekeeperUser }).GildUser({ props: { userObjectId } });
    return outcome(async () => (await user.getGatekeeperClassFor(url)).resource.urlPattern);
  }

  /** Stores a Workshop callback and a connect nonce on an account, as `connectAccount` does. */
  async beginConnect(userObjectId: string, nonce: string): Promise<void> {
    const ns = this.ctx.exports.UserAccount as unknown as DurableObjectNamespace<import("../../src/gild.js").UserAccount>;
    const callback = (this.ctx.exports as unknown as { TestCallback(o: object): Fetcher }).TestCallback({});
    await ns.get(ns.idFromString(userObjectId)).setCallback(callback as never, nonce);
  }
}
