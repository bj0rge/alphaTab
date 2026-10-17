import * as alphaTab from '@coderline/alphatab';
import { type Mountable, css, html, injectStyles, parseHtml } from '../util/Dom';
import { type RseTrack, GeqBands, readRseTracks, rseToChain } from './ToneLabRse';

/*
 * Spike (?tone=1): routes the synthesizer through a WebAudio guitar chain to hear how close a browser chain gets to
 * Guitar Pro's RSE. Throwaway: alphaTab is not changed, the synthesizer's worklet node is intercepted instead.
 * See docs/research/rse-tone-in-the-browser.md. The chain is on the master output, so every track goes through it:
 * solo the guitar track to judge it.
 */

injectStyles(
    'ToneLab',
    css`
    .at-tone-lab {
        position: fixed;
        top: 8px;
        right: 8px;
        z-index: 1000;
        width: 280px;
        max-height: calc(100vh - 16px);
        overflow-y: auto;
        padding: 8px 10px;
        background: #fff;
        border: 1px solid rgba(0, 0, 0, 0.2);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        font: 12px sans-serif;
    }
    .at-tone-lab h3 { margin: 4px 0; font-size: 13px; }
    .at-tone-lab h4 { margin: 8px 0 2px; font-size: 12px; color: #555; }
    .at-tone-lab label { display: flex; align-items: center; justify-content: space-between; margin: 2px 0; }
    .at-tone-lab label input[type='range'] { width: 130px; }
    .at-tone-lab .at-tone-value { width: 44px; text-align: right; color: #555; }
    .at-tone-lab .at-tone-status { color: #888; margin: 4px 0; }
    .at-tone-lab input[type='file'] { width: 100%; font-size: 11px; }
    .at-tone-lab select { width: 100%; }
    .at-tone-lab .at-tone-rse-chain { color: #555; font-size: 11px; white-space: pre-wrap; margin: 2px 0; }
`
);

/** GM programs (0-based) of electric guitars: 26 jazz, 27 clean, 28 muted, 29 overdriven, 30 distortion, 31 harmonics. */
const ElectricGuitarPrograms = new Set([26, 27, 28, 29, 30, 31]);
/** GM 27, clean electric guitar: amp stages expect a clean source, GM 29/30 are recorded already distorted. */
const CleanGuitar: SoundFontPreset = { name: 'GM clean electric guitar', bank: 0, program: 27 };

interface SoundFontPreset {
    name: string;
    bank: number;
    program: number;
}

/** The presets of an SF2/SF3 file (RIFF sfbk → LIST pdta → phdr, 38-byte records, the last one is EOP). */
function readPresets(data: Uint8Array): SoundFontPreset[] {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const tag = (at: number) => String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);
    const presets: SoundFontPreset[] = [];
    let at = 12;
    while (at + 8 <= data.length) {
        const size = view.getUint32(at + 4, true);
        if (tag(at) === 'LIST' && tag(at + 8) === 'pdta') {
            let sub = at + 12;
            while (sub + 8 <= at + 8 + size) {
                const subSize = view.getUint32(sub + 4, true);
                if (tag(sub) === 'phdr') {
                    for (let r = sub + 8; r + 38 <= sub + 8 + subSize - 38; r += 38) {
                        const name = new TextDecoder('latin1').decode(data.subarray(r, r + 20)).replace(/\0.*$/, '');
                        presets.push({ name, program: view.getUint16(r + 20, true), bank: view.getUint16(r + 22, true) });
                    }
                    return presets;
                }
                sub += 8 + subSize + (subSize & 1);
            }
        }
        at += 8 + size + (size & 1);
    }
    return presets;
}

interface Knob {
    /** set from the RSE settings of the file (see RseMapping) */
    id?: string;
    label: string;
    min: number;
    max: number;
    step: number;
    value: number;
    unit?: string;
    apply(chain: ToneChain, value: number): void;
}

/** The input range of the shaper curves: the WaveShaperNode clamps its input to ±1, this keeps headroom. */
const ShaperHeadroom = 8;

/**
 * A fixed soft clipper with a slope of 1 around zero (small signals pass unchanged) over ±ShaperHeadroom: the drive is
 * the gain in front of it, so turning it up saturates progressively instead of reshaping the curve.
 */
function softClipCurve(asymmetry: number): Float32Array<ArrayBuffer> {
    const n = 8192;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const x = ((i / (n - 1)) * 2 - 1) * ShaperHeadroom;
        // a little asymmetry adds the even harmonics of a tube stage (monotonic, silence stays at zero)
        const t = Math.tanh(x);
        curve[i] = t + asymmetry * t * t;
    }
    return curve;
}

