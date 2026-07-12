import { normalizeObservation, staleObservation } from "./usage-model.js";

const FOUR_MINUTES = 4 * 60 * 1000;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const RETRY_DELAYS = [30 * 1000, 2 * 60 * 1000];

export class PluginCore {
  #providers;
  #states = new Map();
  #inFlight = new Map();
  #cooldowns = new Map();
  #timer;

  constructor({ providers, now = () => new Date(), freshnessMs = 15 * 60 * 1000, settings = {}, ui = {}, wait = delay }) {
    this.#providers = new Map(providers.map((provider) => [provider.id, provider]));
    if (this.#providers.size !== providers.length) throw new Error("Provider identifiers must be unique");
    this.now = now;
    this.freshnessMs = freshnessMs;
    this.settings = settings;
    this.ui = ui;
    this.wait = wait;
  }

  stateFor(providerId) {
    return this.#states.get(providerId) ?? { provider: providerId, operationalState: "normal", windows: [] };
  }

  async refreshProvider(providerId) {
    if (this.#inFlight.has(providerId)) return this.#inFlight.get(providerId);
    const work = this.#refreshProvider(providerId).finally(() => this.#inFlight.delete(providerId));
    this.#inFlight.set(providerId, work);
    return work;
  }

  async runCycle() {
    await Promise.all([...this.#providers.keys()].map((id) => this.refreshProvider(id)));
    await Promise.all([...this.#providers.keys()].map((id) => this.#checkWindowKeeping(id)));
  }

  start() {
    if (this.#timer) return;
    void this.runCycle();
    this.#timer = setInterval(() => void this.runCycle(), FOUR_MINUTES);
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  onWillAppear() {
    return this.runCycle();
  }

  onSystemDidWakeUp() {
    return this.runCycle();
  }

  async #refreshProvider(providerId) {
    const provider = this.#provider(providerId);
    try {
      const observations = await provider.usageReader.read();
      if (!Array.isArray(observations)) throw new Error("UsageReader must return an observation list");
      const previousWindows = this.stateFor(providerId).windows;
      const windows = observations.map((observation) => {
        const normalized = normalizeObservation(
          { ...observation, provider: providerId },
          { now: this.now(), freshnessMs: this.freshnessMs },
        );
        const previous = previousWindows.find((window) => window.windowKind === normalized.windowKind);
        return resetDiscontinuity(previous, normalized)
          ? { ...normalized, resetDiscontinuity: true }
          : normalized;
      });
      this.#publish({ provider: providerId, operationalState: "normal", windows });
    } catch (error) {
      this.#publish({
        provider: providerId,
        operationalState: "error",
        windows: this.stateFor(providerId).windows.map(staleObservation),
        error: error instanceof Error ? error.message : "Usage observation failed",
      });
    }
  }

  async #checkWindowKeeping(providerId) {
    const provider = this.#provider(providerId);
    if (!this.settings[providerId]?.windowKeepingEnabled) return;
    if (!provider.windowKeeper) {
      this.#publish({ ...this.stateFor(providerId), operationalState: "unsupported" });
      return;
    }

    try {
      const verdict = await provider.windowKeeper.getActivityVerdict();
      if (verdict === "active") this.#cooldowns.delete(providerId);
      if (verdict !== "inactive" || this.#inCooldown(providerId)) return;

      await this.#keepWithRetries(providerId, provider.windowKeeper);
      this.#cooldowns.set(providerId, this.now().getTime() + FIFTEEN_MINUTES);
      this.#publish({ ...this.stateFor(providerId), operationalState: "window-keeping" });
    } catch (error) {
      this.#publish({
        ...this.stateFor(providerId),
        operationalState: "error",
        error: error instanceof Error ? error.message : "Window keeping failed",
      });
    }
  }

  async #keepWithRetries(providerId, windowKeeper) {
    let lastFailure = new Error("Window keeping did not produce a validated completion");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await windowKeeper.keepWindow({ provider: providerId, model: this.settings[providerId]?.windowKeepingModel });
        if (result?.completed === true) return;
        lastFailure = new Error("Window keeping did not produce a validated completion");
      } catch (error) {
        lastFailure = error instanceof Error ? error : new Error("Window keeping failed");
      }
      if (attempt < RETRY_DELAYS.length) await this.wait(RETRY_DELAYS[attempt]);
    }
    throw lastFailure;
  }

  #inCooldown(providerId) {
    return (this.#cooldowns.get(providerId) ?? 0) > this.now().getTime();
  }

  #provider(providerId) {
    const provider = this.#providers.get(providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    return provider;
  }

  #publish(state) {
    this.#states.set(state.provider, state);
    this.ui.publish?.(state);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resetDiscontinuity(previous, current) {
  return previous?.resetAt instanceof Date
    && current.resetAt instanceof Date
    && previous.usageProgress !== null
    && current.usageProgress !== null
    && previous.resetAt.getTime() !== current.resetAt.getTime()
    && current.usageProgress < previous.usageProgress;
}
