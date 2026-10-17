// Sync lab (CoderLine/alphaTab#2397): measures the synthesizer against a backing track (spec §9).
//
// URL params: ?src=beeps|mp3 &listen=0|1 &mixing=0|1 &rate=48000|44100 &file=/test-data/audio/syncpoints-testfile.gp
//   src=beeps  the file's backing track is replaced by a 2 kHz beep on every beat (from the file's own sync points);
//              the synth plays the metronome. Two taps record every beep (media) and every click (synth) on the
//              AudioContext's clock, so click - beep is the audible offset.
//   mixing=0   the S7 check: the same page with enableSynthesizerWithMedia off.
//   rate=44100 the beep track at 44.1 kHz, the rate of most recordings (Guitar Pro audio tracks, MP3s): a 48 kHz
//              context resamples it, as it does a real song (Task 22 Step 1).
// Every test logs its result and keeps it in window.syncLab.results.
import * as alphaTab from '@coderline/alphatab';
import { AlphaSynthMidiFileHandler } from '@coderline/alphatab/midi/AlphaSynthMidiFileHandler';
import { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { MidiFileGenerator } from '@coderline/alphatab/midi/MidiFileGenerator';
import { BrowserUiFacade } from '@coderline/alphatab/platform/javascript/BrowserUiFacade';
import { MediaLatencyProbe } from '@coderline/alphatab/platform/javascript/MediaLatencyProbe';
import {
    MediaSyncConstants,
    MediaSyncLearnedValues
} from '@coderline/alphatab/platform/javascript/MediaSyncController';
import type { MediaSynthPlayer } from '@coderline/alphatab/platform/javascript/MediaSynthPlayer';
import type { IAudioSampleSynthesizer } from '@coderline/alphatab/synth/IAudioSampleSynthesizer';
import { MidiFileSequencer } from '@coderline/alphatab/synth/MidiFileSequencer';
import type { SynthEvent } from '@coderline/alphatab/synth/synthesis/SynthEvent';
import { Paths } from '../../src/util/Paths';

const params = new URL(window.location.href).searchParams;
const src = params.get('src') ?? 'beeps';
const mixing = params.get('mixing') !== '0';
const beepRate = Number(params.get('rate') ?? 48000);
const file = params.get('file') ?? '/test-data/audio/syncpoints-testfile.gp';
// D-8 (R-1): ?audioSession=playback sets iOS's audio session before any Play (Safari 16.4+), no console needed
if (params.get('audioSession') === 'playback' && 'audioSession' in navigator) {
    (navigator as unknown as { audioSession: { type: string } }).audioSession.type = 'playback';
}
const results: { name: string; value: unknown; at: string }[] = [];

const logEl = document.getElementById('log')!;
function log(...args: unknown[]) {
    const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    logEl.textContent = `${logEl.textContent === 'loading…' ? '' : `${logEl.textContent}\n`}${line}`;
    logEl.scrollTop = logEl.scrollHeight;
    console.log('[sync-lab]', line);
}
function record(name: string, value: unknown) {
    // a copy (as the log prints it): a test returns its rows to the caller, who may change them
    results.push({ name, value: JSON.parse(JSON.stringify(value)), at: new Date().toISOString() });
    log({ [name]: value });
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// a run on a device without a console (the iPad) shows its failures on the page too
window.addEventListener('unhandledrejection', e => log(`error [sync-lab] unhandled rejection: ${errorText(e.reason)}`));
window.addEventListener('error', e => log(`error [sync-lab] ${e.message} (${e.filename}:${e.lineno})`));

// D-7, D-8: the player's warnings on the page too ("The media did not start", "playing the media
// only"): on the iPad the lab runs inside the Web MIDI Browser app, which may have no console
const consoleLogger = alphaTab.Logger.log;
alphaTab.Logger.log = {
    debug: (category, msg, ...details) => consoleLogger.debug(category, msg, ...details),
    info: (category, msg, ...details) => consoleLogger.info(category, msg, ...details),
    warning: (category, msg, ...details) => {
        log(`warning [${category}] ${msg}`);
        consoleLogger.warning(category, msg, ...details);
    },
    error: (category, msg, ...details) => {
        log(`error [${category}] ${msg}`);
        consoleLogger.error(category, msg, ...details);
    }
};

const input = (id: string) => document.getElementById(id) as HTMLInputElement;
(document.getElementById('src') as HTMLSelectElement).value = src;
input('listen').checked = params.get('listen') !== '0';
input('drums').checked = params.has('drums') ? params.get('drums') === '1' : src === 'mp3';
input('metronome').checked = params.get('metronome') !== '0';
input('countIn').checked = params.get('countIn') === '1';
document.getElementById('src')!.addEventListener('change', () => {
    const url = new URL(window.location.href);
    url.searchParams.set('src', (document.getElementById('src') as HTMLSelectElement).value);
    window.location.href = url.toString();
});

// ---- S7: count what the player creates (before the API exists) ----
const created = { synthWorkers: 0, synthWorklets: 0 };
const createSynthWorker = BrowserUiFacade.createAlphaSynthWebWorker;
BrowserUiFacade.createAlphaSynthWebWorker = s => {
    created.synthWorkers++;
    return createSynthWorker(s);
};
const NativeWorkletNode = window.AudioWorkletNode;
// outside a secure context (plain http on a LAN address) there is no AudioWorkletNode: the page still loads, and the
// player says it plays the media only
if (NativeWorkletNode) {
    (window as unknown as { AudioWorkletNode: typeof AudioWorkletNode }).AudioWorkletNode = class extends (
        NativeWorkletNode
    ) {
        public constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
            super(context, name, options);
            if (name === 'alphatab') {
                created.synthWorklets++;
            }
        }
    };
}

class SilentSynth implements IAudioSampleSynthesizer {
    public masterVolume = 0;
    public metronomeVolume = 0;
    public outSampleRate = 44100;
    public currentTempo = 120;
    public timeSignatureNumerator = 4;
    public timeSignatureDenominator = 4;
    public activeVoiceCount = 0;
    public noteOffAll(): void {}
    public resetSoft(): void {}
    public resetPresets(): void {}
    public loadPresets(): void {}
    public setupMetronomeChannel(): void {}
    public synthesizeSilent(): void {}
    public dispatchEvent(_e: SynthEvent): void {}
    public synthesize(): SynthEvent[] {
        return [];
    }
    public applyTranspositionPitches(): void {}
    public setChannelTranspositionPitch(): void {}
    public channelSetMute(): void {}
    public channelSetSolo(): void {}
    public resetChannelStates(): void {}
    public channelSetMixVolume(): void {}
    public hasSamplesForProgram(): boolean {
        return true;
    }
    public hasSamplesForPercussion(): boolean {
        return true;
    }
    public readonly outputBusCount = 1;
    public channelSetOutputBus(): void {}
    public resetChannelOutputBuses(): void {}
}

function encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array {
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const v = new DataView(buf);
    const w = (o: number, s: string) => {
        for (let i = 0; i < s.length; i++) {
            v.setUint8(o + i, s.charCodeAt(i));
        }
    };
    w(0, 'RIFF');
    v.setUint32(4, 36 + pcm.length * 2, true);
    w(8, 'WAVE');
    w(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    w(36, 'data');
    v.setUint32(40, pcm.length * 2, true);
    new Int16Array(buf, 44).set(pcm);
    return new Uint8Array(buf);
}

async function mediaDuration(bytes: Uint8Array): Promise<number> {
    const el = new Audio(URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>])));
    await new Promise<void>((resolve, reject) => {
        // WebKit may not load a hidden <audio> before a tap: without a limit the page would stay at "loading…"
        const timer = setTimeout(
            () => reject(new Error('the browser did not report the audio length within 15 s')),
            15000
        );
        el.addEventListener(
            'loadedmetadata',
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true }
        );
        el.addEventListener(
            'error',
            () => {
                clearTimeout(timer);
                reject(
                    new Error(
                        `the browser could not read the audio (${el.error?.message || `media error ${el.error?.code}`})`
                    )
                );
            },
            { once: true }
        );
    });
    return el.duration * 1000;
}

