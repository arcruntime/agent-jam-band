# Agent Jam Band

A conductor and five AI agents (drums, bass, keys, melody, vox) improvise together while you listen. A Vite + vanilla TypeScript frontend plays the result with Tone.js, and a small Express backend keeps the API keys server-side.

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

Six switches under the graph work live while the band plays, and none of them restarts or glitches the audio (changes are short ramps): Master bus (EQ, compressor, limiter), Humanize (swing, timing jitter, velocity), Ducking, Reverb & delay sends, Panning (stereo vs mono) and Vox chops (robot vowels made from filtered synths; off: no vox). With Master bus off the limiter is out of the path, so peaks can be louder and harsher; that is the point of the comparison.

## Vox (robot vocal chops)

The fifth musician, vox, plays vowel chops. There is no audio model, so the voice is built in Tone.js (`src/vox.ts`): an FM sawtooth source goes through an amplitude envelope and three parallel bandpass filters set to the formants of the vowel ("ah", "oh", "ee" or "oo"), then a bit crusher (a stepped WaveShaper), a highpass, a presence dip, a lowpass, a small compressor that evens out the vowels and a bus that is always under the melody. Each chop glides up into its note, and the filters glide to the next vowel. The voice is monophonic. It uses the same block format as the other agents (4 bars of hits on the step grid, each with `step`, `note`, `vowel`, `dur` and an optional `velocity`), it reads band memory, and it can echo a melody motif as a chop (an ECHOES edge in the graph, with `LOCKS_TO` the melody). It has its own graph color, token counter and Studio switch ("Vox chops").

**Each preset has a vox style** (`shared/vox.ts`):

| Presets | Style | What it does |
| --- | --- | --- |
| futurebass, house, dnb | stab | Bright pitched stabs one octave above the melody: short "ah" and "oh" chops (180 ms at most) on off-beats and syncopations, highpassed at 400 Hz, a light bitcrush (5 bits in futurebass and house, 6 in dnb) for glitch. |
| hiphop, lofi | vocoder | A robot voice below the melody: held vowels on chord tones, a warm lowpass at 3.6 kHz, a 5 dB dip around 3.2 kHz that leaves the lead its presence band, a subtle crush (7 bits in hiphop, 8 in lofi), sparse call phrases only. |
| jazz, ambient | pad | Soft held "oo" vowels (or very sparse airy chops) above the melody, no crush, a big reverb send. |
| rock | rare | Mostly rests: one or two airy "oo" vowels at the very end of a drop. |

**Call and response, no register fight.** The vox and the melody trade phrases. For each style and section there are windows (a bar and a range of steps in it) that belong to the vox. In a drop the melody plays bars 1 and 2 and the stabs answer on bars 3 and 4 (the melody keeps the downbeat); the vocoder answers in the second half of bars 2 and 4; the pad and the rock chop only use bar 4. In a build the stabs tease in the last part of bars 2 to 4, getting busier, while a lowpass sweeps open bar by bar. In an intro the vox is silent (no model call, no tokens) and in a breakdown it plays one chop at most. The melody agent is told which windows to leave empty (`rest_for_vox`), and the server enforces it on both parts: melody notes that start in a window are removed and a note that would ring into one is shortened, while vox hits outside the windows are dropped and every pitch is moved by octaves into the style's register (stabs from the octave above the melody's middle pitch, the vocoder from about an octave below it). Limits per bar and top velocities are also enforced per style. If the model writes nothing for a section where the vox should play, or fails, the server answers the melody's own pitches inside the windows.

**Level.** The vox bus sits under the melody on every preset, and the kick ducks it a little (60% of the keys' own duck depth). Measured with a vox chop against a melody note on each preset: the stabs peak about 3 dB under the melody (futurebass 3.4, house 3.0, dnb 2.8), the vocoder about 5 dB (hiphop 4.8, lofi 4.8), the pads about 6 dB (jazz 6.4, ambient 6.5) and rock 5.9 dB, and no chop peaked above the melody. Each style has its own reverb send so the vox sits in the same room as the keys and melody.

To trace a quiet vox: the server console prints one `[vox]` line per block (section, style, windows, hits per bar, model or fallback), the browser console prints one per block with the Studio switch state and how many chops have been triggered so far, and `__jam.rig.voxStats()` gives the live trigger count.

## Recording

The ● Rec button works any time the band is playing. It records the master output after the limiter (so a take sounds like the speakers), shows "recording 0:42" while it runs, and ends when you click it again or press Stop. The file downloads on its own as `agent-jam-band-<vibe>-<yyyymmdd-hhmmss>.webm` (Safari, which cannot record webm, saves mp4). A summary is also stored in Neo4j as `(:Recording {startBar, endBar, durationSec})-[:IN_SESSION]->(:Session)`; the audio never leaves your computer, and the music and the download carry on if Neo4j is down.

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
