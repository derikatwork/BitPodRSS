/**
 * Only one thing should talk at a time: a podcast or read-aloud. Each registers how to silence itself, and
 * whichever starts calls {@link claimAudio} to silence the others. This module imports nothing, which keeps
 * the player and the speech store from depending on each other.
 */
export type AudioChannel = 'podcast' | 'speech';

const silencers = new Map<AudioChannel, () => void>();

export function registerAudio(channel: AudioChannel, silence: () => void): void {
  silencers.set(channel, silence);
}

/** Silence every channel except `channel`. */
export function claimAudio(channel: AudioChannel): void {
  for (const [other, silence] of silencers) if (other !== channel) silence();
}
