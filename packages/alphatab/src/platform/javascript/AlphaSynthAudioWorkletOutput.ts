import { Environment } from '@coderline/alphatab/Environment';
import { EventEmitterOfT, type IEventEmitterOfT } from '@coderline/alphatab/EventEmitter';
import { Logger } from '@coderline/alphatab/Logger';
import type { Settings } from '@coderline/alphatab/Settings';
import { AlphaSynthWebAudioOutputBase } from '@coderline/alphatab/platform/javascript/AlphaSynthWebAudioOutputBase';
import { BrowserUiFacade } from '@coderline/alphatab/platform/javascript/BrowserUiFacade';
import { MediaChunkMarkers } from '@coderline/alphatab/platform/javascript/MediaChunkMarkers';
import {
    type IMediaFollowingOutput,
    MediaTimestampEventArgs
} from '@coderline/alphatab/platform/javascript/MediaSynthTypes';
import type {
    IAlphaSynthWorkerMessage,
    IAlphaTabWorker
} from '@coderline/alphatab/platform/worker/AlphaTabWorkerProtocol';
import type { MediaSampleChunk } from '@coderline/alphatab/synth/MediaSampleOutput';
import { SynthConstants } from '@coderline/alphatab/synth/SynthConstants';
import { CircularSampleBuffer } from '@coderline/alphatab/synth/ds/CircularSampleBuffer';

/**
 * @target web
 * @internal
 */
type AudioWorkletProcessorMessagePort<T> = Omit<IAlphaTabWorker<T>, 'terminate'> & Pick<MessagePort, 'start'>;

/**
 * @target web
 * @internal
 */
interface AudioWorkletProcessor {
    readonly port: AudioWorkletProcessorMessagePort<IAlphaSynthWorkerMessage>;
    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

/**
 * @target web
 * @internal
 */
declare let AudioWorkletProcessor: {
    prototype: AudioWorkletProcessor;
    new (options?: AudioWorkletNodeOptions): AudioWorkletProcessor;
};

/**
 * @target web
 * @internal
 */
interface AudioWorkletNode<T> extends AudioNode {
    readonly port: AudioWorkletProcessorMessagePort<T>;
}

// Bug 646: Safari 14.1 is buggy regarding audio worklets
// globalThis cannot be used to access registerProcessor or samplerate
// we need to really use them as globals
/**
 * @target web
 * @internal
 */
declare let registerProcessor: any;
/**
 * @target web
 * @internal
 */
declare let sampleRate: number;
/**
 * @target web
 * @internal
 */
declare let currentFrame: number;

/**
 * This class implements a HTML5 Web Audio API based audio output device
 * for alphaSynth using the modern Audio Worklets.
 * @target web
 * @internal
 */
export class AlphaSynthWebWorklet {
    /**
     * The latency probe's tap: a sample above this starts a beep (spec §6.4).
     */
    public static readonly ProbeTapThreshold: number = 0.25;
    /**
     * Frames to wait after an onset (50 ms at 48 kHz): one onset per beep, also at 2×.
     */
    public static readonly ProbeTapCooldownFrames: number = 2400;