const settings = new alphaTab.Settings();
settings.fillFromJson({
    core: { fontDirectory: Paths.fontDirectory, logLevel: 'warning' },
    player: {
        playerMode: alphaTab.PlayerMode.EnabledBackingTrack,
        enableSynthesizerWithMedia: mixing,
        soundFont: Paths.soundFont,
        scrollMode: alphaTab.ScrollMode.Off
    }
} satisfies alphaTab.json.SettingsJson);

// conversions media time <-> alphaTab time (the same sync points as the player)
let sequencer!: MidiFileSequencer;
let durationMs = 0;
let beatMediaTimes: number[] = [];

async function prepareScore(bytes: Uint8Array, name: string): Promise<alphaTab.model.Score | null> {
    let score: alphaTab.model.Score;
    try {
        score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
    } catch (e) {
        log(`${name}: could not load (${(e as Error).message})`);
        return null;
    }
    const audio = score.backingTrack?.rawAudioFile;
    if (!audio) {
        log(`${name}: no embedded audio track. The lab needs a Guitar Pro file with an audio track and sync points.`);
        return null;
    }
    try {
        durationMs = await mediaDuration(audio);
    } catch (e) {
        log(`${name}: ${errorText(e)}`);
        return null;
    }
    const midi = new MidiFile();
    const generator = new MidiFileGenerator(score, settings, new AlphaSynthMidiFileHandler(midi));
    generator.generate();
    sequencer = new MidiFileSequencer(new SilentSynth());
    sequencer.loadMidi(midi);
    sequencer.mainUpdateSyncPoints(generator.syncPoints);
    const metronome = (sequencer as unknown as { _mainState: { synthData: SynthEvent[] } })._mainState.synthData.filter(
        e => e.isMetronome
    );
    beatMediaTimes = metronome.map(e => sequencer.mainTickToMediaTime(e.event.tick, durationMs));
    if (src === 'beeps') {
        const rate = beepRate;
        const pcm = new Int16Array(Math.ceil((durationMs / 1000) * rate));
        const beepFrames = Math.round(rate * 0.003);
        for (const t of beatMediaTimes) {
            const start = Math.round((t / 1000) * rate);
            for (let i = 0; i < beepFrames && start + i < pcm.length; i++) {
                pcm[start + i] = Math.round(Math.sin((2 * Math.PI * 2000 * i) / rate) * 0.6 * 32767);
            }
        }
        score.backingTrack!.rawAudioFile = encodeWav(pcm, rate);
    }
    log(
        `file=${name} src=${src} rate=${beepRate} mixing=${mixing} duration=${(durationMs / 1000).toFixed(2)}s beats=${beatMediaTimes.length} syncPoints=${generator.syncPoints.length}`
    );
    return score;
}

const fileNameEl = document.getElementById('fileName')!;
let pendingFileName = '';
async function loadBytes(bytes: Uint8Array, name: string) {
    const score = await prepareScore(bytes, name);
    if (!score) {
        return;
    }
    api.stop();
    tapOnsets.media.length = 0;
    tapOnsets.synth.length = 0;
    pendingFileName = name;
    fileNameEl.textContent = `${name} — loading, wait for "player ready"…`;
    api.renderScore(
        score,
        score.tracks.map(t => t.index)
    );
}

document.getElementById('fileInput')!.addEventListener('change', async e => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) {
        await loadBytes(new Uint8Array(await f.arrayBuffer()), f.name);
    }
});
window.addEventListener('dragover', e => {
    e.preventDefault();
    document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
window.addEventListener('drop', async e => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    const f = e.dataTransfer?.files?.[0];
    if (f) {
        await loadBytes(new Uint8Array(await f.arrayBuffer()), f.name);
    }
});

const api = new alphaTab.AlphaTabApi(document.querySelector('.at-canvas') as HTMLElement, settings);
(window as unknown as { api: unknown }).api = api;

function mediaSynth(): MediaSynthPlayer {
    const instance = (api.player as unknown as { instance?: unknown } | null)?.instance as MediaSynthPlayer | undefined;
    if (!instance?.diagnostics) {
        throw new Error('no MediaSynthPlayer: mixing is off or not supported in this browser');
    }
    return instance;
}
const lab = () => mediaSynth().diagnostics;
const ctx = () => lab().audioContext!;

// ---- taps ----
const tapOnsets = { media: [] as number[], synth: [] as number[] };
const tapPeaks = { media: 0, synth: 0 };
const tapCode = `
class LabTap extends AudioWorkletProcessor {
    constructor(o) {
        super();
        this.threshold = o.processorOptions.threshold;
        this.cool = 0;
        this.coolFrames = Math.round(sampleRate * 0.1);
        this.peak = 0;
        this.sincePeak = 0;
    }
    process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch) {
            for (let i = 0; i < ch.length; i++) {
                const v = Math.abs(ch[i]);
                if (v > this.peak) this.peak = v;
                if (this.cool > 0) { this.cool--; continue; }
                if (v > this.threshold) {
                    this.port.postMessage({ frame: currentFrame + i });
                    this.cool = this.coolFrames;
                }
            }
        }
        this.sincePeak += 128;
        if (this.sincePeak > sampleRate) { this.port.postMessage({ peak: this.peak }); this.sincePeak = 0; this.peak = 0; }
        return true;
    }
}
registerProcessor('lab-tap', LabTap);`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Polls `done` until it holds. Past `timeoutMs` it logs what it waited for and rejects, so a run on a device without a
 * console ends with a message instead of waiting for ever.
 */
async function waitUntil(what: string | (() => string), done: () => boolean, timeoutMs: number, pollMs = 100) {
    const until = performance.now() + timeoutMs;
    while (!done()) {
        if (performance.now() > until) {
            const message = `gave up waiting for ${typeof what === 'function' ? what() : what} after ${Math.round(timeoutMs / 1000)} s`;
            log(`error [sync-lab] ${message}`);
            throw new Error(message);
        }
        await sleep(pollMs);
    }
}

async function setupTaps() {
    // ctx() throws when the player is the media alone (no AudioWorklet): tapsReady then stays false, so nothing that reads
    // the lab (the live readout every 400 ms, the tapped-start report) runs or throws into the log
    const context = ctx();
    tapsReady = true;
    await context.audioWorklet.addModule(URL.createObjectURL(new Blob([tapCode], { type: 'application/javascript' })));
    const makeTap = (kind: 'media' | 'synth', threshold: number) => {
        const node = new AudioWorkletNode(context, 'lab-tap', { processorOptions: { threshold } });
        node.port.onmessage = e => {
            if (e.data.frame !== undefined) {
                tapOnsets[kind].push(e.data.frame);
            } else if (e.data.peak !== undefined) {
                tapPeaks[kind] = Math.max(tapPeaks[kind], e.data.peak);
            }
        };
        node.connect(context.destination);
        return node;
    };
    const tapMedia = makeTap('media', 0.25);
    const tapSynth = makeTap('synth', 0.02);
    lab().mediaSourceNode!.connect(tapMedia);
    // the worklet is built when the player is ready (warm start)
    await waitUntil('the synthesizer worklet', () => !!lab().synthNode, 30000, 50);
    lab().synthNode!.connect(tapSynth);
    applySound();
}

function applySound() {
    lab().masterGainNode!.gain.value = input('listen').checked ? api.masterVolume : 0;
}
input('listen').addEventListener('change', applySound);

// ---- analysis (as in the spike) ----
interface SegmentStats {
    name: string;
    clicks: number;
    matched: number;
    unmatched: number;
    firstWindow: { n: number; meanMs: number; maxAbsMs: number };
    settled: { n: number; meanMs: number; medianMs: number; p95AbsMs: number; maxAbsMs: number; stdMs: number };
    resyncs: number;
    firstOffsets: number[];
}

function nearest(sorted: number[], x: number): number {
    let lo = 0;
    let hi = sorted.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] < x) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    let best = sorted[lo];
    if (lo > 0 && Math.abs(sorted[lo - 1] - x) < Math.abs(best - x)) {
        best = sorted[lo - 1];
    }
    return best;
}

