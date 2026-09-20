# Browserbase warm-session latency report

Measured on September 20, 2026 with the same local environment, Browserbase context, X account, and `gemini-3.5-flash-lite` in Fast mode.

## Result

The previous cold path created a Browserbase session only after **Start watching** was clicked. It took 13,793 ms to start and collect evidence, then 1,964 ms for Gemini: **15,757 ms total**.

The new path pays an 8,093 ms one-time prewarm cost when the server starts. That cost is outside the user click path. All three searches below reused Browserbase session `0655eba7-81d3-44b2-8966-79de0234ad19` and returned real X evidence plus three Gemini suggestions.

| Game/topic | Type | X posts | Start + first collection | Gemini | Total after click |
| --- | --- | ---: | ---: | ---: | ---: |
| World Cup | Live | 8 | 5,659 ms | 1,868 ms | 7,527 ms |
| Arsenal Chelsea | Live | 7 | 4,852 ms | 1,641 ms | 6,492 ms |
| Argentina France 2022 World Cup final | Historical | 9 | 4,204 ms | 1,945 ms | 6,150 ms |
| **Average** |  | **8** | **4,905 ms** | **1,818 ms** | **6,723 ms** |

Compared with the 15,757 ms cold baseline, average user-visible time fell by **9,034 ms (57.3%)**. Browserbase startup/CDP connection no longer blocks Start watching. Results still vary with X rendering and network latency.

## Correctness checks

- The same Browserbase session and X tab were reused across all game changes.
- Each game navigated to a distinct search URL; the historical query used X's top-results mode.
- The initial collection parsed the page loaded by navigation without a duplicate reload.
- Each case returned different real X evidence and exactly three Gemini suggestions.
- Unit coverage verifies concurrent prewarm calls create one session, restarting the same game avoids navigation, a failed prewarm can be retried, Stop keeps the browser open, and server shutdown closes it.

Run the live comparison again with `npm run test:e2e:latency`. The command requires working Browserbase context and Gemini credentials in `.env`.
