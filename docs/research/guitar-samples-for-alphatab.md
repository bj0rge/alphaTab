# Guitar samples for alphaTab

Research notes: which sample sources can give alphaTab a more realistic
**electric guitar** than a General MIDI SoundFont. The main target is a
clean or slightly driven Stratocaster-type guitar for Dire Straits-style
playing. Steel-string acoustic, nylon and electric bass are secondary.
The samples must load in alphaTab's SF2/SF3 synth, appended on top of
`MuseScore_General.sf3`.

This follows [rse-tone-in-the-browser.md](./rse-tone-in-the-browser.md),
whose section 4.4 already covers: no SFZ support in alphaTab, the
"DI source before amp sim" rule, and the fact that commercial plugins ship
their own engines. Those points are not repeated here.

Status: research only. No source code was changed, nothing was downloaded
except small text files read through the GitHub API. Line numbers refer to
`packages/alphatab/src/` at commit `3741b13e` (branch `spike/rse-tone`).

Conventions: **[verified]** means checked against the cited primary source
(code, vendor page, licence file, repository). **[inferred]** means a
reasonable reading that no primary source confirms. **[unverified]** means
not checked, or only a secondary source was found.

---

## TL;DR

- **Appending works by "last loaded wins" on an exact (bank, program)
  match.** A guitar SF3 loaded with `append = true` and a preset at bank 0,
  program 27 replaces MuseScore's "Clean Guitar" on every track that uses
  GM 27. There is no fallback to bank 0 when a bank is missing, so a missing
  bank means silence. [verified]
- **alphaTab ignores several SF2 features that matter for realism.** It
  supports key/velocity ranges, velocity layers, loops, exclusive classes,
  DAHDSR envelopes and a low-pass filter. It **ignores all modulators**,
  has **no round robin** (overlapping zones all sound at once), **silently
  drops stereo samples** (left/right/linked sample types), reads only
  16-bit data, and uses linear interpolation. [verified]
- **Why the current sound is "very MIDI".** MuseScore_General's and
  GeneralUser GS's guitars are 9-12 single-velocity samples stretched over
  the whole range, and both rely on modulators that alphaTab ignores.
  [verified by parsing the local files]
- **Best free source: FreePats "FSBS" electric guitar.** It is a Fender
  recorded **DI**, released under **CC0**, and ships **as SF2**. It has 2
  velocity layers and 4 round robins, which the SF2 encodes as velocity
  slices. The *Direct* variant is mono 48 kHz/24-bit, the right input for
  the existing WebAudio amp/cab chain. The full *Clean* and *Jazz* variants
  are **stereo**, so alphaTab would drop every sample and play nothing.
  [verified]
- **Other CC0 sources: Karoryfer** (sfzinstruments on GitHub). Emilyguitar
  is an Epiphone recorded DI, with 4 velocity layers and 3 round robins.
  Growlybass is a Squier Jazz Bass recorded DI, with 4 velocity layers and
  4 round robins. Both are SFZ only, so they need converting, which loses
  the round robins and release samples. [verified]
- **Paid libraries cannot be used.** Kontakt-Player and proprietary-engine
  libraries (Ample, Shreddage 3, Orange Tree, Prominy) are encrypted or
  locked, and their EULAs forbid redistribution. Serving samples to
  browsers *is* redistribution. Pianobook packs are free but
  non-redistributable. [verified for ISW's EULA wording, Kontakt
  encryption and Pianobook (secondary source); others inferred]
- **Size.** The full Direct SF2 is ~208 MiB of 16-bit audio, and alphaTab
  decodes every sample of a used program into Float32 (2× the 16-bit
  size). Build a **slimmed SF3**: 1-2 round robins per layer, Ogg Vorbis.
  The target is a few MB to download and about 100 MB or less of RAM.
  [inferred from the code and the published sizes]

---

## 1. How `loadSoundFont(data, append)` works