    private static _isRegistered = false;
    public static init() {
        if (AlphaSynthWebWorklet._isRegistered) {
            return;
        }
        AlphaSynthWebWorklet._isRegistered = true;
        registerProcessor(
            'alphatab',
            class AlphaSynthWebWorkletProcessor extends AudioWorkletProcessor {
                public static readonly BufferSize: number = 4096;

                private _outputBuffer: Float32Array = new Float32Array(0);
                private _circularBuffer!: CircularSampleBuffer;
                private _bufferCount: number = 0;
                private _requestedBufferCount: number = 0;
                private _isStopped = false;
                private _markers: MediaChunkMarkers = new MediaChunkMarkers();
                private _framesSinceReport: number = 0;
                private _isHeld: boolean = false;
                // one stereo output per bus: a frame holds a stereo pair per bus ([b0L b0R b1L b1R ...])
                private _busCount: number = 1;
                private _frameStride: number = SynthConstants.AudioChannels;

                constructor(options: AudioWorkletNodeOptions) {
                    super(options);

                    this._busCount = Math.max(1, options.processorOptions.busCount ?? 1);
                    this._frameStride = SynthConstants.AudioChannels * this._busCount;

                    Logger.debug('WebAudio', 'creating processor');

                    this._bufferCount = Math.floor(
                        (options.processorOptions.bufferTimeInMilliseconds * sampleRate) /
                            1000 /
                            AlphaSynthWebWorkletProcessor.BufferSize
                    );
                    // a multiple of the frame stride: a truncated write never splits a frame
                    this._circularBuffer = new CircularSampleBuffer(
                        AlphaSynthWebWorkletProcessor.BufferSize * this._bufferCount * this._busCount
                    );

                    this.port.addEventListener('message', e => this._handleMessage(e));
                    this.port.start();
                }

                private _handleMessage(e: MessageEvent<IAlphaSynthWorkerMessage>) {
                    const data = e.data;
                    const cmd = data.cmd;
                    switch (cmd) {
                        case 'alphaSynth.output.addSamples': {
                            // never below 0: a negative count over-requests forever, the overflow is dropped
                            // and the synth runs fast (spike finding F8)
                            this._requestedBufferCount = Math.max(0, this._requestedBufferCount - 1);
                            if (this._isHeld) {
                                break;
                            }
                            const f: Float32Array = data.samples;
                            const written = this._circularBuffer.write(f, 0, f.length);
                            this._markers.push(
                                written / this._frameStride,
                                data.mediaStart ?? -1,
                                data.mediaPerFrame ?? 0,
                                data.countInEnd === true,
                                data.countInFramesLeft ?? -1
                            );
                            if (data.countInEnd === true || (data.countInFramesLeft ?? -1) >= 0) {
                                // a count-in chunk already tells where the count-in ends, about a bar ahead;
                                // between blocks currentFrame is the next block's first frame
                                this._reportCountInEnd(currentFrame);
                            }
                            break;
                        }
                        case 'alphaSynth.output.resetSamples':
                            this._circularBuffer.clear();
                            this._markers.clear();
                            break;
                        case 'alphaSynth.output.stop':
                            this._isStopped = true;
                            break;
                        case 'alphaSynth.output.hold':
                            // kept alive while paused (mixing mode): silent, no requests
                            this._isHeld = true;
                            this._circularBuffer.clear();
                            this._markers.clear();
                            break;
                        case 'alphaSynth.output.resume':
                            this._isHeld = false;
                            break;
                    }
                }

                public override process(
                    _inputs: Float32Array[][],
                    outputs: Float32Array[][],
                    _parameters: Record<string, Float32Array>
                ): boolean {
                    if (outputs.length < this._busCount) {
                        return true;
                    }

                    const left: Float32Array = outputs[0][0];
                    const right: Float32Array = outputs[0][1];

                    if (!left || !right) {
                        return true;
                    }

                    if (this._isHeld) {
                        for (const output of outputs) {
                            for (const channel of output) {
                                channel.fill(0);
                            }
                        }
                        return true;
                    }

                    if (this._busCount > 1) {
                        return this._processBuses(outputs, left.length);
                    }

                    const samples: number = left.length + right.length;
                    let buffer = this._outputBuffer;
                    if (buffer.length !== samples) {
                        buffer = new Float32Array(samples);
                        this._outputBuffer = buffer;
                    }
                    const mediaTime = this._markers.mediaTimeAtReadPosition();
                    const samplesFromBuffer = this._circularBuffer.read(
                        buffer,
                        0,
                        Math.min(buffer.length, this._circularBuffer.count)
                    );
                    const frames = samplesFromBuffer / SynthConstants.AudioChannels;
                    const blockStamped = this._markers.consume(frames) && frames === left.length;
                    let s: number = 0;
                    const min = Math.min(left.length, samplesFromBuffer);
                    for (let i: number = 0; i < min; i++) {
                        left[i] = buffer[s++];
                        right[i] = buffer[s++];
                    }

                    if (samplesFromBuffer < left.length) {
                        for (let i = samplesFromBuffer; i < left.length; i++) {
                            left[i] = 0;
                            right[i] = 0;
                        }
                    }

                    this.port.postMessage({
                        cmd: 'alphaSynth.output.samplesPlayed',
                        samples: samplesFromBuffer / SynthConstants.AudioChannels
                    });
                    this._reportMediaTime(mediaTime, blockStamped, left.length);
                    this._requestBuffers();

                    return this._circularBuffer.count > 0 || !this._isStopped;
                }

                private _processBuses(outputs: Float32Array[][], blockFrames: number): boolean {
                    const stride = this._frameStride;
                    const samples: number = blockFrames * stride;
                    let buffer = this._outputBuffer;
                    if (buffer.length !== samples) {
                        buffer = new Float32Array(samples);
                        this._outputBuffer = buffer;
                    }
                    const mediaTime = this._markers.mediaTimeAtReadPosition();
                    const samplesFromBuffer = this._circularBuffer.read(
                        buffer,
                        0,
                        Math.min(buffer.length, this._circularBuffer.count)
                    );
                    const frames = samplesFromBuffer / stride;
                    const blockStamped = this._markers.consume(frames) && frames === blockFrames;
                    for (let b = 0; b < this._busCount; b++) {
                        const left = outputs[b][0];
                        const right = outputs[b][1];
                        if (!left || !right) {
                            continue;
                        }
                        let s = b * SynthConstants.AudioChannels;
                        for (let i = 0; i < frames; i++) {
                            left[i] = buffer[s];
                            right[i] = buffer[s + 1];
                            s += stride;
                        }
                        // an underrun: silence on every bus
                        left.fill(0, frames);
                        right.fill(0, frames);
                    }

                    this.port.postMessage({
                        cmd: 'alphaSynth.output.samplesPlayed',
                        samples: frames
                    });
                    this._reportMediaTime(mediaTime, blockStamped, blockFrames);
                    this._requestBuffers();

                    return this._circularBuffer.count > 0 || !this._isStopped;
                }

                private _reportMediaTime(mediaTime: number, blockStamped: boolean, blockFrames: number): void {
                    // about every 50 ms: "at this context frame I output this media time" (spec §5)
                    this._framesSinceReport += blockFrames;
                    if (this._framesSinceReport < sampleRate / 20) {
                        return;
                    }
                    this._framesSinceReport = 0;
                    if (mediaTime >= 0 && blockStamped) {
                        this.port.postMessage({
                            cmd: 'alphaSynth.output.mediaTimestamp',
                            frame: currentFrame,
                            mediaTime: mediaTime
                        });
                    }
                    // refine the count-in end while it is still buffered (an underrun moves it);
                    // in process() the next block starts after this one
                    this._reportCountInEnd(currentFrame + blockFrames);
                }

                private _reportCountInEnd(nextBlockFrame: number): void {
                    const frames = this._markers.framesUntilCountInEnd();
                    if (frames >= 0) {
                        this.port.postMessage({ cmd: 'alphaSynth.output.countInEnd', frame: nextBlockFrame + frames });
                    }
                }

                private _requestBuffers(): void {
                    // if we fall under the half of buffers
                    // we request one half
                    const halfBufferCount = (this._bufferCount / 2) | 0;
                    // a chunk of the synthesizer holds BufferSize values per bus
                    const chunkSamples: number = AlphaSynthWebWorkletProcessor.BufferSize * this._busCount;
                    const halfSamples: number = halfBufferCount * chunkSamples;
                    // Issue #631: it can happen that requestBuffers is called multiple times
                    // before we already get samples via addSamples, therefore we need to
                    // remember how many buffers have been requested, and consider them as available.
                    const bufferedSamples =
                        this._circularBuffer.count +
                        this._requestedBufferCount * chunkSamples;
                    if (bufferedSamples < halfSamples) {
                        for (let i: number = 0; i < halfBufferCount; i++) {
                            this.port.postMessage({
                                cmd: 'alphaSynth.output.sampleRequest'
                            });
                        }
                        this._requestedBufferCount += halfBufferCount;
                    }
                }
            }
        );

        registerProcessor(
            'alphatab-probe-tap',
            class AlphaSynthProbeTapProcessor extends AudioWorkletProcessor {
                private _cooldown: number = 0;

                public override process(
                    inputs: Float32Array[][],
                    _outputs: Float32Array[][],
                    _parameters: Record<string, Float32Array>
                ): boolean {
                    const channel = inputs.length > 0 && inputs[0].length > 0 ? inputs[0][0] : undefined;
                    if (channel) {
                        for (let i = 0; i < channel.length; i++) {
                            if (this._cooldown > 0) {
                                this._cooldown--;
                                continue;
                            }
                            if (Math.abs(channel[i]) > AlphaSynthWebWorklet.ProbeTapThreshold) {
                                this.port.postMessage({ cmd: 'alphaSynth.probe.onset', frame: currentFrame + i });
                                this._cooldown = AlphaSynthWebWorklet.ProbeTapCooldownFrames;
                            }
                        }
                    }
                    // the outputs stay zero: the tap is connected so it is processed, and is never heard (G-7)
                    return true;
                }
            }
        );
    }
}

/**
 * This class implements a HTML5 Web Audio API based audio output device
 * for alphaSynth. It can be controlled via a JS API.
 * @target web
 * @internal
 */
export class AlphaSynthAudioWorkletOutput extends AlphaSynthWebAudioOutputBase implements IMediaFollowingOutput {
    private _worklet: AudioWorkletNode<IAlphaSynthWorkerMessage> | null = null;
    private _isWarm: boolean = false;