const r1 = (x: number | undefined | null) =>
    x === undefined || x === null || Number.isNaN(x) ? null : Math.round(x * 10) / 10;

/**
 * "clicks/beeps" for lists read at `readFrame`, leaving out the last 100 ms of both: a beep and its click can fall
 * either side of the moment the lists are read, which would count as a missing click.
 */
function countsBefore(readFrame: number, clicks: number[], beeps: number[]): string {
    const cut = readFrame - 0.1 * ctx().sampleRate;
    return `${clicks.filter(f => f < cut).length}/${beeps.filter(f => f < cut).length}`;
}

function analyze(
    name: string,
    fromFrame: number,
    toFrame: number,
    fromPerf: number,
    toPerf: number,
    settleMs: number
): SegmentStats {
    const sr = ctx().sampleRate;
    const media = tapOnsets.media.filter(f => f >= fromFrame - sr && f <= toFrame + sr).sort((a, b) => a - b);
    const synth = tapOnsets.synth.filter(f => f >= fromFrame && f <= toFrame);
    const settleFrame = fromFrame + (settleMs / 1000) * sr;
    const first: number[] = [];
    const settled: number[] = [];
    let unmatched = 0;
    for (const s of synth) {
        if (media.length === 0) {
            unmatched++;
            continue;
        }
        const off = ((s - nearest(media, s)) / sr) * 1000;
        if (Math.abs(off) > 150) {
            unmatched++;
            continue;
        }
        (s < settleFrame ? first : settled).push(off);
    }
    const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : Number.NaN);
    const sortedAbs = settled.map(Math.abs).sort((a, b) => a - b);
    const sorted = [...settled].sort((a, b) => a - b);
    const m = mean(settled);
    return {
        name,
        clicks: synth.length,
        matched: first.length + settled.length,
        unmatched,
        firstWindow: {
            n: first.length,
            meanMs: r1(mean(first))!,
            maxAbsMs: r1(first.length ? Math.max(...first.map(Math.abs)) : Number.NaN)!
        },
        settled: {
            n: settled.length,
            meanMs: r1(m)!,
            medianMs: r1(sorted[Math.floor(sorted.length / 2)])!,
            p95AbsMs: r1(sortedAbs[Math.floor(sortedAbs.length * 0.95)])!,
            maxAbsMs: r1(sortedAbs[sortedAbs.length - 1])!,
            stdMs: r1(Math.sqrt(mean(settled.map(x => (x - m) ** 2))))!
        },
        resyncs: lab().stats.resyncTimes.filter(t => t >= fromPerf && t <= toPerf).length,
        firstOffsets: [...first, ...settled].slice(0, 12).map(x => r1(x)!)
    };
}

function alphaTabTimeForMedia(mediaTime: number) {
    // api.timePosition is time at the current speed; the lab's own sequencer runs at 1x
    return sequencer.mainTimePositionFromBackingTrack(mediaTime, durationMs) / api.playbackSpeed;
}

/**
 * S4's first-click tolerance: max(±11 ms, ±2 × baseLatency) at 1× (F-3), ±25 ms below 1× (the media's
 * time-stretch, spikes 12–13), ±20 ms above.
 */
function firstClickToleranceMs(speed: number): number {
    if (speed === 1) {
        return Math.max(11, 2 * ctx().baseLatency * 1000);
    }
    return speed < 1 ? 25 : 20;
}

function measuringSetup(speed: number) {
    api.metronomeVolume = 1;
    api.countInVolume = 0;
    api.changeTrackMute(api.score!.tracks, true);
    api.backingTrackVolume = 1;
    api.synthVolume = 1;
    // after the volumes: each volume setter writes the master gain again
    lab().masterGainNode!.gain.value = 0; // silent, metronome only at full level: fixed tap thresholds
    api.playbackSpeed = speed;
    lab().enableDriftLog(true);
}

function restore() {
    api.pause();
    api.isLooping = false;
    api.playbackRange = null;
    applyMix();
    applyVolumes();
    applySound(); // last: the volume setters write the master gain
}

async function waitForProbe(speeds: number[]) {
    const missing = () => speeds.filter(s => lab().probeLatencies[String(s)] === undefined);
    await waitUntil(
        () => `the media latency at ${missing().join(', ')}x`,
        () => missing().length === 0,
        60000
    );
}

async function segment(name: string, action: () => void, durationMs: number, settleMs = 1500): Promise<SegmentStats> {
    const context = ctx();
    const fromFrame = Math.round(context.currentTime * context.sampleRate);
    const fromPerf = performance.now();
    action();
    await sleep(durationMs);
    const toFrame = Math.round(context.currentTime * context.sampleRate);
    return analyze(name, fromFrame, toFrame, fromPerf, performance.now(), settleMs);
}

/**
 * S1-S3: steady playback, a seek at 1x, a seek with 0.5x, with 0.75x, with 1.25x and with 1.5x. The 1.5x segment comes
 * last: it runs to the end of the default file, and the player stops there.
 */
async function runMeasurement() {
    if (src !== 'beeps') {
        log('the measurement needs src=beeps');
        return;
    }
    api.stop();
    measuringSetup(1);
    await waitForProbe([1, 0.5, 0.75, 1.25, 1.5]);
    tapOnsets.media.length = 0;
    tapOnsets.synth.length = 0;
    const segments: SegmentStats[] = [];
    segments.push(await segment('start@0s 1.0x', () => api.play(), 25000));
    segments.push(
        await segment('seek 1.0x', () => (api.timePosition = alphaTabTimeForMedia(durationMs * 0.45)), 15000)
    );
    segments.push(
        await segment(
            'seek + 0.5x',
            () => {
                api.playbackSpeed = 0.5;
                api.timePosition = alphaTabTimeForMedia(durationMs * 0.6);
            },
            15000
        )
    );
    segments.push(
        await segment(
            'seek + 0.75x',
            () => {
                api.playbackSpeed = 0.75;
                api.timePosition = alphaTabTimeForMedia(durationMs * 0.2);
            },
            15000
        )
    );
    segments.push(
        await segment(
            'seek + 1.25x',
            () => {
                api.playbackSpeed = 1.25;
                // 15 s at 1.25x are 18.75 s of media: from 10% they end before the 1.5x segment's 75%, which stays a
                // forward seek, as it was
                api.timePosition = alphaTabTimeForMedia(durationMs * 0.1);
            },
            15000
        )
    );
    segments.push(
        await segment(
            'seek + 1.5x',
            () => {
                api.playbackSpeed = 1.5;
                api.timePosition = alphaTabTimeForMedia(durationMs * 0.75);
            },
            15000
        )
    );
    restore();
    record('measurement', {
        sampleRate: ctx().sampleRate,
        baseLatencyMs: r1(ctx().baseLatency * 1000),
        outputLatencyMs: r1(ctx().outputLatency * 1000),
        peaks: tapPeaks,
        totalResyncs: lab().stats.resyncTimes.length,
        resyncLeadMs: r1(lab().stats.resyncLeadMs),
        probeLatencies: lab().probeLatencies,
        segments
    });
}

