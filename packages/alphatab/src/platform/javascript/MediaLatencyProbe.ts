import type { IMediaLatencyProbe } from '@coderline/alphatab/platform/javascript/MediaSynthTypes';
import { PerSpeedValues } from '@coderline/alphatab/platform/javascript/PerSpeedValues';
import type { IAlphaSynthWorkerMessage } from '@coderline/alphatab/platform/worker/AlphaTabWorkerProtocol';

/**
 * @target web
 * @internal
 */
export class ProbeWav {
    public readonly bytes: Uint8Array;
    /** The beeps' positions in the WAV, s. */
    public readonly beepTimes: number[];

    public constructor(bytes: Uint8Array, beepTimes: number[]) {
        this.bytes = bytes;
        this.beepTimes = beepTimes;
    }
}

/**
 * The probe <audio>'s currentTime and the AudioContext's time, read together (both s).
 * @target web
 * @internal
 */
export class ProbePoll {
    public readonly mediaTime: number;
    public readonly contextTime: number;

    public constructor(mediaTime: number, contextTime: number) {
        this.mediaTime = mediaTime;
        this.contextTime = contextTime;
    }
}

/**
 * Measures how much earlier a time-stretched <audio> is heard than its currentTime says, per speed (spec §6.4).
 * @target web
 * @internal
 */
export class MediaLatencyProbe implements IMediaLatencyProbe {
    /**
     * Measured values, cached for the page session (one per speed).
     */
    public static readonly cache: PerSpeedValues = new PerSpeedValues();
    /**
     * Measured in the background after load; other speeds on first use.
     */
    public static readonly backgroundSpeeds: number[] = [1, 0.5, 0.75, 1.25, 1.5];
    public static readonly SampleRate: number = 48000;
    /** Spec §6.4: ~1 s with a beep every 125 ms (untested; the spike used 4 s / 250 ms, Task 22 compares). */
    public static readonly LengthS: number = 1;
    public static readonly SpacingS: number = 0.125;
    private static readonly _beepFrequency: number = 2000;
    private static readonly _beepS: number = 0.003;
    private static readonly _pollMs: number = 4;
    /**
     * A measurement that takes longer than the probe at that speed plus this is given up: WebKit may never load or
     * start a hidden <audio> outside a gesture.
     */
    public static readonly TimeLimitExtraMs: number = 2000;

    private readonly _context: AudioContext;
    private readonly _loadWorkletModule: () => Promise<void>;
    private readonly _lengthS: number;
    private readonly _spacingS: number;
    private _wav: ProbeWav | null = null;
    private _url: string = '';

    /**
     * @param loadWorkletModule Loads alphaTab's worklet module (which registers the probe's tap) into the context.
     * @param lengthS The probe's length; the sync lab passes the spike's 4 s to compare (Task 22).
     * @param spacingS The beeps' spacing; the sync lab passes the spike's 0.25 s to compare.
     */
    public constructor(
        context: AudioContext,
        loadWorkletModule: () => Promise<void>,
        lengthS: number = MediaLatencyProbe.LengthS,
        spacingS: number = MediaLatencyProbe.SpacingS
    ) {
        this._context = context;
        this._loadWorkletModule = loadWorkletModule;
        this._lengthS = lengthS;
        this._spacingS = spacingS;
    }

    public static createProbeWav(sampleRate: number, lengthS: number, spacingS: number): ProbeWav {
        const pcm = new Int16Array(Math.round(sampleRate * lengthS));
        const beepTimes: number[] = [];
        const beepFrames = Math.round(sampleRate * MediaLatencyProbe._beepS);
        for (let i = 1; i * spacingS < lengthS - 0.2; i++) {
            const time = i * spacingS;
            beepTimes.push(time);
            const start = Math.round(time * sampleRate);
            for (let k = 0; k < beepFrames; k++) {
                pcm[start + k] = Math.round(
                    Math.sin((2 * Math.PI * MediaLatencyProbe._beepFrequency * k) / sampleRate) * 0.6 * 32767
                );
            }
        }
        const buffer = new ArrayBuffer(44 + pcm.length * 2);
        const view = new DataView(buffer);
        const text = (offset: number, value: string) => {
            for (let i = 0; i < value.length; i++) {
                view.setUint8(offset + i, value.charCodeAt(i));
            }
        };
        text(0, 'RIFF');
        view.setUint32(4, 36 + pcm.length * 2, true);
        text(8, 'WAVE');
        text(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); // PCM
        view.setUint16(22, 1, true); // mono
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        text(36, 'data');
        view.setUint32(40, pcm.length * 2, true);
        new Int16Array(buffer, 44).set(pcm);
        return new ProbeWav(new Uint8Array(buffer), beepTimes);
    }