/** A short, bright, decaying noise burst with a little flutter: a stand-in for a spring tank. */
function springLikeImpulse(c: BaseAudioContext): AudioBuffer {
    const seconds = 1.8;
    const buffer = c.createBuffer(2, Math.floor(c.sampleRate * seconds), c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
        const data = buffer.getChannelData(ch);
        let last = 0;
        for (let i = 0; i < data.length; i++) {
            const t = i / c.sampleRate;
            const flutter = 1 + 0.3 * Math.sin(2 * Math.PI * 23 * t);
            const noise = Math.random() * 2 - 1;
            // a one-pole high-pass keeps it thin like a spring
            const hp = noise - last;
            last = noise;
            data[i] = hp * Math.exp(-t * 3.2) * flutter * 0.5;
        }
    }
    return buffer;
}

/**
 * input → [leveler] → [graphic EQ] → [TS-style overdrive] → [amp: gain stage + Fender-like tone stack, reverb,
 * tremolo] → compressor → cab → [delay] → output,
 * with a dry path for A/B.
 */
class ToneChain {
    readonly input: GainNode;
    readonly output: GainNode;
    readonly dry: GainNode;
    readonly wet: GainNode;

    readonly tsClipPre: BiquadFilterNode;
    readonly tsDrive: GainNode;
    readonly tsShaper: WaveShaperNode;
    readonly tsTone: BiquadFilterNode;
    readonly tsLevel: GainNode;
    readonly tsDry: GainNode;
    readonly tsBypass: GainNode;
    readonly tsActive: GainNode;

    readonly leveler: DynamicsCompressorNode;
    readonly levelerMakeUp: GainNode;
    readonly levelerBypass: GainNode;
    readonly levelerActive: GainNode;

    readonly ampPre: GainNode;
    readonly ampShaper: WaveShaperNode;
    readonly ampDrive: GainNode;
    readonly ampCompensation: GainNode;
    readonly bass: BiquadFilterNode;
    readonly mid: BiquadFilterNode;
    readonly treble: BiquadFilterNode;
    readonly ampMaster: GainNode;
    readonly reverb: ConvolverNode;
    readonly reverbMix: GainNode;
    readonly tremolo: GainNode;
    readonly tremoloLfo: OscillatorNode;
    readonly tremoloDepth: GainNode;

    readonly geq: BiquadFilterNode[];
    readonly geqLevel: GainNode;

    readonly delay: DelayNode;
    readonly delayFeedback: GainNode;
    readonly delayMix: GainNode;

    readonly compressor: DynamicsCompressorNode;

    readonly cabSim: GainNode;
    readonly cabHighPass: BiquadFilterNode;
    readonly cabPresence: BiquadFilterNode;
    readonly cabLowPass1: BiquadFilterNode;
    readonly cabLowPass2: BiquadFilterNode;
    readonly cabIr: ConvolverNode;
    readonly cabIrGain: GainNode;
    readonly cabSimGain: GainNode;
    readonly makeUp: GainNode;

    private irConnected = false;