/**
 * S4, S5: n plays from different beats, `beforeBeatMs` before the beat; checks the first clicks, the skip
 * (the first beep after Play must have its own click) and the lock time. Each row's `playAtMs` is the
 * performance.now() of its Play.
 */
async function startTest(n: number, beforeBeatMs: number, speed = 1) {
    const sr = ctx().sampleRate;
    measuringSetup(speed);
    const tolerance = firstClickToleranceMs(speed);
    const rows: {
        startMedia: number;
        first: number[];
        lockMs: number | null;
        resyncs: number;
        firstGap: number | null;
        skipped: boolean;
        withinTolerance: boolean;
        counts: string;
        playAtMs: number;
    }[] = [];
    for (let i = 0; i < n; i++) {
        api.pause();
        await sleep(400);
        // a different beat each time, at least 12 beats before the end (the default file has 64 beats)
        const beat = beatMediaTimes[8 + ((i * 23) % Math.max(1, beatMediaTimes.length - 20))];
        const startMedia = beat - beforeBeatMs;
        api.timePosition = alphaTabTimeForMedia(startMedia);
        await sleep(300);
        tapOnsets.media.length = 0;
        tapOnsets.synth.length = 0;
        const playFrame = ctx().currentTime * sr;
        const playT = performance.now();
        api.play();
        await sleep(speed < 1 ? 4500 : 2500);
        const readFrame = ctx().currentTime * sr;
        const resyncs = lab().stats.resyncTimes.filter(t => t > playT).length;
        const media = [...tapOnsets.media].sort((a, b) => a - b);
        const synthAfter = tapOnsets.synth.filter(f => f > playFrame);
        const offs = synthAfter.slice(0, 5).map(f => r1(((f - nearest(media, f)) / sr) * 1000)!);
        let lockMs: number | null = null;
        for (let k = 0; k < synthAfter.length; k++) {
            if (synthAfter.slice(k).every(f => Math.abs(((f - nearest(media, f)) / sr) * 1000) < 3)) {
                lockMs = Math.round(((synthAfter[k] - playFrame) / sr) * 1000);
                break;
            }
        }
        const mediaAfter = media.filter(f => f > playFrame);
        const firstGap =
            mediaAfter.length > 0 && synthAfter.length > 0 ? r1(((synthAfter[0] - mediaAfter[0]) / sr) * 1000) : null;
        const skipped = firstGap === null || Math.abs(firstGap) > 50;
        rows.push({
            startMedia: Math.round(startMedia),
            first: offs,
            lockMs,
            resyncs,
            firstGap,
            skipped,
            withinTolerance: !skipped && Math.abs(firstGap!) <= tolerance,
            counts: countsBefore(readFrame, synthAfter, mediaAfter),
            playAtMs: playT
        });
    }
    restore();
    record('startTest', { speed, beforeBeatMs, toleranceMs: r1(tolerance), rows });
    return rows;
}

/**
 * S4b: n seeks or speed changes during playback, each `beforeBeatMs` before a beat; checks the first click after
 * each one (the first beep after it must have its own click) against S4's tolerance. 'seek' jumps 12 beats on;
 * 'speed' changes from `fromSpeed` to `speed` in place, timed from the media's currentTime (a few ms off); it needs a
 * `fromSpeed` other than `speed`.
 */
async function midPlaybackTest(
    n: number,
    beforeBeatMs: number,
    action: 'seek' | 'speed',
    speed = 1,
    fromSpeed = speed
) {
    if (action === 'speed' && fromSpeed === speed) {
        // the player ignores the speed it already has: the run would change nothing and measure nothing
        throw new Error(
            `a speed-change test needs a fromSpeed other than ${speed}: setting the same speed changes nothing`
        );
    }
    const sr = ctx().sampleRate;
    const element = (api.player!.output as unknown as { audioElement: HTMLAudioElement }).audioElement;
    const mediaNow = () => element.currentTime * 1000;
    const tolerance = firstClickToleranceMs(speed);
    const rows: object[] = [];
    for (let i = 0; i < n; i++) {
        api.pause();
        measuringSetup(fromSpeed);
        await sleep(400);
        // a different place each time, with enough beats left after the action (the default file has 64 beats)
        api.timePosition = alphaTabTimeForMedia(
            beatMediaTimes[4 + ((i * 23) % Math.max(1, beatMediaTimes.length - 40))]
        );
        await sleep(300);
        api.play();
        await sleep(fromSpeed < 1 ? 4500 : 2500); // settled before the action
        const next = beatMediaTimes.find(t => t > mediaNow() + 200 * fromSpeed)!;
        const k = beatMediaTimes.indexOf(next);
        const last = beatMediaTimes.length - 1;
        // a seek comes between two beats, so no beep or click of the old place follows it; a speed change comes
        // beforeBeatMs before a beat
        const actAt = action === 'seek' ? (next + beatMediaTimes[Math.min(k + 1, last)]) / 2 : next - beforeBeatMs;
        await sleep((actAt - mediaNow()) / fromSpeed);
        const target = action === 'seek' ? beatMediaTimes[Math.min(k + 12, last - 1)] : next;
        tapOnsets.media.length = 0;
        tapOnsets.synth.length = 0;
        const actionFrame = ctx().currentTime * sr;
        const actionT = performance.now();
        if (action === 'seek') {
            api.timePosition = alphaTabTimeForMedia(target - beforeBeatMs);
        } else {
            api.playbackSpeed = speed;
        }
        await sleep(speed < 1 ? 4500 : 2500);
        const readFrame = ctx().currentTime * sr;
        const media = [...tapOnsets.media].sort((a, b) => a - b);
        const synth = [...tapOnsets.synth].sort((a, b) => a - b);
        const mediaAfter = media.filter(f => f > actionFrame);
        const synthAfter = synth.filter(f => f > actionFrame);
        const firstGap =
            mediaAfter.length > 0 && synthAfter.length > 0
                ? r1(((nearest(synthAfter, mediaAfter[0]) - mediaAfter[0]) / sr) * 1000)
                : null;
        const skipped = firstGap === null || Math.abs(firstGap) > 50;
        rows.push({
            target: Math.round(target),
            firstGap,
            skipped,
            withinTolerance: !skipped && Math.abs(firstGap!) <= tolerance,
            after: synthAfter.slice(1, 5).map(f => r1(((f - nearest(media, f)) / sr) * 1000)!),
            resyncs: lab().stats.resyncTimes.filter(t => t > actionT).length,
            counts: countsBefore(readFrame, synthAfter, mediaAfter)
        });
    }
    restore();
    record('midPlaybackTest', { action, speed, fromSpeed, beforeBeatMs, toleranceMs: r1(tolerance), rows });
    return rows;
}

/**
 * S5: the whole song from the start; every beep must have its own click, and every click its beep.
 */
async function fullSongTest(speed = 1) {
    const sr = ctx().sampleRate;
    measuringSetup(speed);
    api.pause();
    await sleep(400);
    api.timePosition = 0;
    await sleep(300);
    tapOnsets.media.length = 0;
    tapOnsets.synth.length = 0;
    const playFrame = ctx().currentTime * sr;
    let finished = false;
    const unsubscribe = api.playerFinished.on(() => {
        finished = true;
    });
    api.play();
    const limit = performance.now() + durationMs / speed + 5000;
    while (!finished && performance.now() < limit) {
        await sleep(200);
    }
    unsubscribe();
    await sleep(300);
    restore();
    const media = tapOnsets.media.filter(f => f > playFrame).sort((a, b) => a - b);
    const synth = tapOnsets.synth.filter(f => f > playFrame).sort((a, b) => a - b);
    const apart = (a: number, b: number) => Math.abs(((a - b) / sr) * 1000) > 50;
    const row = {
        speed,
        finished,
        beats: beatMediaTimes.length,
        beeps: media.length,
        clicks: synth.length,
        missing: synth.length === 0 ? media.length : media.filter(m => apart(nearest(synth, m), m)).length,
        extra: media.length === 0 ? synth.length : synth.filter(s => apart(s, nearest(media, s))).length
    };
    record('fullSongTest', row);
    return row;
}

