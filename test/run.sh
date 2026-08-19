#!/usr/bin/env bash
# ブラウザDAWの回帰テストランナー。
#
#   bash test/run.sh            通常実行
#   bash test/run.sh --keep     Chrome のプロファイル一時ディレクトリを残す
#   bash test/run.sh --bench    通常のテストに加えて性能ベンチ（test/bench.js）も走らせる
#   PORT=9000 bash test/run.sh  収集サーバのポートを変更
#
# この環境には node / npm が無いため、テストランナーは python3 + bash +
# google-chrome (headless) だけで完結させている。
# Linux と Windows (Git Bash) の両方で動く。Windows 対応の要点:
#   - python3 が Microsoft Store のスタブのことがあるため、実際に動くものを選ぶ
#   - chrome.exe は POSIX パス (/c/Users/...) を解釈できないため cygpath で変換する
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PORT="${PORT:-8765}"
TIMEOUT="${TIMEOUT:-180}"
RESULT="$HERE/last-result.json"
PAGE="$HERE/.verify.generated.html"
KEEP=0
BENCH=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --bench) BENCH=1 ;;
  esac
done
[ "$BENCH" = "1" ] && TIMEOUT="${TIMEOUT:-300}"

CHROME="${CHROME:-}"
if [ -z "$CHROME" ]; then
  for c in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
  done
fi
if [ -z "$CHROME" ]; then
  # Windows (Git Bash): PATH に無くても標準のインストール先にあれば使う
  for c in "/c/Program Files/Google/Chrome/Application/chrome.exe" \
           "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"; do
    if [ -x "$c" ]; then CHROME="$c"; break; fi
  done
fi
if [ -z "$CHROME" ]; then
  echo "ERROR: google-chrome / chromium が見つかりません。CHROME=... で指定してください。" >&2
  exit 2
fi

# Windows では python3 が Microsoft Store のスタブ（実行すると Store 誘導で失敗）
# のことがあるため、`-c ''` を実際に走らせて動くものを採用する。
PYTHON="${PYTHON:-}"
if [ -z "$PYTHON" ]; then
  for p in python3 python; do
    if command -v "$p" >/dev/null 2>&1 && "$p" -c '' >/dev/null 2>&1; then
      PYTHON="$p"; break
    fi
  done
fi
if [ -z "$PYTHON" ]; then
  echo "ERROR: 動作する python3 / python が見つかりません。" >&2
  exit 2
fi
# Windows の python は標準出力が cp932 になり、テスト結果内の UTF-8 文字
# （≈ など）で UnicodeEncodeError になるため、常に UTF-8 モードで動かす。
export PYTHONUTF8=1

# chrome.exe (Windows ネイティブ) は Git Bash の POSIX パス (/c/Users/... や /tmp/...)
# を解釈できない。cygpath があるとき（= Git Bash / Cygwin）だけ C:/... 形式へ変換する。
# Linux では cygpath が無いのでそのまま返り、従来と同じ挙動になる。
native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi
}

PROFILE="$(mktemp -d /tmp/daw-test-profile.XXXXXX)"
CHROME_LOG="$(mktemp /tmp/daw-test-chrome.XXXXXX.log)"
COLLECT_LOG="$(mktemp /tmp/daw-test-collect.XXXXXX.log)"
CHROME_PID=""
COLLECT_PID=""

kill_chrome() {
  [ -z "$CHROME_PID" ] && return
  kill "$CHROME_PID" 2>/dev/null
  wait "$CHROME_PID" 2>/dev/null
  CHROME_PID=""
}

cleanup() {
  kill_chrome
  if [ -n "$COLLECT_PID" ]; then
    kill "$COLLECT_PID" 2>/dev/null
    wait "$COLLECT_PID" 2>/dev/null
    COLLECT_PID=""
  fi
  if [ "$KEEP" = "1" ]; then
    echo "（一時ファイルを保持: $PROFILE / $CHROME_LOG / $COLLECT_LOG）"
    return
  fi
  # Chrome の子プロセスがプロファイルを掴んだままのことがあるので少し待って再試行する
  rm -rf "$PROFILE" 2>/dev/null
  if [ -d "$PROFILE" ]; then
    "$PYTHON" -c 'import time; time.sleep(0.4)' 2>/dev/null
    rm -rf "$PROFILE" 2>/dev/null
  fi
  rm -f "$CHROME_LOG" "$COLLECT_LOG" 2>/dev/null
}
trap cleanup EXIT INT TERM

rm -f "$RESULT"

# --- index.html からテストページを生成 -------------------------------------
# 静的な verify.html を持つと本体の script タグ / DOM id 追加に追従できないため、
# 毎回 index.html から生成する（詳細は test/build-verify.py）。
BUILD_ARGS=(--out "$PAGE")
[ "$BENCH" = "1" ] && BUILD_ARGS+=(--include bench.js)
if ! "$PYTHON" "$HERE/build-verify.py" "${BUILD_ARGS[@]}"; then
  echo "ERROR: テストページの生成に失敗しました。" >&2
  exit 2
fi

