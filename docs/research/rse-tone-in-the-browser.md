# RSE-driven guitar tone in the browser

Research notes: how to make alphaTab's synthesized "Instruments" playback
sound closer to Guitar Pro's RSE (Realistic Sound Engine) using the
per-track sound settings stored in `.gp` files.

Status: research only. No source code was changed. Line numbers refer to the
fork branch `tabz/1.9.0-tabz.1` as of 2026-10-17.

Conventions: **[verified]** means checked against the cited primary source;
**[inferred]** means a reasonable reading that no primary source confirms;
**[unverified]** means not checked, or no primary source was found.

---

## TL;DR

- A GP7/GP8 file stores, for each track, a **Sound** (GP preset name, GM
  program fallback, RSE sound-bank patch such as `Strat-Guitar`) and an
  **effect chain** of up to 6 RSE effects (EQ, pedals, amp, dynamics, delay)
  with normalized `0..1` parameters. There is also a per-track channel strip
  and a master chain.
- alphaTab reads only the GM program/bank and the pan/volume of the channel
  strip. The RSE patch, the effect chain, the pickups and the master effects
  are all **dropped**.
- The synth mixes every voice into **one stereo buffer** in the worker. No
  per-track signal exists anywhere downstream. Per-track effects need a
  synth change: per-channel render buses, then DSP in the worker or a
  multi-output worklet.
- The best browser tools are **NAM via WebAssembly** (MIT, a maintained npm
  package, runs in an AudioWorklet), **cab IRs through `ConvolverNode`**, and
  **Faust/Guitarix-derived DSP** (Faust `tonestacks.lib` models a Fender Twin
  tone stack, and a TS9 overdrive exists as a WAM). VSTs cannot run in a
  browser. GP's RSE is not sold as a plugin.
- A major fidelity trap: GM "Overdriven Guitar" (program 29) already has the
  distortion baked into the samples. A faithful chain needs a **clean/DI
  guitar source** before the amp sim.
- Recommendation (section 6): first build the cheap global version: switch
  guitar tracks to a clean GM program, then add a master-bus cab IR, a light
  drive and a tone stack. Then, if that is worth it, add per-channel buses in
  the synth plus an RSE-to-browser-chain mapping table, with NAM as the amp
  stage. Skip native VSTs except for offline/server rendering.

---

## 1. What a GP7/GP8 file stores (example: track 1 of the sample file)

The sample file is a GP8 zip (`VERSION` = `7.0`, `meta.json`
`"hasAudio": true`) with `Content/score.gpif` (XML) and an MP3 backing
track in `Content/Assets/`. Inspected locally only.

### 1.1 Track-level sound XML (track 1, a lead electric guitar)

```xml
<PlayingStyle>StringedFinger</PlayingStyle>
<UseOneChannelPerString />
<InstrumentSet><Name>Electric Guitar</Name><Type>electricGuitar</Type> ...
  <SoundbankName></SoundbankName> ... <OutputMidiNumber>0</OutputMidiNumber> ...
</InstrumentSet>
<RSE>
  <ChannelStrip version="E56">
    <Parameters>0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0 0.5 0.25 0.64 0.5 0.5 0.5</Parameters>
    <Automations>
      <Automation><Type>DSPParam_11</Type>...<Value>0.25</Value></Automation>
      <Automation><Type>DSPParam_12</Type>...<Value>0.64</Value></Automation>
    </Automations>
  </ChannelStrip>
</RSE>
<ForcedSound>-1</ForcedSound>
<Sounds>
  <Sound>
    <Name><![CDATA[Lead Money]]></Name>
    <Label><![CDATA[Lead Money]]></Label>
    <Path>Stringed/Electric Guitars/Distortion Guitar</Path>
    <Role>Factory</Role>
    <MIDI><LSB>0</LSB><MSB>0</MSB><Program>29</Program></MIDI>
    <RSE>
      <SoundbankPatch>Strat-Guitar</SoundbankPatch>
      <ElementsSettings></ElementsSettings>
      <Pickups>
        <OverloudPosition>0</OverloudPosition>
        <Volumes>1 1</Volumes>
        <Tones>1 1</Tones>
      </Pickups>
      <EffectChain>
        <Effect id="E30_EqGEq"><Parameters>0.285714 0.342857 0.485714 0.657143 0.742857 0.44 0.36 1</Parameters></Effect>
        <Effect id="E03_OverdriveScreamer"><Parameters>0.0999 0.5 0.8</Parameters></Effect>
        <Effect id="A02_ComboAmericanClean"><Parameters>0.6666 0.47 0.6 0.625 0.205 0 0</Parameters></Effect>
        <Effect id="M07_DynamicClassicDynamic"><Parameters>0.0989 0.218 0.9346</Parameters></Effect>
        <Effect id="M12_DelayDigitalDelay"><Bypass /><Parameters>0.5 0.4 0.24</Parameters></Effect>
      </EffectChain>
    </RSE>
  </Sound>
</Sounds>
<MidiConnection><Port>0</Port><PrimaryChannel>11</PrimaryChannel><SecondaryChannel>12</SecondaryChannel>
  <ForeOneChannelPerString>false</ForeOneChannelPerString></MidiConnection>
<AudioEngineState>RSE</AudioEngineState>
...
<Automations>
  <Automation><Type>Sound</Type>...<Value><![CDATA[Stringed/Electric Guitars/Distortion Guitar;Lead Money;Factory]]></Value></Automation>
</Automations>
```

