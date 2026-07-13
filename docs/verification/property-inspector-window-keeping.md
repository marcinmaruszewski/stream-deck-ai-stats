# Property Inspector manual Codex window-keeping verification

## Automated slice

Run `node --test test/property-inspector.test.js` to exercise the local browser boundary without Stream Deck hardware or provider credentials. The test verifies that the manual Codex request includes the selected key's action and context, then verifies that the inspector renders:

- an `unknown` window activity verdict rather than inferring activity;
- the independent window-keeping action result; and
- the post-action usage-observation comparison.

Run `npm test`, `npm run check`, and `npm run bundle` before a private release to cover the full Node test suite, syntax checks, and the generated plugin backend.

## Manual boundary

On Windows with WSL, install the packaged plugin, add a Codex five-hour usage tile, open its Property Inspector, and select **Run minimal Codex turn**. Confirm that the inspector shows the action outcome and before/after observation result while **Window activity** stays **Unknown**. This step consumes plan usage and requires the user's installed Codex authentication; it is intentionally excluded from automation.

Stream Deck hardware rendering and macOS acceptance remain separate map work.
