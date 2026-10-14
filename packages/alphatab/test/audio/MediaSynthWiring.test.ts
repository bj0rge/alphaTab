/**
 * Creating the combined player from the settings (spec §7).
 * @target web
 */
import { describe, expect, it } from 'vitest';
import { AlphaTabApiBase } from '@coderline/alphatab/AlphaTabApiBase';
import type { EventEmitter } from '@coderline/alphatab/EventEmitter';
import { PlayerMode } from '@coderline/alphatab/PlayerSettings';
import { Settings } from '@coderline/alphatab/Settings';
import { AlphaSynth } from '@coderline/alphatab/synth/AlphaSynth';
import type { AlphaSynthWrapper } from '@coderline/alphatab/synth/AlphaSynthWrapper';
import { BackingTrackPlayer } from '@coderline/alphatab/synth/BackingTrackPlayer';
import { ExternalMediaPlayer } from '@coderline/alphatab/synth/ExternalMediaPlayer';
import type { IAlphaSynth } from '@coderline/alphatab/synth/IAlphaSynth';
import { TestMediaOutput } from 'test/audio/TestMediaOutput';
import { TestOutput } from 'test/audio/TestOutput';
import { TestUiFacade } from '../visualTests/TestUiFacade';

class MixingTestUiFacade extends TestUiFacade {
    public readonly mediaSynthCalls: PlayerMode[] = [];
    public mediaSynthResult: (() => IAlphaSynth | null) = () => null;
    public backingTrackCalls: number = 0;

    public override createMediaSynthPlayer(mode: PlayerMode): IAlphaSynth | null {
        this.mediaSynthCalls.push(mode);
        return this.mediaSynthResult();
    }

    public override createBackingTrackPlayer(): IAlphaSynth | null {
        this.backingTrackCalls++;
        return new BackingTrackPlayer(new TestMediaOutput(), 500);
    }
}

/**
 * An output that reports ready when the test says so: the combined player is ready after alphaTab assigned it, because
 * its worker answers later.
 */
class ReadyLaterOutput extends TestOutput {
    public override open(_bufferTimeInMilliseconds: number): void {}

    public becomeReady(): void {
        (this.ready as EventEmitter).trigger();
    }
}

function createApi(mode: PlayerMode, mixing: boolean, facade: MixingTestUiFacade): AlphaTabApiBase<unknown> {
    const settings = new Settings();
    settings.player.playerMode = mode;
    settings.player.enableSynthesizerWithMedia = mixing;
    return new AlphaTabApiBase<unknown>(facade, settings);
}

function instanceOf(api: AlphaTabApiBase<unknown>): IAlphaSynth | undefined {
    return (api.player as AlphaSynthWrapper | null)?.instance;
}

