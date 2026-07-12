# Codex inactive-window signal

Research date: 2026-07-13  
Scope: Whether a documented Codex interface can authoritatively classify the short-term usage window as inactive.

## Decision

No documented Codex interface provides an authoritative `inactive` signal. The Codex **window activity verdict** must therefore remain `unknown` for a usage observation; the plugin must not authorize a turn from `usedPercent`, `resetsAt`, a missing value, or a difference between observations.

Replace automatic window keeping with an explicit user-triggered fallback. On request, run the existing minimal `codex exec --json` interaction, require a successful exit and a `turn.completed` JSONL event, then read the rate limits again. That establishes only the **window-keeping action status** as completed. It does not establish that the usage window was started, reset, or extended.

## Evidence

- [`account/rateLimits/read`](https://learn.chatgpt.com/docs/app-server#7-rate-limits-chatgpt) documents the current quota snapshot, including `usedPercent`, `windowDurationMins`, `resetsAt`, and rate-limit state. It has no field or event for window activity, an inactive window, or a window start.
- The [official Codex app-server protocol source](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#7-rate-limits-chatgpt) describes the same rate-limit fields and sparse updates; it likewise defines no activity classification.
- [`codex exec --json`](https://learn.chatgpt.com/docs/non-interactive-mode#make-output-machine-readable) emits machine-readable turn lifecycle events, including `turn.completed` and `turn.failed`. A completed event proves the requested turn completed, not a change to a provider usage window.

## Required visible state

Show these independently:

- the provider-reported usage observation (usage progress, reset time, and observation time);
- `Window activity: unknown` when no documented provider activity verdict exists;
- the window-keeping action status: not enabled, requested, completed, or failed; and
- after an action, the observed before/after comparison: usage/reset changed, unchanged, or unavailable.

Never label a window active or inactive from an inferred or incomplete usage observation.

## Local impact

`createCodexWindowKeeper().getActivityVerdict()` currently calls any short-term observation with a `Date` `resetAt` `active`. That is an unsupported inference; the implementation needs a follow-up change to return `unknown` for this data and expose the explicit-action state instead.
