# -*- coding: utf-8 -*-
"""Stem-separation sidecar server for the Web Audio DAW.

Runs demucs (htdemucs, CPU) behind a tiny stdlib-only HTTP server so that the
browser (even on file://) can offload stem separation to native Python.

Endpoints (all responses carry Access-Control-Allow-Origin: *):

  GET  /ping      -> {"ok":true,"version":"<demucs version>","model":"htdemucs",
                      "busy":false}
  GET  /progress  -> {"running":bool,"progress":0.0-1.0,"stage":"...","error":null}
  POST /separate  -> body = WAV (or anything ffmpeg/soundfile can read is NOT
                     supported; send WAV). Optional query: ?model=htdemucs
                     Response 200 = framed binary (see below), 409 if busy,
                     499 if cancelled, 500 on failure (JSON {"error":...}).
  POST /cancel    -> kills the running demucs process. {"ok":true,"cancelled":bool}

/separate response framing ("DAWS" format), Content-Type: application/octet-stream:

  bytes 0..3   magic  "DAWS"
  bytes 4..7   uint32 little-endian: JSON header length N
  bytes 8..8+N JSON header: {"stems":[{"name":"drums","offset":0,"length":123},...]}
               offsets are relative to the start of the payload section
  8+N..        payload: concatenated WAV files

Browser-side parse:
  const buf = await resp.arrayBuffer();
  const dv = new DataView(buf);
  // check magic, then:
  const n = dv.getUint32(4, true);
  const hdr = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, n)));
  const base = 8 + n;
  for (const s of hdr.stems) {
    const wavBytes = buf.slice(base + s.offset, base + s.offset + s.length);
    const audioBuf = await audioCtx.decodeAudioData(wavBytes);
  }

Security: binds to 127.0.0.1 only. One separation at a time.
"""

import io
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = 8787  # deliberately NOT 8765 (test runner uses that)
DEFAULT_MODEL = "htdemucs"
ALLOWED_MODELS = {"htdemucs", "htdemucs_ft", "htdemucs_6s", "mdx_extra_q"}
MAX_BODY = 512 * 1024 * 1024  # 512 MB upload cap

try:
    from importlib.metadata import version as _pkg_version
    DEMUCS_VERSION = _pkg_version("demucs")
except Exception:
    DEMUCS_VERSION = "unknown"


class State:
    """Shared state for the single in-flight separation job."""
    lock = threading.Lock()      # guards acquisition of the job slot
    running = False
    proc = None                  # subprocess.Popen of demucs
    progress = 0.0               # 0.0 .. 1.0
    stage = "idle"               # idle | loading | separating | encoding | done | error | cancelled
    error = None
    cancelled = False


PROGRESS_RE = re.compile(rb"(\d+(?:\.\d+)?)%")


def _drain_stderr(pipe):
    """Read demucs stderr, parsing tqdm progress ('  42%|###  | ...')."""
    tail = []
    buf = b""
    while True:
        chunk = pipe.read(256)
        if not chunk:
            break
        buf += chunk
        # tqdm uses \r to refresh the same line
        while b"\r" in buf or b"\n" in buf:
            sep = b"\r" if b"\r" in buf else b"\n"
            i = min([x for x in (buf.find(b"\r"), buf.find(b"\n")) if x >= 0])
            line, buf = buf[:i], buf[i + 1:]
            if not line.strip():
                continue
            m = PROGRESS_RE.search(line)
            if m:
                try:
                    State.progress = min(1.0, float(m.group(1)) / 100.0)
                    State.stage = "separating"
                except ValueError:
                    pass
            else:
                tail.append(line[-300:])
                if len(tail) > 40:
                    tail.pop(0)
    return b"\n".join(tail)


