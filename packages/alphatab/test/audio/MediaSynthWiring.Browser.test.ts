/**
 * BrowserUiFacade.createMediaSynthPlayer builds the combined player from its parts (spec §7). The browser, Web Audio
 * and the worker are faked: these tests check which parts are built and how they are connected, the sync lab checks
 * the real audio.
 * @target web
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlphaTabApiBase } from '@coderline/alphatab/AlphaTabApiBase';
import { Logger } from '@coderline/alphatab/Logger';
import { PlayerMode, PlayerOutputMode } from '@coderline/alphatab/PlayerSettings';
import type { AlphaSynthAudioWorkletOutput } from '@coderline/alphatab/platform/javascript/AlphaSynthAudioWorkletOutput';
import type { AudioElementBackingTrackSynthOutput } from '@coderline/alphatab/platform/javascript/AudioElementBackingTrackSynthOutput';
import { BrowserUiFacade } from '@coderline/alphatab/platform/javascript/BrowserUiFacade';
import {
    BackingTrackMediaClock,
    ExternalMediaClock,
    type IMediaClock
} from '@coderline/alphatab/platform/javascript/MediaClock';
import { MediaLatencyProbe } from '@coderline/alphatab/platform/javascript/MediaLatencyProbe';
import { MediaSyncLearnedValues } from '@coderline/alphatab/platform/javascript/MediaSyncController';
import type { MediaSynthPlayer } from '@coderline/alphatab/platform/javascript/MediaSynthPlayer';
import type { IMediaLatencyProbe } from '@coderline/alphatab/platform/javascript/MediaSynthTypes';
import { WebAudioMixGraph } from '@coderline/alphatab/platform/javascript/WebAudioMixGraph';
import type { AlphaSynthWebWorkerApi } from '@coderline/alphatab/platform/worker/AlphaSynthWebWorkerApi';
import type {
    IAlphaSynthWorker,
    IAlphaSynthWorkerMessage
} from '@coderline/alphatab/platform/worker/AlphaTabWorkerProtocol';
import { Settings } from '@coderline/alphatab/Settings';
import type { AlphaSynthWrapper } from '@coderline/alphatab/synth/AlphaSynthWrapper';
import { BackingTrackPlayer } from '@coderline/alphatab/synth/BackingTrackPlayer';
import { ExternalMediaPlayer } from '@coderline/alphatab/synth/ExternalMediaPlayer';
import type { IAlphaSynth } from '@coderline/alphatab/synth/IAlphaSynth';
import { TestMediaOutput } from 'test/audio/TestMediaOutput';
import { TestUiFacade } from '../visualTests/TestUiFacade';

class FakeParam {
    public value: number = 0;
}

class FakeNode {
    public readonly connections: FakeNode[] = [];
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
}

class FakeCompressor extends FakeNode {
    public readonly threshold: FakeParam = new FakeParam();
    public readonly ratio: FakeParam = new FakeParam();
    public readonly knee: FakeParam = new FakeParam();
    public readonly attack: FakeParam = new FakeParam();
    public readonly release: FakeParam = new FakeParam();
}

class FakeAudioContext {
    public static instances: FakeAudioContext[] = [];
    public state: string = 'running';
    public sampleRate: number = 48000;
    public currentTime: number = 0;
    public baseLatency: number = 0.005;
    public readonly destination: FakeNode = new FakeNode();
    /** The elements routed into this context. */
    public readonly mediaElements: unknown[] = [];

    public constructor() {
        FakeAudioContext.instances.push(this);
    }
    public createGain(): FakeGain {
        return new FakeGain();
    }
    public createDynamicsCompressor(): FakeCompressor {
        return new FakeCompressor();
    }
    public createMediaElementSource(element: unknown): FakeNode {
        this.mediaElements.push(element);
        return new FakeNode();
    }
    public getOutputTimestamp(): { contextTime?: number; performanceTime?: number } {
        return {};
    }
    public addEventListener(): void {}
    public removeEventListener(): void {}
    public resume(): Promise<void> {
        return Promise.resolve();
    }
    public close(): Promise<void> {
        return Promise.resolve();
    }
}

class FakeAudioElement {
    public readonly style: Record<string, string> = {};
    public currentTime: number = 0;
    public paused: boolean = false;
    public seeking: boolean = false;
    public playbackRate: number = 1;
    public volume: number = 1;
    public addEventListener(): void {}
    public play(): Promise<void> {
        return Promise.resolve();
    }
    public pause(): void {}
}

class FakeWorker implements IAlphaSynthWorker {
    public readonly posted: IAlphaSynthWorkerMessage[] = [];
    public postMessage(message: IAlphaSynthWorkerMessage): void {
        this.posted.push(message);
    }
    public addEventListener(): void {}
    public removeEventListener(): void {}
    public terminate(): void {}
}

