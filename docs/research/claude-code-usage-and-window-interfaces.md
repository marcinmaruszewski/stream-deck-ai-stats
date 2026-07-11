# Claude Code usage and window-keeping interfaces

Research date: 2026-07-12  
Scope: Windows (native and WSL2) and macOS; Claude.ai-plan usage through the user's installed Claude Code; no separate API credentials.

## Recommendation

**Shipping constraint:** Anthropic states that Claude.ai OAuth is for ordinary use of Claude Code and native Anthropic applications, and that third-party developers may not offer Claude.ai login or route requests through Free/Pro/Max credentials on users' behalf. Therefore a distributable Stream Deck product must not ship the plan-authenticated keep-window turn without Anthropic approval; it needs approved use or API/cloud-provider authentication instead. A private, user-operated local wrapper that only launches the user's installed CLI still avoids token extraction, but the policy does not explicitly bless that product pattern, so treat approval as a release gate. [Anthropic legal and compliance guidance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)

Subject to that gate, the technically supported local design uses two deliberately separate mechanisms:

1. **Usage display:** install a small Claude Code `statusLine` collector that copies the `rate_limits` object from its stdin JSON into an owner-only snapshot file. The Stream Deck plugin reads that file. This is the only documented Claude Code interface that exposes both the five-hour and seven-day subscription windows as structured data. The collector runs locally and consumes no API tokens, but the limits are present only for Claude.ai Pro/Max subscribers and only after the first API response in a Claude Code session. A snapshot is therefore a cache, not an on-demand quota API. [Claude Code status-line data contract](https://code.claude.com/docs/en/statusline#available-data), [rate-limit example](https://code.claude.com/docs/en/statusline#rate-limit-usage)
2. **Window-starting interaction:** make this an explicit opt-in action that runs one tiny, tool-free, non-persistent `claude -p` turn and validates its structured result. A real model turn consumes plan usage and is the smallest documented operation that certainly counts as Claude activity. Do not describe it as extending a window: Anthropic documents a five-hour rolling/session window and a reset timestamp, but does not promise that later prompts move that timestamp. [CLI print mode](https://code.claude.com/docs/en/cli-reference), [usage and limits](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work)

There is no documented standalone Claude Code command or public local API that returns a fresh full quota snapshot. `/usage` and Claude Settings > Usage are human interfaces. `rate_limit_event` is a structured event, but it is emitted when a session encounters a rate limit and represents one rate-limit observation; it is not a replacement for the two-window status-line snapshot. [Agent SDK `SDKRateLimitEvent`](https://platform.claude.com/docs/en/agent-sdk/typescript#sdkratelimitevent), [usage-settings guidance](https://support.claude.com/en/articles/9797557-usage-limit-best-practices)

Local inspection of the first-party 2.1.207 implementation also found that the status-line runner is mounted by the interactive UI and is not invoked by `claude -p`. Do not attempt to combine the collector and keep-window turn through an invocation-local `statusLine` override.

## Supported interfaces and their limits

| Interface | Structured | Reuses Claude Code login | Model usage | Appropriate role |
| --- | --- | --- | --- | --- |
| `statusLine` stdin JSON | Yes: `rate_limits.five_hour` and `.seven_day` | Yes, because it runs inside the signed-in CLI session | None for the script itself | Recommended snapshot producer |
| `/usage` in the TUI | No documented parser contract | Yes | No additional model turn for the command itself | Manual diagnosis/cross-check |
| Claude Settings > Usage | Human web UI | Browser session | None | Manual source of truth and extra-cap visibility |
| `claude auth status` | Yes, JSON plus exit code | Reads the CLI login | None | Authentication preflight only; no quota fields |
| `claude -p --output-format json` | Yes, one result object | Yes, unless a higher-precedence credential overrides it | Yes | Explicit window-starting action and completion proof |
| Agent SDK `rate_limit_event` | Yes, one event | Depends on SDK/CLI auth configuration | A session is already running | Warning/rejection handling only |

Claude Code's documented `rate_limits` schema was introduced in version 2.1.80. A plugin relying on it should require at least that version and test against a pinned baseline; the locally verified baseline in this research was 2.1.207. [Claude Code changelog, 2.1.80](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#2180)

## Usage snapshot contract

Claude Code runs the configured status-line command and sends one JSON document on stdin. The relevant portion is:

```json
{
  "version": "2.1.207",
  "rate_limits": {
    "five_hour": {
      "used_percentage": 23.5,
      "resets_at": 1738425600
    },
    "seven_day": {
      "used_percentage": 41.2,
      "resets_at": 1738857600
    }
  }
}
```

The example values above are illustrative values from Anthropic's schema, not the user's usage. The contract is:

- `used_percentage` is the percentage consumed, from 0 through 100. Remaining percentage is `max(0, 100 - used_percentage)`.
- `resets_at` is Unix epoch seconds. Treat it as authoritative and convert it to local time only for display.
- `rate_limits` is absent before the first API response and for non-Claude.ai subscription authentication. `five_hour` and `seven_day` can each be absent independently.
- The documented object exposes one five-hour and one seven-day window. Anthropic may also enforce other weekly, monthly, model, or feature caps; the schema cannot represent all such limits. Settings > Usage remains the manual fallback for those. [Status-line fields and absence rules](https://code.claude.com/docs/en/statusline#available-data), [Pro-plan limit policy](https://support.claude.com/en/articles/8325606-what-is-the-pro-plan)

The collector should read all stdin, validate JSON, extract only the fields above plus `version`, write a temporary file with user-only permissions, then atomically replace the prior snapshot. It should print a short harmless line to stdout because Claude Code displays that output as the status line. Keep the last valid snapshot if a later invocation is malformed or lacks `rate_limits`; record its capture time separately so the plugin can mark it stale.

Claude Code normally invokes the status-line command after each assistant message and on several local state changes, debounced by 300 ms. If a new update arrives while the command is still running, Claude Code cancels the old invocation. The command must therefore be fast and use an atomic write. A configured `refreshInterval` only re-runs the local command with the session's current data; it does not make an API request and must not be treated as a fresh server read. [Status-line lifecycle](https://code.claude.com/docs/en/statusline#how-status-lines-work)

### Platform placement

- **macOS:** use the native `claude` process and a native shell collector. Claude Code stores login credentials in the encrypted macOS Keychain. [Credential management](https://code.claude.com/docs/en/authentication#credential-management)
- **Windows native:** use native Claude Code and a PowerShell or Git Bash collector. Native credentials live in `%USERPROFILE%\.claude\.credentials.json`. Claude Code runs status-line commands through Git Bash when installed, otherwise PowerShell; use forward slashes in command paths because Git Bash consumes unquoted backslashes. [Windows status-line configuration](https://code.claude.com/docs/en/statusline#windows-configuration), [credential management](https://code.claude.com/docs/en/authentication#credential-management)
- **WSL2:** install and invoke Claude Code inside the distribution and use the Linux collector. Its default credential file is WSL's `~/.claude/.credentials.json`; it is distinct from native Windows `%USERPROFILE%\.claude\.credentials.json`. Sign in separately inside WSL rather than copying or parsing credentials. Browser callback failure is common in WSL2, and Claude Code supports copying the login URL/code instead. [Authentication flow](https://code.claude.com/docs/en/authentication#log-in-to-claude-code), [installation on WSL](https://code.claude.com/docs/en/setup#install-claude-code)

Claude Code supports native Windows 10 1809+ / Windows Server 2019+, macOS 13+, and Linux distributions used by WSL. WSL does not need Git for Windows. [System requirements and Windows setup](https://code.claude.com/docs/en/setup#system-requirements)

## Authentication reuse without API credentials

Run `claude auth status` before either operation. The documented contract is JSON by default, exit code 0 when logged in, and exit code 1 otherwise. Do not log or persist identity fields from its JSON; the plugin only needs the boolean/login method needed to explain configuration errors. [CLI authentication commands](https://code.claude.com/docs/en/cli-reference#cli-commands)

For plan usage, require subscription OAuth (`claude.ai`) and ensure no higher-precedence credential changes billing. Claude Code chooses cloud-provider credentials first, then `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, and finally the subscription OAuth created by `/login`. In non-interactive `-p` mode an `ANTHROPIC_API_KEY` is always used when present, which would bill the API instead of the plan. The plugin should fail closed or clearly report the mismatch rather than silently perform the keep-window turn. [Authentication precedence](https://code.claude.com/docs/en/authentication#authentication-precedence), [Pro/Max Claude Code billing](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)

Never read, copy, or parse `.credentials.json` or Keychain records. Let the installed CLI manage and refresh them. This also preserves the platform security boundary and avoids shipping a bearer credential inside plugin state. [Credential management](https://code.claude.com/docs/en/authentication#credential-management)

### Important 2.1.207 version caveat

Local first-party CLI evidence on 2026-07-12:

```text
$ claude --version
2.1.207 (Claude Code)

$ claude auth status
{"loggedIn":true,"authMethod":"claude.ai",...}
```

In 2.1.207, `claude --help` states that `--bare` skips keychain reads and accepts Anthropic auth only from `ANTHROPIC_API_KEY` or `apiKeyHelper`; OAuth/keychain are never read. Therefore **do not use `--bare`** for a subscription-authenticated keep-window operation, even though it looks attractive for minimal startup. Use `--safe-mode` instead: the documented contract disables customizations while leaving authentication, model selection, built-in tools, and permissions operational. [CLI `--safe-mode`](https://code.claude.com/docs/en/cli-reference#cli-flags)

This is version-sensitive behavior. Check `claude --version`, keep an integration probe, and re-evaluate flags whenever the supported baseline changes.

## Smallest reliable window-starting interaction

Use a fresh, non-persistent print-mode turn with all tools removed and customizations disabled:

```text
claude -p --output-format json --no-session-persistence \
  --tools "" --safe-mode --permission-mode dontAsk \
  "Reply with exactly OK."
```

On PowerShell, pass the same arguments as a normal argument array rather than relying on the Unix line-continuation form shown above. The operation should run in an empty temporary directory, with a bounded wall-clock timeout and stdout/stderr captured separately.

Why these flags:

- `-p` makes the operation non-interactive; `json` returns one machine-readable result.
- `--safe-mode` suppresses user/project customizations while preserving normal authentication.
- `--no-session-persistence` avoids saving a resumable conversation.
- `--tools ""` removes built-in tools; safe mode disables ordinary MCP/customization discovery. Admin-managed policy still applies.
- `dontAsk` prevents an unattended permission prompt.
- The one-line user prompt keeps the requested output small.

These flags and their semantics are documented in the [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference#cli-flags). A lightweight model such as Haiku can reduce consumption, but model availability changes by account and time; reliability is better if the plugin uses the account's current default unless model discovery is implemented. Anthropic describes Haiku as the fastest/cheapest option and `/model` as the account-specific source of truth. [Models, usage, and limits](https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code)

This interaction consumes usage. Anthropic says every turn sends conversation/project context plus the prompt to the model; the isolated command minimizes those inputs but cannot make them zero. [What consumes tokens](https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code#what-actually-consumes-tokens)

## Command and output contracts

### Authentication preflight

```text
command: claude auth status
success: exit code 0 and valid JSON with loggedIn == true
failure: exit code 1, invalid JSON, timeout, or loggedIn != true
```

Additionally verify that the active method/provider is subscription OAuth and reject API-key/cloud-provider environments for this feature unless the product explicitly supports paid API usage.

### Keep-window turn

Parse stdout as one JSON object. The locally verified 2.1.207 success object included `type`, `subtype`, `is_error`, `api_error_status`, `duration_ms`, `duration_api_ms`, `num_turns`, `result`, `stop_reason`, `session_id`, `usage`, `modelUsage`, `permission_denials`, and `terminal_reason`. The minimal command above returned `type: "result"`, `subtype: "success"`, `is_error: false`, `num_turns: 1`, `result: "OK"`, and `terminal_reason: "completed"` using the existing Claude.ai Pro login.

The Agent SDK's first-party type contract additionally defines:

- assistant messages with `type: "assistant"` and an optional error including `authentication_failed`, `billing_error`, or `rate_limit`;
- exactly one final result message. Success has `type: "result"`, `subtype: "success"`, `is_error: false`, plus duration, turn count, usage, and model-usage fields. Error subtypes include execution, max-turn, budget, and structured-output failures;
- in streaming mode, optional `rate_limit_event` messages with status `allowed`, `allowed_warning`, or `rejected`, and optional `resetsAt`/`utilization`.

[Agent SDK message types](https://platform.claude.com/docs/en/agent-sdk/typescript#message-types), [result contract](https://platform.claude.com/docs/en/agent-sdk/typescript#sdkresultmessage), [rate-limit event](https://platform.claude.com/docs/en/agent-sdk/typescript#sdkratelimitevent)

Accept the keep-window operation only when the process exits zero and the object is `result/success` with `is_error == false` (and, where present, `terminal_reason == "completed"`). Treat malformed JSON, timeout, nonzero exit, authentication/billing/rate-limit errors, or any error result subtype as failure. The textual `OK` is useful as a sanity check but is not the primary completion signal.

Do not interpret an `allowed` `rate_limit_event` as the full current quota. The current public web reference does not promise both windows or a window discriminator. A locally cached first-party Agent SDK 0.2.141 type adds `rateLimitType` values for five-hour, generic and model-specific seven-day windows, and overage, but that difference itself demonstrates version skew. Use the event only to improve a warning message and tolerate additive fields.

### Snapshot freshness

A stored snapshot should include:

```json
{
  "captured_at": "2026-07-12T12:34:56Z",
  "claude_code_version": "2.1.207",
  "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
  "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
}
```

If `now >= resets_at`, display that window as awaiting a fresh observation rather than inventing a new zero-percent window; a new backend window may not exist until another turn. Show the capture age. A keep-window turn and status-line snapshot update are separate successes: the turn may complete while the snapshot remains stale.

## Window timing semantics

Anthropic documents the short limit as a five-hour rolling/session window. The status-line payload exposes its exact server-provided `resets_at`. Pro's weekly limit resets at a fixed account-assigned time each week, unchanged by when the user begins using Claude; the status line calls this the `seven_day` window and exposes its reset timestamp. [Status-line rate limits](https://code.claude.com/docs/en/statusline#rate-limit-usage), [Pro plan limits](https://support.claude.com/en/articles/8325606-what-is-the-pro-plan)

Consequences for “window keeping”:

- A passive status-line refresh does not consume tokens and cannot start or extend a usage window.
- A successful model turn is the minimum supported way to create account activity. The client should then observe the backend-provided reset timestamp; public documentation does not specify the exact transition when no short window was previously active.
- Do not repeatedly ping during an active window to “keep it alive.” No primary source promises reset extension, and the authoritative `resets_at` should be expected to remain unchanged until the window rolls over.
- Weekly timing is not controllable by keep-window prompts. It is fixed for the account on Pro, and all Claude surfaces share plan usage. [Shared usage limits](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work), [usage monitoring](https://support.claude.com/en/articles/9797557-usage-limit-best-practices)

The safest scheduler is therefore edge-triggered: if the user explicitly asks to establish a window and the last five-hour snapshot is absent or expired, perform at most one minimal turn, then wait for/attempt a normal snapshot update. Never run periodic hidden turns.

## Failure modes to design for

- `claude` is missing, not on `PATH`, older than 2.1.80, or its flags differ from the verified baseline.
- The native-Windows and WSL installations are different versions or only one environment is signed in.
- Subscription OAuth is absent/expired, or `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, a cloud-provider selector, gateway session, or `apiKeyHelper` takes precedence and changes billing.
- `--bare` is used on 2.1.207 and suppresses OAuth/keychain access.
- The user has Pro/Max auth but `rate_limits` or one window is absent before the first response, during backend degradation, or because the account exposes a different limit set.
- A model-specific or additional weekly/monthly cap exists but is not representable by the two-window status-line schema.
- The status-line collector is disabled by `disableAllHooks`, blocked by workspace trust, non-executable, slow, cancelled by a newer update, or writes partial/corrupt JSON. [Status-line troubleshooting](https://code.claude.com/docs/en/statusline#troubleshooting)
- Native Windows path separators are consumed by Git Bash, PowerShell policy blocks the script, or WSL writes the snapshot where the native plugin cannot read it.
- The last snapshot is stale even though its reset timestamp is in the future; other Claude surfaces share the allowance and may consume it without this local collector observing an update.
- The keep turn loads unexpected configuration or tools because isolation flags were omitted or unsupported. Pin the baseline and include a separate stream-mode integration test that verifies the `init` event's tool/MCP sets and permission mode.
- Network, proxy, Anthropic service, managed policy, model availability, or account capacity causes retries, timeout, or an error result.
- A successful turn is mistaken for proof that `resets_at` moved; completion proves activity, not a particular backend window transition.

## Local evidence

Read-only local checks on 2026-07-12 established:

- installed Claude Code version `2.1.207`;
- `claude auth status` returned exit 0, `loggedIn: true`, `authMethod: "claude.ai"`, `apiProvider: "firstParty"`, and a Pro subscription (identity fields intentionally omitted);
- current `--help` documents the `--bare` OAuth/keychain restriction described above;
- the exact minimal `--safe-mode` JSON command recommended above completed with exit 0, one successful turn, `result: "OK"`, and `terminal_reason: "completed"` through the existing Claude.ai Pro login;
- static inspection of the first-party 2.1.207 implementation found that `statusLine` runs only from the interactive UI component, not in print/headless mode;
- the implementation contains an authenticated internal usage endpoint and richer model-specific windows, but neither is a documented integration surface. The plugin must not read credentials or call that endpoint directly;
- the local historical `stats-cache.json` has aggregate sessions/messages/tokens but no live utilization/reset timestamps, so it cannot replace the status-line snapshot.

The recommended architecture therefore keeps the channels separate: normal interactive Claude Code sessions produce snapshots; the isolated keep-window action reports its own success and cannot refresh that snapshot.

## Decision-ready conclusion

For macOS, native Windows, and WSL2, a private local implementation can call the user's installed Claude Code in the same environment where they signed in. Collect short/long plan usage through the supported `statusLine` JSON contract and persist only a sanitized, timestamped snapshot. Use `claude auth status` for preflight. The technically smallest verified “window keeping” action is one `claude -p --safe-mode` model turn with no tools or persistence and structured completion validation. Do not extract OAuth credentials, scrape the TUI, call an undocumented quota endpoint, assume all caps fit the two-window schema, or claim prompts extend reset times. Before distributing this as a third-party product, resolve Anthropic's OAuth policy gate; absent approval, the no-separate-API-credentials requirement is not shippable.