| Step | Behaviour | Citation |
|---|---|---|
| Public API | `AlphaTabApiBase.loadSoundFont(data, append = false)` forwards to the UI facade. The doc says only "Whether to fully replace or append the data". | `AlphaTabApiBase.ts:885`, `:913-915` |
| Synth side | `AlphaSynth.loadSoundFont` parses the bytes into a `Hydra`. If `!append` it clears the list of loaded fonts, then **pushes** the new one. Load order is kept. | `synth/AlphaSynth.ts:611-633` |
| Preset build | On every "ready for playback" (each new song and each new font), all fonts are re-imported in load order: the first with `append = false`, the rest with `append = true`. | `synth/AlphaSynth.ts:635-647` |
| Merge | `loadPresets` builds the presets of one font. With `append` they are **pushed after** the existing ones. Nothing is deduplicated. | `synth/synthesis/TinySoundFont.ts:1140-1146`, `:1503-1509` |
| Lookup / conflicts | `_getPresetIndex(bank, program)` scans the list **backwards**, with the comment "search reverse (last import wins)". An exact `bank` **and** `presetNumber` match is required. | `TinySoundFont.ts:619-632` |
| Program change (melodic) | `channelSetPresetNumber` looks up `(c.bank & 0x7ff, program)` only. There is **no fallback to bank 0**. If not found, `presetIndex = -1` and `noteOn` returns, so the note is silent. | `TinySoundFont.ts:790-808`, `:397-399` |
| Program change (drums, ch 9) | Falls back to `128\|bank`, then `128`, then `128:0`, then the melodic bank. | `TinySoundFont.ts:793-803` |
| Bank number | CC0 (MSB) sets `0x8000\|msb`; CC32 (LSB) then sets `(msb<<7)\|lsb`. alphaTab sends MSB = `bank>>7`, LSB = `bank&0x7f` from `track.playbackInfo.bank`, so the SF2 `wBank` must **equal the model's bank value** (for example bank 1 = MSB 0 / LSB 1). | `TinySoundFont.ts:1011-1018`; `midi/MidiFileGenerator.ts:267-271`; `midi/GeneralMidi.ts:164-169` |
| Lazy sample decoding | Samples are decoded only for presets whose **program number** (any bank) is used by the song. If the GM font and the guitar font both define program 27, **both** are decoded, which costs memory for the shadowed one. | `TinySoundFont.ts:1393-1408` |
| Decoded format | Each used sample is decoded to `Float32Array` and cached. 16-bit PCM is converted to float (4 bytes per sample). SF3 Ogg data is Vorbis-decoded in JS. | `synth/soundfont/Hydra.ts:34-66` |

**Consequence for an add-on guitar font** [inferred from the rows above]:

- To *override* GM sounds, give the add-on presets the GM numbers: bank 0,
  program 24 nylon, 25 steel, 26 jazz, 27 clean, 28 muted, 29/30 OD/dist
  (for a DI source feeding an amp sim), 33/34 finger/pick bass. Load it
  **after** MuseScore_General with `append = true`.
- To keep both and choose per track, put the add-on presets in a
  non-zero bank and set `track.playbackInfo.bank` to that exact value. If
  the add-on font is missing, those tracks go silent, because there is no
  bank-0 fallback.
- A guitar-only font loaded with `append = false` replaces everything, so
  drums and keys go silent.

---

## 2. Which SF2 features alphaTab's synth honours

The synth is a TypeScript port of TinySoundFont (`TinySoundFont.ts` header).
What a library can deliver in alphaTab depends on this table.

