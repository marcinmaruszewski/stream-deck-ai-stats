# Dual-window Stream Deck indicator prototype

> Throwaway visual prototype for the map ticket **Prototype readable dual-window Stream Deck indicators**. It asks which information hierarchy is most legible on a Stream Deck key; it is not production artwork or an implementation specification.

Each bitmap is rendered at high resolution for review, but deliberately uses only the large shapes and labels intended to survive a 72×72 px Stream Deck key: provider initial, usage progress, and the most urgent pace status.

## A — Split Ledger

![Split Ledger](split-ledger.png)

Two equal bands make Codex (`C`) and Claude (`A`) directly comparable. The central amber diamond is the single pace-status signal.

## B — Radial Sentinel

![Radial Sentinel](radial-sentinel.png)

The currently most urgent provider gets the entire key; the other provider remains a small bottom strip. This favors immediate action over balanced comparison.

## D — Radial Sentinel with time and pace delta

![Radial Sentinel with time and pace delta](radial-sentinel-with-pace.png)

This revision keeps the urgent provider as the primary radial reading while exposing three independent facts: usage progress, reset time, and elapsed-time comparison. The illustrative state is 62% usage after 2h of a 5h usage window, resetting in 3h; its pace delta is `−22 pp` because 40% of the window has elapsed while 62% has been consumed.

## C — Pace Beacon

![Pace Beacon](pace-beacon.png)

The pace-status arrow dominates the key, with the two provider values as bands. This favors an at-a-glance warning over accurate progress comparison.

## Review prompt

Choose one direction, or name a combination of parts to keep. The decision should account for: provider identity, both usage windows, reset timing, usage progress, elapsed time, pace delta, stale/error states, and window-keeping activity. The next version will replace the illustrative `C`/`A` values with the provider-neutral domain model once that decision exists.
