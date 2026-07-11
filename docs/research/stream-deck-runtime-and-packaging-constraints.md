# Stream Deck runtime and packaging constraints

Research date: 2026-07-12  
Scope: current official Elgato Stream Deck SDK and the first-party `elgatosf/streamdeck` SDK repository only. This note distinguishes documented guarantees from items that need an implementation spike.

## Decision-ready summary

Ship one Node.js Stream Deck plugin bundle for Windows and macOS where possible, using Stream Deck's embedded Node runtime and a local, static Property Inspector. The action backend is the right boundary for polling installed local CLIs and rendering usage state; the Property Inspector is a Chromium configuration view, not a Node process. Render changing quota data as title text and/or a dynamic SVG/data URL through `setImage` rather than by rewriting bundled assets.

Use a manifest that declares both target operating systems, a compatible minimum Stream Deck version, `Nodejs.Version`, and static paths under the `.sdPlugin` bundle. If a native helper becomes necessary, give it separate `CodePathMac` and `CodePathWin` artifacts and treat macOS notarisation/code signing and Windows signing/reputation as release risks to validate: the official SDK material reviewed here documents platform-specific entry points and Marketplace DRM, but does **not** publish a platform-code-signing requirement for arbitrary plugin executables.

## Runtime model

Elgato describes a plugin as local to the user's machine, with hardware communication handled by the Stream Deck application. Its application layer is a Node.js backend that receives Stream Deck events; its presentation layer—the Property Inspector—is an HTML view running in Chromium with DOM access. Do not put Node-only process work (such as invoking a local CLI) in the Property Inspector. [Plugin environment](https://docs.elgato.com/streamdeck/sdk/introduction/plugin-environment/)