# --- 収集サーバ起動 -------------------------------------------------------
"$PYTHON" "$HERE/collect.py" --port "$PORT" --out "$RESULT" --timeout "$TIMEOUT" >"$COLLECT_LOG" 2>&1 &
COLLECT_PID=$!

for _ in $(seq 1 100); do
  if "$PYTHON" - "$PORT" <<'PY' 2>/dev/null
import socket, sys
s = socket.socket()
s.settimeout(0.2)
try:
    s.connect(('127.0.0.1', int(sys.argv[1])))
    sys.exit(0)
except Exception:
    sys.exit(1)
finally:
    s.close()
PY
  then break; fi
  "$PYTHON" -c 'import time; time.sleep(0.05)'
done

if ! kill -0 "$COLLECT_PID" 2>/dev/null; then
  echo "ERROR: 収集サーバの起動に失敗しました。" >&2
  cat "$COLLECT_LOG" >&2
  exit 2
fi

# --- Headless Chrome でテストページを開く ---------------------------------
# 注意: --dump-dom / --virtual-time-budget は使わない。
# OfflineAudioContext のレンダリング完了前に DOM がダンプされて結果が取れない。
# URL・プロファイルは chrome.exe が読める形式に変換して渡す（Linux では無変換）。
# Windows Chrome は file:///c/Users/... を ERR_FILE_NOT_FOUND にするため、
# file:///C:/Users/... 形式が必須。
PAGE_NATIVE="$(native_path "$PAGE")"
PROFILE_NATIVE="$(native_path "$PROFILE")"
URL="file:///${PAGE_NATIVE#/}?port=$PORT"
START="$(date +%s.%N)"

"$CHROME" \
  --headless=new \
  --disable-gpu \
  --no-sandbox \
  --autoplay-policy=no-user-gesture-required \
  --allow-file-access-from-files \
  --user-data-dir="$PROFILE_NATIVE" \
  --no-first-run \
  --no-default-browser-check \
  --disable-extensions \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding \
  --mute-audio \
  --use-fake-device-for-media-stream \
  --use-fake-ui-for-media-stream \
  "$URL" >"$CHROME_LOG" 2>&1 &
CHROME_PID=$!

# --- 結果待ち -------------------------------------------------------------
wait "$COLLECT_PID"
COLLECT_RC=$?
COLLECT_PID=""
END="$(date +%s.%N)"
ELAPSED="$("$PYTHON" -c "print(f'{max(0.0, $END - $START):.1f}')")"

kill_chrome

if [ "$COLLECT_RC" != "0" ] || [ ! -s "$RESULT" ]; then
  echo "ERROR: テスト結果を受信できませんでした (collect.py rc=$COLLECT_RC, ${ELAPSED}s)" >&2
  echo "--- collect.py ---" >&2; cat "$COLLECT_LOG" >&2
  echo "--- chrome ---" >&2; tail -n 40 "$CHROME_LOG" >&2
  exit 2
fi

# --- 整形表示 -------------------------------------------------------------
"$PYTHON" - "$RESULT" "$ELAPSED" <<'PY'
import json, sys

path, elapsed = sys.argv[1], sys.argv[2]
try:
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
except Exception as e:
    print(f'ERROR: 結果 JSON をパースできません: {e}', file=sys.stderr)
    sys.exit(2)

tests = data.get('tests') or []
G, R, Y, C, B, N = '\033[32m', '\033[31m', '\033[33m', '\033[36m', '\033[1m', '\033[0m'
if not sys.stdout.isatty():
    G = R = Y = C = B = N = ''

width = max([len(t.get('name', '')) for t in tests] + [4])
group = None
for t in tests:
    name = t.get('name', '?')
    g = name.split(']')[0] + ']' if name.startswith('[') else ''
    if g != group:
        group = g
        print()
    ok = bool(t.get('pass'))
    tag = f'{G}PASS{N}' if ok else f'{R}FAIL{N}'
    detail = (t.get('detail') or '').replace('\n', ' / ')
    print(f'  {tag}  {name.ljust(width)}  {detail}')

passed = sum(1 for t in tests if t.get('pass'))
total = len(tests)

errs = data.get('errors') or []
if errs:
    print(f'\n{Y}--- 収集されたエラー ({len(errs)}) ---{N}')
    for e in errs[:30]:
        print('  ' + str(e).replace('\n', '\n    '))
    if len(errs) > 30:
        print(f'  ... 他 {len(errs) - 30} 件')

if data.get('timedOut'):
    print(f"\n{R}!! ウォッチドッグ発火: フェーズ '{data.get('phase')}' で停止{N}")
if data.get('fatal'):
    print(f"\n{R}!! 致命的エラー (phase={data.get('phase')}):{N}\n{data['fatal']}")

print()
print(f'{B}{passed}/{total} passed{N}   ({elapsed}s, page {data.get("durationMs", "?")}ms)')
if data.get('ua'):
    print(f'{C}{data["ua"]}{N}')

sys.exit(0 if (total > 0 and passed == total and not data.get('timedOut') and not data.get('fatal')) else 1)
PY
RC=$?
exit $RC
