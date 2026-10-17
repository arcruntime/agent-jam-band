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

## Sample credits and licenses

- **smplr**, the sampler library, by danigb: MIT license. https://github.com/danigb/smplr
- **Drum machine samples (TR-808, Roland CR-8000)**: the [smpldsnds/drum-machines](https://github.com/smpldsnds/drum-machines) collection, which describes itself as "a collection of public domain samples of different drum machines". The repository does not state a license file or per-sample credits.
- **Wurlitzer EP200 electric piano**: samples by Greg Sullivan, mapped to SFZ by kinwie ([sfzinstruments/GregSullivan.E-Pianos](https://github.com/sfzinstruments/GregSullivan.E-Pianos)). Licensed under [Creative Commons Attribution 3.0 Unported](https://creativecommons.org/licenses/by/3.0/): you must credit Greg Sullivan (this section and the credit line in the app do that).
- **Grand piano**: [sfzinstruments/SplendidGrandPiano](https://github.com/sfzinstruments/SplendidGrandPiano). Its README describes the samples as public domain, originally released by Akai in early 2000 and mapped to SFZ by kinwie, and asks that distributed instruments derived from it say so.
- **Tone.js**: MIT license. https://github.com/Tonejs/Tone.js

Licence statements above are summarized from each project's own README as read on 17 October 2026, not from a legal review: check the linked pages before you ship or sell anything built on these samples.