    constructor(readonly context: BaseAudioContext) {
        const c = context;
        this.input = c.createGain();
        this.output = c.createGain();
        this.dry = c.createGain();
        this.wet = c.createGain();
        this.input.connect(this.dry).connect(this.output);

        // Tube Screamer: only the band above ~720 Hz is clipped (its mid hump), the clean signal is mixed back
        this.tsBypass = c.createGain();
        this.tsActive = c.createGain();
        this.tsDry = c.createGain();
        this.tsClipPre = c.createBiquadFilter();
        this.tsClipPre.type = 'highpass';
        this.tsClipPre.frequency.value = 720;
        this.tsDrive = c.createGain();
        this.tsShaper = c.createWaveShaper();
        this.tsShaper.oversample = '4x';
        this.tsTone = c.createBiquadFilter();
        this.tsTone.type = 'lowpass';
        this.tsLevel = c.createGain();
        const tsOut = c.createGain();
        // leveler: a fast, hard compressor so the drive stages see a steady level whatever the velocity
        const levelerOut = c.createGain();
        this.levelerBypass = c.createGain();
        this.levelerActive = c.createGain();
        this.leveler = c.createDynamicsCompressor();
        this.leveler.attack.value = 0.002;
        this.leveler.release.value = 0.15;
        this.leveler.knee.value = 6;
        this.levelerMakeUp = c.createGain();
        this.input.connect(this.levelerBypass).connect(levelerOut);
        this.input
            .connect(this.leveler)
            .connect(this.levelerMakeUp)
            .connect(this.levelerActive)
            .connect(levelerOut);
        // graphic EQ before the drive (E30 G-EQ: 100 Hz … 6.4 kHz, ±15 dB, then a level)
        this.geq = GeqBands.map(f => {
            const band = c.createBiquadFilter();
            band.type = 'peaking';
            band.frequency.value = f;
            band.Q.value = 1.4;
            return band;
        });
        this.geqLevel = c.createGain();
        let eqTail: AudioNode = levelerOut;
        for (const band of this.geq) {
            eqTail = eqTail.connect(band);
        }
        eqTail.connect(this.geqLevel);
        this.geqLevel.connect(this.tsBypass).connect(tsOut);
        this.geqLevel.connect(this.tsActive);
        this.tsActive.connect(this.tsDry).connect(tsOut);
        this.tsActive
            .connect(this.tsClipPre)
            .connect(this.tsDrive)
            .connect(this.tsShaper)
            .connect(this.tsTone)
            .connect(this.tsLevel)
            .connect(tsOut);

        // amp: a gentle gain stage, then the tone stack (Fender: scooped mids)
        this.ampPre = c.createGain();
        this.ampShaper = c.createWaveShaper();
        this.ampShaper.oversample = '4x';
        this.ampShaper.curve = softClipCurve(0.1);
        this.ampDrive = c.createGain();
        this.ampCompensation = c.createGain();
        this.bass = c.createBiquadFilter();
        this.bass.type = 'lowshelf';
        this.bass.frequency.value = 120;
        this.mid = c.createBiquadFilter();
        this.mid.type = 'peaking';
        this.mid.frequency.value = 500;
        this.mid.Q.value = 0.7;
        this.treble = c.createBiquadFilter();
        this.treble.type = 'highshelf';
        this.treble.frequency.value = 2500;
        this.ampMaster = c.createGain();
        tsOut
            .connect(this.ampPre)
            .connect(this.ampDrive)
            .connect(this.ampShaper)
            .connect(this.ampCompensation)
            .connect(this.bass).connect(this.mid).connect(this.treble);
        // a Fender combo: spring reverb (a synthetic decaying, bright noise tail), then the tremolo
        this.reverb = c.createConvolver();
        this.reverb.buffer = springLikeImpulse(c);
        this.reverbMix = c.createGain();
        this.tremolo = c.createGain();
        this.treble.connect(this.tremolo);
        this.treble.connect(this.reverb).connect(this.reverbMix).connect(this.tremolo);
        this.tremoloLfo = c.createOscillator();
        this.tremoloDepth = c.createGain();
        this.tremoloDepth.gain.value = 0;
        this.tremoloLfo.connect(this.tremoloDepth).connect(this.tremolo.gain);
        this.tremoloLfo.start();
        this.tremolo.connect(this.ampMaster);

        this.compressor = c.createDynamicsCompressor();
        this.ampMaster.connect(this.compressor);

        // cab: an impulse response when one is loaded, otherwise a filter approximation of a 1x12/2x12 speaker
        this.cabSim = c.createGain();
        this.cabHighPass = c.createBiquadFilter();
        this.cabHighPass.type = 'highpass';
        this.cabHighPass.frequency.value = 90;
        this.cabPresence = c.createBiquadFilter();
        this.cabPresence.type = 'peaking';
        this.cabPresence.frequency.value = 2500;
        this.cabPresence.Q.value = 1;
        this.cabPresence.gain.value = 3;
        this.cabLowPass1 = c.createBiquadFilter();
        this.cabLowPass1.type = 'lowpass';
        this.cabLowPass2 = c.createBiquadFilter();
        this.cabLowPass2.type = 'lowpass';
        this.cabSimGain = c.createGain();
        this.compressor
            .connect(this.cabHighPass)
            .connect(this.cabPresence)
            .connect(this.cabLowPass1)
            .connect(this.cabLowPass2)
            .connect(this.cabSimGain);
        this.cabIr = c.createConvolver();
        this.cabIr.normalize = true;
        this.cabIrGain = c.createGain();
        this.cabIrGain.gain.value = 0;
        this.makeUp = c.createGain();
        // digital delay after the cab, off unless the file uses it
        const cabOut = c.createGain();
        this.cabSimGain.connect(cabOut);
        this.cabIrGain.connect(cabOut);
        this.delay = c.createDelay(2);
        this.delayFeedback = c.createGain();
        this.delayMix = c.createGain();
        this.delayMix.gain.value = 0;
        cabOut.connect(this.makeUp);
        cabOut.connect(this.delay).connect(this.delayMix).connect(this.makeUp);
        this.delay.connect(this.delayFeedback).connect(this.delay);
        this.makeUp.connect(this.wet).connect(this.output);
    }

