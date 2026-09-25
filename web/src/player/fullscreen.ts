/**
 * Going full screen, on the two APIs that exist.
 *
 * Everywhere else, the whole stage goes full screen and our own control bar
 * goes with it. iPhone Safari has no element full screen at all -- only the
 * video itself can go, into iOS's own player -- so there the video element is
 * what we hand over. It is the same element either way, which is what keeps
 * playback running across the transition.
 *
 * One module rather than three copies: the button, the `f` key and the
 * double-click all need this, and the version that only knew about the
 * standard API was wrong in all three places at once.
 */

interface IosVideo extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  /** False until metadata has loaded, so it is a readiness check too. */
  webkitSupportsFullscreen?: boolean;
  webkitDisplayingFullscreen?: boolean;
}

export function isFullscreen(video?: HTMLVideoElement | null): boolean {
  if (document.fullscreenElement) return true;
  return Boolean((video as IosVideo | null | undefined)?.webkitDisplayingFullscreen);
}

export function toggleFullscreen(stage: HTMLElement | null, video: HTMLVideoElement | null): void {
  const ios = video as IosVideo | null;

  if (isFullscreen(video)) {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else ios?.webkitExitFullscreen?.();
    return;
  }

  // Preferred: the stage, so the controls, the up-next card and the lesson
  // title come too.
  if (stage?.requestFullscreen) {
    void stage.requestFullscreen().catch(() => {
      // Refused (iPad in some configurations). The video can still go alone.
      ios?.webkitEnterFullscreen?.();
    });
    return;
  }

  // iPhone. iOS draws its own controls over the video from here, which is why
  // there is nothing to hand it but the element.
  if (ios?.webkitEnterFullscreen && ios.webkitSupportsFullscreen !== false) {
    ios.webkitEnterFullscreen();
  }
}

/**
 * Calls back whenever full screen is entered or left, on either API. iOS fires
 * its own events on the video and never fires `fullscreenchange`, so a listener
 * on the document alone leaves the button showing the wrong icon for the whole
 * time the video is full screen.
 */
export function watchFullscreen(video: HTMLVideoElement | null, onChange: () => void): () => void {
  document.addEventListener('fullscreenchange', onChange);
  video?.addEventListener('webkitbeginfullscreen', onChange);
  video?.addEventListener('webkitendfullscreen', onChange);

  return () => {
    document.removeEventListener('fullscreenchange', onChange);
    video?.removeEventListener('webkitbeginfullscreen', onChange);
    video?.removeEventListener('webkitendfullscreen', onChange);
  };
}