class FakeWorkletNode {
    public static created: number = 0;
    public constructor() {
        FakeWorkletNode.created++;
    }
}

/**
 * A private member of the combined player (or of the facade), read by name: these tests check how the facade connected
 * the parts, which only the player's constructor ever sees.
 */
function peek<T>(target: object, name: string): T {
    return Reflect.get(target, name) as T;
}

/**
 * What the combined player was built from.
 */
function partsOf(player: IAlphaSynth | null) {
    expect(player).not.toBeNull();
    return {
        media: peek<BackingTrackPlayer>(player!, '_media'),
        synth: peek<AlphaSynthWebWorkerApi>(player!, '_synth'),
        synthOutput: peek<AlphaSynthAudioWorkletOutput>(player!, '_synthOutput'),
        graph: peek<WebAudioMixGraph>(player!, '_graph'),
        clock: peek<IMediaClock>(player!, '_clock'),
        externalClock: peek<ExternalMediaClock | null>(player!, '_externalClock'),
        probe: peek<IMediaLatencyProbe | null>(player!, '_probe')
    };
}

const audioElements: FakeAudioElement[] = [];
const workers: FakeWorker[] = [];

function stubBrowser(options: { secureContext?: boolean; worklets?: boolean } = {}): void {
    const window: Record<string, unknown> = {
        isSecureContext: options.secureContext ?? true,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval
    };
    if (options.worklets ?? true) {
        window.AudioWorkletNode = FakeWorkletNode;
    }
    vi.stubGlobal('window', window);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('document', {
        createElement: () => {
            const element = new FakeAudioElement();
            audioElements.push(element);
            return element;
        },
        body: { appendChild: () => {}, removeChild: () => {} }
    });
}

function createFacade(settings: Settings): BrowserUiFacade {
    // the constructor needs a real DOM; the player factory only needs the API's settings
    const facade = Object.create(BrowserUiFacade.prototype) as BrowserUiFacade;
    Reflect.set(facade, '_api', { settings });
    return facade;
}

function createSettings(mode: PlayerMode): Settings {
    const settings = new Settings();
    settings.player.playerMode = mode;
    settings.player.enableSynthesizerWithMedia = true;
    return settings;
}

function create(settings: Settings, mode: PlayerMode) {
    const player = createFacade(settings).createMediaSynthPlayer(mode);
    return { player: player as MediaSynthPlayer, parts: partsOf(player) };
}

/**
 * The API's UI layer with the browser's combined player (the real factory on the faked browser) and a plain media
 * player for the switch off.
 */
class BrowserPlayersUiFacade extends TestUiFacade {
    private readonly _browser: BrowserUiFacade;

    public constructor(browser: BrowserUiFacade) {
        super();
        this._browser = browser;
    }

    public override createMediaSynthPlayer(mode: PlayerMode): IAlphaSynth | null {
        return this._browser.createMediaSynthPlayer(mode);
    }

    public override createBackingTrackPlayer(): IAlphaSynth | null {
        return new BackingTrackPlayer(new TestMediaOutput(), 500);
    }
}

