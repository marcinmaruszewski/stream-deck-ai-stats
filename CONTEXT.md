# AI Usage Monitoring

This context describes how a single Stream Deck user observes and manages time-bounded AI-agent usage allowances.

## Language

**Usage window**:
A provider-defined period during which a finite AI usage allowance is consumed, such as a rolling five-hour period.
_Avoid_: Session, billing period

**Usage progress**:
The fraction of the allowance consumed within the current usage window.
_Avoid_: Token count, quota progress

**Burn pace**:
The relationship between elapsed time and usage progress that indicates whether the allowance is being consumed sustainably.
_Avoid_: Burn rate, token speed

**Pace delta**:
The percentage-point difference between elapsed time in a usage window and usage progress. A positive value means usage is behind elapsed time; a negative value means usage is ahead of elapsed time.
_Avoid_: Token delta, session score

**Pace status**:
A user-facing classification of burn pace, including whether current consumption is likely to exhaust the allowance before the usage window ends.
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
Automatic detection and prompt activation of an inactive usage window through a minimal agent interaction.
_Avoid_: Dummy chat, warm-up, activation button, scheduled activation

**Private release**:
An installable plugin package produced for personal use and optionally distributed through GitHub Releases, without marketplace publication.
_Avoid_: Marketplace release, public release