    setEnabled(enabled: boolean): void {
        this.dry.gain.value = enabled ? 0 : 1;
        this.wet.gain.value = enabled ? 1 : 0;
    }

    setLevelerEnabled(enabled: boolean): void {
        this.levelerBypass.gain.value = enabled ? 0 : 1;
        this.levelerActive.gain.value = enabled ? 1 : 0;
    }

    private delayOn = false;
    private delayWet = 0;

    setDelayEnabled(enabled: boolean): void {
        this.delayOn = enabled;
        this.delayMix.gain.value = enabled ? this.delayWet : 0;
    }

    setDelayMix(mix: number): void {
        this.delayWet = mix;
        this.setDelayEnabled(this.delayOn);
    }

    setOverdriveEnabled(enabled: boolean): void {
        this.tsBypass.gain.value = enabled ? 0 : 1;
        this.tsActive.gain.value = enabled ? 1 : 0;
    }

    setOverdriveDrive(amount: number): void {
        // a TS clips symmetrically; only the band above ~720 Hz goes through it
        if (!this.tsShaper.curve) {
            this.tsShaper.curve = softClipCurve(0);
        }
        this.tsDrive.gain.value = (1 + amount * 1.5) / ShaperHeadroom;
    }

    setAmpGain(amount: number): void {
        // 0 → unity (clean unless the input is hot), 20 → ×8 (+18 dB) into the clipper
        const drive = 1 + amount * 0.35;
        this.ampDrive.gain.value = drive / ShaperHeadroom;
        // louder when driven, but not by the whole drive
        this.ampCompensation.gain.value = 1 / Math.sqrt(drive);
    }

    setImpulseResponse(buffer: AudioBuffer | null): void {
        // the convolver is in the graph only while it has a buffer
        if (this.irConnected) {
            this.compressor.disconnect(this.cabIr);
            this.cabIr.disconnect();
            this.irConnected = false;
        }
        if (buffer) {
            this.irConnected = true;
            this.cabIr.buffer = buffer;
            this.compressor.connect(this.cabIr);
            this.cabIr.connect(this.cabIrGain);
        }
        this.cabIrGain.gain.value = buffer ? 1 : 0;
        this.cabSimGain.gain.value = buffer ? 0 : 1;
    }
}

function knob(
    id: string,
    label: string,
    range: [number, number, number],
    value: number,
    apply: (chain: ToneChain, value: number) => void,
    unit?: string
): Knob {
    return { id, label, min: range[0], max: range[1], step: range[2], value, unit, apply };
}

const Db: [number, number, number] = [-15, 15, 0.5];