| SF2 feature | alphaTab | Citation | Impact on realism |
|---|---|---|---|
| Key ranges (preset + instrument level, intersected) | **Supported** | `TinySoundFont.ts:1286-1315`, `:408-415` | Multi-sampling works. |
| Velocity ranges, i.e. **velocity layers** | **Supported** (preset and instrument `velRange`, intersected) | same lines; `Region.ts:324-331` | Velocity layers work. |
| Velocity → loudness | Linear: `noteGainDb = … - gainToDecibels(1/vel)`. The SF2 default concave velocity→attenuation **modulator is not applied**. | `TinySoundFont.ts:447` | Dynamics curve differs from FluidSynth/Polyphone, so layer balance needs tuning by ear. |
| Velocities that alphaTab actually sends | Quantised: `15 + n×16` per dynamic (ppp…fff), ±16 for accents/ghosts | `midi/MidiUtils.ts:9-10`, `:78-165`; `midi/MidiFileGenerator.ts:1333-1346` | Only ~8-11 distinct velocities, so a note with the same dynamic always hits the **same** zone. |
| **Round robin** | **None.** SF2 2.04 has no round-robin or random generator, and alphaTab "Play[s] all matching regions" | `TinySoundFont.ts:406-415` | Overlapping RR zones (e.g. an SFZ converted naively) **all sound at once**: phasing and +6-12 dB. |
| **Modulators** (pmod/imod, incl. SF2 default modulators) | **Parsed, then ignored** ("Modulators (TODO)") | `Hydra.ts:98`, `:134`; `TinySoundFont.ts:1483-1484`, `:1493-1494` | No velocity→filter brightness, no CC→anything. GM banks that rely on modulators sound flatter. |
| Release samples (release trigger) | Not part of SF2, so not available | — | String-release noises cannot be triggered on note-off. |
| Exclusive class (generator 57) | **Supported** within the same preset: matching voices `endQuick` | `Region.ts:358-359`; `TinySoundFont.ts:418-424` | Usable for choke-style behaviour. |
| Loop modes (sampleModes 54) | none / continuous / loop-until-release | `Region.ts:347-353`; `Voice.ts:84-95` | Fine for guitars (usually unlooped or tail-looped). |
| Volume and modulation envelopes (DAHDSR, keynum→hold/decay) | Supported, but keynum scaling is applied only when the value is **> 0** | `Region.ts:276-323`; `VoiceEnvelope.ts:172-179` | Minor. |
| Low-pass filter (initialFilterFc/Q, modEnv/modLFO→Fc) | Supported | `TinySoundFont.ts:470-477`; `Region.ts:243-257` | Static tone shaping works; velocity-driven brightness does not. |
| LFOs (vib/mod → pitch, volume, filter) | Supported | `Region.ts:234-275` | Fine. |
| Chorus/reverb send (15/16) | Ignored (no case in `Region.operator`) | `Region.ts:217-365` | Handled by the WebAudio chain anyway. |
| `keynum` / `velocity` override generators (46/47) | Ignored (no case in `Region.operator`) | `Region.ts:60-61`, `:217-365` | Matters only for converted libraries that use them (e.g. FreePats' converter writes `velocity=127` when `amp_veltrack=0`). |
| **Stereo samples** (sampleType left 4 / right 2 / linked 8, ROM) | **Skipped**: only `sampleType & 0x01` (mono) is loaded, others get an empty buffer and a warning | `TinySoundFont.ts:1410`, `:1452-1467` | **Any stereo library plays nothing.** Convert to mono first. |
| 24-bit (`sm24` chunk) | Ignored: only `smpl` is read, 16-bit | `Hydra.ts:166-178`, `:52-58` | Fine for playback. |
| Interpolation | Linear | `Voice.ts:246-250` | Some aliasing on large up-pitching. Denser key mapping helps. |

### 2.1 What the current GM guitars look like (local files, parsed with a small script)

| Font / preset | Samples | Velocity layers | Sample types | Instrument modulators |
|---|---|---|---|---|
| MuseScore_General.sf3, 0:27 Clean Guitar | 10 unique, 20 zones (two layered zones per key range) | 1 | all mono (0x11) | 3 per instrument (ignored) |
| MuseScore_General.sf3, 0:24/25/26/29/30 | 10-12 unique | 1 | mono | 3 |
| GeneralUser-GS.sf2, 0:27 Clean Guitar | 9 | 1 | mono | 5 (ignored) |
| GeneralUser-GS.sf2, 0:33/34 basses | 4-16 | 1 | mono | 5-12 |

Source: `packages/playground/temp/soundfonts/{MuseScore_General.sf3,GeneralUser-GS.sf2}`
[verified]. MuseScore_General.sf3 also contains 73 left + 73 right stereo
samples (types 0x14/0x12) that alphaTab drops. None of them belong to the
guitar or bass presets above [verified].

Takeaway: one sample per ~5 semitones, one dynamic, no variation. This,
not the amp chain, is the main reason the sound is "very MIDI"
[inferred].

### 2.2 Workarounds for round robin in SF2 / alphaTab

1. **Velocity-sliced pseudo round robin.** Each RR is assigned to a
   different single velocity value inside the layer. FreePats' converter
   does exactly this for groups tagged `//+ RandomRegion: Yes`: RR1 at
   `vel = hivel`, RR2 at `hivel-1`, and so on, cycling down to `lovel`
   ([freepats-tools sf2.py](https://github.com/freepats/freepats-tools/blob/master/sf2.py),
   the `randomRegion` branch) [verified]. In alphaTab the velocities are
   quantised (table above), so one dynamic always hits the same RR. It
   gives variation **between** dynamics/accents, not between repeated
   notes [inferred].
2. **Keep one RR** per layer and drop the rest. This is the smallest file,
   and it is what alphaTab effectively plays anyway [inferred].
3. **Never keep overlapping RR zones** with identical key/velocity ranges:
   alphaTab plays them all at once (`TinySoundFont.ts:406-415`) [verified].
4. True RR would need a synth change, for example cycling between
   identical-range regions in `noteOn`. That is out of scope and not
   proposed here.

---

## 3. Free sources

### 3.1 Guitar-specific, natively SF2

| Library | Instrument / recording | Format & size | Layers / RR / articulations | Licence | Usable in alphaTab? |
|---|---|---|---|---|---|
| **FreePats FSBS Electric Guitar – Direct** (2022-09-11) | "Fender electric guitar (basic model)", **direct** through an instrument input, bridge pickup. Samples: **mono, 48 kHz, 24-bit WAV** | SF2 7z 60 MiB (uncompressed figure on the page: 208 MiB); SFZ+FLAC 74 MiB; SFZ+WAV 153 MiB | 18 key zones (B1–D6, every 2-4 semitones), **2 velocity layers** on 11 low zones (≤92 / ≥93), **4 RR** (`lorand/hirand`), 120 regions; sustain only | **CC0 1.0** | **Yes**: mono, and the SF2 already exists. Needs an amp sim, which you already have. |
| **FreePats FSBS Electric Guitar – Clean #1** (2026-08-07) | Same guitar, re-amped "through an amplifier and effects rack" | SF2 129 MiB (425); **small** SF2 6.3 MiB (10) | Full: 2 layers × 4 RR. Small: **1 sample per zone, looped**, 13 zones | CC0 1.0 | Full: **no as shipped**, because the samples are **stereo** 48 kHz/24-bit, so the SF2 has L/R types and alphaTab drops them. Must be converted to mono. Small: **yes**, the samples are mono 44.1 kHz/16-bit. |
| FreePats FSBS – Jazz (2026-08-07) | Same guitar, jazz re-amp | SF2 66 MiB; small 5.0 MiB | as Clean | CC0 | Full: stereo, same issue. Small: probably mono [unverified]. |
| FreePats FSBS – Dist #1 / #2 (2022-09-11) | Same guitar, distorted | SF2 317 / 121 MiB | — | CC0 | Too big. Pre-distorted, so not for an amp chain. |
| FreePats Clean Electric Bass "YR" (2019-09-30) | Yamaha RBX, pick and finger | SF2 2.2 / 2.5 MiB | not stated | CC0 1.0 | Very likely (tiny). Sample channel count [unverified]. |
| FreePats Spanish Classical Guitar (2019-06-18) | Nylon, AKG Perception 120 | SF2 9.5 MiB (19) | not stated | CC0 1.0 | Likely. Channel count [unverified]. |
| FreePats FSS Steel-String (2020-05-21) | Subset of FlameStudios "Seagull" GIG | SF2 12 MiB; small 2.7 MiB | not stated | **GPL-3.0+ with a composition exception** (FreePats now deprecates this licence) | Licence-compatible if the SF2 is served as-is with its licence [inferred]; quality unknown. |
| "Clean Stratocaster.sf2" on polyphone.io (katoharu) | "Electronic instrument" category, 1 preset 0:27 | 1.01 MB | not stated | Public domain (per the listing) | Login wall; at 1 MB it is unlikely to beat GM [inferred]. |

Sources: [FreePats clean/direct/jazz page](https://freepats.zenvoid.org/ElectricGuitar/clean-electric-guitar.html),
[distorted page](https://freepats.zenvoid.org/ElectricGuitar/distorted-electric-guitar.html),
[bass page](https://freepats.zenvoid.org/ElectricGuitar/clean-electric-bass.html),
[nylon](https://freepats.zenvoid.org/Guitar/acoustic-guitar.html),
[steel](https://freepats.zenvoid.org/Guitar/steel-acoustic-guitar.html),
[FreePats licences](https://freepats.zenvoid.org/licenses.html),
repos [electric-guitar-FSBS-direct](https://github.com/freepats/electric-guitar-FSBS-direct)
/ [-clean](https://github.com/freepats/electric-guitar-FSBS-clean)
/ [-jazz](https://github.com/freepats/electric-guitar-FSBS-jazz)
(README.txt, LICENSE.txt = CC0, the `.sfz` mappings, release asset sizes),
[polyphone.io listing](https://polyphone.io/en/soundfonts/guitars/449-clean-stratocaster).
Zone/layer/RR counts come from the repos' `.sfz` files [verified]. Sample
formats were read from the FLAC/WAV headers through the GitHub blob API:
the Direct `A#5_s6_01.wav` is PCM, 1 ch, 48 000 Hz, 24-bit; the Clean full
`A#5_s6_01.flac` is 2 ch, 48 kHz, 24-bit; the Clean small `A2_s2_01.flac`
is 1 ch, 44.1 kHz, 16-bit [verified]. That FreePats' SF2s were built with
`freepats-tools`, which writes stereo as L/R sample types (`sf2.py`,
`sampleType = 4/2` when `channels == 2`), is [inferred] from the shared
project. The SF2 files themselves were not downloaded.

### 3.2 Guitar-specific, SFZ only (needs conversion)

All the Karoryfer libraries below are **CC0-1.0** on GitHub, and their
readmes say "Royalty-free for all commercial and non-commercial use". This
includes redistribution [verified: GitHub licence field, LICENSE file and
readme of each repo in [github.com/sfzinstruments](https://github.com/sfzinstruments)].

| Library | Instrument / recording | Download size | Layers / RR / extras | Notes |
|---|---|---|---|---|
| **[Emilyguitar](https://github.com/sfzinstruments/karoryfer.emilyguitar)** | Epiphone "Emily the Strange", flatwound 11s, **recorded direct**, both pickups | 103 MB zip | **4 velocity layers × 3 RR**, release samples 4 RR, noises 5 RR. Mappings: basic, **clean (no release samples)**, 3-voice, 5-voice, chords | Best dynamics of the free options, and DI. Not a Strat: flatwounds give a darker sound [inferred]. |
| [Black And Green Guitars](https://github.com/sfzinstruments/karoryfer.black-and-green-guitars) | Gretsch Anniversary + Hofner Club (hollow-bodies) | 482 MB zip, 1 776 samples | keyswitched twang/staccato/hammer-on/behind-bridge, vibrato and unison controls | Sforzando-oriented (CC-driven). Wrong guitar type for Knopfler. |
| [Shinyguitar](https://github.com/sfzinstruments/karoryfer.shinyguitar) | Archtop, magnetic pickup + mic blend (CC100) | ~350 MB repo | release noises, CC voices | Sforzando bank; jazz box. |
| **[Growlybass](https://github.com/sfzinstruments/karoryfer.growlybass)** | Squier Jazz Bass, **recorded direct**, both pickups | 167 MB zip | **4 velocity layers × 4 RR** sustain, staccato 5 RR, releases | Best free electric bass found. |
| [Swagbass](https://github.com/sfzinstruments/karoryfer.swagbass) / [Fashionbass](https://github.com/sfzinstruments/karoryfer.fashionbass) | Ibanez BTB flatwound / Killer KB, DI, neck pickup | 145 / 316 MB | 3×4 / 5×3 | alternatives |
| [Black And Blue Basses](https://github.com/sfzinstruments/karoryfer.black-and-blue-basses), [Big Little Bass](https://github.com/sfzinstruments/karoryfer.big-little-bass), [Pastabass](https://github.com/sfzinstruments/karoryfer.pastabass) (Bass VI) | basses | 1 GB / 264 MB / — | — | too large or niche |
| [Guitar DI Lite](https://boyss-sound-e-scapes.gumroad.com/l/guitar-di) (Boyss-Sound-e-Scapes) | dry DI guitar, "2 round robins" | ? | ? | Secondary source only ([BPB](https://bedroomproducersblog.com/2020/02/19/free-guitar-samples/)). Licence not found [unverified]. |

Not usable or not samples:

- **Spicy Guitar** is a free **physical-modelling** acoustic-guitar plugin,
  not a sample library ([Sonicstate](https://www.sonicstate.com/news/2011/03/17/spicy-guitar-now-free/),
  [Synthtopia](https://synthtopia.com/?p=31718)) [unverified beyond press
  coverage].
- **VSCO 2 CE** (CC0) has no guitar: its top-level folders are Brass, Keys,
  Percussion, Strings, Woodwinds
  ([repo tree](https://github.com/sgossner/VSCO-2-CE)) [verified].
  **Sonatina** is an orchestral library [unverified, not checked].
- **Pianobook** has several Strats, e.g.
  [’62 Reissue Stratocaster](https://www.pianobook.co.uk/packs/62-reissue-stratocaster/):
  a Strat into a Marshall JVM1 "on the edge of breakup", 3 velocity layers,
  one sample every 3 notes, with compression/reverb/delay baked in
  [verified from the page]. Pianobook's terms reportedly say "You may not
  sell sample(s), or give away any sample(s) for use by any other
  person(s)" (quoted in a [2021 LAU post](https://lists.linuxaudio.org/archives/linux-audio-user/2021-May/114357.html);
  the live terms page could not be loaded) [unverified]. That rules out
  serving them to browsers.
- **Crispy Clean Strat** (Kontakt + WAV) and **Shreddage 3 Stratus FREE**
  (Kontakt) are covered in 4.

### 3.3 Converting SFZ / Decent Sampler to SF2, and what is lost

| Tool | What it does | Source |
|---|---|---|
| **Polyphone** (GPL-3.0, GUI + undocumented CLI) | Imports SFZ and exports SF2/SF3. "Only opcodes having a counterpart in tables are imported." `group`/`off_by` must match within a group. Separate pitch/filter envelopes cannot both be imported. | [Polyphone: soundfont formats](https://www.polyphone.io/en/documentation/manual/annexes/the-different-soundfont-formats) [verified]; CLI flags `-1` (sf2) / `-3` (sfz) per a [forum post](https://www.polyphone.io/fr/forum/support-bug-reports/255-convert-sfz-sf2-via-command-line) [unverified] |
| **ConvertWithMoss** (LGPL-3.0, Java, active: pushed 2026-10-11) | Reads SFZ, **DecentSampler** (`.dspreset`/`.dslibrary`), NKI (unencrypted only) and others; reads and writes SoundFont 2. "Formats which cannot express a random selection of a zone fall back to round-robin and never to playing all zones at once." Mono L/R pairs are combined into stereo when reading SF2. "Encrypted files are not supported." | [README-FORMATS.md](https://github.com/git-moss/ConvertWithMoss/blob/master/documentation/README-FORMATS.md) [verified] |
| **freepats-tools** `convertSoundBank.py` (GPL-3.0) | SFZ → SF2, "minimal subset of SFZ opcodes". Maps `RandomRegion` groups to velocity-sliced pseudo RR. Writes stereo samples as L/R types. | [freepats-tools](https://github.com/freepats/freepats-tools) README and `sf2.py` [verified] |

What is lost going SFZ → SF2 for alphaTab [inferred from the SF2 model
and section 2, unless marked]:

- **Random / sequential round robin** (`lorand/hirand`, `seq_length`). It
  is dropped, or turned into velocity slices (freepats-tools). An importer
  that keeps all regions without the random condition produces stacked
  voices in alphaTab (`TinySoundFont.ts:406-415`). This must be checked
  after a Polyphone import [unverified].
- **Release samples** (`trigger=release`). SF2 has no release trigger. If
  an importer keeps them as normal zones, they play **on note-on**. Use
  the library's "clean" mapping (Emilyguitar and Growlybass ship one,
  [verified] in their readmes).
- **Keyswitches** (`sw_*`) and **CC-driven controls** (`locc/hicc`,
  vibrato and tone CCs, mic blend). SF2 cannot select zones by keyswitch
  or CC, and alphaTab ignores modulators anyway. One articulation per
  preset remains, which can be split into separate presets/programs (e.g.
  sustain on 27, palm-mute on 28).
- **Sforzando scripting / bank XML / GUI.** Lost entirely.
- **24-bit depth.** Kept in SF2 via `sm24`, but alphaTab reads 16-bit only
  (`Hydra.ts:166-178`) [verified].
- **Stereo.** Must be summed or picked to **mono** before or after
  conversion, or alphaTab drops the samples (`TinySoundFont.ts:1410`)
  [verified].
- **Velocity curves** (`amp_velcurve_N`, `amp_veltrack`). alphaTab uses a
  linear gain (`TinySoundFont.ts:447`) [verified], so the layer
  attenuations need re-balancing.

---

## 4. Paid libraries

None of the commercial guitars found can legally become a browser-served
SF3. The table shows why.

| Product | Engine / format | Why it cannot be used | Source |
|---|---|---|---|
| Ample Sound Ample Guitar SC (Strat, 4 pickup libraries, 10 articulations, ~6 100 samples, ~9.9 GB) and other Ample guitars | Proprietary plugin (VST2/3, AU, AAX, standalone) | Samples are not exposed. The EULA covers "sound libraries" [unverified: the PDF text could not be extracted]. | [Plugin Boutique](https://www.pluginboutique.com/products/15098-Ample-Guitar-SC), [Ample AGL page](https://www.amplesound.net/en/pro-pd.asp?id=8), [EULA PDF](https://amplesound.net/en/EULA-Ample.pdf) |
| Impact Soundworks Shreddage 3 (incl. **Stratus FREE**: DI neck pickup, 3 dynamics, up to 4 down + 4 up strokes per note, 1 GB) | Kontakt (the product page says Kontakt Player 6.7+; earlier coverage says full Kontakt is required) | ISW licence forbids "Redistributing, reselling, electronically transmitting, uploading, sharing, or renting the Product" and use "in the production of any other sample library or virtual instrument products". Older Shreddage SFZ editions existed ([KVR forum](https://www.kvraudio.com/forum/viewtopic.php?p=4943433)), but the same terms apply [inferred]. | [Stratus FREE page](https://impactsoundworks.com/product/shreddage-3-stratus-free/); licence text via [tostracker archive](https://tostracker.app/document/impact-soundworks) [verified wording, archived copy] |
| Orange Tree Samples Evolution Stratosphere (single-coil, 4× RR, 3 dynamics, 2.53 GB, $179) | Kontakt Player | Kontakt Player libraries are encrypted. ConvertWithMoss: "Encrypted files are not supported." | [product page](https://www.orangetreesamples.com/products/evolution-electric-guitar-stratosphere), [ConvertWithMoss](https://github.com/git-moss/ConvertWithMoss/blob/master/documentation/README-FORMATS.md) |
| Prominy V-METAL / SR5 Rock Bass | Kontakt Player, NCW, product activation | same | [KVR](https://www.kvraudio.com/product/v-metal-2-by-prominy), [SOS SR5 review](https://www.soundonsound.com/reviews/prominy-sr5-rock-bass) [unverified details] |
| Native Instruments Session Guitarist etc. | Kontakt Player | same | [inferred] |
| Karoryfer paid catalogue (e.g. Dubious Electrics) | SFZ + "unlocked WAV files" that "can be used in other samplers" | Technically convertible, but no electric-guitar product was in the shop listing and the paid licence terms were not found. Ask the vendor. | [shop.karoryfer.com](https://shop.karoryfer.com/) [unverified licence] |

The only commercial route is a **custom licence**: ask a vendor for
redistribution rights in a web app, or record your own Strat DI
multisamples (the FreePats Direct mapping is a good template). This is
[inferred], not researched further.

---

## 5. GM banks (for the non-guitar parts, and for comparison)

| Bank | Size | Licence | Guitar quality for alphaTab | Source |
|---|---|---|---|---|
| MuseScore_General.sf3 (current) | 40 MB | MIT | 10 samples, 1 layer (section 2.1) | local `MuseScore_General_License.md` [verified] |
| FluidR3_GM | ~140 MB SF2 [unverified size] | MIT ("I hereby release Fluid under the MIT license") | MuseScore_General derives from it ("All instruments without attribution are still using samples from FluidR3Mono") | [Debian copyright](https://metadata.ftp-master.debian.org/changelogs//main/f/fluid-soundfont/fluid-soundfont_3.1-5.3_copyright), local licence file [verified] |
| GeneralUser GS | 32 MB SF2 | Permissive: "feel free to use it in your software projects, and to modify …"; the author is not "100% sure where all of the samples originated" | 9 samples, 1 layer (section 2.1) | [LICENSE.txt](https://github.com/mrbumpy409/GeneralUser-GS/blob/main/documentation/LICENSE.txt) [verified] |
| Arachno SoundFont | 136 MB SF2 | No licence found. The site footer says "All rights reserved. Any reproduction is forbidden without authorization." | Guitar demos exist | [arachnosoft.com](https://www.arachnosoft.com/main/soundfont.php) [verified page; licence absent] |
| Timbres of Heaven | large | "personal use" per the Polyphone listing | — | [Polyphone listing](https://www.polyphone.io/en/soundfonts/instrument-sets/261-timbres-of-heaven-v3-4-final) [unverified primary] |
| SGM-V2.01 | 235 MB | No licence found | — | [Wikipedia: SoundFont](https://en.wikipedia.org/wiki/SoundFont) [unverified] |
| Musyng Kite | large | Conflicting: "personal use" on Polyphone; CC BY-SA 3.0 claimed by the MIDI.js conversion | — | [Polyphone](https://www.polyphone.io/en/soundfonts/instrument-sets/258-musyng-kite), [MIDI.js README](https://unpkg.com/music21j-port@0.9.7/src/ext/soundfonts/README.md) [unverified] |

No GM bank was found whose electric guitars are clearly better *and*
redistributable. Keep MuseScore_General for everything else and append a
dedicated guitar font [inferred].

---

## 6. Size, SF3 and browser delivery

- **SF3** stores samples as Ogg Vorbis and is "about 10 times lighter than
  the sf2 format for a comparable quality"
  ([Polyphone](https://www.polyphone.io/en/documentation/manual/annexes/the-different-soundfont-formats))
  [verified claim]. alphaTab decodes Vorbis in JS on load
  (`Hydra.ts:37-39`) [verified]. Polyphone can export SF3 [verified, same
  page].
- **Two memory costs** [verified code, numbers inferred]:
  1. The whole file stays in `Hydra.sampleData` (`Hydra.ts:169-171`).
  2. Every sample of every preset whose program is used is decoded to
     Float32 (`TinySoundFont.ts:1393-1408`, `Hydra.ts:55-61`). That is 4
     bytes per sample frame, so ~2× the 16-bit size, at the file's sample
     rate.

  For example, the full FSBS Direct SF2 is ~208 MiB of 16-bit audio,
  which would be ~416 MiB of Float32 in the worker once program 27 is used.
  That is far too much, especially on mobile.
- **Slimming FSBS Direct** [inferred estimates]:
  - Keep 1 RR per layer, i.e. 30 of the 120 regions: ~52 MiB 16-bit,
    ~104 MiB decoded.
  - Optionally keep only the loud layer (≥93) where both exist, trim long
    tails (≤4-6 s) and resample 48 → 32 or 44.1 kHz. That roughly halves
    it again.
  - As SF3 the download would be a few MB.
- **Shadowed presets** are decoded too (section 1). A guitar font that
  overrides 0:27 still causes MuseScore's 0:27 to decode. That is small
  for GM (10 samples) [verified behaviour; size impact inferred].
- **Practical targets** [inferred, no browser limit was measured]: a
  guitar add-on SF3 of **≤10-20 MB** download and **≤100-150 MB**
  decoded. The worker has to Vorbis-decode everything before playback, so
  load time grows with sample count.
- **Serving.** CC0 needs no notice. GPL+exception (FreePats steel) means
  serving the SF2 with its licence text. MIT (MuseScore_General) needs the
  licence notice kept [inferred from the licence texts].

---

## 7. Ranked shortlist

| # | Pick | Why | Direct download |
|---|---|---|---|
| **1 (recommended)** | **FreePats FSBS Electric Guitar – Direct (SF2)** | Fender, recorded **DI**, **mono**, CC0, already SF2, 2 layers × 4 pseudo-RR. Built for an amp sim, which is the chain you already have. Slim it (1-2 RR, mono 16-bit, SF3), set it as bank 0 programs 27 (and optionally 26/28-30), and append it after MuseScore_General. | <https://github.com/freepats/electric-guitar-FSBS-direct/releases/download/2022-09-11/EGuitarFSBS-direct-SF2-20220911.7z> (60 MiB; FLAC/SFZ alt: [74 MiB](https://github.com/freepats/electric-guitar-FSBS-direct/releases/download/2022-09-11/EGuitarFSBS-direct-SFZ+FLAC-20220911.7z)) |
| 2 | FreePats FSBS Clean – **bridge small** SF2 | 6.3 MiB, mono, CC0, works as-is. The fastest A/B test against MuseScore 0:27 (no amp needed, but only 1 layer). | <https://github.com/freepats/electric-guitar-FSBS-clean/releases/download/2026-08-07/EGuitarFSBS-clean-bridge-small-SF2-20260807.7z> |
| 3 | Karoryfer **Emilyguitar** (convert the `emily_clean.sfz` mapping) | CC0, DI, **4 velocity layers** (more dynamic nuance than FSBS), 103 MB. Not Strat-like (flatwounds). Conversion work: drop RR to 1, drop releases, mono. | <https://github.com/sfzinstruments/karoryfer.emilyguitar/releases/download/v1.001/Karoryfer.Emilyguitar.v1.001.zip> |
| 4 | Karoryfer **Growlybass** (bass) / FreePats Bass YR (quick test) | Growlybass: CC0, Squier Jazz DI, 4 × 4. YR: CC0, 2.2 MiB SF2, ready to try. | <https://github.com/sfzinstruments/karoryfer.growlybass/releases/download/v1.002/Karoryfer.Growlybass.v1.002.zip>; <https://github.com/freepats/electric-bass-YR/releases/download/2019-09-30/PickedBassYR-SF2-20190930.7z> |
| 5 | FreePats Spanish Classical (nylon) | CC0, 9.5 MiB SF2. Steel string: FreePats FSS (GPL+exception) or keep GM. | <https://freepats.zenvoid.org/Guitar/acoustic-guitar.html> (download links on the page) |

Before shipping any pick, open it in Polyphone and check two things:

1. All samples are **mono**. Left/right samples are silent in alphaTab.
2. No zones overlap with identical key/velocity ranges. Those would stack
   in alphaTab.

Then A/B the result through the existing amp/cab chain on the Dire
Straits test file.

**Recommendation:** start with #2 for a 5-minute sanity check of the
append path. Then build a slimmed SF3 from #1 (FSBS Direct), mapped to GM
27 and fed into the WebAudio amp/cab chain. Use Growlybass (#4) the same
way if the bass also needs an upgrade.