/**
 * S6: Play with the real count-in on a beat; counts the count-in clicks, the downbeat (click vs the media's first
 * beep) and the next clicks.
 */
async function countInTest(n: number, speed = 1) {
    const sr = ctx().sampleRate;
    measuringSetup(speed);
    api.countInVolume = 1;
    const rows: object[] = [];
    for (let i = 0; i < n; i++) {
        api.pause();
        await sleep(400);
        // a different beat each time, as in startTest (the default file has 64 beats)
        const k = 8 + ((i * 23) % Math.max(1, beatMediaTimes.length - 20));
        const target = beatMediaTimes[k];
        api.timePosition = alphaTabTimeForMedia(target);
        await sleep(300);
        tapOnsets.media.length = 0;
        tapOnsets.synth.length = 0;
        const playFrame = ctx().currentTime * sr;
        const playT = performance.now();
        const handOffs = lab().countIns.length;
        api.play();
        // a 4/4 count-in bar and four more beats at this place's tempo (the default file runs from 60 to 240 BPM)
        await sleep((8 * (beatMediaTimes[k + 1] - target)) / speed + 1000);
        const media = [...tapOnsets.media].sort((a, b) => a - b);
        const synthAfter = tapOnsets.synth.filter(f => f > playFrame).sort((a, b) => a - b);
        const firstBeep = media.find(f => f > playFrame) ?? null;
        const ms = (f: number) => r1((f / sr) * 1000)!;
        const countInClicks = firstBeep === null ? null : synthAfter.filter(f => f < firstBeep - 0.05 * sr).length;
        const downbeatMs =
            firstBeep === null || synthAfter.length === 0 ? null : ms(nearest(synthAfter, firstBeep) - firstBeep);
        const handOff = lab().countIns[handOffs];
        rows.push({
            target: Math.round(target),
            countInClicks,
            downbeatMs,
            skipped: downbeatMs === null || Math.abs(downbeatMs) > 50,
            withinTolerance: downbeatMs !== null && Math.abs(downbeatMs) <= firstClickToleranceMs(speed),
            after:
                firstBeep === null
                    ? []
                    : synthAfter
                          .filter(f => f > firstBeep + 0.05 * sr)
                          .slice(0, 4)
                          .map(f => ms(f - nearest(media, f))),
            resyncs: lab().stats.resyncTimes.filter(t => t > playT).length,
            playLateMs: handOff ? r1(handOff.lateMs) : null,
            learnedMediaStartMs: lab().mediaStartLatencies[String(speed)] ?? null
        });
    }
    restore();
    record('countInTest', { speed, rows });
    return rows;
}

/**
 * D-3 (F-14): the count-in's media pre-roll below 1x, 60 ms against 120 ms, with the real count-in. The arms run ABBA
 * (60, 120, 120, 60) with `n` Plays each, and every arm starts with the speed's media-start latency unlearned, so
 * neither inherits what the other learned; the rows are reported per arm, in run order.
 */
async function countInPreRollTest(speed = 0.5, n = 6) {
    const constants = MediaSyncConstants as unknown as { CountInPreRollBelow1xMs: number };
    const original = constants.CountInPreRollBelow1xMs;
    // the lab always plays a backing track
    const learned = MediaSyncLearnedValues.backingTrack;
    const preRolls = [60, 120, 120, 60];
    const arms: { order: number; preRollMs: number; rows: object[] }[] = [];
    try {
        for (let i = 0; i < preRolls.length; i++) {
            constants.CountInPreRollBelow1xMs = preRolls[i];
            learned.mediaStartLatencies.delete(speed);
            learned.lastMediaStartLatencies.delete(speed);
            arms.push({ order: i + 1, preRollMs: preRolls[i], rows: await countInTest(n, speed) });
        }
    } finally {
        constants.CountInPreRollBelow1xMs = original;
    }
    record('countInPreRollTest', { speed, arms });
    return arms;
}

/**
 * S10: loops `bars` bars from beat 40 for `wraps` repetitions; every beep must have its own click, and each
 * repetition's first beat is checked against S4b's tolerance. The wrap gap is measured at the wraps only: from the
 * last beep before a wrap to the first beep after it, less that pair's nominal spacing (the range's last beat to the
 * range end, where the next repetition's first beat takes the place of the beat after the range).
 * `medianWrapGapMs` is the median over every wrap; `gaps` lists the wrap gaps above 15 ms.
 */
async function loopTest(speed: number, bars = 2, wraps = 10, beatsPerBar = 4) {
    const sr = ctx().sampleRate;
    measuringSetup(speed);
    api.pause();
    await sleep(400);
    const k0 = 40;
    const startMedia = beatMediaTimes[k0];
    const endMedia = beatMediaTimes[k0 + bars * beatsPerBar];
    // what a pass without a wrap would space the range's last beep and the one after it by
    const lastBeat = k0 + bars * beatsPerBar - 1;
    const nominalWrapMs = (beatMediaTimes[lastBeat + 1] - beatMediaTimes[lastBeat]) / speed;
    api.timePosition = alphaTabTimeForMedia(endMedia);
    await sleep(150);
    const endTick = api.tickPosition;
    api.timePosition = alphaTabTimeForMedia(startMedia);
    await sleep(150);
    const range = new alphaTab.synth.PlaybackRange();
    range.startTick = api.tickPosition;
    range.endTick = endTick;
    api.playbackRange = range;
    api.isLooping = true;
    const wrapsBefore = lab().wraps.length;
    // the context frame of each wrap, as autoBpmLoopTest records it
    const wrapFrames: number[] = [];
    const unsubscribeWraps = api.playerFinished.on(() => wrapFrames.push(ctx().currentTime * sr));
    await sleep(300);
    tapOnsets.media.length = 0;
    tapOnsets.synth.length = 0;
    const playFrame = ctx().currentTime * sr;
    const playT = performance.now();
    api.play();
    await sleep(((endMedia - startMedia) / speed) * (wraps + 1) + 300);
    const wrapCount = lab().wraps.length - wrapsBefore;
    unsubscribeWraps();
    restore();
    await sleep(300);
    const media = tapOnsets.media.filter(f => f > playFrame).sort((a, b) => a - b);
    const synth = tapOnsets.synth.filter(f => f > playFrame).sort((a, b) => a - b);
    const offsets: number[] = [];
    let missing = 0;
    for (const m of media) {
        const off = ((nearest(synth, m) - m) / sr) * 1000;
        if (Math.abs(off) <= 50) {
            offsets.push(off);
        } else {
            missing++;
        }
    }
    const extra =
        media.length === 0
            ? synth.length
            : synth.filter(s => Math.abs(((s - nearest(media, s)) / sr) * 1000) > 50).length;
    // a wrap whose next repetition was not heard before the run ended has no beep after it: it is left out
    const wrapGaps: number[] = [];
    for (const w of wrapFrames) {
        const before = media.filter(f => f < w);
        const after = media.find(f => f > w);
        if (before.length > 0 && after !== undefined) {
            wrapGaps.push(((after - before[before.length - 1]) / sr) * 1000 - nominalWrapMs);
        }
    }
    const abs = offsets.map(Math.abs).sort((a, b) => a - b);
    const sortedWrapGaps = [...wrapGaps].sort((a, b) => a - b);
    // each repetition's first beat: the first beep after each of the first `wraps` wraps (as autoBpmLoopTest);
    // a later wrap comes too close to the run's end for its first beat to be heard
    const firstBeats = wrapFrames.slice(0, wraps).map(w => {
        const beep = media.find(f => f > w);
        return beep === undefined || synth.length === 0 ? null : r1(((nearest(synth, beep) - beep) / sr) * 1000);
    });
    const tolerance = firstClickToleranceMs(speed);
    const result = {
        speed,
        beeps: media.length,
        clicks: synth.length,
        missing,
        extra,
        meanMs: r1(offsets.reduce((a, b) => a + b, 0) / Math.max(1, offsets.length)),
        p95Ms: r1(abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.95))]),
        wraps: wrapCount,
        nominalWrapMs: r1(nominalWrapMs),
        wrapGapsN: wrapGaps.length,
        medianWrapGapMs: r1(sortedWrapGaps[Math.floor(sortedWrapGaps.length / 2)]),
        gaps: wrapGaps.filter(g => g > 15).map(g => Math.round(g)),
        firstBeatsMs: firstBeats,
        toleranceMs: r1(tolerance),
        firstBeatsWithinTolerance:
            firstBeats.length === wraps && firstBeats.every(x => x !== null && Math.abs(x) <= tolerance),
        resyncs: lab().stats.resyncTimes.filter(t => t > playT).length
    };
    record('loopTest', result);
    return result;
}

