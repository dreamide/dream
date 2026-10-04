// The chime for chat activity, synthesized so the app ships no audio file:
// two short sine notes, the second a fifth above the first.

const NOTES_HZ = [660, 990];
const NOTE_SECONDS = 0.16;
const NOTE_GAP_SECONDS = 0.11;
const PEAK_GAIN = 0.12;

let context: AudioContext | null = null;

export const playNotificationSound = () => {
  try {
    context ??= new AudioContext();
    const audio = context;
    if (audio.state === "suspended") void audio.resume();

    NOTES_HZ.forEach((frequency, index) => {
      const start = audio.currentTime + index * NOTE_GAP_SECONDS;
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      // A quick attack and an exponential fade, so the note does not click.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + NOTE_SECONDS);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(start);
      oscillator.stop(start + NOTE_SECONDS);
    });
  } catch {
    // No audio output: the notification is simply silent.
  }
};
