# -*- coding: utf-8 -*-
"""Smoke test for sidecar.py: /ping, /separate (DAWS framing), /progress.

Usage:
    python test_sidecar.py [input.wav]

If no WAV is given, a 30-second synthetic test tune (kick/bass/pad/lead)
is generated in a temp file with stdlib only, so the test is self-contained.
Requires a running sidecar (start-sidecar.bat). Full round trip takes
roughly 15-30 s on CPU (model load included on the first run).
"""
import json
import math
import os
import random
import struct
import sys
import tempfile
import threading
import time
import urllib.request
import wave

BASE = "http://127.0.0.1:8787"


def gen_test_wav(path, dur=30):
    """Write a 44.1 kHz stereo test WAV with drum/bass/pad/lead-ish content."""
    sr = 44100
    random.seed(42)
    frames = bytearray()
    for i in range(sr * dur):
        t = i / sr
        beat = (t * 2.0) % 1.0  # 120 BPM
        bar = int(t * 0.5) % 3
        bass_f = (55.0, 73.4, 82.4)[bar]
        bass = 0.30 * math.sin(2 * math.pi * bass_f * t)
        pad = 0.10 * (math.sin(2 * math.pi * 220 * t) +
                      math.sin(2 * math.pi * 277.2 * t) +
                      math.sin(2 * math.pi * 329.6 * t))
        vib = 5 * math.sin(2 * math.pi * 5 * t)
        lead = 0.15 * math.sin(2 * math.pi * (440 + vib) * t) * (0.5 + 0.5 * math.sin(2 * math.pi * 0.25 * t))
        kick = 0.5 * math.exp(-beat * 30) * math.sin(2 * math.pi * 60 * (1 + 4 * math.exp(-beat * 40)) * beat) if beat < 0.2 else 0.0
        hat = 0.12 * math.exp(-((beat + 0.5) % 1.0) * 60) * (random.random() * 2 - 1)
        l = bass + pad + lead + kick + hat
        r = bass + pad * 0.8 + lead * 1.1 + kick + hat * 0.7
        frames += struct.pack("<hh",
                              max(-32767, min(32767, int(l * 32767 * 0.7))),
                              max(-32767, min(32767, int(r * 32767 * 0.7))))
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(bytes(frames))


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as r:
        return json.loads(r.read())


def main():
    print("ping:", get("/ping"))

    tmp = None
    if len(sys.argv) > 1:
        wav_path = sys.argv[1]
    else:
        fd, tmp = tempfile.mkstemp(suffix=".wav", prefix="daw_sidecar_test_")
        os.close(fd)
        print("generating 30 s test WAV ...")
        gen_test_wav(tmp)
        wav_path = tmp
    try:
        wav = open(wav_path, "rb").read()

        done = threading.Event()

        def poll():
            while not done.is_set():
                try:
                    print("progress:", get("/progress"))
                except Exception as e:
                    print("progress poll failed:", e)
                done.wait(10)

        threading.Thread(target=poll, daemon=True).start()

        t0 = time.time()
        req = urllib.request.Request(
            BASE + "/separate", data=wav,
            headers={"Content-Type": "application/octet-stream"}, method="POST")
        with urllib.request.urlopen(req, timeout=1800) as r:
            body = r.read()
            ctype = r.headers.get("Content-Type")
        done.set()
        dt = time.time() - t0

        assert body[:4] == b"DAWS", "bad magic: %r" % body[:8]
        n = struct.unpack("<I", body[4:8])[0]
        hdr = json.loads(body[8:8 + n])
        base = 8 + n
        print("HTTP round-trip: %.1fs  content-type: %s  total bytes: %d" % (dt, ctype, len(body)))
        for s in hdr["stems"]:
            blob = body[base + s["offset"]: base + s["offset"] + s["length"]]
            ok = blob[:4] == b"RIFF"
            print("  stem %-7s %8d bytes  RIFF=%s" % (s["name"], s["length"], ok))
            assert ok
        print("final progress:", get("/progress"))
        print("OK")
    finally:
        if tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass


if __name__ == "__main__":
    main()
