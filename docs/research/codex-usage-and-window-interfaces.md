# Codex usage and window-keeping interfaces

Research date: 2026-07-12  
Scope: Windows (native and WSL2) and macOS; local Codex/ChatGPT-plan usage; no API-key provisioning.

## Recommendation

Use a short-lived `codex app-server` subprocess over stdio to read plan usage. After the required `initialize`/`initialized` handshake, issue `account/rateLimits/read`, prefer `rateLimitsByLimitId`, and fall back to the backward-compatible `rateLimits` snapshot. This is the smallest documented machine-readable interaction: it performs no model turn, consumes the existing Codex login, and returns both short- and long-term windows when the service exposes them.

Treat “window keeping” as a separate operation. A rate-limit read is passive and cannot prove that a usage window was started or extended. The smallest supported interaction that definitely performs Codex work is a non-interactive `codex exec` turn with a tiny no-tools prompt. Completion must be established by process exit plus the JSONL `turn.completed` event. Re-read the limits afterward. OpenAI’s public documentation does **not** promise that a minimal turn moves `resetsAt`, nor does it define the windows as sliding; the backend values remain authoritative.

## Available interfaces

| Interface | Windows/WSL2 | macOS | Machine-readable | Reuses existing login | Suitability |
| --- | --- | --- | --- | --- | --- |
| `codex app-server` + `account/rateLimits/read` | Native Windows CLI or CLI inside WSL2 | Native CLI | Yes: request/response JSONL over stdio | Yes, from that CLI environment’s `CODEX_HOME` | Recommended for the plugin |
| Interactive `/status` | Native, WSL2 | Native | No stable parser contract | Yes | Manual diagnosis only |
| Codex usage dashboard | Browser | Browser | No documented local machine API | Browser session | Manual cross-check |
| `codex exec --json` | Native, WSL2 | Native | Yes: event JSONL | Yes | Only when a real turn is intentionally required |
| ChatGPT desktop app | Native Windows; can use WSL2 agent | Native macOS | No documented plugin-facing quota contract | Own signed-in app session | Human UI, not the plugin boundary |