    /**
     * Keep the worklet between plays (mixing mode): pause holds it silently, play resumes it.
     * @internal
     */
    public keepAlive: boolean = false;

    /**
     * Where the worklet's output goes (mixing mode: the synth's gain); the context's destination when null.
     * @internal
     */
    public destinationNode: AudioNode | null = null;

    /**
     * The stereo buses the worklet plays (`player.synthOutputBusCount`, 1..8): the worker must render as many.
     * @internal
     */
    public readonly outputBusCount: number;

    private _busNodes: GainNode[] | null = null;
    private _busReturnNode: GainNode | null = null;

    /**
     * One node per bus, connected to {@link busReturnNode} by default (null with a single bus or before open):
     * an app disconnects one and routes it through its own nodes back into {@link busReturnNode}.
     * They outlive the worklet, which is created again on play.
     * @internal
     */
    public get busNodes(): GainNode[] | null {
        return this._busNodes;
    }

    /**
     * Where the buses meet again, connected to {@link destinationNode} (or the context's destination).
     * @internal
     */
    public get busReturnNode(): GainNode | null {
        return this._busReturnNode;
    }

    /** @internal */
    public readonly mediaTimestamp: IEventEmitterOfT<MediaTimestampEventArgs> =
        new EventEmitterOfT<MediaTimestampEventArgs>();
    /** @internal */
    public readonly countInEnd: IEventEmitterOfT<number> = new EventEmitterOfT<number>();
    /** @internal */
    public readonly workletFailed: IEventEmitterOfT<Error> = new EventEmitterOfT<Error>();

