'use strict';
// =====================================================================
// テストハーネス（アプリ本体のスクリプトより「前」に読み込まれる）
//
//  - window.onerror / unhandledrejection / console.error / リソース読み込み失敗を収集
//  - alert / confirm / prompt をスタブ化（モーダルで止まるのを防ぐ）
//  - ウォッチドッグ（既定90秒）でハングしても必ず結果を送る
//  - 結果は fetch(no-cors) で test/collect.py へ POST する
//    （--dump-dom + --virtual-time-budget は OfflineAudioContext の
//      レンダリング完了を待てないため使わない）
// =====================================================================
window.HARNESS = {
  tests: [],       // { name, pass, detail }
  errors: [],      // 未捕捉エラー / console.error / リソース読み込み失敗
  alerts: [],      // スタブした alert の引数
  confirms: [],    // スタブした confirm の引数
  downloads: [],   // スタブした DAW.wav.download の引数
  confirmResult: true, // confirm の戻り値（テストごとに切り替える）
  realDownload: null,
  phase: 'boot',
  t0: Date.now(),
  sent: false,
  timedOut: false,
  fatal: null,
  WATCHDOG_MS: 90000,
};

window.phase = function (p) { window.HARNESS.phase = p; };

window.noteError = function (kind, msg, stack) {
  const H = window.HARNESS;
  H.errors.push(`[${kind}] (phase=${H.phase}) ${msg}` +
    (stack ? '\n' + String(stack).split('\n').slice(0, 3).join('\n') : ''));
};

// リソース読み込み失敗（<script src> の 404 等）も拾うためキャプチャ段で見る
window.addEventListener('error', e => {
  const t = e.target;
  if (t && t !== window && t.tagName) {
    window.noteError('resource', `${t.tagName} の読み込みに失敗: ${t.src || t.href}`);
  }
}, true);

window.addEventListener('error', e => {
  window.noteError('window.onerror', e.message || String(e.error), e.error && e.error.stack);
});

window.addEventListener('unhandledrejection', e => {
  const r = e.reason;
  window.noteError('unhandledrejection', (r && r.message) || String(r), r && r.stack);
});

const _consoleError = console.error.bind(console);
console.error = function (...args) {
  window.noteError('console.error',
    args.map(a => (a && a.stack) ? String(a.stack).split('\n')[0] : String(a)).join(' '));
  _consoleError(...args);
};

// モーダル系は必ずスタブ（実行が止まるのを防ぐ）
window.alert = function (msg) { window.HARNESS.alerts.push(String(msg)); };
window.confirm = function (msg) {
  window.HARNESS.confirms.push(String(msg));
  return window.HARNESS.confirmResult;
};
window.prompt = function () { return null; };

window.sendResult = function () {
  const H = window.HARNESS;
  if (H.sent) return;
  H.sent = true;
  const port = new URLSearchParams(location.search).get('port') || '8765';
  const payload = JSON.stringify({
    tests: H.tests,
    errors: H.errors,
    phase: H.phase,
    timedOut: H.timedOut,
    fatal: H.fatal,
    scripts: H.scripts || [],
    meta: window.__VERIFY_META || null,
    durationMs: Date.now() - H.t0,
    ua: navigator.userAgent,
  });
  try { document.title = 'done'; } catch (e) {}
  try {
    fetch('http://127.0.0.1:' + port + '/result', { method: 'POST', mode: 'no-cors', body: payload });
  } catch (e) {
    try { navigator.sendBeacon('http://127.0.0.1:' + port + '/result', payload); } catch (e2) {}
  }
};

// ハングしても必ず結果が返るようにする
setTimeout(() => {
  const H = window.HARNESS;
  if (H.sent) return;
  H.timedOut = true;
  H.tests.push({
    name: '[!] ウォッチドッグ',
    pass: false,
    detail: `${H.WATCHDOG_MS / 1000}秒でタイムアウト（フェーズ: ${H.phase}）`,
  });
  window.sendResult();
}, window.HARNESS.WATCHDOG_MS);