def run_separation(wav_bytes, model):
    """Run demucs on wav_bytes; return list of (stem_name, wav_bytes).

    Raises RuntimeError on failure, including cancellation."""
    workdir = tempfile.mkdtemp(prefix="daw_stems_")
    try:
        in_path = os.path.join(workdir, "input.wav")
        with open(in_path, "wb") as f:
            f.write(wav_bytes)
        out_dir = os.path.join(workdir, "out")

        State.progress = 0.0
        State.stage = "loading"
        State.error = None
        State.cancelled = False

        cmd = [
            sys.executable, "-m", "demucs",
            "-n", model,
            "-d", "cpu",
            "-o", out_dir,
            "--filename", "{stem}.{ext}",
            in_path,
        ]
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=workdir,
        )
        State.proc = proc
        stderr_tail_holder = {}

        def reader():
            stderr_tail_holder["tail"] = _drain_stderr(proc.stderr)

        t = threading.Thread(target=reader, daemon=True)
        t.start()
        proc.stdout.read()  # drain (demucs prints little to stdout)
        rc = proc.wait()
        t.join(timeout=10)
        State.proc = None

        if State.cancelled:
            raise RuntimeError("cancelled")
        if rc != 0:
            tail = stderr_tail_holder.get("tail", b"")
            raise RuntimeError(
                "demucs exited with code %d: %s"
                % (rc, tail.decode("utf-8", "replace")[-500:])
            )

        State.stage = "encoding"
        stem_dir = os.path.join(out_dir, model)
        if not os.path.isdir(stem_dir):
            raise RuntimeError("demucs produced no output directory")
        stems = []
        order = ["drums", "bass", "other", "vocals", "guitar", "piano"]
        names = sorted(
            (n[:-4] for n in os.listdir(stem_dir) if n.endswith(".wav")),
            key=lambda n: order.index(n) if n in order else 99,
        )
        if not names:
            raise RuntimeError("demucs produced no stem files")
        for name in names:
            with open(os.path.join(stem_dir, name + ".wav"), "rb") as f:
                stems.append((name, f.read()))
        return stems
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def frame_response(stems):
    """Build the DAWS framed binary response body."""
    entries = []
    offset = 0
    for name, data in stems:
        entries.append({"name": name, "offset": offset, "length": len(data)})
        offset += len(data)
    header = json.dumps({"stems": entries}).encode("utf-8")
    out = io.BytesIO()
    out.write(b"DAWS")
    out.write(struct.pack("<I", len(header)))
    out.write(header)
    for _, data in stems:
        out.write(data)
    return out.getvalue()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "DAWStemsSidecar/1.0"

    # ---- helpers -----------------------------------------------------------
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_binary(self, body):
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("[sidecar] %s\n" % (fmt % args))

    # ---- verbs -------------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/ping":
            self._send_json(200, {
                "ok": True,
                "version": DEMUCS_VERSION,
                "model": DEFAULT_MODEL,
                "busy": State.running,
            })
        elif path == "/progress":
            self._send_json(200, {
                "running": State.running,
                "progress": round(State.progress, 4),
                "stage": State.stage,
                "error": State.error,
            })
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        path, _, query = self.path.partition("?")
        if path == "/cancel":
            proc = State.proc
            cancelled = False
            if proc is not None and proc.poll() is None:
                State.cancelled = True
                State.stage = "cancelled"
                try:
                    proc.kill()
                    cancelled = True
                except OSError:
                    pass
            self._send_json(200, {"ok": True, "cancelled": cancelled})
            return
        if path != "/separate":
            self._send_json(404, {"error": "not found"})
            return

        # ---- /separate -----------------------------------------------------
        model = DEFAULT_MODEL
        for part in query.split("&"):
            if part.startswith("model="):
                model = part[6:]
        if model not in ALLOWED_MODELS:
            self._send_json(400, {"error": "unknown model %r" % model})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            self._send_json(400, {"error": "empty body (send WAV bytes)"})
            return
        if length > MAX_BODY:
            self._send_json(413, {"error": "body too large"})
            return

        if not State.lock.acquire(blocking=False):
            self._send_json(409, {"error": "busy"})
            return
        if State.running:
            State.lock.release()
            self._send_json(409, {"error": "busy"})
            return
        State.running = True
        State.lock.release()

        try:
            body = self.rfile.read(length)
            if body[:4] != b"RIFF":
                self._send_json(400, {"error": "body is not a WAV (RIFF) file"})
                return
            stems = run_separation(body, model)
            State.stage = "done"
            State.progress = 1.0
            self._send_binary(frame_response(stems))
        except RuntimeError as e:
            if str(e) == "cancelled":
                State.stage = "cancelled"
                self._send_json(499, {"error": "cancelled"})
            else:
                State.stage = "error"
                State.error = str(e)
                self._send_json(500, {"error": str(e)})
        except Exception as e:  # noqa: BLE001 - report anything to the client
            State.stage = "error"
            State.error = str(e)
            self._send_json(500, {"error": str(e)})
        finally:
            State.running = False


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("DAW stems sidecar listening on http://%s:%d  (demucs %s, model %s)"
          % (HOST, PORT, DEMUCS_VERSION, DEFAULT_MODEL))
    print("Endpoints: GET /ping  GET /progress  POST /separate  POST /cancel")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