    /** @internal */
    public get workletNode(): AudioNode | null {
        return this._worklet;
    }

    /**
     * The AudioContext the synthesizer plays into; the combined player routes the media into it too.
     * @internal
     */
    public get audioContext(): AudioContext | null {
        return this.context;
    }

    /**
     * Creates the worklet now and holds it silent until the first play (warm start, spike finding F7).
     * @internal
     */
    public warmUp(): void {
        const ctx = this.context;
        if (!ctx || this._isWarm) {
            return;
        }
        this._isWarm = true;
        this._enqueue(async () => {
            if (this._worklet) {
                return;
            }
            await this._start(ctx, []);
            // _start() assigned it; re-read past the narrowing above
            const worklet = this._worklet as AudioWorkletNode<IAlphaSynthWorkerMessage> | null;
            worklet?.port.postMessage({ cmd: 'alphaSynth.output.hold' });
        });
    }

    private _bufferTimeInMilliseconds: number = 0;
    private readonly _settings: Settings;
    private _boundHandleMessage: (e: MessageEvent<IAlphaSynthWorkerMessage>) => void;

    /**
     * The events received between a play call and the creation of its worklet.
     */
    private _pendingEvents?: IAlphaSynthWorkerMessage[];

    /**
     * The worklet is created asynchronously while play, pause and destroy are synchronous.
     * Their audio graph operations are chained here to run in the order of the calls.
     */
    private _operations: Promise<void> = Promise.resolve();