/**
 * F-9d: a held tempo sweep (notation-hero's tempo button, one step per `stepMs`). With `settleOnly` a speed change
 * settles instead of re-syncing, and each step's row says how far the media player's own seek moved the recording
 * back (`seekBackMs`) and how far behind the synth the media then was (`firstDriftMs`) (decision gate D-9).
 * From 1.5 s after the last step the clicks must be back within S4b's tolerance: `settledOk` judges the clicks of that
 * window (the run reads on until three beats are in it) and is null when fewer than two were heard.
 */
async function sweepTest(fromSpeed: number, steps: number, stepSpeed: number, stepMs = 250, settleOnly = false) {
    const sr = ctx().sampleRate;
    measuringSetup(fromSpeed);
    api.pause();
    await sleep(400);
    api.timePosition = alphaTabTimeForMedia(beatMediaTimes[40]);
    await sleep(300);
    api.play();
    await sleep(3000);
    const element = (api.player!.output as unknown as { audioElement: HTMLAudioElement }).audioElement;
    const controller = mediaSynth().controller;
    const speedChanged = controller.speedChanged.bind(controller);
    lab().enableDriftLog(true);
    const stepRows: { seekBackMs: number; firstDriftMs: number | null }[] = [];
    tapOnsets.media.length = 0;
    tapOnsets.synth.length = 0;
    const f0 = ctx().currentTime * sr;
    const t0 = performance.now();
    let speed = fromSpeed;
    // the last step's own time, and where the media was then
    let lastStepT = t0;
    let mediaAtLastStep = element.currentTime * 1000;
    try {
        if (settleOnly) {
            // spike 11's settle rule: no forced re-sync; the drift rules still re-sync above the threshold
            controller.speedChanged = (s: number) => {
                const resync = controller.resync;
                controller.resync = () => {};
                try {
                    speedChanged(s);
                } finally {
                    controller.resync = resync;
                }
            };
        }
        for (let i = 0; i < steps; i++) {
            speed = Math.round((speed + stepSpeed) * 10000) / 10000;
            const before = element.currentTime * 1000;
            const stepT = performance.now();
            api.playbackSpeed = speed;
            // the media player's own seek is synchronous: currentTime already reads its target
            mediaAtLastStep = element.currentTime * 1000;
            const seekBackMs = r1(before - mediaAtLastStep)!;
            lastStepT = stepT;
            await sleep(stepMs);
            const first = lab().stats.driftLog!.find(e => e.time >= stepT);
            stepRows.push({ seekBackMs, firstDriftMs: first ? r1(first.drift) : null });
        }
    } finally {
        controller.speedChanged = speedChanged;
        lab().enableDriftLog(false);
    }
    // 1.5 s after the last step the settled window opens (the media moves 1.5 s x speed on by then): read on until
    // three beats are in it. Without three beats left the song ends first, and what was heard is judged.
    const thirdBeat = beatMediaTimes.filter(t => t > mediaAtLastStep + 1500 * speed)[2];
    const tailMs = thirdBeat === undefined ? 4500 : (thirdBeat - mediaAtLastStep) / speed + 200;
    await sleep(Math.max(0, lastStepT + tailMs - performance.now()));
    const f1 = ctx().currentTime * sr;
    restore();
    const media = [...tapOnsets.media].sort((a, b) => a - b);
    const clicks = tapOnsets.synth.filter(f => f > f0 && f < f1);
    const abs = clicks.map(f => Math.abs(((f - nearest(media, f)) / sr) * 1000)).sort((a, b) => a - b);
    // from 1.5 s after the last step on the clicks must be back within S4b's tolerance
    const settledFrom = f0 + ((lastStepT - t0 + 1500) / 1000) * sr;
    const settled = clicks.filter(f => f > settledFrom).map(f => Math.abs(((f - nearest(media, f)) / sr) * 1000));
    const row = {
        fromSpeed,
        toSpeed: speed,
        steps,
        stepMs,
        resyncs: lab().stats.resyncTimes.filter(t => t > t0).length,
        counts: countsBefore(
            f1,
            clicks,
            media.filter(f => f > f0 && f < f1)
        ),
        p95Ms: r1(abs[Math.floor(abs.length * 0.95)]),
        maxMs: r1(abs[abs.length - 1]),
        over20: abs.filter(x => x > 20).length,
        settledClicks: settled.length,
        settledMaxMs: r1(settled.length ? Math.max(...settled) : Number.NaN),
        // null with fewer than two clicks in the window: there is nothing to judge
        settledOk: settled.length < 2 ? null : settled.every(x => x <= firstClickToleranceMs(speed)),
        settleOnly,
        stepRows
    };
    record('sweepTest', row);
    return row;
}

/**
 * F-9d: the rhythm game's auto-BPM loop: +`bpmStep` BPM each time the loop wraps. `resyncs` counts from Play; each
 * repetition's first beat is judged against S4b's tolerance at the speed that repetition runs at.
 */
