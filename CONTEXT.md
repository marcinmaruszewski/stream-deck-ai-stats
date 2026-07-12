# AI Usage Monitoring

This context describes how a single Stream Deck user observes and manages time-bounded AI-agent usage allowances.

## Language

**Usage window**:
A provider-defined period during which a finite AI usage allowance is consumed, such as a rolling five-hour period.
_Avoid_: Session, billing period

**Usage progress**:
The fraction of the allowance consumed within the current usage window.
_Avoid_: Token count, quota progress

**Window kind**:
The role of a usage window within a provider's plan, such as short-term or long-term. It distinguishes independent allowances and is not a user session or billing period.
_Avoid_: Window level, session type

**Usage observation**:
A point-in-time report of usage progress and reset timing for one usage window. An observation may be incomplete or stale when provider data is unavailable or delayed, and the provider may externally change the reset timing or progress between observations.
_Avoid_: Usage event, token sample

**Observation provenance**:
Whether a value was reported by the provider or derived by the plugin from an observation and elapsed time.
_Avoid_: Confidence score

**Observation quality**:
The completeness and freshness of a usage observation, expressed as `fresh`, `stale`, `incomplete`, or `unknown`. A quality marker may also explain a reset discontinuity reported by the provider.
_Avoid_: Sync status, validity flag

**Reset discontinuity**:
A provider-reported change in usage progress or reset timing that breaks continuity with the previous usage observation, potentially because an allowance was reset externally. It starts a new forecast basis and is not evidence of user consumption.
_Avoid_: Usage rollback, quota bug

**Data freshness**:
The recency of a usage observation compared with now. Freshness determines whether the observation can drive current pace and forecast status, not whether its reported value is discarded.
_Avoid_: Data validity, sync status

**Awaiting fresh observation**:
A usage window whose provider-reported reset time has passed, but for which the plugin has not received a new usage observation for the next window. It is shown as stale rather than assumed to have zero usage.
_Avoid_: Reset to zero, inactive window

**Burn pace**:
The relationship between elapsed time and usage progress that indicates whether the allowance is being consumed sustainably.
_Avoid_: Burn rate, token speed

**Exhaustion forecast**:
An estimate of whether the current burn pace would consume an allowance before its usage window ends. It is an estimate, not a provider fact, and is unknown when the usage observation or elapsed-window data is insufficient.
_Avoid_: Limit prediction, quota forecast

**Pace delta**:
The percentage-point difference between elapsed time in a usage window and usage progress. A positive value means usage is behind elapsed time; a negative value means usage is ahead of elapsed time.
_Avoid_: Token delta, session score

**Pace status**:
A user-facing classification of burn pace: `unknown`, `on-track`, `at-risk`, or `likely-to-exhaust`, including whether current consumption is likely to exhaust the allowance before the usage window ends.
_Avoid_: Limit status, token alert

**Pace accent**:
The status color applied together to a usage tile's progress ring, large usage-progress value, and pace delta. It makes a pace status legible before its numeric details are read.
_Avoid_: Provider color, decorative color

**Usage tile**:
One Stream Deck key that presents exactly one provider's usage window. A four-tile layout has separate keys for the five-hour and seven-day windows of Codex and Claude Code.
_Avoid_: Provider summary tile, combined usage tile

**Provider accent**:
A low-contrast provider-specific background mark used only to help identify a usage tile. It does not convey usage progress or pace status.
_Avoid_: Provider status color, provider alert color

**Operational badge**:
A small top-right marker on a usage tile for an operational condition independent of pace status: red exclamation for error, pulsing blue reset mark for active window keeping, amber clock for stale data, or no badge when normal.
_Avoid_: Pace badge, provider badge

**Window keeping**:
An explicitly user-requested minimal provider interaction. Its completion proves only that the interaction completed; it does not establish whether a usage window became active, reset, or was extended.
_Avoid_: Dummy chat, warm-up, scheduled activation

**Window-keeping action status**:
The visible outcome of an explicitly requested window-keeping action: not enabled, requested, completed, or failed. It is separate from a window activity verdict and from the provider-reported usage observation.
_Avoid_: Window state, activation result

**Window activity verdict**:
A provider-confirmed classification of a short-term usage window as `active`, `inactive`, or `unknown`; `unknown` never authorizes window keeping.
_Avoid_: Inferred activity, progress-change signal

**Window-keeping model**:
The provider model selected for the minimal interaction that keeps a usage window active; it is independent of the model the user normally chooses.
_Avoid_: Display model, default model

**Private release**:
An installable plugin package produced for personal use and optionally distributed through GitHub Releases, without marketplace publication.
_Avoid_: Marketplace release, public release
