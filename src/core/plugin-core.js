import { normalizeObservation, staleObservation } from "./usage-model.js";
import { createProviderAdapter, providerCapabilities } from "./contracts.js";

const FOUR_MINUTES = 4 * 60 * 1000;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const RETRY_DELAYS = [30 * 1000, 2 * 60 * 1000];

export class PluginCore {
  #providers;
  #states = new Map();
  #inFlight = new Map();
  #windowChecks = new Map();
  #recoveries = new Map();
  #cooldowns = new Map();
  #timer;

  constructor({ providers, now = () => new Date(), freshnessMs = 15 * 60 * 1000, settings = {}, ui = {}, wait = delay }) {
    this.#providers = providerMap(providers);
    this.now = now;
    this.freshnessMs = freshnessMs;
    this.settings = settings;
    this.ui = ui;
    this.wait = wait;
  }

  async configure({ providers, settings = {} } = {}) {
    await Promise.allSettled([...this.#providers.values()].map((provider) => provider.recover?.()));
    await Promise.allSettled([...this.#inFlight.values(), ...this.#windowChecks.values()]);
    this.#providers = providerMap(providers);
    this.settings = settings;
    for (const providerId of this.#states.keys()) {
      if (!this.#providers.has(providerId)) this.#states.delete(providerId);
    }
    await this.runCycle();
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
    this.#recreateSchedule();
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  onWillAppear() {
    this.#recreateSchedule();
    return this.#recoverAndRun();
  }

  onSystemDidWakeUp() {
    this.#recreateSchedule();
    return this.#recoverAndRun();
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
      this.#publishFailure(providerId, usageReadFailure(error));
    }
  }

  async #recoverAndRun() {
    const availableProviders = (await Promise.all([...this.#providers.keys()].map(async (id) => {
      try {
        await this.#recoverProvider(id);
        return id;
      } catch {
        this.#publishFailure(id, "Transport recovery failed");
        return null;
      }
    }))).filter(Boolean);
    await Promise.all(availableProviders.map((id) => this.refreshProvider(id)));
    return Promise.all(availableProviders.map((id) => this.#checkWindowKeeping(id)));
  }

  #recreateSchedule() {
    clearInterval(this.#timer);
    this.#timer = setInterval(() => void this.runCycle(), FOUR_MINUTES);
  }

  async #recoverProvider(providerId) {
    if (this.#recoveries.has(providerId)) return this.#recoveries.get(providerId);
    const provider = this.#provider(providerId);
    const recovery = Promise.resolve(provider.recover?.()).finally(() => this.#recoveries.delete(providerId));
    this.#recoveries.set(providerId, recovery);
    return recovery;
  }

  async #checkWindowKeeping(providerId) {
    if (this.#windowChecks.has(providerId)) return this.#windowChecks.get(providerId);
    const work = this.#runWindowKeeping(providerId).finally(() => this.#windowChecks.delete(providerId));
    this.#windowChecks.set(providerId, work);
    return work;
  }

  async #runWindowKeeping(providerId) {
    const provider = this.#provider(providerId);
    if (!this.settings[providerId]?.windowKeepingEnabled) return;
    if (!providerCapabilities(provider).windowKeeping) {
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
      this.#publishFailure(providerId, "Window keeping failed");
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

  #publishFailure(providerId, error) {
    const { error: previousError, errorCode: previousErrorCode, ...state } = this.stateFor(providerId);
    const failure = typeof error === "string" ? { message: error } : error;
    this.#publish({
      ...state,
      operationalState: "error",
      windows: state.windows.map(staleObservation),
      error: failure.message,
      ...(failure.code ? { errorCode: failure.code } : {}),
    });
  }
}

function usageReadFailure(error) {
  const messages = {
    "authentication-required": "Provider authentication is required",
    "unsupported-version": "Provider version is unsupported",
    "snapshot-unavailable": "Provider usage snapshot is unavailable",
    "malformed-data": "Provider usage data was malformed",
    "command-unavailable": "Provider CLI is unavailable",
    "command-failed": "Provider usage command failed",
    "configuration-required": "Provider configuration is incomplete",
  };
  const code = error?.code;
  return code && messages[code]
    ? { code, message: messages[code] }
    : { message: "Usage observation unavailable" };
}

function providerMap(providers) {
  if (!Array.isArray(providers)) throw new Error("PluginCore requires a provider list");
  const adapters = new Map(providers.map((provider) => {
    const adapter = createProviderAdapter(provider);
    return [adapter.id, adapter];
  }));
  if (adapters.size !== providers.length) throw new Error("Provider identifiers must be unique");
  return adapters;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resetDiscontinuity(previous, current) {
  return previous?.resetAt instanceof Date
    && current.resetAt instanceof Date
    && previous.usageProgress !== null
    && current.usageProgress !== null
    && (previous.resetAt.getTime() !== current.resetAt.getTime()
      || current.usageProgress < previous.usageProgress);
}
