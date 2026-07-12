# Use a provider-neutral plugin core with platform transports

The plugin uses one Node.js backend whose core owns scheduling, freshness, forecasting, retries, and UI state; provider adapters translate provider-specific I/O through a `ProcessTransport` abstraction. Windows native is the default transport, WSL2 is an explicitly selected alternative, and macOS uses its native CLI. Usage reading and window keeping are separate contracts, with window keeping an optional provider capability; Claude window keeping remains unavailable until the required policy approval exists.

## Consequences

- The Property Inspector only owns configuration and diagnostics; it does not run CLI processes or polling.
- `onWillAppear` and `onSystemDidWakeUp` must recreate transport resources, processes, and timers idempotently.
- The plugin persists only non-secret settings and sanitized UI/cache data; CLI credentials remain owned by the provider CLIs.
- Provider adapters and transports can be tested independently from the Stream Deck UI and from each other.
