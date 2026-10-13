/**
 * Drives the worklet processor registered by `AlphaSynthWebWorklet.init()` with a simulated AudioWorklet scope
 * (`registerProcessor`, `AudioWorkletProcessor`, `sampleRate`, `currentFrame`): media stamps, count-in end, hold and
 * request accounting (spec §5). The scope globals live at module level, which is safe because vitest isolates each
 * test file.
 * @target web
 */
import { describe, expect, it } from 'vitest';
import { AlphaSynthWebWorklet } from '@coderline/alphatab/platform/javascript/AlphaSynthAudioWorkletOutput';

type Msg = Record<string, any>;

class ProcPort {
    public posted: Msg[] = [];
    private readonly _listeners: ((e: { data: Msg }) => void)[] = [];
    public postMessage(m: Msg) {
        this.posted.push(m);
    }
    public addEventListener(_t: string, l: (e: { data: Msg }) => void) {
        this._listeners.push(l);
    }
    public removeEventListener() {}
    public start() {}
    public send(data: Msg) {
        for (const l of this._listeners) {
            l({ data });
        }
    }
    public of(cmd: string): Msg[] {
        return this.posted.filter(m => m.cmd === cmd);
    }
    public clear() {
        this.posted = [];
    }
}

const g = globalThis as any;
let processorClass: any;
g.registerProcessor = (_name: string, cls: any) => {
    processorClass = cls;
};
g.AudioWorkletProcessor = class {
    public readonly port = new ProcPort();
};
g.sampleRate = 48000;
g.currentFrame = 0;
AlphaSynthWebWorklet.init();

class Harness {
    public readonly proc: any;
    public readonly port: ProcPort;
    public frame: number;
    public constructor(startFrame: number) {
        this.proc = new processorClass({ processorOptions: { bufferTimeInMilliseconds: 500 } });
        this.port = this.proc.port;
        this.frame = startFrame;
        g.currentFrame = startFrame;
    }
    public send(data: Msg) {
        // a message handler runs between blocks: currentFrame is the next block's first frame
        g.currentFrame = this.frame;
        this.port.send(data);
    }
    public chunk(frames: number, mediaStart: number, mediaPerFrame: number, extra: Msg = {}) {
        this.send({
            cmd: 'alphaSynth.output.addSamples',
            samples: new Float32Array(frames * 2).fill(0.5),
            mediaStart,
            mediaPerFrame,
            countInEnd: false,
            countInFramesLeft: -1,
            ...extra
        });
    }
    public blocks(count: number): { left: Float32Array; right: Float32Array }[] {
        const outs: { left: Float32Array; right: Float32Array }[] = [];
        for (let i = 0; i < count; i++) {
            g.currentFrame = this.frame;
            const left = new Float32Array(128);
            const right = new Float32Array(128);
            expect(this.proc.process([], [[left, right]], {})).toBe(true);
            outs.push({ left, right });
            this.frame += 128;
            g.currentFrame = this.frame;
        }
        return outs;
    }
}

