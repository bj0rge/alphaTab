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

    it('readings-4-ms-apart-do-not-agree', () => {
        // §6.2: only readings within 3 ms of each other count as agreed
        const s = setup();
        s.controller.startedAfterHandOff(1, true);
        s.stamp(20);
        s.stamp(24); // 4 apart: not agreed, so no re-sync (a mean of 22 is above the 12 ms threshold) and no learning
        expect(s.synth.seeks).toEqual([]);
        expect(s.controller.mediaStartLatencies.size).toBe(0);
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

    it('float-noise-around-1x-counts-as-1x', () => {
        // a tempo sweep that sums its steps lands on 1 - 1e-12, not on 1
        const noisy = 1 - 1e-12;
        const { controller } = setup();
        expect(controller.settleThreshold(noisy)).toBe(controller.settleThreshold(1));
        expect(MediaSyncController.preRoll(noisy, true)).toBe(0);
        const plan = controller.planStart(5000, noisy, 3); // 1x: no pre-roll, the latency is a catch-up gap
        expect(plan.mediaSeekTo).toBe(5000);
        expect(plan.catchUpGapMs).toBeCloseTo(3, 6);

        const settling = setup();
        settling.controller.startedAfterHandOff(noisy, false);
        settling.stamp(3);
        settling.stamp(3);
        expect(settling.controller.correction).toBeCloseTo(1 - 3 / 300, 9); // the faster settling nudge of 1x
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

    it('the-nudge-averages-the-readings-with-a-30-percent-step', () => {
        // §6.2: the average starts at the first reading, then moves 30% of the way to each next one
        const s = settled();
        s.stamp(30);
        s.stamp(60); // 30 apart: not agreed, so the nudge acts; the average is 30 + 0.3 * (60 - 30) = 39
        expect(s.controller.correction).toBeCloseTo(1 - 39 / 3000, 9);
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

    it('the-learned-re-sync-lead-is-clamped-to-100-ms', () => {
        const s = settled();
        s.controller.resync();
        s.time.t += 150;
        s.stamp(-100); // t = resync + 200: read again
        s.stamp(-100); // agreed -100: the synth came out 100 ms behind; 10 + 100 would be 110
        expect(s.controller.stats.resyncLeadMs).toBe(100);
        s.controller.resync();
        expect(s.synth.seeks[s.synth.seeks.length - 1]).toBe(12345 + 100);
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

    it('the-learned-media-start-latency-is-clamped-to-250-ms', () => {
        const s = setup();
        s.controller.startedAfterHandOff(1, true);
        s.stamp(300);
        s.stamp(300); // the media started 300 ms late; one start can teach at most 250
        expect(s.controller.mediaStartLatencies.get(1)).toBe(250);
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

describe('MediaSyncControllerStartTests', () => {
    it('start-at-1x-is-at-the-target-never-past-it', () => {
        const { controller } = setup();
        let plan = controller.planStart(5000, 1, 0);
        expect([plan.mediaSeekTo, plan.synthSeekTo, plan.mediaDelayMs, plan.catchUpGapMs]).toEqual([5000, 5000, 0, 0]);

        plan = controller.planStart(5000, 1, 3); // a positive latency at 1x: caught up, never pre-rolled past
        expect([plan.synthSeekTo, plan.catchUpGapMs]).toEqual([5000, 3]);

        controller.startLeads.set(1, 8); // the synth is slower: delay the media
        plan = controller.planStart(5000, 1, 0);
        expect([plan.synthSeekTo, plan.mediaDelayMs]).toEqual([5000, 8]);

        controller.startLeads.set(1, -6); // the media is slower: the synth starts earlier in the song
        plan = controller.planStart(5000, 1, 0);
        expect([plan.synthSeekTo, plan.mediaDelayMs]).toEqual([4994, 0]);
    });

    it('start-at-other-speeds-pre-rolls-and-starts-the-synth-where-the-media-is-heard', () => {
        const { controller } = setup();
        let plan = controller.planStart(5000, 0.5, 60); // spec §6.4: 0.5x latency 60 ms
        expect(plan.mediaSeekTo).toBe(4940);
        expect(plan.synthSeekTo).toBe(4940 + 60 * 0.5);
        expect(plan.synthSeekTo).toBeLessThan(5000);
        plan = controller.planStart(5000, 1.5, -4);
        expect(plan.mediaSeekTo).toBe(4940);
        expect(plan.synthSeekTo).toBeCloseTo(4940 - 6, 9);
    });

    it('the-pre-roll-stops-at-the-media-start', () => {
        // a start near media time 0 (a recording whose bar 1 is at its very start: Play from the start, a loop from
        // bar 1): the media can't seek below 0
        const { controller } = setup();
        let plan = controller.planStart(0, 0.5, 60);
        expect(plan.mediaSeekTo).toBe(0);
        expect(plan.synthSeekTo).toBe(60 * 0.5); // where the media is first heard
        plan = controller.planStart(30, 1.5, 0);
        expect([plan.mediaSeekTo, plan.synthSeekTo]).toEqual([0, 0]);
    });

    it('an-unlearned-speed-uses-the-straight-line-guess', () => {
        // F-9a, spike 11 §2
        const { controller } = setup();
        controller.startLeads.set(0.5, -36);
        controller.startLeads.set(0.75, -25.4);
        controller.startLeads.set(1, 5.7);
        const plan = controller.planStart(5000, 0.625, 0);
        expect(plan.synthSeekTo).toBeCloseTo(4940 - 30.7 * 0.625, 6);
        expect(plan.mediaDelayMs).toBe(0);
    });

    it('learns-the-start-lead-from-the-median-of-the-first-three-readings', () => {
        const s = setup();
        s.controller.started(s.controller.planStart(5000, 1, 0), true);
        s.stamp(-4);
        s.stamp(-6);
        expect(s.synth.corrections).toEqual([]); // waiting for three readings
        s.stamp(-5); // median -5: the synth started 5 ms behind
        expect(s.controller.startLeads.get(1)).toBe(5);
    });

    it('start-lead-is-per-speed-and-clamped', () => {
        const s = setup();
        s.controller.started(s.controller.planStart(5000, 0.5, 0), true);
        s.stamp(-14);
        s.stamp(-14.5);
        s.stamp(-14.2);
        expect(s.controller.startLeads.get(0.5)).toBeCloseTo(14.2 / 0.5, 9);
        expect(s.controller.startLeads.has(1)).toBe(false);

        const far = setup();
        far.controller.started(far.controller.planStart(5000, 0.5, 0), true);
        far.stamp(-200);
        far.stamp(-201);
        expect(far.controller.startLeads.get(0.5)).toBe(150); // G-4 clamp
    });

    it('a-re-sync-before-three-readings-learns-from-the-agreed-offset', () => {
        const s = setup();
        s.controller.started(s.controller.planStart(5000, 1, 0), true);
        s.stamp(20);
        s.stamp(21); // 20.5 > 12 while settling
        expect(s.synth.seeks.length).toBe(1);
        expect(s.controller.startLeads.get(1)).toBeCloseTo(-20.5, 9);
    });

    it('one-late-start-teaches-nothing', () => {
        const s = setup();
        const start = (offset: number) => {
            s.time.t += 5000;
            s.controller.started(s.controller.planStart(5000, 1, 0), true);
            s.stamp(offset);
            s.stamp(offset);
            s.stamp(offset);
        };
        start(-5); // the first start at a speed learns at once: the synth was 5 ms behind
        expect(s.controller.startLeads.get(1)).toBe(5);
        start(200); // the media started 200 ms late, once: the synth ran ahead
        expect(s.controller.startLeads.get(1)).toBe(5);
        start(0);
        expect(s.controller.startLeads.get(1)).toBe(5);
        start(-20); // the synth now comes out 20 ms later: one start doesn't move it
        expect(s.controller.startLeads.get(1)).toBe(5);
        start(-20); // two in a row that agree do
        expect(s.controller.startLeads.get(1)).toBe(25);
    });

    it('the-catch-up-gap-raises-the-settle-threshold-until-caught-up', () => {
        const s = setup();
        s.controller.started(s.controller.planStart(5000, 1, 10), false); // gap 10 ms
        s.stamp(-15);
        s.stamp(-15.5); // |-15.25| < 12 + 10: nudge (speed up), no re-sync
        expect(s.synth.seeks).toEqual([]);
        expect(s.controller.correction).toBeGreaterThan(1);
        s.stamp(-1);
        s.stamp(-1.5); // caught up (within 2 ms): the gap no longer counts
        s.stamp(-13);
        s.stamp(-13.5); // 13.25 > 12
        expect(s.synth.seeks.length).toBe(1);
    });

    it('the-media-delay-is-ignored-until-the-media-starts', () => {
        const s = setup();
        s.controller.startLeads.set(1, 100);
        s.controller.started(s.controller.planStart(5000, 1, 0), false);
        s.stamp(500);
        s.stamp(500); // within the 100 ms media delay
        expect(s.synth.seeks).toEqual([]);
    });

    it('hand-off-play-time-subtracts-the-latency-and-the-pre-roll', () => {
        const { controller } = setup();
        controller.mediaStartLatencies.set(0.5, 20);
        expect(controller.handOffPlayTime(96000, 48000, 0.5, 120)).toBeCloseTo(2 - (20 + 240) / 1000, 12);
    });

    it('pre-roll-rules', () => {
        expect(MediaSyncController.preRoll(1, true)).toBe(0);
        expect(MediaSyncController.preRoll(1, false)).toBe(0);
        expect(MediaSyncController.preRoll(1.5, true)).toBe(60);
        expect(MediaSyncController.preRoll(1.25, false)).toBe(60);
        expect(MediaSyncController.preRoll(0.5, false)).toBe(60);
        expect(MediaSyncController.preRoll(0.5, true)).toBe(120); // F-14 (D-3)
    });

    it('latency-change-settles-without-resync', () => {
        // F-9a probe part (D-1)
        const s = settled();
        s.controller.latencyChanged();
        expect(s.controller.isSettling).toBe(true);
        expect(s.synth.seeks).toEqual([]);
    });

    it('a-start-resets-the-correction', () => {
        const s = settled();
        s.stamp(30);
        expect(s.controller.correction).toBeLessThan(1);
        s.controller.started(s.controller.planStart(5000, 1, 0), false);
        expect(s.controller.correction).toBe(1);
    });

    it('a-speed-change-before-the-first-agreed-reading-teaches-no-media-start-latency', () => {
        // the next agreed reading would measure the re-sync, not the media's start
        const s = setup();
        s.controller.startedAfterHandOff(1, true);
        s.stamp(20); // one reading: nothing agreed yet
        s.controller.speedChanged(0.5);
        s.time.t += 200; // past the 200 ms the re-sync ignores
        s.stamp(20);
        s.stamp(20);
        expect(s.controller.mediaStartLatencies.size).toBe(0);
    });

    it('a-speed-change-before-the-start-lead-is-learned-teaches-no-start-lead', () => {
        // the next readings would measure the re-sync, not the synthesizer's start
        const s = setup();
        s.controller.started(s.controller.planStart(5000, 1, 0), true);
        s.stamp(-8); // one reading of the three
        s.controller.speedChanged(0.5);
        s.time.t += 200; // past the 200 ms the re-sync ignores
        s.stamp(-8);
        s.stamp(-8);
        s.stamp(-8);
        expect(s.controller.startLeads.size).toBe(0);
    });
});
