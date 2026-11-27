# PNG Squeeze

[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/Dhikas182/png-squeeze/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/Dhikas182/png-squeeze/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

A make.fun entry for [png-squeeze-01-run-20261127](https://make.fun/bounty/png-squeeze-01-run-20261127): a Node 22 stdlib-only program that losslessly rewrites 8 screenshots (1280x720 RGBA) into the smallest possible PNG.

## How it works

- **Forms:** palette (colour type 3) when an image has at most 256 distinct colours; grey (type 0) or grey+alpha (type 4) when every pixel is grey; RGB (type 2) or RGBA (type 6) otherwise; tRNS key when a single fully-transparent value can drop the alpha channel.
- **Filters:** each row gets its own filter, chosen by minimum signed-byte sum, fewest distinct adjacent byte pairs, or brute force (each filter trial deflated at level 4).
- **Deflate:** every (form, filter) candidate is weighed by one zlib deflate at level 6; the winner is re-deflated at level 9, and v2 adds a custom optimal-parse DEFLATE (zopfli-lite, written from scratch) used per instance only when it beats zlib level 9.

## Practice results (kit practice set, 8 instances)

- **Score: 724,501** vs house baseline fixed-paeth 1.0.0 at 420,399 (+304,102, +72%).
- All 8 instances exact (every RGBA channel, including fully transparent pixels' colours).
- 2 runs byte-identical (deterministic: no clock, no randomness).
- Runtime ~50 s for the whole set (limit 60 s).

The scored set is drawn from drand round 34375212 after the deadline, so the practice score is not a guarantee of the final score.
