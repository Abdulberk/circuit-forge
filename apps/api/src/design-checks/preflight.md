# Why preflight runs without the pad oracle

`classifyCircuit` takes an optional pad-count oracle. With it, pad accounting runs; without it, the result
carries `PCB006` saying the check did not run — never a silent pass.

The API deliberately runs **without** it, always. Two reasons, and the second is the one that matters:

1. The oracle is `@tscircuit/footprinter`, which `pcb-preflight` declares as an *optional* peer. The API does
   not install it, because pulling the board toolchain into the API is the exact cost this package was
   extracted to avoid.

2. More importantly: it must behave the **same everywhere**. In a pnpm workspace footprinter is present on
   disk (pcb-core needs it) and a hopeful `loadPadCountOracle()` would succeed in development and fail in the
   Docker image, where it is not installed. An endpoint that answers differently in dev and prod is worse
   than one that answers less — the dev answer becomes the one everyone believes.

So the endpoint is honest about being a *fast* check rather than a complete one. Pad accounting belongs to
the layout job, which has the oracle, takes minutes, and is the authority. This tells you in milliseconds
that U3 has no footprint at all — which is the thing worth knowing before spending those minutes.
