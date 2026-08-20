#!/usr/bin/env python3
"""テスト結果を1件だけ受け取って保存し、終了する極小HTTPサーバ。

ブラウザ側は file:// オリジンから
  fetch('http://127.0.0.1:8765/result', {method:'POST', mode:'no-cors', body: json})
で結果を送る。no-cors の simple request なのでプリフライトは飛ばず、
レスポンスは opaque になるが送信自体は成功する。

  usage: python3 collect.py [--port 8765] [--out last-result.json] [--timeout 180]

受信すると <out> に本文をそのまま書き出して exit 0。
タイムアウトすると exit 3。
"""
import argparse
import http.server
import os
import socket
import socketserver
import sys
import threading

RESULT = {'body': None}
DONE = threading.Event()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        # 起動確認用のヘルスチェック
        body = b'ok'
        self.send_response(200)
        self._cors()
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else b''
        if RESULT['body'] is None:
            RESULT['body'] = body
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()
        DONE.set()

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'last-result.json'))
    ap.add_argument('--timeout', type=float, default=180.0)
    args = ap.parse_args()

    try:
        srv = Server((args.host, args.port), Handler)
    except OSError as e:
        print(f'collect.py: ポート {args.host}:{args.port} を開けません: {e}', file=sys.stderr)
        return 2

    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    print(f'collect.py: listening on http://{args.host}:{args.port}/ -> {args.out}', flush=True)

    got = DONE.wait(args.timeout)
    srv.shutdown()
    if not got:
        print('collect.py: タイムアウト（結果を受信できませんでした）', file=sys.stderr)
        return 3

    with open(args.out, 'wb') as f:
        f.write(RESULT['body'] or b'')
    print(f'collect.py: 結果を保存しました ({len(RESULT["body"] or b"")} bytes)', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
