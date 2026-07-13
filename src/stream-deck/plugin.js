import { actionBinding, usageTileDataUrl } from "./usage-tile.js";

/** Routes Stream Deck events while keeping all provider polling in PluginCore. */
export class StreamDeckPlugin {
  #contexts = new Map();
  #states = new Map();
  #configuration = Promise.resolve();

  constructor({ core, send, configure = async () => {}, now = () => new Date(), providerMarks = {} }) {
    if (typeof core?.onWillAppear !== "function" || typeof core?.onSystemDidWakeUp !== "function") {
      throw new Error("StreamDeckPlugin requires a PluginCore lifecycle boundary");
    }
    if (typeof send !== "function") throw new Error("StreamDeckPlugin requires a Stream Deck sender");
    if (typeof configure !== "function") throw new Error("StreamDeckPlugin configuration must be a function");
    this.core = core;
    this.send = send;
    this.configure = configure;
    this.now = now;
    this.providerMarks = providerMarks;
  }

  publish(state) {
    this.#states.set(state.provider, state);
    for (const [context, binding] of this.#contexts) {
      if (binding.provider === state.provider) this.#render(context, binding, state);
    }
  }

  async handleEvent(event) {
    if (event?.event === "willAppear") {
      const binding = actionBinding(event.action);
      if (!binding) return;
      this.#contexts.set(event.context, binding);
      this.#render(event.context, binding, this.#states.get(binding.provider));
      await this.core.onWillAppear();
      return;
    }
    if (event?.event === "willDisappear") {
      this.#contexts.delete(event.context);
      return;
    }
    if (event?.event === "systemDidWakeUp") {
      await this.core.onSystemDidWakeUp();
      return;
    }
    if (event?.event === "didReceiveGlobalSettings") {
      this.#configuration = this.#configuration.catch(() => undefined).then(() => this.configure(event.payload?.settings ?? {}));
      await this.#configuration;
      return;
    }
    if (event?.event === "sendToPlugin" && event.payload?.event === "requestDiagnostics") {
      this.send({ event: "sendToPropertyInspector", action: event.action, context: event.context, payload: this.diagnosticsFor(event.action) });
      return;
    }
    if (event?.event === "sendToPlugin" && event.payload?.event === "requestCodexWindowKeeping") {
      if (typeof this.core.requestWindowKeeping !== "function") return;
      await this.core.requestWindowKeeping("codex");
      this.send({ event: "sendToPropertyInspector", action: event.action, context: event.context, payload: this.diagnosticsFor(event.action) });
    }
  }

  diagnosticsFor(action) {
    const binding = actionBinding(action);
    const state = binding ? this.#states.get(binding.provider) : undefined;
    const window = state?.windows?.find((candidate) => candidate.windowKind === binding?.windowKind);
    return {
      provider: binding?.provider ?? null,
      windowKind: binding?.windowKind ?? null,
      operationalState: state?.operationalState ?? "normal",
      observationQuality: window?.quality ?? "unknown",
      error: state?.error ?? null,
      resetAt: window?.resetAt instanceof Date ? window.resetAt.toISOString() : null,
      windowActivity: state?.windowActivity ?? "unknown",
      windowKeepingAction: state?.windowKeepingAction?.status ?? "not-enabled",
      observationComparison: state?.windowKeepingAction?.observationComparison ?? "unavailable",
    };
  }

  #render(context, binding, state) {
    const window = state?.windows?.find((candidate) => candidate.windowKind === binding.windowKind);
    const image = usageTileDataUrl({
      ...binding,
      window,
      operationalState: state?.operationalState,
      error: state?.error,
      now: this.now(),
      providerMarkUri: this.providerMarks[binding.provider],
    });
    this.send({ event: "setImage", context, payload: { image, target: 0 } });
  }
}