Master track (`<MasterTrack><RSE><Master>`):

```xml
<Effect id="M06_DynamicAnalogDynamic"><ByPass /><Parameters>0 0 0.8 0 0.4 0.6 0.5 0.5</Parameters></Effect>
<Effect id="M03_StudioReverbRoomStudioA"><ByPass /><Parameters>0 0 0 0 0</Parameters></Effect>
<Effect id="M08_GraphicEQ10Band"><ByPass /><Parameters>0 0 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5</Parameters></Effect>
<Effect id="I01_VolumeAndPan"><Parameters>0.76 0.5</Parameters> ...</Effect>
```

Effect ids on the other tracks of the same file: bass `A10_StackClassic`,
`E31_EqBEq`; jazz guitar `A02_ComboAmericanClean`,
`M01_StudioReverbHallConcertHall`, `E30_EqGEq`, `M07_DynamicClassicDynamic`;
drums `M06_…`, `M08_…`, `M05_StudioReverbPlatePercussive`; e-piano
`M09_GraphicEQ15Band`, `A02_…`, `M13_ModulationDigitalChorus`, `M07_…`,
`M04_StudioReverbRoomAmbience`. Sound-bank patches seen: `Strat-Guitar`,
`Fretless-Bass`, `ES-Guitar`, `Pre-Bass`, `Drumkit-Master`, `200A-EPiano`.

### 1.2 What each element means