describe('MediaSynthWiringTests', () => {
    it('settings-default-off-and-read-from-json', () => {
        const settings = new Settings();
        expect(settings.player.enableSynthesizerWithMedia).toBe(false);
        expect(settings.player.mediaSyncOffsetInMilliseconds).toBe(0);
        settings.fillFromJson({ player: { enableSynthesizerWithMedia: true, mediaSyncOffsetInMilliseconds: 25 } });
        expect(settings.player.enableSynthesizerWithMedia).toBe(true);
        expect(settings.player.mediaSyncOffsetInMilliseconds).toBe(25);
    });

    it('mixing-on-asks-for-a-combined-player', () => {
        const facade = new MixingTestUiFacade();
        const combined = new AlphaSynth(new TestOutput(), 500);
        facade.mediaSynthResult = () => combined;
        const api = createApi(PlayerMode.EnabledBackingTrack, true, facade);
        expect(facade.mediaSynthCalls).toEqual([PlayerMode.EnabledBackingTrack]);
        expect(facade.backingTrackCalls).toBe(0);
        expect(instanceOf(api)).toBe(combined);
        api.destroy();
    });

    it('no-combined-player-falls-back-to-the-media-player', () => {
        const facade = new MixingTestUiFacade();
        const api = createApi(PlayerMode.EnabledBackingTrack, true, facade);
        expect(facade.mediaSynthCalls.length).toBe(1);
        expect(instanceOf(api)).toBeInstanceOf(BackingTrackPlayer);
        api.destroy();
    });

    it('external-media-asks-too-and-falls-back', () => {
        const facade = new MixingTestUiFacade();
        const api = createApi(PlayerMode.EnabledExternalMedia, true, facade);
        expect(facade.mediaSynthCalls).toEqual([PlayerMode.EnabledExternalMedia]);
        expect(instanceOf(api)).toBeInstanceOf(ExternalMediaPlayer);
        api.destroy();
    });

    it('mixing-off-changes-nothing', () => {
        // S7
        const facade = new MixingTestUiFacade();
        const api = createApi(PlayerMode.EnabledBackingTrack, false, facade);
        expect(facade.mediaSynthCalls).toEqual([]);
        expect(facade.backingTrackCalls).toBe(1);
        api.destroy();
    });

    it('synthesizer-mode-ignores-the-switch', () => {
        const facade = new MixingTestUiFacade();
        const api = createApi(PlayerMode.EnabledSynthesizer, true, facade);
        expect(facade.mediaSynthCalls).toEqual([]);
        api.destroy();
    });

    it('flag-change-recreates-the-player', () => {
        // Review Focus 4
        const facade = new MixingTestUiFacade();
        facade.mediaSynthResult = () => new AlphaSynth(new TestOutput(), 500);
        const api = createApi(PlayerMode.EnabledBackingTrack, false, facade);
        expect(facade.backingTrackCalls).toBe(1);

        api.settings.player.enableSynthesizerWithMedia = true;
        api.updateSettings();
        expect(facade.mediaSynthCalls.length).toBe(1);

        api.updateSettings(); // unchanged: no new player
        expect(facade.mediaSynthCalls.length).toBe(1);

        api.settings.player.enableSynthesizerWithMedia = false;
        api.updateSettings();
        expect(facade.backingTrackCalls).toBe(2);
        api.destroy();
    });

    it('wrapper-restores-media-volumes', () => {
        // Review Focus 4
        const facade = new MixingTestUiFacade();
        const combined = new AlphaSynth(new TestOutput(), 500);
        facade.mediaSynthResult = () => combined;
        const api = createApi(PlayerMode.EnabledBackingTrack, false, facade);
        api.backingTrackVolume = 0.4;
        api.synthVolume = 1.5;
        api.settings.player.enableSynthesizerWithMedia = true;
        api.updateSettings();
        expect(combined.backingTrackVolume).toBeCloseTo(0.4, 9);
        expect(combined.synthVolume).toBeCloseTo(1.5, 9);
        api.destroy();
    });

    it('wrapper-restores-state-when-the-player-reports-ready-later', () => {
        // the wrapper's late-ready path: the combined player is not ready when it is assigned, so the app's volumes,
        // speed and looping are restored once it reports ready
        const facade = new MixingTestUiFacade();
        const output = new ReadyLaterOutput();
        const combined = new AlphaSynth(output, 500);
        facade.mediaSynthResult = () => combined;
        const api = createApi(PlayerMode.EnabledBackingTrack, false, facade);
        api.backingTrackVolume = 0.4;
        api.synthVolume = 1.5;
        api.playbackSpeed = 0.75;
        api.isLooping = true;
        api.settings.player.enableSynthesizerWithMedia = true;
        api.updateSettings();
        expect(instanceOf(api)).toBe(combined);
        expect(combined.isReady).toBe(false);
        expect(combined.backingTrackVolume).toBe(1);
        expect(combined.synthVolume).toBe(1);

        output.becomeReady();
        expect(combined.backingTrackVolume).toBeCloseTo(0.4, 9);
        expect(combined.synthVolume).toBeCloseTo(1.5, 9);
        expect(combined.playbackSpeed).toBeCloseTo(0.75, 9);
        expect(combined.isLooping).toBe(true);
        api.destroy();
    });
});