async function autoBpmLoopTest(startSpeed: number, bpmStep = 5, wraps = 10, bars = 2, beatsPerBar = 4) {
    const sr = ctx().sampleRate;
    const bpm = api.score!.tempo;
    const step = bpmStep / bpm;
    let speed = startSpeed;
    // the speed each wrap sets: the repetition after it runs at that speed
    const wrapSpeeds: number[] = [];
    const unsubscribe = api.playerFinished.on(() => {
        speed = Math.round((speed + step) * 10000) / 10000;
        api.playbackSpeed = speed;
        wrapSpeeds.push(speed);
    });
    const wrapFrames: number[] = [];
    const unsubscribeWraps = api.playerFinished.on(() => wrapFrames.push(ctx().currentTime * sr));
    let playFrame = 0;
    let playT = 0;
    try {
        measuringSetup(startSpeed);
        const k0 = 40;
        const startMedia = beatMediaTimes[k0];
        const endMedia = beatMediaTimes[k0 + bars * beatsPerBar];
        api.timePosition = alphaTabTimeForMedia(endMedia);
        await sleep(150);
        const endTick = api.tickPosition;
        api.timePosition = alphaTabTimeForMedia(startMedia);
        await sleep(150);
        const range = new alphaTab.synth.PlaybackRange();
        range.startTick = api.tickPosition;
        range.endTick = endTick;
        api.playbackRange = range;
        api.isLooping = true;
        tapOnsets.media.length = 0;
        tapOnsets.synth.length = 0;
        playFrame = ctx().currentTime * sr;
        playT = performance.now();
        api.play();
        // the slowest repetition is the longest: a loop that has not wrapped by then has stopped
        const slowest = Math.max(0.1, Math.min(startSpeed, startSpeed + step * wraps));
        await waitUntil(
            `${wraps} wraps of the loop`,
            () => wrapFrames.length >= wraps,
            ((endMedia - startMedia) / slowest) * (wraps + 1) + 10000
        );
        await sleep(((endMedia - startMedia) / speed) * 0.5);
    } finally {
        unsubscribe();
        unsubscribeWraps();
        restore();
    }
    const media = tapOnsets.media.filter(f => f > playFrame).sort((a, b) => a - b);
    const synth = tapOnsets.synth.filter(f => f > playFrame).sort((a, b) => a - b);
    // each repetition's first beat: the first beep after each wrap
    const firstBeats = wrapFrames.map(w => {
        const beep = media.find(f => f > w);
        return beep === undefined || synth.length === 0 ? null : r1(((nearest(synth, beep) - beep) / sr) * 1000);
    });
    const missing =
        synth.length === 0
            ? media.length
            : media.filter(m => Math.abs(((nearest(synth, m) - m) / sr) * 1000) > 50).length;
    const row = {
        startSpeed,
        endSpeed: speed,
        bpmStep,
        wraps: wrapFrames.length,
        firstBeatsMs: firstBeats,
        firstBeatsWithinTolerance: firstBeats.every(
            (x, i) => x !== null && Math.abs(x) <= firstClickToleranceMs(wrapSpeeds[i])
        ),
        missing,
        resyncs: lab().stats.resyncTimes.filter(t => t > playT).length
    };
    record('autoBpmLoopTest', row);
    return row;
}

/**
 * F-9a / F-9d: the first Play at a speed with no probe value and no start lead: the straight-line guesses. The
 * speed change before the Play already starts the speed's probe, so its value can land before the Play:
 * `landedBeforePlay` says whether it did (then the Play was not at an unprobed speed), and `probeArrivedAfterPlayMs`
 * counts from the Play (negative before it).
 */
async function firstPlayAtUnprobedSpeedTest(speeds: number[], beforeBeatMs = 30) {
    const rows: object[] = [];
    for (const speed of speeds) {
        lab().forgetProbeLatency(speed);
        lab().forgetStartLead(speed);
        const guessedLead = mediaSynth().controller.startLeads.get(speed);
        const guessedLatency = MediaLatencyProbe.cache.get(speed);
        const probesBefore = lab().probes.length;
        const [row] = await startTest(1, beforeBeatMs, speed);
        const probe = lab()
            .probes.slice(probesBefore)
            .find(p => p.speed === speed);
        const { playAtMs, ...started } = row;
        rows.push({
            speed,
            guessedLeadMs: r1(guessedLead),
            guessedLatencyMs: r1(guessedLatency),
            landedBeforePlay: probe !== undefined && probe.time < playAtMs,
            probeArrivedAfterPlayMs: probe ? Math.round(probe.time - playAtMs) : null,
            ...started
        });
    }
    record('firstPlayAtUnprobedSpeedTest', rows);
    return rows;
}

/**
 * D-1 (F-9a): a probe value lands while a loop plays at an unprobed speed. forcedResync = true runs the spec's
 * current rule (re-sync on arrival) for comparison. Both arms start from a speed never played before: no probe value
 * and no learned start lead. Each arm first sets the speed away to 1x, so in both the change to the arm's speed, about
 * 300 ms before Play, queues that speed's probe. `resyncsAfterArrival` counts the 2 s that `clicksAfterMs` covers.
 */
async function probeMidPlaybackTest(speed = 0.875, forcedResync = false) {
    const sr = ctx().sampleRate;
    const controller = mediaSynth().controller;
    const latencyChanged = controller.latencyChanged.bind(controller);
    try {
        if (forcedResync) {
            controller.latencyChanged = () => {
                latencyChanged();
                controller.resync();
            };
        }
        if (speed !== 1) {
            // the first arm leaves its speed set: from 1x, measuringSetup's speed change queues this speed's probe in
            // both arms alike
            api.playbackSpeed = 1;
        }
        lab().forgetProbeLatency(speed);
        lab().forgetStartLead(speed);
        measuringSetup(speed);
        api.timePosition = alphaTabTimeForMedia(beatMediaTimes[40]);
        await sleep(300);
        tapOnsets.media.length = 0;
        tapOnsets.synth.length = 0;
        const probesBefore = lab().probes.length;
        const playFrame = ctx().currentTime * sr;
        const playT = performance.now();
        api.play(); // measuringSetup's speed change queued this speed's probe: it lands mid-playback
        await sleep(8000);
        restore();
        const probe = lab()
            .probes.slice(probesBefore)
            .find(p => p.speed === speed);
        const arrivalFrame = probe ? playFrame + ((probe.time - playT) / 1000) * sr : Number.NaN;
        const media = [...tapOnsets.media].sort((a, b) => a - b);
        const offsetsAround = (from: number, to: number) =>
            tapOnsets.synth.filter(f => f > from && f < to).map(f => r1(((f - nearest(media, f)) / sr) * 1000)!);
        const row = {
            speed,
            forcedResync,
            probeArrivedAfterPlayMs: probe ? Math.round(probe.time - playT) : null,
            probeLatencyMs: probe ? r1(probe.latencyMs) : null,
            resyncsAfterArrival: probe
                ? lab().stats.resyncTimes.filter(t => t >= probe.time && t <= probe.time + 2000).length
                : null,
            clicksBeforeMs: offsetsAround(arrivalFrame - sr, arrivalFrame),
            clicksAfterMs: offsetsAround(arrivalFrame, arrivalFrame + 2 * sr)
        };
        record('probeMidPlaybackTest', row);
        return row;
    } finally {
        controller.latencyChanged = latencyChanged;
    }
}

/**
 * §6.4: the ~1 s probe (125 ms spacing) against the spike's 4 s probe (250 ms spacing).
 */
async function probeComparison(speeds = [0.5, 0.75, 1.25, 1.5], repeats = 3) {
    const context = ctx();
    const load = () => BrowserUiFacade.createAlphaSynthAudioWorklet(context, settings);
    const short = new MediaLatencyProbe(context, load, 1, 0.125);
    const long = new MediaLatencyProbe(context, load, 4, 0.25);
    const rows: object[] = [];
    for (const speed of speeds) {
        const shortValues: number[] = [];
        const longValues: number[] = [];
        for (let i = 0; i < repeats; i++) {
            shortValues.push(r1(await short.measure(speed))!);
            longValues.push(r1(await long.measure(speed))!);
        }
        rows.push({ speed, shortMs: shortValues, longMs: longValues });
    }
    record('probeComparison', rows);
    return rows;
}

/**
 * §6.1, spike 7: playBeat while playing pauses both; the next Play is in sync.
 */