describe('processor harness', () => {
    it('stamps: about every 50 ms, the first frame of the block and its media time', () => {
        const h = new Harness(10000);
        for (let i = 0; i < 8; i++) {
            h.chunk(1024, 1000 + i * 1024 * 0.02, 0.02);
        }
        h.blocks(40);
        const stamps = h.port.of('alphaSynth.output.mediaTimestamp');
        expect(stamps.length).toBe(2);
        expect(stamps[0].frame).toBe(10000 + 18 * 128);
        expect(stamps[0].mediaTime).toBeCloseTo(1000 + 18 * 128 * 0.02, 6);
        expect(stamps[1].frame).toBe(10000 + 37 * 128);
        expect(stamps[1].mediaTime).toBeCloseTo(1000 + 37 * 128 * 0.02, 6);
    });

    it('stamps: a block across the count-in boundary is not stamped, the next one is', () => {
        const h = new Harness(0);
        h.chunk(2400, -1, 0); // count-in, not on the media axis
        h.chunk(6000, 5000, 0.5, { countInEnd: true });
        h.blocks(40);
        const stamps = h.port.of('alphaSynth.output.mediaTimestamp');
        // block 18 reads frames 2304..2432, across the boundary at 2400 -> no stamp
        // block 37 reads frames 4736..4864, all stamped
        expect(stamps.length).toBe(1);
        expect(stamps[0].frame).toBe(37 * 128);
        expect(stamps[0].mediaTime).toBeCloseTo(5000 + (4736 - 2400) * 0.5, 6);
    });

    it('stamps: a block cut short by an underrun is not stamped (consume() is true for a partial read)', () => {
        const h = new Harness(0);
        h.chunk(2340, 100, 0.02); // block 18 would read frames 2304..2432, only 36 are buffered
        h.blocks(19);
        expect(h.port.of('alphaSynth.output.mediaTimestamp').length).toBe(0);
        // control: with enough frames buffered it is stamped
        const c = new Harness(0);
        c.chunk(4000, 100, 0.02);
        c.blocks(19);
        expect(c.port.of('alphaSynth.output.mediaTimestamp').length).toBe(1);
    });

    it('count-in end: from the first count-in chunk, refined every ~50 ms, exact once the boundary is buffered', () => {
        const h = new Harness(5000);
        h.chunk(4000, -1, 0, { countInFramesLeft: 96000 });
        let ends = h.port.of('alphaSynth.output.countInEnd');
        expect(ends.length).toBe(1);
        expect(ends[0].frame).toBe(5000 + 96000);

        h.blocks(19); // reports at block 18, in process(): the next block starts after the current one
        ends = h.port.of('alphaSynth.output.countInEnd');
        expect(ends.length).toBe(2);
        expect(ends[1].frame).toBe(5000 + 96000); // no underrun: unchanged

        // a later count-in chunk (frames left counted from its own first frame): consistent
        h.chunk(4000, -1, 0, { countInFramesLeft: 92000 });
        ends = h.port.of('alphaSynth.output.countInEnd');
        expect(ends[ends.length - 1].frame).toBe(5000 + 96000);

        // the chunk that starts after the count-in is buffered: exact (frames until it)
        h.chunk(1000, 7000, 0.5, { countInEnd: true });
        ends = h.port.of('alphaSynth.output.countInEnd');
        // buffered before the boundary: (4000 - 2432) + 4000 = 5568; currentFrame is 5000 + 19 * 128
        expect(ends[ends.length - 1].frame).toBe(5000 + 19 * 128 + 5568);
    });

    it('count-in end: an underrun moves it (the next count-in chunk reports it later)', () => {
        const h = new Harness(0);
        h.chunk(2000, -1, 0, { countInFramesLeft: 96000 });
        expect(h.port.of('alphaSynth.output.countInEnd')[0].frame).toBe(96000);
        h.blocks(19); // 2432 frames pass, only 2000 were buffered: 432 silent frames
        h.chunk(2000, -1, 0, { countInFramesLeft: 94000 });
        const ends = h.port.of('alphaSynth.output.countInEnd');
        expect(ends[ends.length - 1].frame).toBe(2432 + 94000);
    });

    it('count-in end: exact when the boundary chunk is buffered right behind the count-in', () => {
        const h = new Harness(1000);
        h.chunk(3000, -1, 0, { countInFramesLeft: 3000 });
        h.chunk(3000, 7000, 0.5, { countInEnd: true });
        const ends = h.port.of('alphaSynth.output.countInEnd');
        expect(ends[ends.length - 1].frame).toBe(1000 + 3000);
        h.blocks(19);
        const after = h.port.of('alphaSynth.output.countInEnd');
        expect(after[after.length - 1].frame).toBe(1000 + 3000);
    });

    it('hold: silent, no requests, nothing played, incoming samples dropped; resume plays again', () => {
        const h = new Harness(0);
        h.chunk(4000, 100, 0.02);
        h.blocks(2);
        h.port.clear();

        h.send({ cmd: 'alphaSynth.output.hold' });
        const outs = h.blocks(5);
        for (const o of outs) {
            expect(Array.from(o.left).every(v => v === 0)).toBe(true);
            expect(Array.from(o.right).every(v => v === 0)).toBe(true);
        }
        expect(h.port.posted.length).toBe(0); // no samplesPlayed, no sampleRequest, no timestamps

        // samples arriving while held are dropped; the request accounting still floors at 0
        h.chunk(4000, 100, 0.02);
        h.chunk(4000, 100, 0.02);
        expect(h.proc._requestedBufferCount).toBe(0);
        expect(h.proc._circularBuffer.count).toBe(0);
        expect(h.proc._markers.bufferedFrames).toBe(0);

        h.send({ cmd: 'alphaSynth.output.resume' });
        h.blocks(1);
        expect(h.port.of('alphaSynth.output.samplesPlayed').length).toBe(1);
        expect(h.port.of('alphaSynth.output.samplesPlayed')[0].samples).toBe(0); // nothing buffered
        expect(h.port.of('alphaSynth.output.sampleRequest').length).toBeGreaterThan(0); // asks for more
    });

    it('request accounting never below 0 (finding F8): unrequested samples do not push it negative', () => {
        const h = new Harness(0);
        h.chunk(1024, 100, 0.02);
        h.chunk(1024, 100, 0.02);
        h.chunk(1024, 100, 0.02);
        expect(h.proc._requestedBufferCount).toBe(0);
        // 3072 frames = 6144 floats buffered (< half = 8192): asks for 2 buffers
        h.blocks(1);
        expect(h.port.of('alphaSynth.output.sampleRequest').length).toBe(2);
        expect(h.proc._requestedBufferCount).toBe(2);
        // 4 samples messages answer 2 requests: floor at 0, not -2
        h.chunk(1024, 100, 0.02);
        h.chunk(1024, 100, 0.02);
        h.chunk(1024, 100, 0.02);
        h.chunk(1024, 100, 0.02);
        expect(h.proc._requestedBufferCount).toBe(0);
    });

    it('reset clears the markers with the buffer', () => {
        const h = new Harness(0);
        h.chunk(4000, 100, 0.02);
        h.send({ cmd: 'alphaSynth.output.resetSamples' });
        expect(h.proc._circularBuffer.count).toBe(0);
        expect(h.proc._markers.bufferedFrames).toBe(0);
    });
});
