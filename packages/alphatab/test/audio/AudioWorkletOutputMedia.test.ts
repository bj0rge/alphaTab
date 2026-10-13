/**
 * The AudioWorklet output while mixing with media: keep-alive, destination, stamps, failures (spec §5).
 * Web Audio is faked: these tests check the output's own logic, the sync lab checks the real audio.
 * @target web
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AlphaSynthAudioWorkletOutput } from '@coderline/alphatab/platform/javascript/AlphaSynthAudioWorkletOutput';
import { BrowserUiFacade } from '@coderline/alphatab/platform/javascript/BrowserUiFacade';
import type { MediaTimestampEventArgs } from '@coderline/alphatab/platform/javascript/MediaSynthTypes';
import { Settings } from '@coderline/alphatab/Settings';
import { MediaSampleChunk } from '@coderline/alphatab/synth/MediaSampleOutput';

class FakePort {
    public readonly posted: { cmd: string }[] = [];
    private readonly _listeners: ((e: MessageEvent) => void)[] = [];
    public postMessage(message: { cmd: string }): void {
        this.posted.push(message);
    }
    public addEventListener(_type: string, listener: (e: MessageEvent) => void): void {
        this._listeners.push(listener);
    }
    public removeEventListener(_type: string, listener: (e: MessageEvent) => void): void {
        const index = this._listeners.indexOf(listener);
        if (index >= 0) {
            this._listeners.splice(index, 1);
        }
    }
    public start(): void {}
    public emit(data: unknown): void {
        for (const listener of [...this._listeners]) {
            listener({ data } as MessageEvent);
        }
    }
    public commands(): string[] {
        return this.posted.map(m => m.cmd);
    }
}

class FakeWorkletNode {
    public static created: FakeWorkletNode[] = [];
    public readonly port: FakePort = new FakePort();
    public readonly connectedTo: unknown[] = [];
    public disconnected: boolean = false;
    public constructor(_context: unknown, _name: string, _options: unknown) {
        FakeWorkletNode.created.push(this);
    }
    public connect(node: unknown): void {
        this.connectedTo.push(node);
    }
    public disconnect(): void {
        this.disconnected = true;
    }
}

class FakeAudioContext {
    public state: string = 'running';
    public sampleRate: number = 48000;
    public currentTime: number = 0;
    public readonly destination = { name: 'destination' };
    public createBuffer(): unknown {
        return {};
    }
    public createBufferSource(): unknown {
        return { buffer: null, loop: false, start() {}, stop() {}, connect() {}, disconnect() {} };
    }
    public resume(): Promise<void> {
        return Promise.resolve();
    }
    public close(): Promise<void> {
        return Promise.resolve();
    }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const globals = globalThis as unknown as Record<string, unknown>;

function setGlobal(name: string, value: unknown) {
    if (value === undefined) {
        delete globals[name];
    } else {
        globals[name] = value;
    }
}

describe('AudioWorkletOutputMediaTests', () => {
    let savedContext: unknown;
    let savedNode: unknown;
    let savedLoad: typeof BrowserUiFacade.createAlphaSynthAudioWorklet;

    beforeEach(() => {
        savedContext = globals.AudioContext;
        savedNode = globals.AudioWorkletNode;
        savedLoad = BrowserUiFacade.createAlphaSynthAudioWorklet;
        setGlobal('AudioContext', FakeAudioContext);
        setGlobal('AudioWorkletNode', FakeWorkletNode);
        BrowserUiFacade.createAlphaSynthAudioWorklet = () => Promise.resolve();
        FakeWorkletNode.created = [];
    });

    afterEach(() => {
        setGlobal('AudioContext', savedContext);
        setGlobal('AudioWorkletNode', savedNode);
        BrowserUiFacade.createAlphaSynthAudioWorklet = savedLoad;
    });

    function openOutput(): AlphaSynthAudioWorkletOutput {
        const output = new AlphaSynthAudioWorkletOutput(new Settings());
        output.open(500);
        return output;
    }

    it('keep-alive-holds-and-resumes-one-node', async () => {
        const output = openOutput();
        output.keepAlive = true;
        output.warmUp();
        await flush();
        expect(FakeWorkletNode.created.length).toBe(1);
        const port = FakeWorkletNode.created[0].port;

        output.play();
        await flush();
        output.pause();
        await flush();
        output.play();
        await flush();

        expect(FakeWorkletNode.created.length).toBe(1);
        expect(port.commands()).toEqual([
            'alphaSynth.output.hold',
            'alphaSynth.output.resume',
            'alphaSynth.output.hold',
            'alphaSynth.output.resume'
        ]);
    });

    it('without-keep-alive-pause-tears-the-node-down-as-today', async () => {
        const output = openOutput();
        output.play();
        await flush();
        output.pause();
        await flush();
        expect(FakeWorkletNode.created[0].disconnected).toBe(true);
        expect(FakeWorkletNode.created[0].port.commands()).toContain('alphaSynth.output.stop');
        output.play();
        await flush();
        expect(FakeWorkletNode.created.length).toBe(2);
    });

    it('connects-to-the-destination-node', async () => {
        const output = openOutput();
        const synthGain = { name: 'synthGain' } as unknown as AudioNode;
        output.destinationNode = synthGain;
        output.keepAlive = true;
        output.warmUp();
        await flush();
        expect(FakeWorkletNode.created[0].connectedTo).toEqual([synthGain]);
        expect(output.workletNode).toBe(FakeWorkletNode.created[0]);
    });

    it('worklet-messages-become-events', async () => {
        const output = openOutput();
        output.keepAlive = true;
        output.warmUp();
        await flush();
        const stamps: MediaTimestampEventArgs[] = [];
        const ends: number[] = [];
        output.mediaTimestamp.on(e => stamps.push(e));
        output.countInEnd.on(f => ends.push(f));
        const port = FakeWorkletNode.created[0].port;
        port.emit({ cmd: 'alphaSynth.output.mediaTimestamp', frame: 4800, mediaTime: 1234.5 });
        port.emit({ cmd: 'alphaSynth.output.countInEnd', frame: 96000 });
        expect(stamps.map(s => [s.frame, s.mediaTime])).toEqual([[4800, 1234.5]]);
        expect(ends).toEqual([96000]);
    });

    it('stamped-samples-carry-their-media-time', async () => {
        const output = openOutput();
        output.play();
        await flush();
        const chunk = new MediaSampleChunk();
        chunk.mediaStart = 100;
        chunk.mediaPerFrame = 0.02;
        output.addMediaSamples(new Float32Array(8), chunk);
        const posted = FakeWorkletNode.created[0].port.posted;
        expect(posted[posted.length - 1]).toMatchObject({
            cmd: 'alphaSynth.output.addSamples',
            mediaStart: 100,
            mediaPerFrame: 0.02,
            countInEnd: false
        });
    });

    it('a-failed-module-load-raises-worklet-failed', async () => {
        BrowserUiFacade.createAlphaSynthAudioWorklet = () => Promise.reject(new Error('worklet module 404'));
        const output = openOutput();
        const errors: Error[] = [];
        output.workletFailed.on(e => errors.push(e));
        output.play();
        await flush();
        expect(errors.length).toBe(1);
        expect(errors[0].message).toContain('404');
    });

    it('a-throwing-worklet-failed-listener-does-not-wedge-the-operations', async () => {
        let loadFails = true;
        BrowserUiFacade.createAlphaSynthAudioWorklet = () =>
            loadFails ? Promise.reject(new Error('worklet module 404')) : Promise.resolve();
        const output = openOutput();
        let raised = 0;
        output.workletFailed.on(() => {
            raised++;
            throw new Error('listener bug');
        });
        output.play();
        await flush();
        expect(raised).toBe(1);
        expect(FakeWorkletNode.created.length).toBe(0);

        // the next play loads fine: the queue must still run its operations
        loadFails = false;
        output.play();
        await flush();
        expect(FakeWorkletNode.created.length).toBe(1);
        expect(raised).toBe(1);
    });
});
