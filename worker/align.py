#!/usr/bin/env python3
"""Word timestamps of the narration (faster-whisper, CPU).

usage: align.py <audio> [model]   ->  JSON list of {"w": word, "s": start, "e": end} on stdout

The TTS gives no timings, so the captions are synced to what is actually
heard: the recognized words are matched to the script words in TypeScript.
"""
import json
import subprocess
import sys

import numpy as np
from faster_whisper import WhisperModel


def load_audio(path: str) -> np.ndarray:
    # decode with the ffmpeg binary (16 kHz mono float), not PyAV
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


def main() -> None:
    audio = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "base"
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(load_audio(audio), language="pt", word_timestamps=True, vad_filter=False, beam_size=1)
    words = []
    for seg in segments:
        for w in seg.words or []:
            words.append({"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3)})
    json.dump(words, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