    /**
     * Aborted on destroy, to stop waiting for a worklet load which might never complete.
     */
    private readonly _destroyed = new AbortController();

    public constructor(settings: Settings) {
        super();
        this._settings = settings;
        this._boundHandleMessage = e => this._handleMessage(e);
        this.outputBusCount = Math.min(8, Math.max(1, settings.player.synthOutputBusCount | 0));
    }

    public override open(bufferTimeInMilliseconds: number) {
        super.open(bufferTimeInMilliseconds);
        this._bufferTimeInMilliseconds = bufferTimeInMilliseconds;
        const ctx = this.context;
        if (ctx && this.outputBusCount > 1) {
            this._busReturnNode = ctx.createGain();
            this._busNodes = [];
            for (let b = 0; b < this.outputBusCount; b++) {
                const bus = ctx.createGain();
                bus.connect(this._busReturnNode);
                this._busNodes.push(bus);
            }
        }
        this.onReady();
    }

    private _isReturnConnected: boolean = false;

    public override play(): void {
        // resuming the context must happen synchronously within the user interaction
        this.activate();
        const ctx = this.context!;

        // we just want the events which come in after this play call until its worklet is created
        const pendingEvents: IAlphaSynthWorkerMessage[] = [];
        this._pendingEvents = pendingEvents;

        this._enqueue(() => this._start(ctx, pendingEvents));
    }

    public override pause(): void {
        this._pendingEvents = undefined;
        if (this.keepAlive) {
            this._enqueue(() => {
                this._worklet?.port.postMessage({ cmd: 'alphaSynth.output.hold' });
            });
            return;
        }
        this._enqueue(() => this._stop());
    }

    public override destroy(): void {
        this.keepAlive = false;
        // a pending worklet load must not delay the destroy
        this._destroyed.abort();
        this.pause();
        // the context must only be closed after the pending operations completed
        this._enqueue(() => super.destroy());
    }

    private _enqueue(operation: () => void | Promise<void>): void {
        this._operations = this._operations.then(operation).catch(e => {
            Logger.error('WebAudio', `Audio Worklet operation failed: reason=${e}`);
            // only the combined player acts on this (F-8); synth-only mode keeps today's behavior
            try {
                (this.workletFailed as EventEmitterOfT<Error>).trigger(e instanceof Error ? e : new Error(String(e)));
            } catch (listenerError) {
                // a throwing listener must not reject the queue: every later operation (even destroy) would be skipped
                Logger.error('WebAudio', `workletFailed listener threw: reason=${listenerError}`);
            }
        });
    }

    /**
     * Loads the worklet module.
     * @returns false if the output was destroyed before the load completed.
     */
    private _loadWorklet(ctx: AudioContext): Promise<boolean> {
        const signal = this._destroyed.signal;
        return new Promise<boolean>((resolve, reject) => {
            if (signal.aborted) {
                resolve(false);
                return;
            }
            const load = BrowserUiFacade.createAlphaSynthAudioWorklet(ctx, this._settings);
            const onAbort = () => resolve(false);
            signal.addEventListener('abort', onAbort, { once: true });
            load.then(() => resolve(true), reject).finally(() => signal.removeEventListener('abort', onAbort));
        });
    }

