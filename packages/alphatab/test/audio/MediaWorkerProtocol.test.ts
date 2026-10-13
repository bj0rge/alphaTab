/**
 * The worker protocol for following a media clock (spec §5).
 * @target web
 */
import { describe, expect, it } from 'vitest';
import { ScoreLoader } from '@coderline/alphatab/importer/ScoreLoader';
import { LogLevel } from '@coderline/alphatab/LogLevel';
import { AlphaSynthMidiFileHandler } from '@coderline/alphatab/midi/AlphaSynthMidiFileHandler';
import { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { MidiFileGenerator } from '@coderline/alphatab/midi/MidiFileGenerator';
import { JsonConverter } from '@coderline/alphatab/model/JsonConverter';
import type {
    IAlphaSynthWorker,
    IAlphaSynthWorkerMessage,
    IAlphaTabWorkerGlobalScope
} from '@coderline/alphatab/platform/worker/AlphaTabWorkerProtocol';
import { AlphaSynthWebWorker } from '@coderline/alphatab/platform/worker/AlphaSynthWebWorker';
import { AlphaSynthWebWorkerApi } from '@coderline/alphatab/platform/worker/AlphaSynthWebWorkerApi';
import { Settings } from '@coderline/alphatab/Settings';
import type { IMediaSampleOutput, MediaSampleChunk } from '@coderline/alphatab/synth/MediaSampleOutput';
import { TestOutput } from 'test/audio/TestOutput';

class FakeWorkerScope implements IAlphaTabWorkerGlobalScope<IAlphaSynthWorkerMessage> {
    public readonly posted: IAlphaSynthWorkerMessage[] = [];
    private readonly _handlers: ((ev: MessageEvent<IAlphaSynthWorkerMessage>) => void)[] = [];

    public postMessage(message: IAlphaSynthWorkerMessage): void {
        this.posted.push(message);
    }
    public addEventListener(_event: 'message', handler: (ev: MessageEvent<IAlphaSynthWorkerMessage>) => void): void {
        this._handlers.push(handler);
    }
    public removeEventListener(): void {}
    public send(message: IAlphaSynthWorkerMessage): void {
        for (const handler of [...this._handlers]) {
            handler({ data: message } as MessageEvent<IAlphaSynthWorkerMessage>);
        }
    }
    public last(cmd: string): IAlphaSynthWorkerMessage | undefined {
        return [...this.posted].reverse().find(m => m.cmd === cmd);
    }
}

class FakeSynthWorker implements IAlphaSynthWorker {
    public readonly posted: IAlphaSynthWorkerMessage[] = [];
    private readonly _errorHandlers: ((ev: ErrorEvent) => void)[] = [];

    public postMessage(message: IAlphaSynthWorkerMessage): void {
        this.posted.push(message);
    }
    public addEventListener(event: 'message' | 'error', handler: (ev: never) => void): void {
        if (event === 'error') {
            this._errorHandlers.push(handler as (ev: ErrorEvent) => void);
        }
    }
    public removeEventListener(): void {}
    public terminate(): void {}
    public fail(message: string): void {
        for (const handler of this._errorHandlers) {
            handler({ message } as ErrorEvent);
        }
    }
}

class RecordingMediaOutput implements IMediaSampleOutput {
    public readonly chunks: MediaSampleChunk[] = [];
    public addMediaSamples(_samples: Float32Array, chunk: MediaSampleChunk): void {
        this.chunks.push(chunk);
    }
}

function texMidi(): MidiFile {
    const score = ScoreLoader.loadAlphaTex(`
        \\tempo 120
        .
        C4 * 4 | C4 * 4
    `);
    const midi = new MidiFile();
    new MidiFileGenerator(score, new Settings(), new AlphaSynthMidiFileHandler(midi)).generate();
    return midi;
}

function startWorker(): FakeWorkerScope {
    const scope = new FakeWorkerScope();
    new AlphaSynthWebWorker(scope);
    scope.send({
        cmd: 'alphaSynth.initialize',
        sampleRate: 44100,
        logLevel: LogLevel.None,
        bufferTimeInMilliseconds: 500
    });
    scope.send({ cmd: 'alphaSynth.loadMidi', midi: JsonConverter.midiFileToJsObject(texMidi()) });
    return scope;
}

describe('MediaWorkerProtocolTests', () => {
    it('worker-renders-stamped-chunks-while-following', () => {
        const scope = startWorker();
        scope.send({ cmd: 'alphaSynth.followMedia', enabled: true, mediaDuration: 10000, syncPoints: [] });
        scope.send({ cmd: 'alphaSynth.seekToMediaTime', mediaTime: 1000 });
        scope.send({ cmd: 'alphaSynth.setRateCorrection', factor: 1.01 });
        scope.send({ cmd: 'alphaSynth.play' });
        scope.send({ cmd: 'alphaSynth.output.sampleRequest' });

        const added = scope.last('alphaSynth.output.addSamples') as { mediaStart?: number; mediaPerFrame?: number };
        expect(added.mediaStart).toBe(1000);
        expect(added.mediaPerFrame).toBeCloseTo((1000 / 44100) * 1.01, 12);
    });

    it('worker-posts-count-in-started', () => {
        const scope = startWorker();
        scope.send({ cmd: 'alphaSynth.followMedia', enabled: true, mediaDuration: 10000, syncPoints: [] });
        scope.send({ cmd: 'alphaSynth.seekToMediaTime', mediaTime: 1000 });
        scope.send({ cmd: 'alphaSynth.setCountInVolume', value: 1 });
        scope.send({ cmd: 'alphaSynth.play' });

        const started = scope.last('alphaSynth.countInStarted') as { lengthMs: number };
        expect(started.lengthMs).toBeCloseTo(4 * 500, 6); // one bar of 4/4 at 120 BPM
        scope.send({ cmd: 'alphaSynth.output.sampleRequest' });
        const added = scope.last('alphaSynth.output.addSamples') as {
            mediaStart?: number;
            countInEnd?: boolean;
            countInFramesLeft?: number;
        };
        expect(added.mediaStart).toBe(-1); // count-in samples are not on the media's axis
        expect(added.countInFramesLeft).toBeGreaterThan(0); // and say how long the count-in still lasts

        // the count-in ends in the same stream: the next chunk is the song's first, and it says so
        let handOff = added;
        for (let i = 0; i < 100 && handOff.mediaStart === -1; i++) {
            scope.send({ cmd: 'alphaSynth.output.sampleRequest' });
            handOff = scope.last('alphaSynth.output.addSamples') as typeof added;
        }
        expect(handOff.mediaStart).toBe(1000);
        expect(handOff.countInEnd).toBe(true);
    });

    it('main-side-sends-the-follow-commands', () => {
        const worker = new FakeSynthWorker();
        const api = new AlphaSynthWebWorkerApi(new TestOutput(), new Settings(), worker);
        api.followMedia(true, 42000, []);
        api.seekToMediaTime(500);
        api.setRateCorrection(0.99);
        expect(worker.posted.slice(-3)).toEqual([
            { cmd: 'alphaSynth.followMedia', enabled: true, mediaDuration: 42000, syncPoints: [] },
            { cmd: 'alphaSynth.seekToMediaTime', mediaTime: 500 },
            { cmd: 'alphaSynth.setRateCorrection', factor: 0.99 }
        ]);
    });

    it('main-side-routes-stamped-samples-to-the-media-output', () => {
        const output = new TestOutput();
        const api = new AlphaSynthWebWorkerApi(output, new Settings(), new FakeSynthWorker());
        const media = new RecordingMediaOutput();
        api.mediaSampleOutput = media;

        api.handleWorkerMessage({
            data: {
                cmd: 'alphaSynth.output.addSamples',
                samples: new Float32Array(4),
                mediaStart: 250,
                mediaPerFrame: 0.5,
                countInEnd: true,
                countInFramesLeft: 128
            }
        } as MessageEvent<IAlphaSynthWorkerMessage>);
        expect(media.chunks.length).toBe(1);
        expect(media.chunks[0].mediaStart).toBe(250);
        expect(media.chunks[0].mediaPerFrame).toBe(0.5);
        expect(media.chunks[0].countInEnd).toBe(true);
        expect(media.chunks[0].countInFramesLeft).toBe(128);
        expect(output.sampleCount).toBe(0);

        api.handleWorkerMessage({
            data: { cmd: 'alphaSynth.output.addSamples', samples: new Float32Array(4) }
        } as MessageEvent<IAlphaSynthWorkerMessage>);
        expect(output.sampleCount).toBe(4);
    });

    it('count-in-started-reaches-the-main-side', () => {
        const api = new AlphaSynthWebWorkerApi(new TestOutput(), new Settings(), new FakeSynthWorker());
        const lengths: number[] = [];
        api.countInStarted.on(l => lengths.push(l));
        api.handleWorkerMessage({
            data: { cmd: 'alphaSynth.countInStarted', lengthMs: 1800 }
        } as MessageEvent<IAlphaSynthWorkerMessage>);
        expect(lengths).toEqual([1800]);
    });

    it('a-worker-that-fails-raises-worker-failed', () => {
        const worker = new FakeSynthWorker();
        const api = new AlphaSynthWebWorkerApi(new TestOutput(), new Settings(), worker);
        const errors: Error[] = [];
        api.workerFailed.on(e => errors.push(e));
        worker.fail('alphaTab.worker.mjs: 404');
        expect(errors.length).toBe(1);
        expect(errors[0].message).toContain('404');
    });
});
