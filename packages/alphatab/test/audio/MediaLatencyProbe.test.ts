/**
 * The latency probe's pure parts (spec §6.4); the measurement itself runs in the sync lab.
 * @target web
 */
import { describe, expect, it, vi } from 'vitest';
import { MediaLatencyProbe, ProbePoll } from '@coderline/alphatab/platform/javascript/MediaLatencyProbe';
import { PerSpeedValues } from '@coderline/alphatab/platform/javascript/PerSpeedValues';

describe('MediaLatencyProbeTests', () => {
    it('creates-a-1-second-wav-with-a-beep-every-125-ms', () => {
        const wav = MediaLatencyProbe.createProbeWav(48000, 1, 0.125);
        const view = new DataView(wav.bytes.buffer, wav.bytes.byteOffset, wav.bytes.byteLength);
        const text = (offset: number) => String.fromCharCode(...wav.bytes.subarray(offset, offset + 4));
        expect(text(0)).toBe('RIFF');
        expect(text(8)).toBe('WAVE');
        expect(view.getUint32(24, true)).toBe(48000);
        expect(view.getUint32(40, true)).toBe(48000 * 2); // 1 s of 16-bit mono
        expect(wav.beepTimes).toEqual([0.125, 0.25, 0.375, 0.5, 0.625, 0.75]);
        const sampleAt = (s: number) => view.getInt16(44 + Math.round(s * 48000) * 2 + 2 * 10, true);
        expect(Math.abs(sampleAt(0.25))).toBeGreaterThan(0); // inside a beep
        expect(sampleAt(0.3)).toBe(0); // between beeps
    });

    for (const [speed, latency] of [
        [0.5, 60],
        [1.5, -4],
        [1, 0]
    ]) {
        it(`latency-from-onsets-${speed}x`, () => {
            const beepTimes = [0.125, 0.25, 0.375, 0.5, 0.625, 0.75];
            // the media starts at context time 1 s; a beep is heard `latency` real ms before currentTime reaches it
            const polls: ProbePoll[] = [];
            for (let ctx = 1; ctx < 1 + 1 / speed + 0.2; ctx += 0.004) {
                polls.push(new ProbePoll((ctx - 1) * speed, ctx));
            }
            const onsets = beepTimes.map(b => 1 + (b - (latency / 1000) * speed) / speed);
            onsets[0] += 0.2; // the first beep carries the start transient: skipped
            expect(MediaLatencyProbe.latencyFromOnsets(onsets, polls, beepTimes, speed)).toBeCloseTo(latency, 6);
        });
    }

    it('fewer-than-two-onsets-is-nan', () => {
        // the first beep is skipped: no beep or one beep heard is no measurement (measure() then fails)
        const polls = [new ProbePoll(0, 1), new ProbePoll(1, 2)];
        expect(MediaLatencyProbe.latencyFromOnsets([], polls, [0.125, 0.25], 1)).toBeNaN();
        expect(MediaLatencyProbe.latencyFromOnsets([1.105], polls, [0.125, 0.25], 1)).toBeNaN();
        expect(MediaLatencyProbe.latencyFromOnsets([1.105, 1.23], polls, [0.125, 0.25], 1)).toBeCloseTo(20, 6);
    });

    it('background-speeds-and-a-session-cache', () => {
        expect(MediaLatencyProbe.backgroundSpeeds).toEqual([1, 0.5, 0.75, 1.25, 1.5]);
        expect(MediaLatencyProbe.cache).toBeInstanceOf(PerSpeedValues);
    });

    it('a-measurement-that-never-loads-gives-up-after-its-time-limit', async () => {
        // iOS may never load a hidden <audio> outside a gesture: the probe gives up after its length plus 2 s
        vi.useFakeTimers();
        let paused = 0;
        vi.stubGlobal(
            'Audio',
            class {
                public preload: string = '';
                public playbackRate: number = 1;
                public addEventListener(): void {} // canplaythrough never comes
                public pause(): void {
                    paused++;
                }
            }
        );
        let outcome = '';
        new MediaLatencyProbe({} as AudioContext, () => Promise.resolve()).measure(0.5).then(
            () => (outcome = 'measured'),
            (e: Error) => (outcome = e.message)
        );
        await vi.advanceTimersByTimeAsync(1000 / 0.5 + 2000 - 1);
        expect(outcome).toBe('');
        await vi.advanceTimersByTimeAsync(1);
        expect(outcome).toBe('no result within 4000 ms');
        expect(paused).toBe(1);
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('a-measurement-that-hears-no-beeps-fails', async () => {
        // the hidden <audio> played to its end, but the tap heard no beep: not a measured 0 (Task 15)
        vi.stubGlobal(
            'Audio',
            class {
                public preload: string = '';
                public playbackRate: number = 1;
                public currentTime: number = 0;
                public ended: boolean = false;
                public addEventListener(_type: string, listener: () => void): void {
                    listener(); // canplaythrough at once
                }
                public play(): Promise<void> {
                    this.ended = true;
                    return Promise.resolve();
                }
                public pause(): void {}
            }
        );
        vi.stubGlobal(
            'AudioWorkletNode',
            class {
                public port: { onmessage: unknown } = { onmessage: null };
                public connect(): void {}
                public disconnect(): void {}
            }
        );
        const context = {
            sampleRate: 48000,
            currentTime: 0,
            destination: {},
            createMediaElementSource: () => ({ connect: () => {}, disconnect: () => {} })
        } as unknown as AudioContext;
        await expect(new MediaLatencyProbe(context, () => Promise.resolve()).measure(1)).rejects.toThrow(
            'no beeps heard'
        );
        vi.unstubAllGlobals();
    });
});
