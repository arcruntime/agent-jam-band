# Agent Jam Band

A conductor and four AI agents (drums, bass, keys, melody) improvise together while you listen. A Vite + vanilla TypeScript frontend plays the result with Tone.js, and a small Express backend keeps the API keys server-side.

## Run it

Copy `.env.example` to `.env` and fill in the `AIAND_*` values (and the `NEO4J_*` values if you want band memory). Then:

```
npm install
npm run dev
```

`npm run typecheck` checks the whole project, and `npm run ping` sends a test prompt to the configured model.

## Sounds

Most of the band is Tone.js synths. Where a preset calls for it, real sampled instruments are played with the [smplr](https://github.com/danigb/smplr) package:

| Preset | Drums | Keys |
| --- | --- | --- |
| lofi (also used for jazz) | TR-808 samples | Wurlitzer EP200 electric piano |
| futurebass | TR-808 samples | supersaw synth |
| house | TR-808 samples | synth |
| rock | Roland CR-8000 samples (smplr's drum machine has no TR-909, so it uses a 909 if a newer smplr adds one) | synth |
| ambient | synth | grand piano |

Bass and melody are always synths. The samples are not bundled: smplr downloads them when the page opens (hence the "Warming up the band…" state) and they need an internet connection. If a sample set fails to load, that preset quietly plays on its synth and the reason is logged to the browser console.

## Demo screen

The layout is built for a projector: dark theme, band chat on the left, the live band-memory graph on the right, and a compact header with tempo, key, meter, sound, the beat counter and token counters (per agent plus a session total, taken from the model's usage reports). The graph pulses on every beat (bigger on beat 1), an agent's node flashes in its color when its instrument plays, and a new ECHOES edge is highlighted for two seconds.

## Studio (production A/B)

Five switches under the graph work live while the band plays, and none of them restarts or glitches the audio (changes are short ramps): Master bus (EQ, compressor, limiter), Humanize (swing, timing jitter, velocity), Ducking, Reverb & delay sends, and Panning (stereo vs mono). With Master bus off the limiter is out of the path, so peaks can be louder and harsher; that is the point of the comparison.

## Genres

Presets: lofi, futurebass, house, rock, ambient, dnb (fast, reese-style bass), jazz (swung ride, EP or piano keys) and hiphop (heavy swing, 808 drums). The conductor picks the closest preset from this list and names it, and why, in its chat line (for example "No garage kit, using house."). What each musician plays rhythmically is still decided by the agents; the preset sets the sound, swing and tempo feel.

## Song structure

The conductor plans a simple arrangement for the session: sections called intro, build, drop and breakdown, each with its own chord progression that repeats to give one chord per bar. The default is intro 8 bars, build 8, drop 16, breakdown 8, drop 16, and then the song loops back to the start; the conductor may adapt it to the vibe (3 to 7 sections, at most 64 bars, lengths in whole 4-bar blocks). If the model returns something unusable, a built-in arrangement in the song's key is used instead, so the band never plays without a plan.

Every 4-bar block belongs to one section. Each musician is told the section and the chord of each of its four bars (with the chord's tones), plus a short note on what its instrument does there: intro and breakdown are sparse, a build rises bar by bar, a drop is the full band. The header shows the current section next to the beat counter, and the chat announces each new one.

A steer can override the section: typing "drop", "breakdown", "build" or "intro" (or pressing the quick button) throws away what was written for the old direction and jumps to the start of that section at the next block boundary, and if you are already in that section the song just carries on. A steer that changes the key re-harmonizes the chords for the new key.

In Neo4j each section is stored as `(:Section {name, startBar})-[:IN_SESSION]->(:Session)` and every block links to its section with `(:Block)-[:IN_SECTION]->(:Section)`. `startBar` is the song bar the section started on, counted through the loops, so a second drop is its own node. Sections show in the band-memory graph as rounded squares. If you steer away from blocks that never played, a section that only existed for them is removed with them. The ⓘ button in the Band memory panel opens a compact legend of every symbol.

## Sample credits and licenses

- **smplr**, the sampler library, by danigb: MIT license. https://github.com/danigb/smplr
- **Drum machine samples (TR-808, Roland CR-8000)**: the [smpldsnds/drum-machines](https://github.com/smpldsnds/drum-machines) collection, which describes itself as "a collection of public domain samples of different drum machines". The repository does not state a license file or per-sample credits.
- **Wurlitzer EP200 electric piano**: samples by Greg Sullivan, mapped to SFZ by kinwie ([sfzinstruments/GregSullivan.E-Pianos](https://github.com/sfzinstruments/GregSullivan.E-Pianos)). Licensed under [Creative Commons Attribution 3.0 Unported](https://creativecommons.org/licenses/by/3.0/): you must credit Greg Sullivan (this section and the credit line in the app do that).
- **Grand piano**: [sfzinstruments/SplendidGrandPiano](https://github.com/sfzinstruments/SplendidGrandPiano). Its README describes the samples as public domain, originally released by Akai in early 2000 and mapped to SFZ by kinwie, and asks that distributed instruments derived from it say so.
- **Tone.js**: MIT license. https://github.com/Tonejs/Tone.js

Licence statements above are summarized from each project's own README as read on 17 October 2026, not from a legal review: check the linked pages before you ship or sell anything built on these samples.
