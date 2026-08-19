#!/usr/bin/env python3
"""index.html から回帰テスト用ページ test/.verify.generated.html を生成する。

verify ページを静的に持つとアプリ本体（script タグ・DOM id）の変更に追従できず
壊れるため、毎回 index.html から生成する。やっていることは3つだけ:

  1. href="style.css" / src="js/..." を ../ 始まりに書き換える（test/ から見た相対パス）
  2. 最初の <script> の直前に harness.js（エラー収集・alert/confirm スタブ・
     ウォッチドッグ）を差し込む ... アプリ本体より前に仕掛ける必要があるため
  3. </body> の直前に tests.js（テスト本体と結果送信）と、
     追加スイート tests-*.js を名前順で差し込む

  usage: python3 build-verify.py [--out <path>]
"""
import argparse
import datetime
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
INDEX = os.path.join(ROOT, 'index.html')

CORE = ['js/state.js', 'js/plugins.js', 'js/wav.js', 'js/audio.js', 'js/ui.js', 'js/main.js']


def build(out_path, include=()):
    if not os.path.exists(INDEX):
        print(f'ERROR: {INDEX} が見つかりません', file=sys.stderr)
        return None
    with open(INDEX, encoding='utf-8') as f:
        html = f.read()

    scripts = re.findall(r'<script[^>]*\ssrc="([^"]+)"', html)
    styles = re.findall(r'<link[^>]*\shref="([^"]+\.css)"', html)

    missing = [s for s in CORE if s not in scripts]
    if missing:
        print(f'WARN: index.html に想定スクリプトがありません: {missing}', file=sys.stderr)

    # 1) 相対パスを test/ から見たものに書き換える
    html = re.sub(r'href="(?!(?:https?:)?//|\.\./|/)([^"]+\.css)"', r'href="../\1"', html)
    html = re.sub(r'src="(?!(?:https?:)?//|\.\./|/)(js/[^"]+)"', r'src="../\1"', html)

    meta = {
        'source': 'index.html',
        'generatedAt': datetime.datetime.now().isoformat(timespec='seconds'),
        'scripts': scripts,
        'styles': styles,
        'generator': 'test/build-verify.py',
    }
    prelude = (
        '  <!-- 以下 2 行は test/build-verify.py が挿入 -->\n'
        '  <script>window.__VERIFY_META = ' + json.dumps(meta, ensure_ascii=False) + ';</script>\n'
        '  <script src="harness.js"></script>\n'
    )
    # tests.js のあとに tests-*.js（追加スイート）を名前順で差し込む。
    # 追加スイートは tests.js が定義する T() / H を使う（後から読むので定義済み）。
    extra = sorted(f for f in os.listdir(HERE)
                   if f.startswith('tests-') and f.endswith('.js'))
    runner = '  <!-- 以下は test/build-verify.py が挿入 -->\n  <script src="tests.js"></script>\n'
    for f in extra:
        runner += f'  <script src="{f}"></script>\n'
    for f in include:
        runner += f'  <script src="{f}"></script>\n'
    meta['testFiles'] = ['tests.js'] + extra + list(include)

    m = re.search(r'^[ \t]*<script', html, re.M)
    if not m:
        print('ERROR: index.html に <script> が見つかりません', file=sys.stderr)
        return None
    html = html[:m.start()] + prelude + html[m.start():]

    if '</body>' not in html:
        print('ERROR: index.html に </body> が見つかりません', file=sys.stderr)
        return None
    html = html.replace('</body>', runner + '</body>', 1)

    title = re.sub(r'<title>.*?</title>', '<title>DAW 回帰テスト</title>', html, count=1, flags=re.S)
    html = title

    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(html)
    return meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(HERE, '.verify.generated.html'))
    ap.add_argument('--quiet', action='store_true')
    ap.add_argument('--include', action='append', default=[],
                    help='既定のテストに加えて差し込むスクリプト（例: bench.js）')
    args = ap.parse_args()
    meta = build(args.out, args.include)
    if meta is None:
        return 2
    if not args.quiet:
        print(f'build-verify.py: {args.out} を生成 '
              f'(scripts={len(meta["scripts"])}, styles={len(meta["styles"])})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
