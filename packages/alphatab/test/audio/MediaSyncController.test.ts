/**
 * The sync rules (spec §6.2), fed with readings.
 * @target web
 */
import { describe, expect, it } from 'vitest';
import {
    type IMediaSyncClock,
    type IMediaSyncSynth,
    type IMediaSyncTime,
    MediaSyncController
} from '@coderline/alphatab/platform/javascript/MediaSyncController';

class FakeSyncSynth implements IMediaSyncSynth {
    public readonly seeks: number[] = [];
    public readonly corrections: number[] = [];
    public seekToMediaTime(mediaTime: number): void {
        this.seeks.push(mediaTime);
    }
    public setRateCorrection(factor: number): void {
        this.corrections.push(factor);
    }
}

/**
 * Media time 10000 ms at frame 0, 48 frames per ms; "now" is 12345 ms.
 */
class FakeSyncClock implements IMediaSyncClock {
    public valid: boolean = true;
    public now: number = 12345;
    public mediaTimeAt(frame: number): number {
        return this.valid ? 10000 + frame / 48 : Number.NaN;
    }
    public mediaTimeNow(): number {
        return this.valid ? this.now : Number.NaN;
    }
}

class FakeSyncTime implements IMediaSyncTime {
    public t: number = 0;
    public now(): number {
        return this.t;
    }
}

function setup() {
    const synth = new FakeSyncSynth();
    const clock = new FakeSyncClock();
    const time = new FakeSyncTime();
    const controller = new MediaSyncController(synth, clock, time);
    let frame = 0;
    // one worklet stamp every 50 ms whose synth media time is `drift` ms off the media
    const stamp = (drift: number) => {
        time.t += 50;
        frame += 2400;
        controller.onStamp(frame, clock.mediaTimeAt(frame) + drift);
    };
    return { synth, clock, time, controller, stamp };
}

function settled(speed = 1) {
    const s = setup();
    s.controller.startedAfterHandOff(speed, false);
    s.time.t += 2000;
    return s;
}

