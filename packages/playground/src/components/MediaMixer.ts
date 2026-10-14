import * as alphaTab from '@coderline/alphatab';
import { type Mountable, css, html, injectStyles, mount, parseHtml } from '../util/Dom';
import { Icons } from '../util/Icons';
import { Slider } from './primitives/Slider';
import { ToggleButton } from './primitives/ToggleButton';

injectStyles(
    'MediaMixer',
    css`
    .at-media-mixer {
        display: flex;
        align-items: center;
    }
    .at-media-mixer.hidden { display: none; }
    .at-media-mixer > * { margin-right: 4px; }
    .at-media-mixer-label {
        font-size: 12px;
        padding: 0 4px;
    }
    .at-media-mixer .at-slider { width: 70px; }
`
);

/**
 * Balances the backing track against the synthesizer while both play together
 * (`player.enableSynthesizerWithMedia`). Shown only while that combined player is active.
 */
export class MediaMixer implements Mountable {
    readonly root: HTMLElement;
    private muteMedia: ToggleButton;
    private mediaVolume: Slider;
    private synthVolume: Slider;
    private subscriptions: (() => void)[] = [];

    constructor(private api: alphaTab.AlphaTabApi) {
        this.root = parseHtml(html`
            <div class="at-media-mixer hidden">
                <div class="cmp-mute-media"></div>
                <span class="at-media-mixer-label">Backing track</span>
                <div class="cmp-media-volume"></div>
                <span class="at-media-mixer-label">Instruments</span>
                <div class="cmp-synth-volume"></div>
            </div>
        `);

        this.muteMedia = mount(
            this.root,
            '.cmp-mute-media',
            new ToggleButton({ icon: Icons.DownloadAudio, tooltip: 'Mute backing track' })
        );
        this.muteMedia.onChange = () => this.applyMediaVolume();

        // above 1 the backing track is only louder through the mixing graph, which is the case here
        this.mediaVolume = mount(
            this.root,
            '.cmp-media-volume',
            new Slider({ min: 0, max: 2, step: 0.05, initialValue: 1 })
        );
        this.mediaVolume.onInput = () => this.applyMediaVolume();

        this.synthVolume = mount(
            this.root,
            '.cmp-synth-volume',
            new Slider({ min: 0, max: 3, step: 0.1, initialValue: 1 })
        );
        this.synthVolume.onInput = value => {
            api.synthVolume = value;
        };

        this.subscriptions.push(api.scoreLoaded.on(() => this.refresh()));
        this.subscriptions.push(api.playerReady.on(() => this.refresh()));
    }

    private applyMediaVolume(): void {
        this.api.backingTrackVolume = this.muteMedia.isActive() ? 0 : this.mediaVolume.getValue();
    }

    private refresh(): void {
        const mixing =
            this.api.settings.player.enableSynthesizerWithMedia &&
            this.api.actualPlayerMode === alphaTab.PlayerMode.EnabledBackingTrack;
        this.root.classList.toggle('hidden', !mixing);
    }

    dispose(): void {
        for (const u of this.subscriptions) {
            u();
        }
        this.subscriptions = [];
        this.root.remove();
    }
}