The current first-party SDK README says developing Node.js plugins requires Node.js 24+ and Stream Deck 7.1+. The manifest schema supports embedded runtime selections `20` or `24`, and documents the Stream Deck runtime table (for 7.1–7.3: Node 20.20.0 or 24.13.1, Chromium 130). Pin the manifest's `Software.MinimumVersion` to the oldest Stream Deck release that supplies every SDK feature used, and test against its precise embedded Node/Chromium versions—not merely the development machine's Node version. [SDK README](https://github.com/elgatosf/streamdeck#readme), [runtime-version table](https://docs.elgato.com/streamdeck/sdk/introduction/plugin-environment/), [manifest reference](https://docs.elgato.com/streamdeck/sdk/references/manifest/)

The manifest's `CodePath` is executed when Stream Deck starts the plugin. It may be overridden per platform by `CodePathMac` and `CodePathWin`; the latter can be an `.exe`. A Node plugin is also launched with `--enable-source-maps` and `--no-global-search-paths` (and Stream Deck 6.4 additionally used `--no-addons`). That makes the embedded runtime and a fully bundled dependency tree the safe baseline; do not assume global modules or native Node addons are available. [Manifest: entry points and Node options](https://docs.elgato.com/streamdeck/sdk/references/manifest/)

The documented sleep/recovery contract is an `onWillAppear` event for every visible action plus a one-time `onSystemDidWakeUp`; Elgato specifically recommends using the latter to restore connections or IPC. Recreate local-CLI child processes, pipes, and polling timers on those events, and make visible-action initialization idempotent. The documentation does not make a broader promise about preserving a plugin process across app restarts, upgrades, crashes, or sleep; persist only the minimum sanitized state needed to rehydrate. [System wake](https://docs.elgato.com/streamdeck/sdk/guides/system/)

## Windows and macOS boundaries

`OS` is a required manifest collection of one or two supported platforms with their own minimum OS versions. The top-level and action-level fields use `mac` and `windows`; action-level `OS` can further restrict an action. This gives the plugin a documented cross-platform packaging shape, but it is not a Linux/WSL target: run a Windows plugin with Windows-native executables and a macOS plugin with macOS-native executables. [Manifest: OS and action support](https://docs.elgato.com/streamdeck/sdk/references/manifest/)

Where the plugin needs to observe another desktop application, `ApplicationsToMonitor` is explicitly platform-specific: Windows names an executable (for example `Notepad.exe`), while macOS names the app's `CFBundleIdentifier`. Stream Deck emits launch/termination events only for the registered applications. This can help refresh a local integration, but it does not replace direct health checks for a CLI process. [App monitoring](https://docs.elgato.com/streamdeck/sdk/guides/app-monitoring/)

The reviewed official SDK references do not specify: a child-process API contract, working directory/environment inherited by plugin code, a guarantee that an arbitrary macOS binary is notarised/signed, or an Authenticode requirement for a Windows helper. Therefore any helper that launches `codex`/`claude` needs a Windows-and-macOS spike covering path discovery, interactive-user permissions, process termination, and security tooling before a Marketplace release. This is an explicit documentation gap, not evidence that signing is unnecessary.

## Property Inspector

A Property Inspector is an optional HTML file in the plugin bundle, configured either per action (which takes precedence) or at plugin level. It is rendered only as an in-app configuration view, so use it for choice of provider, refresh interval, and diagnostics—not as a background collector. Its default popup size for `window.open()` is 500 × 650 unless `DefaultWindowSize` changes it. [Manifest: Property Inspector](https://docs.elgato.com/streamdeck/sdk/references/manifest/)

Use Elgato's `sdpi-components` locally beside the inspector HTML. Elgato recommends a local reference for predictable offline behavior and says the remote CDN is no longer recommended for distributed plugins. Its `streamDeckClient` communicates directly with the plugin, including settings updates. Do not import `@elgato/streamdeck` in browser code: SDK v2 removed that browser import. [Property Inspectors](https://docs.elgato.com/streamdeck/sdk/guides/ui/), [SDK v2 migration](https://docs.elgato.com/streamdeck/sdk/releases/upgrading/v2/)

Elgato currently labels the Property Inspector guide work in progress and subject to change. Keep its boundary small: use the documented settings/message channel, isolate inspector JavaScript from backend code, and regression-test it when upgrading the SDK or Stream Deck baseline. [Property Inspectors](https://docs.elgato.com/streamdeck/sdk/guides/ui/)

Action settings and global settings can be changed by either the backend or Property Inspector, with the adjacent environment notified. Global settings are plugin-scoped; Elgato says security-sensitive user settings such as user-provided access tokens belong there, but also warns that local users can access them and says never to put a vendor's own secrets there. For this project, avoid copying CLI credential files or tokens into Stream Deck settings; store only user choices and sanitized display/cache data. [Settings and security guidance](https://docs.elgato.com/streamdeck/sdk/guides/settings/)

## Dynamic display constraints

For key actions, `setImage` accepts a local bundle path or a base64 image data URL. Documented supported dynamic image types are SVG (recommended), JPEG, PNG, and WEBP; animated formats such as GIF are not supported by `setImage`. An encoded SVG data URL is the natural portable implementation for a small, frequently refreshed statistics tile. [Key images](https://docs.elgato.com/streamdeck/sdk/guides/keys/)

`setTitle` is a lower-cost companion for a percentage/value label. Both title and image customization yield to a user's custom title/image where applicable, so always retain a readable fallback and do not rely on the plugin being able to override a user-selected image. [Key titles and images](https://docs.elgato.com/streamdeck/sdk/guides/keys/), [dial `setImage` behavior](https://docs.elgato.com/streamdeck/sdk/guides/dials/)

The action manifest's `DisableCaching` controls whether Stream Deck caches images for the plugin/actions and defaults to `false`. Start with the default and use data URLs/SVG updates; only consider the caching flag after a measured rendering issue, since the documentation does not make it a requirement for dynamic image updates. [Manifest: action properties](https://docs.elgato.com/streamdeck/sdk/references/manifest/)

For Stream Deck + dials/touch strips, use a fixed or bundled feedback layout and update values with `setFeedback`; layout items can be updated with string text/pixmaps or numeric bars/gradient bars. `setImage` is also supported, but as with keys it cannot replace a user custom image. [Dials and touch strip](https://docs.elgato.com/streamdeck/sdk/guides/dials/)

## Packaging, distribution, and integrity

The distributable is the compiled `*.sdPlugin` directory, containing (at least as needed) compiled `bin`, static `imgs`, `ui` Property Inspector files, and `manifest.json`. `streamdeck pack <plugin>.sdPlugin` validates the bundle and supporting files, bundles it, and emits a `.streamDeckPlugin` installer; `.sdignore` uses `.gitignore`-style paths to exclude files. Package only production assets—never credential snapshots, log files, source maps with sensitive paths, or development dependency trees. [Getting started: bundle layout](https://docs.elgato.com/streamdeck/sdk/introduction/getting-started/), [Distribution: packaging](https://docs.elgato.com/streamdeck/sdk/introduction/distribution/)

Marketplace DRM is a post-upload protection: files become encrypted/integrity checked only after Maker Console processes the uploaded plugin. Current CLI 1.6+ enables DRM by default. DRM-ready Node plugins require `@elgato/streamdeck` v2+, manifest `SDKVersion: 3`, and `Software.MinimumVersion: "6.9"` or higher. Most importantly, distributed files are immutable and the manifest is protected and unavailable at runtime. Generate mutable output in a writable runtime location; do not modify bundled image/config files and do not query `manifest.json` at runtime. This map explicitly excludes Marketplace publication, so DRM processing is not a release gate for the private GitHub-release artifact; preserve the same immutability discipline so a later distribution change remains viable. [Distribution and DRM](https://docs.elgato.com/streamdeck/sdk/introduction/distribution/)

For a beta that exercises DRM, Elgato's documented flow is upload to Maker Console without selecting “Publish after review,” then download that processed version from the product's Versions tab. Marketplace publication additionally requires adherence to plugin guidelines and a Maker Console submission/review. [Distribution: DRM test and publishing](https://docs.elgato.com/streamdeck/sdk/introduction/distribution/)

## Recommended release gate

1. Target embedded Node 24 / Stream Deck 7.1+ unless a later design deliberately chooses Node 20 and documents the reduced baseline.
2. Bundle the backend and a local Property Inspector; expose settings through the inspector and run all local-process work in Node.
3. Draw key state through dynamic SVG/title APIs and never mutate files inside the installed `.sdPlugin`.
4. Declare both OS targets and use `CodePathMac`/`CodePathWin` only if platform-specific helpers are unavoidable.
5. Before shipping a helper, test its launch, recovery after wake, and native security treatment on clean Windows and macOS systems. The official SDK docs do not settle signing/notarisation policy for such a helper.
6. Package the private installer with `streamdeck pack`; do not make Marketplace/Maker Console DRM processing a prerequisite for this out-of-scope distribution channel. Release-asset naming, versioning, and GitHub Actions acceptance remain for [Define private-release acceptance and automation](https://github.com/marcinmaruszewski/stream-deck-ai-stats/issues/4).

## Source list

- [Elgato Stream Deck SDK: Plugin environment](https://docs.elgato.com/streamdeck/sdk/introduction/plugin-environment/)
- [Elgato Stream Deck SDK: Manifest reference](https://docs.elgato.com/streamdeck/sdk/references/manifest/)
- [Elgato Stream Deck SDK: Property Inspectors](https://docs.elgato.com/streamdeck/sdk/guides/ui/)
- [Elgato Stream Deck SDK: Keys](https://docs.elgato.com/streamdeck/sdk/guides/keys/)
- [Elgato Stream Deck SDK: Dials & Touch Strip](https://docs.elgato.com/streamdeck/sdk/guides/dials/)
- [Elgato Stream Deck SDK: System](https://docs.elgato.com/streamdeck/sdk/guides/system/)
- [Elgato Stream Deck SDK: App monitoring](https://docs.elgato.com/streamdeck/sdk/guides/app-monitoring/)
- [Elgato Stream Deck SDK: Settings](https://docs.elgato.com/streamdeck/sdk/guides/settings/)
- [Elgato Stream Deck SDK: Distribution](https://docs.elgato.com/streamdeck/sdk/introduction/distribution/)
- [Elgato first-party SDK repository](https://github.com/elgatosf/streamdeck)