describe('MediaSyncControllerTests', () => {
    it('acts-only-on-two-readings-that-agree', () => {
        const s = settled();
        s.stamp(200);
        s.stamp(150);
        expect(s.synth.seeks).toEqual([]);
        s.stamp(151); // 150 and 151 agree: mean 150.5 > 120
        expect(s.synth.seeks).toEqual([12345 + 10]); // the media now + the initial re-sync lead
    });

    it('settle-threshold-is-12-ms-at-1x-and-15-elsewhere', () => {
        const { controller } = setup();
        expect(controller.settleThreshold(1)).toBe(12);
        expect(controller.settleThreshold(0.5)).toBe(15);
        expect(controller.settleThreshold(1.5)).toBe(15);
    });

    it('settle-threshold-at-1x-grows-with-the-base-latency', () => {
        // F-3: max(12, 2 x baseLatency + 1)
        const { controller } = setup();
        controller.baseLatencyMs = 2.7;
        expect(controller.settleThreshold(1)).toBe(12);
        controller.baseLatencyMs = 8;
        expect(controller.settleThreshold(1)).toBe(17);
        expect(controller.settleThreshold(0.5)).toBe(15);
    });

    it('re-syncs-above-the-settle-threshold-while-settling', () => {
        const atOne = setup();
        atOne.controller.startedAfterHandOff(1, false);
        atOne.stamp(13);
        atOne.stamp(13.5); // 13.25 > 12
        expect(atOne.synth.seeks.length).toBe(1);

        const atHalf = setup();
        atHalf.controller.startedAfterHandOff(0.5, false);
        atHalf.stamp(14);
        atHalf.stamp(14.5); // 14.25 < 15
        expect(atHalf.synth.seeks.length).toBe(0);
    });

    it('locked-threshold-is-120-ms', () => {
        const s = settled();
        s.stamp(100);
        s.stamp(101);
        expect(s.synth.seeks.length).toBe(0);
    });

    it('nudge-slows-a-synth-that-is-ahead', () => {
        const s = settled();
        s.stamp(30);
        expect(s.synth.corrections[s.synth.corrections.length - 1]).toBeCloseTo(1 - 30 / 3000, 9);
        expect(s.controller.correction).toBeCloseTo(0.99, 9);
    });

    it('nudge-is-clamped-to-2-percent', () => {
        const s = settled();
        s.stamp(100);
        expect(s.controller.correction).toBeCloseTo(0.98, 9);
        const behind = settled();
        behind.stamp(-100);
        expect(behind.controller.correction).toBeCloseTo(1.02, 9);
    });

    it('settling-nudge-at-1x-is-faster', () => {
        const atOne = setup();
        atOne.controller.startedAfterHandOff(1, false);
        atOne.stamp(3); // one reading while settling: wait
        expect(atOne.synth.corrections).toEqual([]);
        atOne.stamp(3);
        expect(atOne.controller.correction).toBeCloseTo(1 - 3 / 300, 9);

        const atHalf = setup();
        atHalf.controller.startedAfterHandOff(0.5, false);
        atHalf.stamp(3);
        atHalf.stamp(3);
        expect(atHalf.controller.correction).toBeCloseTo(1 - 3 / 3000, 9);
    });

    it('ignores-readings-for-200-ms-after-a-re-sync', () => {
        // G-2: stamps rendered before the jump can still arrive
        const s = settled();
        s.controller.resync();
        const corrections = s.synth.corrections.length;
        s.stamp(500);
        s.stamp(500);
        s.stamp(500);
        expect(s.synth.seeks.length).toBe(1);
        expect(s.synth.corrections.length).toBe(corrections);
    });

    it('learns-the-re-sync-lead-from-the-first-agreed-reading', () => {
        const s = settled();
        s.controller.resync();
        s.time.t += 150;
        s.stamp(4); // t = resync + 200: read again
        s.stamp(4); // agreed +4: the synth came out 4 ms ahead
        expect(s.controller.stats.resyncLeadMs).toBe(6);
        s.controller.resync();
        expect(s.synth.seeks[s.synth.seeks.length - 1]).toBe(12345 + 6);
    });

    it('learns-the-media-start-latency-after-a-hand-off', () => {
        const s = setup();
        s.controller.startedAfterHandOff(1, true);
        s.stamp(7);
        s.stamp(8); // the media started 7.5 ms late: issue play() earlier next time
        expect(s.controller.mediaStartLatencies.get(1)).toBe(7.5);

        const fast = setup();
        fast.controller.startedAfterHandOff(1.5, true);
        fast.stamp(3);
        fast.stamp(3);
        expect(fast.controller.mediaStartLatencies.get(1.5)).toBeCloseTo(2, 9);
    });

    it('one-late-hand-off-teaches-nothing', () => {
        // a media that starts late once (spike 6: about 1 YouTube start in 7-10 buffers) mustn't move the next start
        const s = setup();
        const handOff = (late: number) => {
            s.time.t += 5000;
            s.controller.startedAfterHandOff(1, true);
            s.stamp(late);
            s.stamp(late);
        };
        handOff(45); // the first hand-off at a speed learns at once
        expect(s.controller.mediaStartLatencies.get(1)).toBe(45);
        handOff(200); // 200 ms late, once
        expect(s.controller.mediaStartLatencies.get(1)).toBe(45);
        handOff(0);
        expect(s.controller.mediaStartLatencies.get(1)).toBe(45);
        handOff(50); // the media now starts 50 ms later: one start doesn't move it
        expect(s.controller.mediaStartLatencies.get(1)).toBe(45);
        handOff(50); // two in a row that agree do
        expect(s.controller.mediaStartLatencies.get(1)).toBe(95);
    });

    it('a-jumpy-clock-must-not-re-sync', () => {
        const s = settled();
        for (let i = 0; i < 6; i++) {
            s.stamp(i % 2 === 0 ? 130 : 10);
        }
        expect(s.synth.seeks).toEqual([]);
    });

    it('re-syncs-later-when-the-media-gives-no-time', () => {
        const s = settled();
        s.clock.valid = false;
        s.controller.resync();
        expect(s.synth.seeks).toEqual([]);
        s.clock.valid = true;
        s.stamp(0);
        expect(s.synth.seeks).toEqual([12345 + 10]);
    });

    it('speed-change-re-syncs-and-settles', () => {
        // spike 11 §1: every change puts Chrome's media 15-43 ms behind the synth
        const s = settled();
        s.controller.speedChanged(0.75);
        expect(s.synth.seeks).toEqual([12345 + 10 * 0.75]);
        expect(s.controller.isSettling).toBe(true);
        expect(s.controller.speed).toBe(0.75);
    });

    it('stopped-ignores-stamps', () => {
        const s = settled();
        s.controller.stopped();
        s.stamp(500);
        s.stamp(500);
        expect(s.synth.seeks).toEqual([]);
        expect(s.controller.isActive).toBe(false);
    });

    it('drift-log-stays-off-unless-turned-on', () => {
        const s = settled();
        s.stamp(5);
        expect(s.controller.stats.driftLog).toBe(null);
        s.controller.stats.driftLog = [];
        s.stamp(5);
        expect(s.controller.stats.driftLog.length).toBe(1);
    });
});