describe('MediaSynthWiringBrowserTests', () => {
    let savedWorkerFactory: typeof BrowserUiFacade.createAlphaSynthWebWorker;

    beforeEach(() => {
        audioElements.length = 0;
        workers.length = 0;
        FakeAudioContext.instances = [];
        FakeWorkletNode.created = 0;
        savedWorkerFactory = BrowserUiFacade.createAlphaSynthWebWorker;
        BrowserUiFacade.createAlphaSynthWebWorker = () => {
            const worker = new FakeWorker();
            workers.push(worker);
            return worker;
        };
        stubBrowser();
        // (no SoundFont is set: the combined player warns that it plays the media only until one is loaded)
        vi.spyOn(Logger, 'warning').mockImplementation(() => {});
    });

    afterEach(() => {
        BrowserUiFacade.createAlphaSynthWebWorker = savedWorkerFactory;
        MediaLatencyProbe.cache.delete(1);
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('backing-track-parts-share-one-context-and-are-set-before-any-worklet', () => {
        const settings = createSettings(PlayerMode.EnabledBackingTrack);
        const { player, parts } = create(settings, PlayerMode.EnabledBackingTrack);

        const { synth, synthOutput: output, graph } = parts;
        expect(workers.length).toBe(1);
        expect(output).toBe(synth.output);

        // media and synthesizer in one AudioContext
        expect(FakeAudioContext.instances.length).toBe(1);
        expect(graph).toBeInstanceOf(WebAudioMixGraph);
        expect(graph.context).toBe(FakeAudioContext.instances[0]);
        expect(output.audioContext).toBe(FakeAudioContext.instances[0]);
        expect(player.diagnostics.audioContext).toBe(FakeAudioContext.instances[0]);

        // no worklet yet (it is built on the worker's first readyForPlayback): its destination and keep-alive are set
        // before, and the stamped chunks reach the worklet output with their stamps
        expect(FakeWorkletNode.created).toBe(0);
        expect(output.destinationNode).toBe(graph.synthInput);
        expect(output.keepAlive).toBe(true);
        expect(synth.mediaSampleOutput).toBe(output);

        // the <audio> is routed into the graph once
        expect(audioElements.length).toBe(1);
        expect(FakeAudioContext.instances[0].mediaElements).toEqual([audioElements[0]]);
        expect(player.diagnostics.mediaSourceNode).not.toBeNull();
        expect(parts.media).toBeInstanceOf(BackingTrackPlayer);
        expect(parts.media).not.toBeInstanceOf(ExternalMediaPlayer);
        expect((parts.media.output as AudioElementBackingTrackSynthOutput).audioElement).toBe(
            audioElements[0] as unknown as HTMLAudioElement
        );

        expect(parts.clock).toBeInstanceOf(BackingTrackMediaClock);
        expect(parts.externalClock).toBeNull();
        expect(parts.probe).toBeInstanceOf(MediaLatencyProbe);
        expect(player.controller.startLeads).toBe(MediaSyncLearnedValues.backingTrack.startLeads);
        // the probe's values are the page's cache
        MediaLatencyProbe.cache.set(1, 12);
        expect(player.diagnostics.probeLatencies).toEqual({ '1': 12 });
    });

    it('external-media-shares-one-clock-that-runs-on-the-graph', () => {
        const settings = createSettings(PlayerMode.EnabledExternalMedia);
        const { player, parts } = create(settings, PlayerMode.EnabledExternalMedia);

        const output = parts.synthOutput;
        expect(parts.media).toBeInstanceOf(ExternalMediaPlayer);
        expect(parts.clock).toBeInstanceOf(ExternalMediaClock);
        expect(parts.externalClock).toBe(parts.clock);
        // no <audio> to route and nothing to probe
        expect(audioElements.length).toBe(0);
        expect(FakeAudioContext.instances[0].mediaElements).toEqual([]);
        expect(player.diagnostics.mediaSourceNode).toBeNull();
        expect(parts.probe).toBeNull();
        expect(player.controller.startLeads).toBe(MediaSyncLearnedValues.externalMedia.startLeads);
        expect(output.destinationNode).toBe(parts.graph.synthInput);
        expect(output.keepAlive).toBe(true);
        expect(parts.synth.mediaSampleOutput).toBe(output);

        // the clock is stamped with the graph's heard time (this context's time): updates every 50 ms at 1x
        const context = FakeAudioContext.instances[0];
        const clock = parts.externalClock!;
        clock.setPlaying(true);
        for (let i = 0; i < 4; i++) {
            context.currentTime = 1 + i * 0.05;
            clock.addSample(5000 + i * 50);
        }
        expect(clock.mediaTimeAt(1.15 * context.sampleRate)).toBeCloseTo(5150, 0);
    });

    it('the-offset-setting-is-read-live-by-both-clocks', () => {
        // tuning mediaSyncOffsetInMilliseconds by ear needs no new player
        const backingTrack = createSettings(PlayerMode.EnabledBackingTrack);
        const backingTrackClock = create(backingTrack, PlayerMode.EnabledBackingTrack).parts.clock;
        audioElements[0].currentTime = 10;

        const externalMedia = createSettings(PlayerMode.EnabledExternalMedia);
        const externalClock = create(externalMedia, PlayerMode.EnabledExternalMedia).parts.externalClock!;
        const context = FakeAudioContext.instances[1];
        externalClock.setPlaying(true);
        for (let i = 0; i < 4; i++) {
            context.currentTime = 1 + i * 0.05;
            externalClock.addSample(10000 + i * 50);
        }

        const checks = [
            { settings: backingTrack, clock: backingTrackClock, frame: 0 },
            { settings: externalMedia, clock: externalClock, frame: 1.15 * context.sampleRate }
        ];
        for (const { settings, clock, frame } of checks) {
            const reference = clock.mediaTimeAt(frame);
            expect(reference).toBeCloseTo(frame === 0 ? 10000 : 10150, 0);
            settings.player.mediaSyncOffsetInMilliseconds = 25;
            expect(clock.mediaTimeAt(frame)).toBeCloseTo(reference - 25, 6);
            settings.player.mediaSyncOffsetInMilliseconds = -10;
            expect(clock.mediaTimeAt(frame)).toBeCloseTo(reference + 10, 6);
        }
    });

    it('every-player-gets-its-own-graph-and-probe', () => {
        const settings = createSettings(PlayerMode.EnabledBackingTrack);
        const facade = createFacade(settings);
        const first = partsOf(facade.createMediaSynthPlayer(PlayerMode.EnabledBackingTrack));
        const second = partsOf(facade.createMediaSynthPlayer(PlayerMode.EnabledBackingTrack));
        expect(first.graph).not.toBe(second.graph);
        expect(first.probe).not.toBe(second.probe);
        expect(first.clock).not.toBe(second.clock);
        expect(first.media).not.toBe(second.media);
        // each <audio> is routed into the context of its own player, once
        expect(FakeAudioContext.instances.length).toBe(2);
        expect(audioElements.length).toBe(2);
        expect(FakeAudioContext.instances[0].mediaElements).toEqual([audioElements[0]]);
        expect(FakeAudioContext.instances[1].mediaElements).toEqual([audioElements[1]]);
    });

    it('the-wrapper-restores-the-volumes-onto-the-combined-player-once-it-reports-ready', () => {
        // the combined player is not ready when alphaTab assigns it (its worker answers later): the wrapper's
        // late-ready path puts the app's volumes on the graph then
        const settings = createSettings(PlayerMode.EnabledBackingTrack);
        settings.player.enableSynthesizerWithMedia = false;
        const api = new AlphaTabApiBase<unknown>(new BrowserPlayersUiFacade(createFacade(settings)), settings);
        api.masterVolume = 0.8;
        api.backingTrackVolume = 0.4;
        api.synthVolume = 1.5;
        api.isLooping = true;

        settings.player.enableSynthesizerWithMedia = true;
        api.updateSettings();
        const combined = (api.player as AlphaSynthWrapper).instance as MediaSynthPlayer;
        const parts = partsOf(combined);
        expect(parts.graph).toBeInstanceOf(WebAudioMixGraph);
        expect(combined.isReady).toBe(false);
        expect(parts.graph.mediaGain).toBe(1);
        expect(parts.graph.synthGain).toBe(1);

        // the worker answers
        parts.synth.handleWorkerMessage({ data: { cmd: 'alphaSynth.ready' } } as MessageEvent<IAlphaSynthWorkerMessage>);
        expect(combined.isReady).toBe(true);
        expect(parts.graph.masterGain).toBeCloseTo(0.8, 9);
        expect(parts.graph.mediaGain).toBeCloseTo(0.4, 9);
        expect(parts.graph.synthGain).toBeCloseTo(1.5, 9);
        expect(combined.isLooping).toBe(true);
        api.destroy();
    });

    it('without-audio-worklets-the-media-plays-alone-and-nothing-is-created', () => {
        const unsupported: { name: string; apply: (settings: Settings) => void }[] = [
            {
                name: 'script processor output',
                apply: s => {
                    s.player.outputMode = PlayerOutputMode.WebAudioScriptProcessor;
                }
            },
            { name: 'insecure context', apply: () => stubBrowser({ secureContext: false }) },
            { name: 'no AudioWorkletNode', apply: () => stubBrowser({ worklets: false }) }
        ];
        for (const { name, apply } of unsupported) {
            const warning = vi.mocked(Logger.warning);
            warning.mockClear();
            const settings = createSettings(PlayerMode.EnabledBackingTrack);
            apply(settings);
            expect(createFacade(settings).createMediaSynthPlayer(PlayerMode.EnabledBackingTrack), name).toBeNull();
            expect(warning, name).toHaveBeenCalledTimes(1);
            expect(warning.mock.calls[0][1], name).toContain('AudioWorklets');
            // no worker, no AudioContext and no <audio>
            expect(workers.length, name).toBe(0);
            expect(FakeAudioContext.instances.length, name).toBe(0);
            expect(audioElements.length, name).toBe(0);
        }
    });

    it('a-synthesizer-that-cannot-be-created-leaves-no-media-player-behind', () => {
        vi.spyOn(Logger, 'error').mockImplementation(() => {});
        BrowserUiFacade.createAlphaSynthWebWorker = () => {
            throw new Error('no worker');
        };
        const warning = vi.mocked(Logger.warning);
        const settings = createSettings(PlayerMode.EnabledBackingTrack);
        expect(createFacade(settings).createMediaSynthPlayer(PlayerMode.EnabledBackingTrack)).toBeNull();
        expect(warning).toHaveBeenCalledTimes(1);
        expect(warning.mock.calls[0][1]).toContain('synthesizer could not be created');
        expect(FakeAudioContext.instances.length).toBe(0);
        expect(audioElements.length).toBe(0);
    });
});