const Knobs: { section: string; knobs: Knob[] }[] = [
    {
        section: 'Input leveler',
        knobs: [
            knob('leveler.threshold', 'Threshold', [-60, 0, 1], -30, (c, v) => {
                c.leveler.threshold.value = v;
            }, 'dB'),
            knob('leveler.ratio', 'Ratio', [1, 20, 0.5], 12, (c, v) => {
                c.leveler.ratio.value = v;
            }),
            knob('leveler.makeUp', 'Make-up', [0, 8, 0.1], 3, (c, v) => {
                c.levelerMakeUp.gain.value = v;
            })
        ]
    },
    {
        section: 'Graphic EQ (E30 G-EQ)',
        knobs: [
            ...GeqBands.map((f, i) =>
                knob(`geq.${i}`, f < 1000 ? `${f} Hz` : `${f / 1000} kHz`, Db, 0, (c, v) => {
                    c.geq[i].gain.value = v;
                }, 'dB')
            ),
            knob('geq.level', 'Level', Db, 0, (c, v) => {
                c.geqLevel.gain.value = 10 ** (v / 20);
            }, 'dB')
        ]
    },
    {
        section: 'Overdrive (E03 Screamer)',
        knobs: [
            knob('ts.drive', 'Drive', [0, 20, 0.5], 4, (c, v) => c.setOverdriveDrive(v)),
            knob('ts.tone', 'Tone', [1000, 8000, 100], 3500, (c, v) => {
                c.tsTone.frequency.value = v;
            }, 'Hz'),
            knob('ts.level', 'Level', [0, 2, 0.05], 0.5, (c, v) => {
                c.tsLevel.gain.value = v;
            })
        ]
    },
    {
        section: 'Amp (A02 American Clean)',
        knobs: [
            knob('amp.input', 'Input', [0, 4, 0.05], 1, (c, v) => {
                c.ampPre.gain.value = v;
            }),
            knob('amp.gain', 'Gain', [0, 20, 0.5], 2, (c, v) => c.setAmpGain(v)),
            knob('amp.bass', 'Bass', Db, 2, (c, v) => {
                c.bass.gain.value = v;
            }, 'dB'),
            knob('amp.mid', 'Mid', Db, -6, (c, v) => {
                c.mid.gain.value = v;
            }, 'dB'),
            knob('amp.midFreq', 'Mid freq', [200, 1500, 10], 500, (c, v) => {
                c.mid.frequency.value = v;
            }, 'Hz'),
            knob('amp.treble', 'Treble', Db, 3, (c, v) => {
                c.treble.gain.value = v;
            }, 'dB'),
            knob('amp.reverb', 'Reverb', [0, 1, 0.01], 0, (c, v) => {
                c.reverbMix.gain.value = v;
            }),
            knob('amp.tremoloSpeed', 'Trem. speed', [0.5, 10, 0.1], 4, (c, v) => {
                c.tremoloLfo.frequency.value = v;
            }, 'Hz'),
            knob('amp.tremoloDepth', 'Trem. depth', [0, 0.5, 0.01], 0, (c, v) => {
                c.tremoloDepth.gain.value = v;
            }),
            knob('amp.master', 'Master', [0, 2, 0.05], 0.8, (c, v) => {
                c.ampMaster.gain.value = v;
            })
        ]
    },
    {
        section: 'Compressor (M07 Classic Dynamic)',
        knobs: [
            knob('comp.threshold', 'Threshold', [-60, 0, 1], -18, (c, v) => {
                c.compressor.threshold.value = v;
            }, 'dB'),
            knob('comp.ratio', 'Ratio', [1, 20, 0.5], 3, (c, v) => {
                c.compressor.ratio.value = v;
            })
        ]
    },
    {
        section: 'Cab (filters, unless an IR is loaded)',
        knobs: [
            knob('cab.lowCut', 'Low cut', [20, 300, 5], 90, (c, v) => {
                c.cabHighPass.frequency.value = v;
            }, 'Hz'),
            knob('cab.highCut', 'High cut', [2000, 12000, 100], 5500, (c, v) => {
                c.cabLowPass1.frequency.value = v;
                c.cabLowPass2.frequency.value = v;
            }, 'Hz'),
            knob('cab.presence', 'Presence', [-12, 12, 0.5], 3, (c, v) => {
                c.cabPresence.gain.value = v;
            }, 'dB')
        ]
    },
    {
        section: 'Delay (M12 Digital Delay)',
        knobs: [
            knob('delay.time', 'Time', [0.02, 1.5, 0.01], 0.5, (c, v) => {
                c.delay.delayTime.value = v;
            }, 's'),
            knob('delay.regen', 'Regen', [0, 0.9, 0.01], 0.4, (c, v) => {
                c.delayFeedback.gain.value = v;
            }),
            knob('delay.mix', 'Mix', [0, 1, 0.01], 0.24, (c, v) => c.setDelayMix(v))
        ]
    },
    {
        section: 'Output',
        knobs: [
            knob('out.makeUp', 'Make-up', [0, 4, 0.05], 1, (c, v) => {
                c.makeUp.gain.value = v;
            })
        ]
    }
];

/**
 * Changes how the electric guitar tracks play (and back):
 * - another preset: the GM clean guitar, so the chain gets a DI-like source, or a preset of an extra SoundFont. Other
 *   tracks keep theirs, unless the preset shares their bank/program.
 * - flat dynamics: every note at one dynamic, so a SoundFont with velocity layers always plays the same layer.
 */
class GuitarTrackOverride {
    private restores: (() => void)[] = [];

