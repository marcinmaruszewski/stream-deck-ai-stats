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

**Pace status**:
A user-facing classification of burn pace, including whether current consumption is likely to exhaust the allowance before the usage window ends.
_Avoid_: Limit status, token alert

**Window keeping**:
Automatic detection and prompt activation of an inactive usage window through a minimal agent interaction.
_Avoid_: Dummy chat, warm-up, activation button, scheduled activation

**Private release**:
An installable plugin package produced for personal use and optionally distributed through GitHub Releases, without marketplace publication.
_Avoid_: Marketplace release, public release
