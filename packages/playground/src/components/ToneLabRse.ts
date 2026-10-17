import { ByteBuffer } from '@coderline/alphatab/io/ByteBuffer';
import { ZipReader } from '@coderline/alphatab/zip/ZipReader';

/*
 * Spike (?tone=1): the Guitar Pro RSE sound of each track, and how the tone lab plays its effects.
 * See docs/research/rse-tone-in-the-browser.md.
 */

export interface RseEffect {
    id: string;
    bypass: boolean;
    params: number[];
}

export interface RseTrack {
    name: string;
    sound: string;
    effects: RseEffect[];
}

/** The RSE sound of each track of a GP7/GP8 file (Content/score.gpif): alphaTab's importer drops it. */
export function readRseTracks(file: Uint8Array): RseTrack[] {
    let entries: ReturnType<ZipReader['read']>;
    try {
        entries = new ZipReader(ByteBuffer.fromBuffer(file), 50 * 1024 * 1024).read();
    } catch {
        // not a zip: GP3-5, alphaTex, MusicXML…
        return [];
    }
    const gpif = entries.find(e => e.fullName === 'Content/score.gpif');
    if (!gpif) {
        return [];
    }
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(gpif.data), 'application/xml');
    const tracks: RseTrack[] = [];
    for (const track of doc.querySelectorAll('GPIF > Tracks > Track')) {
        // the sound the track starts with: the one of its first Sound automation, else its first sound
        const sounds = [...track.querySelectorAll(':scope > Sounds > Sound')];
        const firstSound = track.querySelector(':scope > Automations > Automation > Value')?.textContent ?? '';
        const sound =
            sounds.find(s => firstSound.includes(`;${s.querySelector(':scope > Name')?.textContent};`)) ?? sounds[0];
        tracks.push({
            name: track.querySelector(':scope > Name')?.textContent ?? '',
            sound: sound?.querySelector(':scope > Name')?.textContent ?? '',
            effects: [...(sound?.querySelectorAll('RSE > EffectChain > Effect') ?? [])].map(e => ({
                id: e.getAttribute('id') ?? '',
                bypass: e.querySelector(':scope > Bypass') !== null,
                params: (e.querySelector(':scope > Parameters')?.textContent ?? '').trim().split(/\s+/).map(Number)
            }))
        });
    }
    return tracks;
}

export const GeqBands = [100, 200, 400, 800, 1600, 3200, 6400];

/** A 0..1 RSE knob (0 → 0, 1 → 10 on the pedal) as ±range dB, 5 being flat. */
const knobDb = (v: number, range: number) => (v - 0.5) * 2 * range;

export interface RseEffectMapping {
    /** the knobs in Guitar Pro, left to right: the order of the parameters in the file */
    knobs: string[];
    /** the tone lab's knob values (by knob id) */
    toChain(p: number[]): Record<string, number>;
    /** the lab's switch for the effect being on */
    switch?: 'overdrive' | 'delay';
}

/**
 * The RSE effects the tone lab can play. The knob names come from Guitar Pro; the curves are by-ear guesses, to
 * calibrate once per effect model (not per song).
 */
export const RseMapping: Record<string, RseEffectMapping> = {
    E30_EqGEq: {
        knobs: ['100', '200', '400', '800', '1.6k', '3.2k', '6.4k', 'Level'],
        toChain: p => ({
            ...Object.fromEntries(GeqBands.map((_, i) => [`geq.${i}`, knobDb(p[i], 15)])),
            // the level fader at the top reads as unity [guess]
            'geq.level': knobDb(p[7], 15) - 15
        })
    },
    E03_OverdriveScreamer: {
        knobs: ['Drive', 'Tone', 'Level'],
        switch: 'overdrive',
        toChain: p => ({
            'ts.drive': p[0] * 20,
            'ts.tone': 1000 * 8 ** p[1],
            'ts.level': p[2] * 1.25
        })
    },
    A02_ComboAmericanClean: {
        knobs: ['Volume', 'Bass', 'Middle', 'Treble', 'Reverb', 'Speed', 'Intensity'],
        toChain: p => ({
            // a Fender without master volume: Volume is the preamp drive
            'amp.input': 0.5 + p[0] * 1.5,
            'amp.gain': p[0] * 8,
            'amp.bass': knobDb(p[1], 10),
            // a Fender tone stack scoops the mids even with Middle at 5
            'amp.mid': knobDb(p[2], 10) - 4,
            'amp.midFreq': 500,
            'amp.treble': knobDb(p[3], 10),
            'amp.reverb': p[4] * 0.8,
            'amp.tremoloSpeed': 0.5 + p[5] * 9.5,
            'amp.tremoloDepth': p[6] * 0.5,
            'amp.master': 0.8
        })
    },
    M07_DynamicClassicDynamic: {
        knobs: ['Gain', 'Ratio', 'Level'],
        toChain: p => ({
            // Gain pushes the signal into the compressor: the more, the lower the threshold
            'comp.threshold': -p[0] * 60,
            'comp.ratio': 1 + p[1] * 19,
            'out.makeUp': 0.4 + p[2] * 1.2
        })
    },
    M12_DelayDigitalDelay: {
        knobs: ['D-Time', 'Regen', 'Mix'],
        switch: 'delay',
        toChain: p => ({
            'delay.time': 0.02 + p[0] * 1.48,
            'delay.regen': p[1] * 0.9,
            'delay.mix': p[2]
        })
    }
};

export interface ChainSettings {
    knobs: Record<string, number>;
    overdrive: boolean;
    delay: boolean;
    /** effects of the file this lab does not play */
    unsupported: string[];
}

export function rseToChain(track: RseTrack): ChainSettings {
    const settings: ChainSettings = { knobs: {}, overdrive: false, delay: false, unsupported: [] };
    for (const effect of track.effects) {
        const mapping = RseMapping[effect.id];
        if (!mapping) {
            settings.unsupported.push(effect.id);
            continue;
        }
        if (mapping.switch) {
            settings[mapping.switch] = !effect.bypass;
        }
        if (!effect.bypass || mapping.switch) {
            Object.assign(settings.knobs, mapping.toChain(effect.params));
        }
    }
    return settings;
}