    /**
     * The median of (currentTime reaching a beep − the beep being heard), real ms. The first beep carries the
     * start transient and is skipped. Fewer than two beeps heard: NaN, not a measured 0 (measure() then fails).
     */
    public static latencyFromOnsets(onsets: number[], polls: ProbePoll[], beepTimes: number[], speed: number): number {
        const offsets: number[] = [];
        for (const onset of onsets) {
            for (let i = 1; i < polls.length; i++) {
                const a = polls[i - 1];
                const b = polls[i];
                if (a.contextTime <= onset && b.contextTime > onset) {
                    const mediaAt =
                        a.mediaTime +
                        ((onset - a.contextTime) / (b.contextTime - a.contextTime)) * (b.mediaTime - a.mediaTime);
                    let beep = beepTimes[0];
                    for (const time of beepTimes) {
                        if (Math.abs(time - mediaAt) < Math.abs(beep - mediaAt)) {
                            beep = time;
                        }
                    }
                    offsets.push(((beep - mediaAt) / speed) * 1000);
                    break;
                }
            }
        }
        offsets.shift();
        if (offsets.length === 0) {
            return Number.NaN;
        }
        offsets.sort((x, y) => x - y);
        return offsets[Math.floor(offsets.length / 2)];
    }

    public async measure(speed: number): Promise<number> {
        const context = this._context;
        await this._loadWorkletModule();
        if (!this._wav) {
            this._wav = MediaLatencyProbe.createProbeWav(MediaLatencyProbe.SampleRate, this._lengthS, this._spacingS);
            this._url = URL.createObjectURL(new Blob([this._wav.bytes as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }));
        }
        const wav = this._wav;
        const limitMs = (this._lengthS / speed) * 1000 + MediaLatencyProbe.TimeLimitExtraMs;
        let expired = false;
        let expire: () => void = () => {};
        const limit = new Promise<void>(resolve => {
            expire = resolve;
        });
        const limitTimer = setTimeout(() => {
            expired = true;
            expire();
        }, limitMs);
        const element = new Audio(this._url);
        element.preload = 'auto';
        element.playbackRate = speed;
        let source: MediaElementAudioSourceNode | null = null;
        let tap: AudioWorkletNode | null = null;
        const onsets: number[] = [];
        const polls: ProbePoll[] = [];
        const lastBeep = wav.beepTimes[wav.beepTimes.length - 1];
        try {
            // iOS may never load a hidden <audio> outside a gesture: the time limit ends the wait
            await Promise.race([
                new Promise<void>(resolve => element.addEventListener('canplaythrough', () => resolve(), { once: true })),
                limit
            ]);
            if (expired) {
                throw new Error(`no result within ${Math.round(limitMs)} ms`);
            }
            source = context.createMediaElementSource(element);
            tap = new AudioWorkletNode(context, 'alphatab-probe-tap');
            tap.port.onmessage = (e: MessageEvent<IAlphaSynthWorkerMessage>) => {
                if (e.data.cmd === 'alphaSynth.probe.onset') {
                    onsets.push(e.data.frame / context.sampleRate);
                }
            };
            source.connect(tap);
            // connected so it is processed; it outputs silence (G-7)
            tap.connect(context.destination);
            // a refused play() rejects here (WebKit, outside a gesture)
            await Promise.race([element.play(), limit]);
            while (!expired && element.currentTime < lastBeep + 0.1 && !element.ended) {
                polls.push(new ProbePoll(element.currentTime, context.currentTime));
                await new Promise(resolve => setTimeout(resolve, MediaLatencyProbe._pollMs));
            }
            if (expired) {
                throw new Error(`no result within ${Math.round(limitMs)} ms`);
            }
        } finally {
            clearTimeout(limitTimer);
            element.pause();
            source?.disconnect();
            tap?.disconnect();
        }
        const latency = MediaLatencyProbe.latencyFromOnsets(onsets, polls, wav.beepTimes, speed);
        if (Number.isNaN(latency)) {
            // the media played, but its tap heard fewer than two beeps: a failure, not a measured 0 (Task 15)
            throw new Error('no beeps heard');
        }
        return latency;
    }
}
