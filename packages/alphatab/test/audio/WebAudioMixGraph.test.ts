/**
 * The mixing graph's wiring and the limiter's values (F-13); the sound itself is checked with spike 8's script.
 * @target web
 */
import { describe, expect, it } from 'vitest';
import { WebAudioMixGraph } from '@coderline/alphatab/platform/javascript/WebAudioMixGraph';

class FakeParam {
    public value: number = 0;
}

class FakeNode {
    public readonly name: string;
    public readonly connections: FakeNode[] = [];
    public constructor(name: string) {
        this.name = name;
    }
    public connect(node: FakeNode): FakeNode {
        this.connections.push(node);
        return node;
    }
    public disconnect(): void {
        this.connections.length = 0;
    }
}

class FakeGain extends FakeNode {
    public readonly gain: FakeParam = new FakeParam();
    public constructor() {
        super('gain');
        this.gain.value = 1;
    }
}

class FakeCompressor extends FakeNode {
    public readonly threshold: FakeParam = new FakeParam();
    public readonly ratio: FakeParam = new FakeParam();
    public readonly knee: FakeParam = new FakeParam();
    public readonly attack: FakeParam = new FakeParam();
    public readonly release: FakeParam = new FakeParam();
    public constructor() {
        super('compressor');
    }
}

class FakeContext {
    public readonly destination: FakeNode = new FakeNode('destination');
    public sampleRate: number = 48000;
    public currentTime: number = 2;
    public baseLatency: number = 0.0053;
    public outputLatency: number = 0.02;
    public state: string = 'running';
    public mediaSources: number = 0;
    public outputTimestamp: { contextTime: number; performanceTime: number } | undefined = undefined;
    private _listeners: (() => void)[] = [];
    public createGain(): FakeGain {
        return new FakeGain();
    }
    public createDynamicsCompressor(): FakeCompressor {
        return new FakeCompressor();
    }
    public createMediaElementSource(_element: unknown): FakeNode {
        this.mediaSources++;
        return new FakeNode('media');
    }
    public getOutputTimestamp(): { contextTime?: number; performanceTime?: number } {
        return this.outputTimestamp ?? {};
    }
    public addEventListener(_type: string, listener: () => void): void {
        this._listeners.push(listener);
    }
    public removeEventListener(_type: string, listener: () => void): void {
        this._listeners = this._listeners.filter(l => l !== listener);
    }
    public setState(state: string): void {
        this.state = state;
        for (const listener of [...this._listeners]) {
            listener();
        }
    }
}

function create(): { context: FakeContext; graph: WebAudioMixGraph } {
    const context = new FakeContext();
    return { context, graph: new WebAudioMixGraph(context as unknown as AudioContext) };
}

describe('WebAudioMixGraphTests', () => {
    it('limiter-holds-the-spike-8-values', () => {
        const { graph } = create();
        const limiter = graph.limiterNode as unknown as FakeCompressor;
        expect(limiter.threshold.value).toBe(-1);
        expect(limiter.ratio.value).toBe(20);
        expect(limiter.knee.value).toBe(0);
        expect(limiter.attack.value).toBe(0.001);
        expect(limiter.release.value).toBe(0.1);
        expect((graph.trimNode as unknown as FakeGain).gain.value).toBeCloseTo(Math.pow(10, -0.57 / 20), 12);
    });

    it('wires-media-and-synth-through-master-limiter-and-trim', () => {
        const { context, graph } = create();
        const node = (n: unknown) => n as FakeNode;
        expect(node(graph.mediaGainNode).connections).toEqual([graph.masterGainNode]);
        expect(node(graph.synthGainNode).connections).toEqual([graph.masterGainNode]);
        expect(node(graph.masterGainNode).connections).toEqual([graph.limiterNode]);
        expect(node(graph.limiterNode).connections).toEqual([graph.trimNode]);
        expect(node(graph.trimNode).connections).toEqual([context.destination]);
        expect(graph.synthInput).toBe(graph.synthGainNode);
    });

    it('routes-a-media-element-once', () => {
        // createMediaElementSource works once per element (§13)
        const { context, graph } = create();
        const element = {} as HTMLMediaElement;
        graph.connectMediaElement(element);
        graph.connectMediaElement(element);
        expect(context.mediaSources).toBe(1);
        expect((graph.mediaSourceNode as unknown as FakeNode).connections).toEqual([graph.mediaGainNode]);
    });

    it('gains-and-context-values', () => {
        const { graph } = create();
        graph.masterGain = 0.8;
        graph.mediaGain = 0.35;
        graph.synthGain = 2;
        expect((graph.masterGainNode as unknown as FakeGain).gain.value).toBe(0.8);
        expect(graph.mediaGain).toBe(0.35);
        expect(graph.synthGain).toBe(2);
        expect(graph.baseLatencyMs).toBeCloseTo(5.3, 9);
        expect(graph.sampleRate).toBe(48000);
        expect(graph.currentTime).toBe(2);
    });

    it('heard-context-time-uses-the-output-timestamp-else-the-output-latency', () => {
        const { context, graph } = create();
        expect(graph.heardContextTime()).toBeCloseTo(2 - 0.02, 9);
        context.outputTimestamp = { contextTime: 1.9, performanceTime: performance.now() };
        expect(graph.heardContextTime()).toBeCloseTo(1.9, 1);
    });

    it('when-running-waits-for-the-context', () => {
        const { context, graph } = create();
        context.state = 'suspended';
        let ran = 0;
        graph.whenRunning(() => ran++);
        expect(graph.isRunning).toBe(false);
        expect(ran).toBe(0);
        context.setState('running');
        expect(ran).toBe(1);
        graph.whenRunning(() => ran++);
        expect(ran).toBe(2);
    });
});