| Element | Meaning | Confidence |
|---|---|---|
| `Sound/Name`, `Label`, `Path`, `Role` | GP preset name, its category path in GP's sound browser, and Factory vs User preset. `Path;Name;Role` is the key that `Sound` automations reference. | [verified] the key format matches alphaTab's `GpifSound.uniqueId` (`GpifParser.ts:79-81`) and the automation value above |
| `Sound/MIDI` | GM program (0-based) and bank MSB/LSB used when the track plays in MIDI mode. Program 29 (0-based) is GM "Overdriven Guitar" even though the path says "Distortion Guitar" (GM 30). | [verified] GM 1 sound set, [MIDI Association GM1](https://midi.org/general-midi-level-1) |
| `RSE/SoundbankPatch` | The RSE sample bank: "the raw, unprocessed sound of an instrument, such as a guitar without effects". `Strat-Guitar` is a Stratocaster-type DI sample set. | [verified] definition: [GP8 Track Sound](https://www.guitar-pro.com/docs/gp8/audio/soundsetup/sound-settings); the "Stratocaster" reading of the name is [inferred] |
| `RSE/Pickups` | Pickup selection, volumes and tones for the sampled guitar. The `OverloudPosition` name suggests technology from Overloud, but no partnership was found in any public source. | [unverified] |
| `RSE/EffectChain/Effect` | "A track can include up to 6 effects (pedals, amplifiers)", stored in signal order; `<Bypass/>` = off. Parameters are normalized `0..1` in the effect's knob order. | [verified] count and order: [GP8 Track Sound](https://www.guitar-pro.com/docs/gp8/audio/soundsetup/sound-settings); knob order [inferred] |
| `E30_EqGEq` | "GEq" guitar graphic EQ. 8 values: probably 7 bands plus level (Boss GE-7 layout). | name [verified] ([GP8 Amps & Effects](https://www.guitar-pro.com/docs/gp8/appendix/effects)); layout [inferred] |
| `E03_OverdriveScreamer` | "Screamer: Overdrive". 3 values = Drive / Tone / Level (Tube Screamer layout): drive about 0.1, tone 0.5, level 0.8, i.e. a clean-boost. | name [verified] (same page); TS heritage and knob order [inferred] |
| `A02_ComboAmericanClean` | "American Clean: Combo (Fender American)". 7 values; probably gain/volume, bass, mid, treble, presence or reverb, plus switches. | name and Fender reference [verified] (same page); knob order [unverified] |
| `M07_DynamicClassicDynamic` | Listed under Mastering > Dynamics as "Classic": a compressor (3 values, probably threshold/ratio/gain). | category [verified] (same page); knob order [unverified] |
| `M12_DelayDigitalDelay` | "D-Delay: Digital delay"; bypassed here. | [verified] (same page) |
| `A10_StackClassic` | Bass amp "Stack: Classic (Ampeg)". | [verified] (same page) |
| `RSE/ChannelStrip` (16 values, `version="E56"`) | Per-track mixer strip. Index 11 = pan and 12 = volume, which is how alphaTab uses them. The other 14 are probably the strip's EQ, gain and sends. `DSPParam_NN` automations animate index NN. | 11/12 [verified] by alphaTab usage (`GpifParser.ts:1333-1342`); the rest [unverified] |
| `MasterTrack/RSE/Master` | Song-level mastering chain ("global mastering (up to 3 effects)") plus master volume/pan. | [verified] [GP8 Track Sound](https://www.guitar-pro.com/docs/gp8/audio/soundsetup/sound-settings) |
| `AudioEngineState` | `RSE` vs `MIDI` per track ("Enable or disable these options in the track inspector for each track individually"). | [verified] [GP8 RSE vs MIDI](https://www.guitar-pro.com/docs/gp8/audio/soundsetup/RSE-vs-MIDI) |
| `UseOneChannelPerString`, `PlayingStyle` | Per-string MIDI channels, and finger vs pick style (which picks RSE samples). | [inferred] |

No official GPIF schema is published. Everything above comes from observing
the file plus GP's user docs. There is no public spec for the parameter
semantics, so a mapping must be calibrated by ear or by A/B against GP
renders.

---

## 2. What alphaTab parses today

All paths are relative to `packages/alphatab/src/`.

| GPIF data | alphaTab handling | Citation |
|---|---|---|
| `Track/Sounds/Sound` | Reads only `Name`, `Path`, `Role`, `MIDI`. `Label` and the whole `RSE` sub-tree (`SoundbankPatch`, `Pickups`, `EffectChain`) are ignored. | `importer/GpifParser.ts:1220-1248` |
| `GpifSound` model | Holds name/path/role/program/bank only; parser-internal (`@internal`), not exposed on the model. | `importer/GpifParser.ts:75-85` |
| First sound | Its program/bank become `track.playbackInfo.program/bank`. | `importer/GpifParser.ts:1239-1245` |
| `Sound/MIDI` | `bank = (MSB<<7) \| LSB`, program as is. | `importer/GpifParser.ts:1250-1266` |
| `Sound` automations | Converted to a Bank automation plus an Instrument (program) automation. | `importer/GpifParser.ts:541-557` |
| Other automation types | Only `Tempo`, `SyncPoint`, `Sound`, `SustainPedal` are handled. `DSPParam_*` (channel-strip automation) is dropped. | `importer/GpifParser.ts:526-560` |
| `Track/RSE/ChannelStrip` | Only `Parameters[11]` → `balance` (×16) and `[12]` → `volume` (×16). | `importer/GpifParser.ts:1313-1343` |
| `MidiConnection` | Port and primary/secondary channel. | `importer/GpifParser.ts:664-667`, `1185-1208` |
| `MasterTrack/RSE` | Ignored: the master parser handles only `Automations`, `Tracks`, `Anacrusis`. | `importer/GpifParser.ts:420-434` |
| `AudioEngineState`, `UseOneChannelPerString`, `PlayingStyle`, `ForcedSound` | Not referenced anywhere in the parser. | `grep` over `importer/GpifParser.ts` (no matches) |
| Model | `PlaybackInformation` has only volume, balance, port, program, bank, channels, mute, solo. There is no field for RSE data. | `model/PlaybackInformation.ts:12-52` |
| GP5 (binary) RSE | Skipped: RSE bank ids, 3-band EQ and effect name/category are read and discarded. | `importer/Gp3To5Importer.ts:126-130`, `728-755`, `1299-1318` |

GP instruments therefore reach the synth only as a **GM program number**,
which is then looked up in the loaded SoundFont. The RSE patch name
(`Strat-Guitar`) is never used, and neither is any effect.

---

## 3. Can the synth be extended?

### 3.1 Current signal flow (browser)

1. **Worker**: `AlphaSynthBase.onSampleRequest` fills one interleaved stereo
   `Float32Array` (`MicroBufferSize` 64 × `MicroBufferCount` 32 × 2 ch), then
   calls `output.addSamples(samples)` (`synth/AlphaSynth.ts:373-414`;
   constants in `synth/SynthConstants.ts:12,35-36`).
2. `TinySoundFont._fillWorkingBuffer` loops over all voices. Each voice
   `render()`s into **the same** buffer (`synth/synthesis/TinySoundFont.ts:180-216`).
   Voices accumulate with `outputBuffer[...] += value * gain`
   (`synth/synthesis/Voice.ts:257-287`). Per-channel state only scales gain
   (`mixVolume`, `Voice.ts:226`). Output modes are stereo or mono only
   (`synth/synthesis/OutputMode.ts`).
3. The worker posts the samples to the main thread
   (`platform/worker/AlphaSynthWorkerSynthOutput.ts:62-72`). The main thread
   forwards them (`platform/worker/AlphaSynthWebWorkerApi.ts:471`) to the
   AudioWorklet (`platform/javascript/AlphaSynthAudioWorkletOutput.ts:552-561`).
4. The worklet is created with `numberOfOutputs: 1, outputChannelCount: [2]`
   and connects to `destinationNode ?? ctx.destination`
   (`AlphaSynthAudioWorkletOutput.ts:482-496`, `destinationNode` at `:331`).
   `process()` copies from a circular buffer into the two outputs (`:171-200`).
5. In this fork's mixing mode, `destinationNode` is
   `WebAudioMixGraph.synthGainNode`. The graph is
   synthGain + mediaGain → masterGain → limiter → trim → destination
   (`platform/javascript/WebAudioMixGraph.ts:30-49`, `synthInput` at `:64`).

### 3.2 Where effects can plug in

| Insertion point | Scope | Effort | Notes |
|---|---|---|---|
| **A. Between worklet and `synthGainNode`** (the existing `destinationNode` seam) | Master only (all instruments together) | Very low: app-side WebAudio nodes, no alphaTab change in the fork | Effects then hit drums, bass and keys as well. Fine for a global "room + cab" colour, wrong for an amp. |
| **B. Per-channel buses in `TinySoundFont`** | Per MIDI channel = per track (each track owns primary/secondary channels, `midi/MidiFileGenerator.ts:252-257`; 17 channels incl. metronome, `SynthConstants.ts:10`) | Medium: `Voice.render` writes into `buses[voice.playingChannel]`, then a mix step | Core change. Needed for any per-track effect. |
| **B1. DSP in the worker** after B, before the mix | Per track | Medium-high: effects written in TS, or WASM loaded in the worker | Keeps one stereo stream to the worklet. Native `ConvolverNode`/`WaveShaperNode` are **not** available: `AudioContext`/`OfflineAudioContext` are `[Exposed=Window]` ([Web Audio API spec](https://webaudio.github.io/web-audio-api/#AudioContext)), so convolution must be done in code (FFT partitioned convolution). NAM's WASM engine has a plain C API (`wasm/nam-engine.cpp`, per its [README](https://github.com/tone-3000/neural-amp-modeler-wasm)), so in principle it can run in a worker [unverified: not tried]. |
| **B2. Multi-output worklet** after B | Per track | High: N stereo streams over `postMessage` (17 ch × 2 × 48 kHz × 4 B ≈ 6.5 MB/s), worklet `numberOfOutputs: N`, app builds a WebAudio graph per output | Gives native `ConvolverNode` and WAM/NAM worklets per track, and lets the app's mixer own the routing. The cost is bandwidth and latency handling. |
| **C. Offline stems** via `exportAudio` with `AudioExportOptions.trackVolume` set to solo one track (`synth/AlphaSynth.ts:944`, `synth/IAudioExporter.ts:62`) → process in an `OfflineAudioContext` → play as media | Per track, not live | Medium: no core change, but editing/tempo changes need a re-render, and playback must be synced like a backing track | This fork already syncs external media (`MediaSynthPlayer.ts`). |

Note: alphaTab's synth renders ahead of real time (buffered,
`bufferTimeInMilliseconds`), so added DSP latency in B1 does not add any
user-visible delay [inferred from the buffered design above].

---

## 4. Options for a richer guitar tone

### 4.1 WebAudio-native building blocks

- **`ConvolverNode`**: cab simulation by impulse response. It is native and
  cheap, and it is the standard way to do cab sim
  ([MDN ConvolverNode](https://developer.mozilla.org/en-US/docs/Web/API/ConvolverNode)).
- **`WaveShaperNode`**: static non-linearity with `oversample` `'2x'/'4x'`
  ([MDN WaveShaperNode](https://developer.mozilla.org/en-US/docs/Web/API/WaveShaperNode)).
  Good enough for a light TS-style drive; crude for amp sag/dynamics.
- **`BiquadFilterNode`**, **`DynamicsCompressorNode`**, **`DelayNode`**: map
  directly to GEq, Classic Dynamic and D-Delay.
- **Tone.js** (MIT, [Tonejs/Tone.js](https://github.com/Tonejs/Tone.js)):
  wraps the above (Distortion, Chebyshev, EQ3, Compressor, FeedbackDelay,
  Reverb). It is convenient, but adds no amp modelling beyond WaveShaper.
- **Free cab IR licensing is the catch.** Most free IR packs are free *to
  use* but not to *redistribute*, and serving IRs to browsers is
  redistribution. For example, ViViX states "unauthorized reproduction or
  redistribution of this pack is prohibited"
  ([ViViX](https://vivix.gumroad.com/l/ocxaK)). Packs with explicit
  redistribution rights: Zach Weeks TL806/1960B under **CC BY-SA 4.0**
  ([gumroad](https://zachweeks.gumroad.com/l/tl806cabir)), and the IRs
  bundled in Guitarix's `trunk/IR` (`BestPlugins_Amps`, `BestPlugins_Bands`)
  under Guitarix's GPL-2.0-or-later
  ([guitarix COPYING](https://github.com/brummer10/guitarix/tree/master/trunk))
  [unverified: the individual IR files' provenance]. God's Cab, Metal Cabs
  and Origin Effects IRs are free, but their redistribution terms were not
  found [unverified]
  ([BPB roundup](https://bedroomproducersblog.com/2013/09/11/metal-cabs-free/),
  [SOS Origin](https://www.soundonsound.com/news/origin-effects-launch-free-ir-cab-library)).
  The safest route is to **record or buy your own IRs with a redistribution licence**.

### 4.2 Web Audio Modules (WAM 2.0)

- WAM is an open-source web-plugin standard that reached v2.0 in 2021
  ([AES e-library](https://aes2.org/publications/elibrary-page/?id=23110);
  API repo [webaudiomodules/api](https://github.com/webaudiomodules/api), no
  licence file declared).
- The community index ([plugins.json](https://www.webaudiomodules.com/community/plugins.json),
  sources in [boourns/wam-community](https://github.com/boourns/wam-community))
  lists 58 plugins. The guitar-relevant ones (vendor Wimmics/Univ. Côte
  d'Azur): **TS9 Overdrive**, **Vox Amp 30**, **DistoMachine** (amp sims),
  Big Muff, KppFuzz, KppDistorder, OSCTube, Temper, QuadraFuzz,
  Overdriverix, GraphicEqualizer, PingPongDelay/SmoothDelay, KBVerb/Grey
  Hole, plus Pedalboard hosts. **There is no cabinet/IR plugin and no
  compressor.**
- The TS9 Overdrive source is a Faust file adapted from Guitarix: its header
  reads "GNU General Public License ... version 2 ... or (at your option)
  any later version", but it also declares `license "LGPL"`
  ([TS9_OverdriveFaustGenerated.dsp](https://github.com/boourns/wam-community/blob/main/plugins/wimmics/TS9_Overdrive/TS9_OverdriveFaustGenerated.dsp)).
  The licence is ambiguous, so treat it as **GPL** for a closed-source app.
- Background: Buffa and Lebrun's WebAudio tube amps/pedalboard work
  ([HAL hal-01893781](https://hal.archives-ouvertes.fr/hal-01893781)).
- Maturity: the API repo was last pushed in 2023-03 and wam-community in
  2024-03 (GitHub API). The ecosystem is usable but quiet.

### 4.3 WASM ports of open-source DSP

- **Neural Amp Modeler (NAM)**: the most realistic option.
  - Core DSP: [sdatkinson/NeuralAmpModelerCore](https://github.com/sdatkinson/NeuralAmpModelerCore), **MIT**.
  - Web runtime: [tone-3000/neural-amp-modeler-wasm](https://github.com/tone-3000/neural-amp-modeler-wasm)
    (**MIT**, npm `neural-amp-modeler-wasm`). It consumes the core
    unmodified, pinned to v0.5.4 ("A2 + slimmable models"). It is a
    "single-threaded module with a plain C API ... instantiated exactly once
    inside a hand-written AudioWorklet processor" and supports multiple NAM
    instances. It needs "No COOP/COEP headers", with a "64 MB initial wasm
    heap (grows on demand to 512 MB max)" (README).
  - CPU: "Real-time neural inference is a bit CPU-intensive". TONE3000
    targets "Apple Silicon or recent Intel/AMD" and is building a
    pre-rendered fallback
    ([TONE3000 blog](https://www.tone3000.com/blog/introducing-the-nam-web-player)).
    Several NAM instances on mobile is a real risk [inferred].
  - The same runtime powers openDAW's NAM device
    ([TONE3000](https://www.tone3000.com/blog/opendaw-now-supports-tone3000);
    openDAW is AGPL-3.0, [andremichelle/openDAW](https://github.com/andremichelle/openDAW),
    so do not copy its code into a closed app).
  - **Model licensing**: most TONE3000 captures use the "T3K" licence:
    "Users may download and use the data file in software and publish the
    resulting outputs ... However, they may not upload, republish, or
    distribute the data file without the author's permission". Some are
    CC BY ([example listing](https://www.tone3000.com/tones/tone-king-imperial-mkii-standard-models-5714)).
    Hosting T3K models yourself is therefore not allowed. Two ways around
    it: pick CC-BY captures, or use the **TONE3000 API** (OAuth 2.0 + PKCE;
    the user picks or loads a tone through TONE3000; 100 req/min by default)
    ([tone3000.com/api](https://tone3000.com/api)), so the file comes from
    TONE3000 to the user.
- **AIDA-X / RTNeural**: AIDA-X is **GPL-3.0**
  ([AidaDSP/AIDA-X](https://github.com/AidaDSP/AIDA-X)); RTNeural is
  **BSD-3-Clause** ([jatinchowdhury18/RTNeural](https://github.com/jatinchowdhury18/RTNeural)).
  No maintained web runtime was found [unverified]. NAM-wasm is the
  practical choice.
- **Faust → WASM**: [grame-cncm/faustwasm](https://github.com/grame-cncm/faustwasm)
  compiles Faust to WASM AudioWorklets/WAMs. The Faust libraries include
  `tonestacks.lib` (**LGPL-2.1-or-later**), with physically derived tone
  stacks for `bassman`, `twin` ("69 Twin Reverb AA270"), `princeton`,
  `jcm800`, `ac30`, and others, plus `tubes.lib`
  ([faustlibraries/tonestacks.lib](https://github.com/grame-cncm/faustlibraries/blob/master/tonestacks.lib)).
  This makes it a good free "American Clean" approximation: tube preamp →
  Twin tone stack → cab IR.
- **Guitarix** itself: Linux/JACK, GPL-2.0-or-later
  ([brummer10/guitarix](https://github.com/brummer10/guitarix)). No WASM
  port was found [unverified]; its DSP survives on the web through Faust
  and WAM (above).
- **WebCLAP**: CLAP plugins compiled to wasm32, hosted as an AudioNode over
  an AudioWorkletProcessor ([WebCLAP](https://github.com/WebCLAP),
  [browser-test-host](https://github.com/WebCLAP/browser-test-host)). This
  is the nearest thing to "VST in the browser", but only for plugins
  recompiled from source. It is experimental [unverified maturity].

### 4.4 Better samples

- alphaTab loads **SF2/SF3 only**: the loader requires a RIFF `sfbk` chunk
  (`synth/soundfont/Hydra.ts:71`). SF3's Ogg Vorbis samples are decoded in
  JS (`Hydra.ts:13,34-38`, `synth/vorbis/`). **No SFZ support.**
- SFZ in the browser exists separately: [sfzlab/sfz-web-player](https://github.com/sfzlab/sfz-web-player)
  (CC0) and [sfztools/sfizz](https://github.com/sfztools/sfizz)
  (BSD-2-Clause, native C++). Using either would mean a second synth beside
  AlphaSynth, which is out of proportion.
- Size: the currently used `MuseScore_General.sf3` is about 40 MB (local
  file `packages/playground/temp/soundfonts/MuseScore_General.sf3`, 39,900,972 B).
  A dedicated multi-sampled DI electric guitar in SF2 would likely add tens
  to hundreds of MB [inferred], so a *guitar-only* SF3 with only the needed
  programs would be needed for the browser.
- The key point for amp sims: amp sims and NAM expect a **DI** input. GM
  program 29/30 samples are recorded *already distorted*, so feeding them
  into an amp sim double-distorts. Use GM 27 "Electric Guitar (clean)" (or
  a DI-recorded guitar SF2) as the source whenever an amp stage is applied
  [inferred from how amp modelling works; GM numbers per
  [MIDI Association GM1](https://midi.org/general-midi-level-1)].
- Paid sampled guitars (Ample Guitar SC = Stratocaster-based, Impact
  Soundworks Shreddage, etc.) ship as VST/AU/AAX plugins with their own
  engines ([Muziker listing for AGSC](https://www.muziker.al/ample-sound-ample-guitar-sc-agsc):
  "AAX, AU, Standalone, VST2, VST3"). Their samples cannot legally be
  converted to SF2 for redistribution [unverified: EULAs not read; this is
  the norm for commercial libraries].

### 4.5 Native VST route (outside the browser)

- VST/AU/AAX plugins are native machine code built against a host SDK.
  Browsers only run JS/WASM in a sandbox, so a stock VST cannot load in a
  browser. The only route is recompiling *source* to WASM: WAM, WebCLAP,
  Faust, NAM-wasm.
- Guitar Pro's RSE is **not available as a plugin**. GP's docs describe it
  only as GP's internal engine, switchable per track, and "the pedalboard is
  exclusive to RSE tracks"
  ([RSE vs MIDI](https://www.guitar-pro.com/docs/gp8/audio/soundsetup/RSE-vs-MIDI),
  [Track Sound](https://www.guitar-pro.com/docs/gp8/audio/soundsetup/sound-settings)).
  No VST/AU version was found in any vendor or retailer page [verified
  absence within the sources searched].
- Using a DAW to frame what quality is possible: export MIDI from alphaTab
  (`midi/MidiFile.ts:161` `toBinary()`), then render it with Ample Guitar
  plus an amp sim (IK AmpliTube, Neural DSP, NAM plugin). This gives the
  best quality, but it is manual and desktop-only.

### 4.6 Server-side / pre-rendering

- Render each track offline on a server: MIDI → VST instrument → amp/cab →
  audio stems, then serve them as media, synced the way the fork already
  syncs backing tracks. Headless hosts: [spotify/pedalboard](https://github.com/spotify/pedalboard)
  (GPL-3.0, hosts VST3/AU) and [DBraun/DawDreamer](https://github.com/DBraun/DawDreamer)
  (GPL-3.0, renders MIDI through VST instruments and Faust). Both are GPL,
  which is fine server-side unless you distribute them.
- Pros: unlimited quality, no client CPU cost. Cons: server cost, re-render
  on every edit, no live tempo/transpose without time-stretching, and
  licensing: commercial VST EULAs may forbid use as a rendering service
  [unverified].
- A browser-side variant uses alphaTab's own exporter (section 3.2 C) plus
  an `OfflineAudioContext` with Convolver/NAM, rendered once per song load.

---

## 5. Mapping proposal: track 1's RSE chain → browser chain

Source: `Strat-Guitar` DI → GEq → Screamer (drive ~0.1) → American Clean
(Fender) combo → Classic compressor → (D-Delay bypassed). Channel strip pan
0.25, volume 0.64.

| RSE stage | Browser stage (free) | Better option | Fidelity notes |
|---|---|---|---|
| `Strat-Guitar` patch, `Pickups` | SoundFont GM 27 clean electric (instead of the file's GM 29) | A DI-recorded Strat SF2/SF3 subset | The source dominates realism; GM samples lack RSE's articulation and pickup variants [inferred]. |
| `E30_EqGEq` (8 values) | 7 × `BiquadFilterNode` peaking at GE-7 centres (100, 200, 400, 800, 1.6k, 3.2k, 6.4k Hz) ±15 dB, value 0.5 = 0 dB, plus output gain | same | Band centres and range are [inferred] from the GE-7 layout; calibrate by A/B. |
| `E03_OverdriveScreamer` (0.0999 / 0.5 / 0.8) | WAM **TS9 Overdrive** (Guitarix/Faust, GPL/LGPL) or a `WaveShaperNode` tanh + mid hump (720 Hz) + tone LPF | NAM capture of a TS-808/TS9 pedal | At drive 0.1 this is mostly a mid-boost into the amp: easy to approximate well. |
| `A02_ComboAmericanClean` (7 values) | Faust `tubes.lib` preamp + `ts.twin` tone stack (LGPL-2.1+) | **NAM capture** of a Fender Twin/Deluxe Reverb (CC-BY or loaded via the TONE3000 API) | NAM amp-only captures are the closest to real gear. RSE's knob mapping is unknown, so map gain → NAM input gain and bass/mid/treble → a tone stack or post EQ [inferred]. |
| (cab, implicit in a combo) | `ConvolverNode` + 2x12/1x12 IR (CC BY-SA or own IR) | Commercial IR with redistribution licence | A combo model includes the speaker in RSE [inferred], so an amp-only NAM capture needs an IR. A full-rig capture does not. |
| `M07_DynamicClassicDynamic` | `DynamicsCompressorNode` (threshold from 0.0989, ratio 0.218, makeup 0.9346, mapping to be calibrated) | same | Fine. |
| `M12_DelayDigitalDelay` (bypassed) | `DelayNode` + feedback `GainNode` | WAM PingPong/SmoothDelay | Honour `Bypass`. |
| ChannelStrip pan/vol | already applied by alphaTab | n/a | |
| Master: all bypassed except Volume/Pan | master gain | n/a | Master effects could map to the existing `WebAudioMixGraph` (section 3.1 step 5). |

Implementation outline (for an issue upstream, if pursued: AGENTS.md
requires an accepted issue before any PR):

1. **Parser/model**: keep `Sound/RSE` (`SoundbankPatch`, `Pickups`,
   `EffectChain` with ids, bypass and raw parameters), the master RSE chain
   and `DSPParam_*` automations on the model, e.g. as a raw, typed
   pass-through on `PlaybackInformation` or `Track`. alphaTab should not
   interpret them; the app does.
2. **Synth**: per-channel render buses (section 3.2 B), exposed either as
   worker-side effect hooks (B1) or multi-output streams (B2).
3. **App (tabz)**: a table from `effect id` → factory(params) producing a
   WebAudio/WAM/NAM chain, plus a "use clean source" program override for
   tracks whose chain contains an amp (`A*` ids).

Honest fidelity expectation: a well-chosen NAM capture plus IR on a *clean*
source gets the *amp colour* close to, or better than, RSE. Realism is
still capped by the GM guitar samples, which have no pickup choice,
round-robin, or slide/bend/mute articulation samples [inferred]. Expect
"clearly better than GM", not "indistinguishable from GP".

---

## 6. Ranking and recommendation

| # | Option | Effort | Sound gain | Licensing risk |
|---|---|---|---|---|
| 1 | Master-bus chain in tabz on the existing `destinationNode` seam: light drive + Twin tone stack + cab IR, and switch guitar tracks to GM 27 clean when an amp is in the RSE chain | Low (app only; the program override needs parser data or a manual per-track setting) | Low-medium (everything shares one chain) | Low with CC-BY-SA/own IR |
| 2 | Per-channel buses in AlphaSynth + RSE pass-through in the parser + id→chain mapping using WebAudio nodes/Faust | Medium-high (core change, upstream issue) | Medium-high | Low (MIT/LGPL; GPL if WAM TS9 is used) |
| 3 | Option 2 plus NAM-wasm as the amp stage | +Medium | High (best in-browser amp realism) | Medium: models need CC-BY or the TONE3000 API; CPU on mobile |
| 4 | Guitar-only DI SF3 (a better source) | Medium (finding/licensing samples) | Medium; multiplies the value of 2/3 | Medium-high (sample licences) |
| 5 | Offline stems in browser (exporter + OfflineAudioContext) | Medium | High, but not live | Same as 2/3 |
| 6 | Server-side VST rendering | High (infra + sync) | Highest | High (VST EULAs, cost) |
| 7 | WAM ecosystem as the main platform | Medium | Medium (no cab, quiet ecosystem) | GPL-ish plugins |
| 8 | Native VST in browser | Not possible | n/a | n/a |

**Recommendation:**

1. Run a quick spike on option 1 in tabz to measure the gain cheaply. The
   biggest audible win per hour is the clean source plus a cab IR, which
   removes the "GM fizz".
2. If the gain is worth it, file an upstream issue (problem statement:
   "RSE sound settings are discarded; no per-track audio bus") for option 2.
   Build the RSE id→chain table in tabz.
3. Add NAM-wasm (option 3) for amp ids, sourcing models through the TONE3000
   API or CC-BY captures, with a WebAudio-only fallback on low-power
   devices.
4. Treat a better guitar SF3 (option 4) as a parallel, independent
   improvement. Leave server rendering (option 6) for a premium "render
   track" feature, if ever.
