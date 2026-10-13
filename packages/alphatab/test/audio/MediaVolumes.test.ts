import { describe, expect, it } from 'vitest';
import { AlphaSynth } from '@coderline/alphatab/synth/AlphaSynth';
import { AlphaSynthWrapper } from '@coderline/alphatab/synth/AlphaSynthWrapper';
import { BackingTrackPlayer } from '@coderline/alphatab/synth/BackingTrackPlayer';
import { ExternalMediaPlayer, type IExternalMediaSynthOutput } from '@coderline/alphatab/synth/ExternalMediaPlayer';
import { TestMediaHandler, TestMediaOutput } from 'test/audio/TestMediaOutput';
import { TestOutput } from 'test/audio/TestOutput';

describe('MediaVolumesTests', () => {
    it('backing-track-player-applies-master-times-backing-track-volume', () => {
        const output = new TestMediaOutput();
        const player = new BackingTrackPlayer(output, 500);
        player.masterVolume = 0.8;
        player.backingTrackVolume = 0.35;
        expect(output.masterVolume).toBeCloseTo(0.28, 9);
        player.masterVolume = 1;
        expect(output.masterVolume).toBeCloseTo(0.35, 9);
    });

    it('backing-track-player-caps-the-audio-element-at-1', () => {
        // an <audio> element's volume stops at 1 (the browser throws IndexSizeError above it); above 1 needs mixing
        const output = new TestMediaOutput();
        const player = new BackingTrackPlayer(output, 500);
        player.backingTrackVolume = 2;
        expect(output.masterVolume).toBe(1);
        player.masterVolume = 0.4;
        expect(output.masterVolume).toBeCloseTo(0.8, 9);
        player.masterVolume = 3;
        player.backingTrackVolume = 1;
        expect(output.masterVolume).toBe(1);
    });

    it('external-media-handler-keeps-master-volume-alone', () => {
        // §7, spike 9 §3
        const player = new ExternalMediaPlayer(500);
        const handler = new TestMediaHandler();
        (player.output as IExternalMediaSynthOutput).handler = handler;
        player.masterVolume = 0.8;
        player.backingTrackVolume = 0.35;
        expect(handler.masterVolume).toBeCloseTo(0.8, 9);
    });

    it('a-synthesizer-alone-keeps-both-and-ignores-them', () => {
        const synth = new AlphaSynth(new TestOutput(), 500);
        synth.masterVolume = 0.5;
        synth.backingTrackVolume = 0.35;
        synth.synthVolume = 2;
        expect(synth.masterVolume).toBeCloseTo(0.5, 9);
        expect(synth.backingTrackVolume).toBeCloseTo(0.35, 9);
        expect(synth.synthVolume).toBe(2);
    });

    it('volumes-are-clamped-at-0', () => {
        const player = new BackingTrackPlayer(new TestMediaOutput(), 500);
        player.backingTrackVolume = -1;
        player.synthVolume = -1;
        expect(player.backingTrackVolume).toBe(0);
        expect(player.synthVolume).toBe(0);
    });

    it('wrapper-remembers-the-media-volumes-across-player-switches', () => {
        const wrapper = new AlphaSynthWrapper();
        wrapper.backingTrackVolume = 0.4;
        wrapper.synthVolume = 1.5;
        const output = new TestMediaOutput();
        const player = new BackingTrackPlayer(output, 500);
        wrapper.instance = player;
        expect(player.backingTrackVolume).toBeCloseTo(0.4, 9);
        expect(player.synthVolume).toBeCloseTo(1.5, 9);
        expect(output.masterVolume).toBeCloseTo(0.4, 9);
        wrapper.backingTrackVolume = 0.2;
        expect(output.masterVolume).toBeCloseTo(0.2, 9);
    });
});