async function playBeatTest(n = 4, speed = 1) {
    const sr = ctx().sampleRate;
    measuringSetup(speed);
    const track = api.score!.tracks[0];
    const beat = track.staves[0].bars[Math.min(12, track.staves[0].bars.length - 1)].voices[0].beats[0];
    const rows: object[] = [];
    for (let i = 0; i < n; i++) {
        api.pause();
        await sleep(400);
        api.timePosition = alphaTabTimeForMedia(
            beatMediaTimes[8 + ((i * 23) % Math.max(1, beatMediaTimes.length - 20))] - 500
        );
        await sleep(300);
        api.play();
        await sleep(2500);
        const states: string[] = [];
        const unsubscribe = api.playerStateChanged.on(e =>
            states.push(e.state === alphaTab.synth.PlayerState.Playing ? 'Playing' : 'Paused')
        );
        api.playBeat(beat);
        await sleep(1500);
        unsubscribe();
        tapOnsets.media.length = 0;
        tapOnsets.synth.length = 0;
        const playFrame = ctx().currentTime * sr;
        api.play();
        await sleep(2500);
        const media = [...tapOnsets.media].sort((a, b) => a - b);
        const synthAfter = tapOnsets.synth.filter(f => f > playFrame);
        const mediaAfter = media.filter(f => f > playFrame);
        rows.push({
            statesAfterPlayBeat: states,
            firstGapMs:
                mediaAfter.length && synthAfter.length ? r1(((synthAfter[0] - mediaAfter[0]) / sr) * 1000) : null,
            nextClicksMs: synthAfter.slice(0, 5).map(f => r1(((f - nearest(media, f)) / sr) * 1000))
        });
    }
    restore();
    record('playBeatTest', { speed, rows });
    return rows;
}

/**
 * D-7 (R-2): after a TAPPED Play, whether the media started, how long after the tap, and the player's state. WebKit may
 * refuse a media play() that runs after the tap (after a count-in, or after the seek of a start below 1x), and only
 * for an element that never played from a gesture: so this is the first start on a fresh page.
 */
async function reportTappedStart(tapFrame: number) {
    const sr = ctx().sampleRate;
    const countIn = api.countInVolume > 0;
    const speed = api.playbackSpeed;
    await sleep(speed < 1 ? 9000 : 6000);
    const firstBeep = tapOnsets.media.find(f => f > tapFrame);
    record('tappedStart', {
        speed,
        countIn,
        mediaStartedAfterMs: firstBeep === undefined ? null : Math.round(((firstBeep - tapFrame) / sr) * 1000),
        playing: api.playerState === alphaTab.synth.PlayerState.Playing
    });
}

// a run from a button has no console to fail into (the iPad): its failure goes to the page's log
function runFromButton(name: string, test: () => Promise<unknown>) {
    test().catch(e => log(`error [sync-lab] ${name} failed: ${errorText(e)}`));
}

document.getElementById('play')!.addEventListener('click', () => {
    // api.playPause() runs inside the tap, as an app's Play button does
    const starting = api.playerState !== alphaTab.synth.PlayerState.Playing;
    const tapFrame = mixing && tapsReady ? ctx().currentTime * ctx().sampleRate : Number.NaN;
    api.playPause();
    if (starting && !Number.isNaN(tapFrame)) {
        runFromButton('tapped start report', () => reportTappedStart(tapFrame));
    }
});
document.getElementById('measure')!.addEventListener('click', () => runFromButton('measurement', runMeasurement));
// the device runs (Task 24) need no console: the speed comes from the Speed select, the rows print in the log
const selectedSpeed = () => Number.parseFloat((document.getElementById('speed') as HTMLSelectElement).value);
document
    .getElementById('startTestButton')!
    .addEventListener('click', () => runFromButton('start test', () => startTest(10, 30, selectedSpeed())));
document
    .getElementById('loopTestButton')!
    .addEventListener('click', () => runFromButton('loop test', () => loopTest(selectedSpeed())));
document
    .getElementById('countInTestButton')!
    .addEventListener('click', () => runFromButton('count-in test', () => countInTest(6, selectedSpeed())));
document
    .getElementById('seekTestButton')!
    .addEventListener('click', () =>
        runFromButton('seek test', () => midPlaybackTest(10, 30, 'seek', selectedSpeed()))
    );
document.getElementById('speedTestButton')!.addEventListener('click', () => {
    // from another speed: setting the speed the player already has changes nothing
    const speed = selectedSpeed();
    runFromButton('speed-change test', () => midPlaybackTest(10, 30, 'speed', speed, speed === 1 ? 0.75 : 1));
});
document.getElementById('speed')!.addEventListener('change', e => {
    api.playbackSpeed = Number.parseFloat((e.target as HTMLSelectElement).value);
});
const metronomeEl = input('metronome');
const drumsEl = input('drums');
const metronomeVolEl = input('metronomeVol');
const countInEl = input('countIn');
function applyMix() {
    api.metronomeVolume = metronomeEl.checked ? Number.parseFloat(metronomeVolEl.value) : 0;
    api.countInVolume = countInEl.checked ? 1 : 0;
    if (api.score) {
        api.changeTrackMute(api.score.tracks, !drumsEl.checked);
    }
}
metronomeEl.addEventListener('change', applyMix);
metronomeVolEl.addEventListener('input', applyMix);
drumsEl.addEventListener('change', applyMix);
countInEl.addEventListener('change', applyMix);
const mediaVolEl = input('mediaVol');
const synthVolEl = input('synthVol');
function applyVolumes() {
    api.backingTrackVolume = Number.parseFloat(mediaVolEl.value);
    api.synthVolume = Number.parseFloat(synthVolEl.value);
}
function applyVolumesAndSound() {
    applyVolumes();
    applySound(); // the volume setters write the master gain: keep "sound on" as ticked
}
mediaVolEl.addEventListener('input', applyVolumesAndSound);
synthVolEl.addEventListener('input', applyVolumesAndSound);

// the taps are set up once per page (setupTaps sets tapsReady)
let tapsReady = false;
api.playerReady.on(async () => {
    fileNameEl.textContent = pendingFileName;
    // S7: with mixing=0 both stay 0 in backing-track mode
    log('player ready', { mixing, created });
    if (!mixing) {
        return;
    }
    applyMix();
    applyVolumes();
    applySound(); // a second file: the volume setters wrote the master gain again
    if (!tapsReady) {
        await setupTaps();
    }
});

// live readout: how far each metronome click is from the backing track's beep (beeps only)
const liveEl = document.getElementById('live')!;
let liveSeen = 0;
setInterval(() => {
    if (!mixing || !tapsReady) {
        return;
    }
    const speed = api.playbackSpeed;
    const latency = lab().probeLatencies[String(speed)];
    const probe = latency === undefined ? `latency @${speed}x: guessed` : `latency @${speed}x: ${latency} ms`;
    if (src !== 'beeps') {
        liveEl.textContent = `live: ${probe} — switch Audio to "generated beeps" for click-vs-beep offsets`;
        return;
    }
    const sr = ctx().sampleRate;
    const media = [...tapOnsets.media].sort((a, b) => a - b);
    const recent = tapOnsets.synth.slice(-8);
    if (media.length === 0 || recent.length === 0 || tapOnsets.synth.length === liveSeen) {
        return;
    }
    liveSeen = tapOnsets.synth.length;
    const offsets = recent
        .map(s => ((s - nearest(media, s)) / sr) * 1000)
        .filter(o => Math.abs(o) < 150)
        .map(o => Math.round(o));
    const mean = offsets.length ? Math.round(offsets.reduce((a, b) => a + b, 0) / offsets.length) : 0;
    liveEl.textContent = `live @${speed}x: click - beep (last ${offsets.length}): ${offsets.join(' ')} ms, mean ${mean} ms; ${probe}`;
}, 400);

(window as unknown as { syncLab: unknown }).syncLab = {
    results,
    created,
    lab,
    mediaSynth,
    runMeasurement,
    startTest,
    midPlaybackTest,
    fullSongTest,
    countInTest,
    countInPreRollTest,
    loopTest,
    sweepTest,
    autoBpmLoopTest,
    firstPlayAtUnprobedSpeedTest,
    probeMidPlaybackTest,
    probeComparison,
    playBeatTest
};

(async () => {
    const bytes = new Uint8Array(await (await fetch(file)).arrayBuffer());
    await loadBytes(bytes, file.split('/').pop() ?? file);
})();
