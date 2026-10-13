import type { IExternalClockSource } from '@coderline/alphatab/platform/javascript/MediaClock';
import type { IMediaMixGraph } from '@coderline/alphatab/platform/javascript/MediaSynthTypes';

/**
 * The backing track (or external media) and the synthesizer in one AudioContext (spec §3):
 * media → mediaGain and synth → synthGain, both into masterGain → limiter → trim → destination.
 * @target web
 * @internal
 */
export class WebAudioMixGraph implements IMediaMixGraph, IExternalClockSource {
    // F-13, spike 8: the sum of a mastered recording and the synthesizer stays under 0 dBFS
    public static readonly LimiterThresholdDb: number = -1;
    public static readonly LimiterRatio: number = 20;
    public static readonly LimiterKneeDb: number = 0;
    public static readonly LimiterAttackS: number = 0.001;
    public static readonly LimiterReleaseS: number = 0.1;
    /**
     * Cancels the compressor's automatic make-up gain (spike 8).
     */
    public static readonly TrimDb: number = -0.57;

    public readonly context: AudioContext;
    public readonly mediaGainNode: GainNode;
    public readonly synthGainNode: GainNode;
    public readonly masterGainNode: GainNode;
    public readonly limiterNode: DynamicsCompressorNode;
    public readonly trimNode: GainNode;
    private _mediaSource: MediaElementAudioSourceNode | null = null;

    public constructor(context: AudioContext) {
        this.context = context;
        this.mediaGainNode = context.createGain();
        this.synthGainNode = context.createGain();
        this.masterGainNode = context.createGain();
        this.limiterNode = context.createDynamicsCompressor();
        this.limiterNode.threshold.value = WebAudioMixGraph.LimiterThresholdDb;
        this.limiterNode.ratio.value = WebAudioMixGraph.LimiterRatio;
        this.limiterNode.knee.value = WebAudioMixGraph.LimiterKneeDb;
        this.limiterNode.attack.value = WebAudioMixGraph.LimiterAttackS;
        this.limiterNode.release.value = WebAudioMixGraph.LimiterReleaseS;
        this.trimNode = context.createGain();
        this.trimNode.gain.value = Math.pow(10, WebAudioMixGraph.TrimDb / 20);

        this.mediaGainNode.connect(this.masterGainNode);
        this.synthGainNode.connect(this.masterGainNode);
        this.masterGainNode.connect(this.limiterNode);
        this.limiterNode.connect(this.trimNode);
        this.trimNode.connect(context.destination);
    }

    /**
     * Routes an <audio> into the mix. createMediaElementSource works once per element (§13).
     */
    public connectMediaElement(element: HTMLMediaElement): void {
        if (!this._mediaSource) {
            this._mediaSource = this.context.createMediaElementSource(element);
            this._mediaSource.connect(this.mediaGainNode);
        }
    }

    /**
     * Where the synthesizer's worklet connects.
     */
    public get synthInput(): AudioNode {
        return this.synthGainNode;
    }

    public get mediaSourceNode(): AudioNode | null {
        return this._mediaSource;
    }

    public get masterGain(): number {
        return this.masterGainNode.gain.value;
    }

    public set masterGain(value: number) {
        this.masterGainNode.gain.value = value;
    }

    public get mediaGain(): number {
        return this.mediaGainNode.gain.value;
    }

    public set mediaGain(value: number) {
        this.mediaGainNode.gain.value = value;
    }

    public get synthGain(): number {
        return this.synthGainNode.gain.value;
    }

    public set synthGain(value: number) {
        this.synthGainNode.gain.value = value;
    }

    public get currentTime(): number {
        return this.context.currentTime;
    }

    public get sampleRate(): number {
        return this.context.sampleRate;
    }

    public get baseLatencyMs(): number {
        return (this.context.baseLatency ?? 0) * 1000;
    }

    public get isRunning(): boolean {
        return this.context.state === 'running';
    }

    public whenRunning(action: () => void): void {
        if (this.isRunning) {
            action();
            return;
        }
        const listener = () => {
            if (this.isRunning) {
                this.context.removeEventListener('statechange', listener);
                action();
            }
        };
        this.context.addEventListener('statechange', listener);
    }

    /**
     * The context time (s) of the audio being heard now (gap G-6).
     */
    public heardContextTime(): number {
        const timestamp = this.context.getOutputTimestamp?.();
        if (timestamp && timestamp.contextTime !== undefined && timestamp.performanceTime !== undefined) {
            return timestamp.contextTime + (performance.now() - timestamp.performanceTime) / 1000;
        }
        return this.context.currentTime - (this.context.outputLatency ?? 0);
    }
}
