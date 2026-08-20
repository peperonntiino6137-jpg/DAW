# ステム分離用アセットの再生成スクリプト。
#
# file:// では fetch/XHR でローカルファイルを読めないため、ONNX モデルと
# onnxruntime-web の実体をすべて「base64 文字列を代入するだけの classic script」
# に変換し、<script> タグ（動的注入）で搬入する。グローバルは
# self.DAW_STEMS_ASSETS の 1 名前空間だけを使う。
#
# 入力（リポジトリに含まれるもの / 含まれないもの）:
#   vendor/ort.wasm.min.js              onnxruntime-web 1.27.0 の wasm 専用ビルド（リポジトリ同梱）
#   vendor/ort-wasm-simd-threaded.mjs   wasm ローダ glue（リポジトリ同梱）
#   vendor/ort-wasm-simd-threaded.wasm  wasm 本体（リポジトリ同梱）
#   htdemucs_embedded.onnx              モデル本体 172MB。リポジトリには含まれない。
#                                       https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx
#                                       から取得して --onnx で渡す（詳細は models/README.md）
#
# 出力:
#   vendor/ort-js.b64.js / ort-mjs.b64.js / ort-wasm.b64.js
#   models/htdemucs/model-000.b64.js ... （24MB/チャンク。base64 後も 1 ファイル 100MB 未満）
#   models/htdemucs/manifest.js           チャンク一覧とサイズ（読み込み側の入口）
#
# 使い方:  python3 models/gen_b64.py --onnx /path/to/htdemucs_embedded.onnx
import argparse
import base64
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
VENDOR = os.path.join(ROOT, 'vendor')
MODEL_DIR = os.path.join(HERE, 'htdemucs')

# 24MB/チャンク。base64 で 1.33 倍になっても 1 ファイル 100MB 未満に収まり、
# GitHub のファイルサイズ上限（100MB）にかからない。
CHUNK = 24 * 1024 * 1024

PRE = ("self.DAW_STEMS_ASSETS = self.DAW_STEMS_ASSETS || {}; "
       "self.DAW_STEMS_ASSETS.modelParts = self.DAW_STEMS_ASSETS.modelParts || [];\n")


def b64_of(path):
    with open(path, 'rb') as f:
        return base64.b64encode(f.read()).decode('ascii')


def emit(path, js):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(js)
    print(f'{os.path.relpath(path, ROOT)}  {os.path.getsize(path) / 1e6:.1f}MB')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--onnx', default=os.path.join(HERE, 'htdemucs_embedded.onnx'),
                    help='htdemucs_embedded.onnx の場所（既定: models/ 直下）')
    ap.add_argument('--skip-vendor', action='store_true',
                    help='vendor/ 側（ort ランタイム）の再生成を省略する')
    args = ap.parse_args()

    if not args.skip_vendor:
        emit(os.path.join(VENDOR, 'ort-js.b64.js'),
             PRE + 'self.DAW_STEMS_ASSETS.ortJs = "%s";\n' % b64_of(os.path.join(VENDOR, 'ort.wasm.min.js')))
        emit(os.path.join(VENDOR, 'ort-mjs.b64.js'),
             PRE + 'self.DAW_STEMS_ASSETS.ortMjs = "%s";\n' % b64_of(os.path.join(VENDOR, 'ort-wasm-simd-threaded.mjs')))
        emit(os.path.join(VENDOR, 'ort-wasm.b64.js'),
             PRE + 'self.DAW_STEMS_ASSETS.ortWasm = "%s";\n' % b64_of(os.path.join(VENDOR, 'ort-wasm-simd-threaded.wasm')))

    if not os.path.exists(args.onnx):
        print(f'モデルが見つかりません: {args.onnx}')
        print('models/README.md の手順で htdemucs_embedded.onnx を取得してから再実行してください。')
        return 1

    os.makedirs(MODEL_DIR, exist_ok=True)
    with open(args.onnx, 'rb') as f:
        data = f.read()
    n = (len(data) + CHUNK - 1) // CHUNK
    files = []
    for k in range(n):
        name = 'model-%03d.b64.js' % k
        part = base64.b64encode(data[k * CHUNK:(k + 1) * CHUNK]).decode('ascii')
        emit(os.path.join(MODEL_DIR, name),
             PRE + 'self.DAW_STEMS_ASSETS.modelParts[%d] = "%s";\n' % (k, part))
        files.append(name)

    manifest = (PRE
                + 'self.DAW_STEMS_ASSETS.manifest = {\n'
                + '  name: "htdemucs",\n'
                + f'  bytes: {len(data)},\n'
                + f'  parts: {n},\n'
                + '  files: [' + ', '.join(f'"{f}"' for f in files) + '],\n'
                + '  source: "https://huggingface.co/timcsy/demucs-web-onnx",\n'
                + '};\n')
    emit(os.path.join(MODEL_DIR, 'manifest.js'), manifest)
    print(f'model: {len(data)} bytes -> {n} parts')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