The desktop app is officially available on both Windows and macOS. Windows also has a native CLI/sandbox; WSL2 remains appropriate for Linux-native workflows. WSL1 stopped being supported after Codex 0.114. [Quickstart](https://learn.chatgpt.com/docs/quickstart#setup), [Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox), [WSL](https://learn.chatgpt.com/docs/windows/wsl)

OpenAI documents `/status` as showing task ID, context usage, and rate limits, and points users to the web usage dashboard. These are useful validation surfaces, but neither page defines a stable programmatic output. [Slash commands](https://learn.chatgpt.com/docs/reference/slash-commands), [usage limits](https://learn.chatgpt.com/docs/pricing#where-can-i-see-my-current-usage-limits)

## Usage-read contract

Start `codex app-server` with its default stdio transport. Stdio is newline-delimited JSON; the protocol resembles JSON-RPC 2.0 but omits the `jsonrpc` member on the wire. A client must initialize once before any other request:

```jsonl
{"method":"initialize","id":0,"params":{"clientInfo":{"name":"stream_deck_ai_stats","title":"Stream Deck AI Stats","version":"<plugin-version>"}}}
{"method":"initialized","params":{}}
{"method":"account/rateLimits/read","id":1}
```

Read stdout line by line until the response whose `id` is `1`. A successful response has this relevant shape:

```json
{
  "id": 1,
  "result": {
    "rateLimits": {
      "limitId": "codex",
      "planType": "plus",
      "primary": {
        "usedPercent": 25,
        "windowDurationMins": 300,
        "resetsAt": 1730947200
      },
      "secondary": {
        "usedPercent": 42,
        "windowDurationMins": 10080,
        "resetsAt": 1730950800
      },
      "rateLimitReachedType": null
    },
    "rateLimitsByLimitId": {
      "codex": "<same RateLimitSnapshot shape>"
    }
  }
}
```

The numbers above illustrate the locally observed window durations, not fixed plan guarantees. Parse the fields as follows:

- `usedPercent`: integer percent already used; remaining percent is `max(0, 100 - usedPercent)`.
- `windowDurationMins`: nullable integer duration. Display it, but do not use it to calculate the reset.
- `resetsAt`: nullable Unix timestamp in seconds. This is the authoritative next-reset time; convert it to the user’s local timezone only for presentation.
- `primary` / `secondary`: nullable windows. In the observed Plus response they represented 300 minutes (5 hours) and 10,080 minutes (7 days), respectively. Do not hard-code these durations or labels.
- `planType`, `limitId`, `limitName`, `credits`, and `rateLimitReachedType`: all may be absent or null in snapshots. Preserve unknown plan and limit identifiers.
- `rateLimitsByLimitId`: nullable multi-bucket view. Iterate all buckets and select `limitId == "codex"` for the current display while retaining unknown buckets for forward compatibility.
- `rateLimits`: required backward-compatible single-bucket view and safe fallback when the multi-bucket map is absent.

The server may also emit `account/rateLimits/updated`. Its schema explicitly describes it as a sparse rolling update: merge only present values into the last full read or simply refetch; null account metadata in that notification does not necessarily clear prior data. [App-server protocol](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt), [official app-server source](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

For a Stream Deck action that polls infrequently, one fresh subprocess and one full read per refresh is simpler and safer than maintaining a long-lived server and merging notifications. Put a bounded startup/request timeout around it, send termination after receiving the matching response, and keep stderr separate from protocol stdout.

## Authentication and platform placement

`codex app-server` reads the authentication already managed by the Codex CLI. The CLI’s ChatGPT tokens are refreshed automatically during active use. Credentials live under `CODEX_HOME` (default `~/.codex`) either in `auth.json` or an OS credential store; never copy, parse, log, or ship `auth.json` with the plugin. `codex login status` is a safe diagnostic because it reports the login method without exposing the token. [Authentication and login caching](https://learn.chatgpt.com/docs/auth#login-caching), [credential storage](https://learn.chatgpt.com/docs/auth#credential-storage)

Platform details:

- **macOS:** spawn the native `codex` executable in the signed-in user context. The default `~/.codex` is the relevant home.
- **Windows native:** spawn native `codex.exe`; the default home is `%USERPROFILE%\.codex`.
- **WSL2:** spawn Codex inside the distribution (for example through `wsl.exe -- codex app-server`). WSL’s `~/.codex` is distinct from the native Windows app/CLI home by default. Either ask the user to sign in inside WSL, or deliberately set WSL `CODEX_HOME=/mnt/c/Users/<user>/.codex` as documented. Do not silently copy credentials.
- **WSL1:** unsupported on current Codex. WSL2’s Linux sandbox expects `bubblewrap`; missing or blocked user namespaces can produce startup warnings/failures.

The Windows app documentation explicitly notes that native Windows and WSL do not automatically share config, cached auth, or session history. [Windows app: share config, auth, and sessions with WSL](https://learn.chatgpt.com/docs/windows/windows-app#share-config-auth-and-sessions-with-wsl), [sandbox prerequisites](https://learn.chatgpt.com/docs/sandboxing#prerequisites)

## Window-keeping interaction

If product behavior genuinely requires an actual Codex turn rather than merely displaying quota, use a separate, explicit action. A defensible minimal command is:

```text
codex exec --ephemeral --json --sandbox read-only --skip-git-repo-check --ignore-user-config --ignore-rules "Reply with exactly OK. Do not use tools."
```

Run it in an empty temporary working directory. `--ephemeral` avoids persisting the session rollout; `--ignore-user-config` and `--ignore-rules` reduce unrelated MCP/rule startup failures while authentication still comes from `CODEX_HOME`; read-only prevents repository writes. Accept success only if the process exits zero and JSONL includes `{"type":"turn.completed",...}`. Treat `turn.failed`, an `error` event, timeout, nonzero exit, or missing `turn.completed` as failure. `codex exec --json` is documented to emit `thread.started`, `turn.started`, `turn.completed`/`turn.failed`, item events, and errors. [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode#make-output-machine-readable)

This command necessarily invokes a model and consumes quota. It is therefore not suitable as an invisible polling mechanism. The equivalent app-server `thread/start` + `turn/start` flow gives more control but is not smaller and creates more lifecycle state. No cited source guarantees that any keep-alive prompt extends a rolling window; compare `resetsAt` before and after and present “unchanged” as a valid result.

## Local verification and version assumptions

The following was observed directly on 2026-07-12:

- `codex-cli 0.144.1` reported `Logged in using ChatGPT`.
- A real stdio app-server handshake followed by `account/rateLimits/read` succeeded without a login flow or separate credential.
- The response exposed a `codex` bucket with a 300-minute primary window and a 10,080-minute secondary window, plus the backward-compatible snapshot. Personal usage percentages and exact reset timestamps are intentionally omitted here.
- `codex app-server generate-json-schema --out <dir>` generated version-specific schemas. In 0.144.1, `GetAccountRateLimitsResponse` requires `rateLimits`; `rateLimitsByLimitId` is nullable; `primary`, `secondary`, `windowDurationMins`, and `resetsAt` are nullable; `usedPercent` is an integer.
- Starting app-server while `~/.codex` was read-only failed while initializing its SQLite state runtime. It is not a purely read-only process even when the only requested operation is a quota read.
- The 0.144.1 CLI help labels the overall `app-server` command experimental. The documented `account/rateLimits/read` request does not require the protocol's `experimentalApi` capability, but version pinning and integration tests are still warranted.

The official documentation says generated protocol artifacts are specific to the exact Codex version that generated them. The implementation should therefore:

1. establish `0.144.1` as the verified baseline rather than assuming older CLIs have this endpoint;
2. check `codex --version` and surface a clear unsupported-version error;
3. tolerate additive JSON fields and unknown enum/string values;
4. regenerate schemas and rerun an integration probe when bumping the supported Codex version.

[App-server message schema](https://learn.chatgpt.com/docs/app-server#message-schema), [openai/codex releases](https://github.com/openai/codex/releases)

## Failure modes to design for

- `codex` is missing, not on `PATH`, or is older than the verified baseline.
- The selected environment is not signed in, credentials expired without refresh, the managed workspace rejects the login, or the user signed out in another CLI/extension surface.
- Native Windows and WSL launch different `CODEX_HOME` trees, so one is authenticated and the other is not.
- `CODEX_HOME` is read-only or its SQLite state is locked/corrupt; app-server may fail before the handshake.
- The network, OpenAI service, proxy, or workspace policy prevents the quota request.
- The client sends requests before `initialize`, repeats initialization, mixes stderr with stdout, receives malformed/non-JSON output, or waits for the wrong response ID.
- `primary`, `secondary`, `resetsAt`, `windowDurationMins`, `planType`, or the multi-bucket map is null/missing; a new `limitId` appears; the service returns an error object instead of `result`.
- A long-lived server becomes stale or exits. Prefer restart-on-refresh initially; if later kept alive, reconnect and perform a full read after failure.
- The window-keeping turn invokes unexpected configuration, tools, or approvals. Use the isolated command above and still enforce timeout and event validation.
- A successful usage read is mistaken for model activity. It is only a snapshot. A successful turn is still not proof that the reset timestamp moved.

## Decision-ready conclusion

For both platforms, the plugin can avoid separate OpenAI credentials by calling the user’s installed Codex CLI. Implement quota display with `codex app-server` stdio and `account/rateLimits/read`. Keep native Windows and WSL2 as distinct execution/auth placements; use native Codex on macOS. Make any real-turn “window keeping” an explicit, opt-in operation, validate it through `codex exec --json`, and re-read the server-provided reset timestamps rather than modeling undocumented window behavior.