    private async _start(ctx: AudioContext, pendingEvents: IAlphaSynthWorkerMessage[]): Promise<void> {
        let worklet = this._worklet;
        if (worklet) {
            // kept alive while paused (mixing mode): resume it before the samples arrive
            worklet.port.postMessage({ cmd: 'alphaSynth.output.resume' });
        } else {
            if (!(await this._loadWorklet(ctx))) {
                // destroyed while loading
                return;
            }

            // create a worklet node which will replace the silence with the generated audio
            const busCount = this.outputBusCount;
            worklet = new AudioWorkletNode(ctx, 'alphatab', {
                numberOfOutputs: busCount,
                outputChannelCount: new Array<number>(busCount).fill(2),
                processorOptions: {
                    bufferTimeInMilliseconds: this._bufferTimeInMilliseconds,
                    busCount: busCount
                }
            }) as AudioWorkletNode<IAlphaSynthWorkerMessage>;
            this._worklet = worklet;
            worklet.port.addEventListener('message', this._boundHandleMessage);
            worklet.port.start();

            // created and started together: base pause() must only ever see a started source
            this.createSource(ctx);
            this.source!.start(0);
            this.source!.connect(worklet);
            const busNodes = this._busNodes;
            if (busNodes && this._busReturnNode) {
                for (let b = 0; b < busNodes.length; b++) {
                    worklet.connect(busNodes[b], b, 0);
                }
                // destinationNode is set before the first start (mixing mode)
                if (!this._isReturnConnected) {
                    this._isReturnConnected = true;
                    this._busReturnNode.connect(this.destinationNode ?? ctx.destination);
                }
            } else {
                worklet.connect(this.destinationNode ?? ctx.destination);
            }
        }

        for (const e of pendingEvents) {
            worklet.port.postMessage(e);
        }
        if (this._pendingEvents === pendingEvents) {
            this._pendingEvents = undefined;
        }
    }

    private _stop(): void {
        super.pause();
        const worklet = this._worklet;
        if (worklet) {
            worklet.port.postMessage({
                cmd: 'alphaSynth.output.stop'
            });
            worklet.port.removeEventListener('message', this._boundHandleMessage);
            worklet.disconnect();
        }
        this._worklet = null;
    }

    private _handleMessage(e: MessageEvent<IAlphaSynthWorkerMessage>) {
        const data = e.data;
        const cmd = data.cmd;
        switch (cmd) {
            case 'alphaSynth.output.samplesPlayed':
                this.onSamplesPlayed(data.samples);
                break;
            case 'alphaSynth.output.sampleRequest':
                this.onSampleRequest();
                break;
            case 'alphaSynth.output.mediaTimestamp':
                (this.mediaTimestamp as EventEmitterOfT<MediaTimestampEventArgs>).trigger(
                    new MediaTimestampEventArgs(data.frame, data.mediaTime)
                );
                break;
            case 'alphaSynth.output.countInEnd':
                (this.countInEnd as EventEmitterOfT<number>).trigger(data.frame);
                break;
        }
    }

    private _postWorkerMessage(message: IAlphaSynthWorkerMessage) {
        // while a worklet is being created, the events are buffered for it
        const pendingEvents = this._pendingEvents;
        if (pendingEvents) {
            pendingEvents.push(message);
        } else {
            this._worklet?.port.postMessage(message);
        }
    }

    public addSamples(f: Float32Array): void {
        this._postWorkerMessage({
            cmd: 'alphaSynth.output.addSamples',
            samples: Environment.prepareForPostMessage(f)
        });
    }

    public addMediaSamples(samples: Float32Array, chunk: MediaSampleChunk): void {
        this._postWorkerMessage({
            cmd: 'alphaSynth.output.addSamples',
            samples: Environment.prepareForPostMessage(samples),
            mediaStart: chunk.mediaStart,
            mediaPerFrame: chunk.mediaPerFrame,
            countInEnd: chunk.countInEnd,
            countInFramesLeft: chunk.countInFramesLeft
        });
    }

    public resetSamples(): void {
        this._postWorkerMessage({
            cmd: 'alphaSynth.output.resetSamples'
        });
    }
}