    apply(
        score: alphaTab.model.Score,
        target: SoundFontPreset | null,
        flatDynamics: alphaTab.model.DynamicValue | null
    ): void {
        for (const restore of this.restores.reverse()) {
            restore();
        }
        this.restores = [];
        const set = <T extends object, K extends keyof T>(owner: T, key: K, value: T[K]) => {
            const original = owner[key];
            owner[key] = value;
            this.restores.push(() => {
                owner[key] = original;
            });
        };
        for (const track of score.tracks) {
            const info = track.playbackInfo;
            if (!ElectricGuitarPrograms.has(info.program)) {
                continue;
            }
            if (target) {
                set(info, 'program', target.program);
                set(info, 'bank', target.bank);
            }
            for (const staff of track.staves) {
                for (const bar of staff.bars) {
                    for (const voice of bar.voices) {
                        for (const beat of voice.beats) {
                            if (flatDynamics !== null) {
                                set(beat, 'dynamics', flatDynamics);
                                // the velocity comes from the note's dynamics
                                for (const note of beat.notes) {
                                    set(note, 'dynamics', flatDynamics);
                                }
                            }
                            if (!target) {
                                continue;
                            }
                            for (const automation of beat.automations) {
                                if (automation.type === alphaTab.model.AutomationType.Instrument) {
                                    set(automation, 'value', target.program);
                                } else if (automation.type === alphaTab.model.AutomationType.Bank) {
                                    set(automation, 'value', target.bank);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

export class ToneLab implements Mountable {
    private static instance: ToneLab | null = null;

    /**
     * Wraps the global AudioWorkletNode so the synthesizer's worklet ('alphatab') connects into the chain instead of
     * its destination. Must run before the player starts.
     */
    static install(): void {
        const Native = window.AudioWorkletNode;
        if ((Native as unknown as { toneLab?: boolean }).toneLab) {
            return;
        }
        class Tapped extends Native {
            static toneLab = true;
            constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
                super(context, name, options);
                if (name === 'alphatab') {
                    ToneLab.instance?.tap(this);
                }
            }
        }
        Object.defineProperty(window, 'AudioWorkletNode', { value: Tapped, configurable: true, writable: true });
    }

    readonly root: HTMLElement;
    private chain: ToneChain | null = null;
    private enabled = true;
    private overdrive = true;
    private source: SoundFontPreset | null = CleanGuitar;
    private sourceSelect: HTMLSelectElement;
    private impulse: ArrayBuffer | null = null;
    private values = new Map<Knob, number>();
    private status: HTMLElement;
    private trackOverride = new GuitarTrackOverride();
    private flatDynamics: alphaTab.model.DynamicValue | null = null;
    private delayOn = false;
    private rseTracks: RseTrack[] = [];
    private knobInputs = new Map<string, { knob: Knob; set(value: number): void }>();
    private leveler = false;
    private subscriptions: (() => void)[] = [];

    constructor(private api: alphaTab.AlphaTabApi) {
        ToneLab.instance = this;
        this.root = parseHtml(html`
            <div class="at-tone-lab">
                <h3>Tone lab (spike)</h3>
                <div class="at-tone-status">Press play to hook the synthesizer.</div>
                <label><span>Chain on (off = A/B)</span><input type="checkbox" class="at-tone-enabled" checked /></label>
                <h4>Guitar source (electric guitar tracks)</h4>
                <select class="at-tone-source"></select>
                <h4>Extra SoundFont (.sf2/.sf3, added on top)</h4>
                <input type="file" accept=".sf2,.sf3" class="at-tone-sf" />
                <h4>Settings from the file's RSE (drop a .gp)</h4>
                <select class="at-tone-rse"><option value="">Drop a GP7/GP8 file</option></select>
                <div class="at-tone-rse-chain"></div>
                <h4>Dynamics of the guitar tracks</h4>
                <select class="at-tone-dynamics">
                    <option value="">As in the file</option>
                    <option value="MP">All mp</option>
                    <option value="MF">All mf</option>
                    <option value="F">All f</option>
                </select>
                <label><span>Input leveler (before drive)</span><input type="checkbox" class="at-tone-leveler" /></label>
                <label><span>Overdrive on</span><input type="checkbox" class="at-tone-od" checked /></label>
                <label><span>Delay on</span><input type="checkbox" class="at-tone-delay" /></label>
                <div class="at-tone-knobs"></div>
                <h4>Cab impulse response (.wav)</h4>
                <input type="file" accept="audio/*" class="at-tone-ir" />
                <label><span>Use IR</span><input type="checkbox" class="at-tone-use-ir" /></label>
            </div>
        `);
        this.status = this.root.querySelector<HTMLElement>('.at-tone-status')!;

        const knobs = this.root.querySelector<HTMLElement>('.at-tone-knobs')!;
        for (const group of Knobs) {
            const h = document.createElement('h4');
            h.textContent = group.section;
            knobs.appendChild(h);
            for (const knob of group.knobs) {
                this.values.set(knob, knob.value);
                const row = parseHtml(html`
                    <label
                        ><span>${knob.label}</span
                        ><input type="range" min="${knob.min}" max="${knob.max}" step="${knob.step}" value="${knob.value}" /><span
                            class="at-tone-value"
                        ></span
                    ></label>
                `);
                const input = row.querySelector<HTMLInputElement>('input')!;
                const out = row.querySelector<HTMLElement>('.at-tone-value')!;
                const show = () => {
                    out.textContent = `${input.valueAsNumber}${knob.unit ? ` ${knob.unit}` : ''}`;
                };
                show();
                if (knob.id) {
                    this.knobInputs.set(knob.id, {
                        knob,
                        set: value => {
                            input.valueAsNumber = value;
                            this.values.set(knob, input.valueAsNumber);
                            show();
                            if (this.chain) {
                                knob.apply(this.chain, input.valueAsNumber);
                            }
                        }
                    });
                }
                input.addEventListener('input', () => {
                    this.values.set(knob, input.valueAsNumber);
                    show();
                    if (this.chain) {
                        knob.apply(this.chain, input.valueAsNumber);
                    }
                });
                knobs.appendChild(row);
            }
        }

        this.checkbox('.at-tone-enabled', v => {
            this.enabled = v;
            this.chain?.setEnabled(v);
        });
        const dynamics = this.root.querySelector<HTMLSelectElement>('.at-tone-dynamics')!;
        dynamics.addEventListener('change', () => {
            this.flatDynamics = dynamics.value
                ? alphaTab.model.DynamicValue[dynamics.value as keyof typeof alphaTab.model.DynamicValue]
                : null;
            this.applySource(true);
        });
        this.checkbox('.at-tone-delay', v => {
            this.delayOn = v;
            this.chain?.setDelayEnabled(v);
        });
        const rse = this.root.querySelector<HTMLSelectElement>('.at-tone-rse')!;
        rse.addEventListener('change', () => this.applyRse(Number.parseInt(rse.value, 10)));
        document.addEventListener('drop', this.onDrop);
        this.checkbox('.at-tone-leveler', v => {
            this.leveler = v;
            this.chain?.setLevelerEnabled(v);
        });
        this.checkbox('.at-tone-od', v => {
            this.overdrive = v;
            this.chain?.setOverdriveEnabled(v);
        });
        this.sourceSelect = this.root.querySelector<HTMLSelectElement>('.at-tone-source')!;
        this.fillSources([]);
        this.sourceSelect.addEventListener('change', () => {
            const value = this.sourceSelect.value;
            this.source = value ? (JSON.parse(value) as SoundFontPreset) : null;
            this.applySource(true);
        });
        this.root.querySelector<HTMLInputElement>('.at-tone-sf')!.addEventListener('change', async e => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) {
                return;
            }
            const data = new Uint8Array(await file.arrayBuffer());
            const presets = readPresets(data);
            this.fillSources(presets);
            this.status.textContent = `${file.name}: ${presets.length} presets, ${(data.length / 1e6).toFixed(1)} MB`;
            // the last loaded SoundFont wins for a bank/program both have
            this.api.loadSoundFont(data, true);
        });
        const useIr = this.root.querySelector<HTMLInputElement>('.at-tone-use-ir')!;
        useIr.addEventListener('change', () => this.applyImpulse(useIr.checked));
        this.root.querySelector<HTMLInputElement>('.at-tone-ir')!.addEventListener('change', async e => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) {
                return;
            }
            this.impulse = await file.arrayBuffer();
            useIr.checked = true;
            await this.applyImpulse(true);
        });

        // before the MIDI of a new score is generated (scoreLoaded fires first)
        this.subscriptions.push(api.scoreLoaded.on(() => this.applySource(false)));
    }

    /** the playground loads a dropped file itself: read the same file for its RSE settings */
    private onDrop = async (e: DragEvent) => {
        const files = e.dataTransfer?.files;
        if (!files || files.length !== 1) {
            return;
        }
        this.rseTracks = readRseTracks(new Uint8Array(await files[0].arrayBuffer()));
        const select = this.root.querySelector<HTMLSelectElement>('.at-tone-rse')!;
        const withChain = this.rseTracks.map((t, i) => ({ t, i })).filter(({ t }) => t.effects.length > 0);
        select.replaceChildren(
            ...[{ value: '', label: withChain.length ? 'Keep the current settings' : 'No RSE settings in this file' }]
                .concat(withChain.map(({ t, i }) => ({ value: String(i), label: `${t.name} — ${t.sound}` })))
                .map(({ value, label }) => {
                    const option = document.createElement('option');
                    option.value = value;
                    option.textContent = label;
                    return option;
                })
        );
        // the first track with an amp: the chain is on the master, it can follow one track only
        const first = withChain.find(({ t }) => t.effects.some(fx => fx.id.startsWith('A'))) ?? withChain[0];
        if (first) {
            select.value = String(first.i);
            this.applyRse(first.i);
        }
    };

    private setSwitch(selector: string, value: boolean): void {
        const box = this.root.querySelector<HTMLInputElement>(selector)!;
        box.checked = value;
        box.dispatchEvent(new Event('change'));
    }

    private applyRse(index: number): void {
        const track = this.rseTracks[index];
        const out = this.root.querySelector<HTMLElement>('.at-tone-rse-chain')!;
        if (!track) {
            out.textContent = '';
            return;
        }
        const settings = rseToChain(track);
        // effects missing from the file are neutral: back to the defaults first
        for (const { knob, set } of this.knobInputs.values()) {
            if (!knob.id?.startsWith('leveler.') && !knob.id?.startsWith('cab.')) {
                set(knob.value);
            }
        }
        this.knobInputs.get('geq.level')?.set(0);
        if (!track.effects.some(fx => fx.id.startsWith('A'))) {
            this.knobInputs.get('amp.gain')?.set(0);
        }
        for (const [id, value] of Object.entries(settings.knobs)) {
            this.knobInputs.get(id)?.set(value);
        }
        this.setSwitch('.at-tone-od', settings.overdrive);
        this.setSwitch('.at-tone-delay', settings.delay);
        out.textContent = track.effects
            .map(fx => `${fx.bypass ? '(off) ' : ''}${fx.id}: ${fx.params.map(p => (p * 10).toFixed(1)).join(' ')}`)
            .concat(settings.unsupported.length ? [`not played: ${settings.unsupported.join(', ')}`] : [])
            .join('\n');
    }

    private checkbox(selector: string, onChange: (value: boolean) => void): void {
        const box = this.root.querySelector<HTMLInputElement>(selector)!;
        box.addEventListener('change', () => onChange(box.checked));
    }

    private fillSources(extra: SoundFontPreset[]): void {
        const options: [string, string][] = [
            ['', 'As in the file'],
            [JSON.stringify(CleanGuitar), CleanGuitar.name]
        ];
        for (const p of extra) {
            options.push([JSON.stringify(p), `${p.name} (bank ${p.bank}, program ${p.program})`]);
        }
        const current = this.source ? JSON.stringify(this.source) : '';
        this.sourceSelect.replaceChildren(
            ...options.map(([value, label]) => {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = label;
                option.selected = value === current;
                return option;
            })
        );
    }

    private applySource(reloadMidi: boolean): void {
        const score = this.api.score;
        if (!score) {
            return;
        }
        this.trackOverride.apply(score, this.source, this.flatDynamics);
        if (reloadMidi) {
            this.api.loadMidiForScore();
        }
    }

    private async applyImpulse(use: boolean): Promise<void> {
        if (!this.chain) {
            return;
        }
        if (!use || !this.impulse) {
            this.chain.setImpulseResponse(null);
            return;
        }
        // decodeAudioData detaches the buffer it gets
        const buffer = await this.chain.context.decodeAudioData(this.impulse.slice(0));
        this.chain.setImpulseResponse(buffer);
        this.status.textContent = `IR: ${buffer.duration.toFixed(3)} s, ${buffer.numberOfChannels} ch`;
    }

    private tap(node: AudioWorkletNode): void {
        if (!this.chain || this.chain.context !== node.context) {
            this.chain = new ToneChain(node.context);
            for (const [knob, value] of this.values) {
                knob.apply(this.chain, value);
            }
            this.chain.setEnabled(this.enabled);
            this.chain.setOverdriveEnabled(this.overdrive);
            this.chain.setLevelerEnabled(this.leveler);
            this.chain.setDelayEnabled(this.delayOn);
            const useIr = this.root.querySelector<HTMLInputElement>('.at-tone-use-ir')!;
            void this.applyImpulse(useIr.checked);
        }
        const chain = this.chain;
        const nativeConnect = node.connect.bind(node) as (destination: AudioNode) => AudioNode;
        node.connect = ((destination: AudioNode | AudioParam, ...rest: number[]) => {
            if (destination instanceof AudioNode) {
                nativeConnect(chain.input);
                chain.output.disconnect();
                chain.output.connect(destination);
                this.status.textContent = 'Synthesizer hooked into the chain.';
                return destination;
            }
            return (AudioNode.prototype.connect as (d: AudioParam, ...r: number[]) => void).call(
                node,
                destination,
                ...rest
            );
        }) as typeof node.connect;
    }

    dispose(): void {
        document.removeEventListener('drop', this.onDrop);
        for (const u of this.subscriptions) {
            u();
        }
        this.subscriptions = [];
        ToneLab.instance = null;
        this.root.remove();
    }
}
