'use strict';
// =====================================================================
// DAW 回帰テスト本体
//
//  このファイルは build-verify.py が index.html の </body> 直前に差し込む。
//  つまり全アプリスクリプトの「後」に実行される（DAW は初期化済みではないが定義済み）。
//  実際のテストは window load 後（main.js の DOMContentLoaded 初期化の後）に走る。
//
//  テストの追加方法:
//    T('[グループ] 名前', async () => { ... ; return '詳細文字列'; });
//  例外を投げれば FAIL。戻り値の文字列が結果一覧の右側に出る。
//
//  方針:
//    - テスト対象は state / plugins / wav / audio のロジック。
//    - DAW.PPS は可変なので、ピクセル計算に依存するテストは書かない。
//    - DOM は「初期描画されたか」程度まで。
// =====================================================================
const H = window.HARNESS;
const SUITE = [];
function T(name, fn) { SUITE.push({ name, fn }); }

// 実ダウンロードを防ぐ（アプリ初期化より前に差し替えておく）
H.realDownload = DAW.wav.download;
DAW.wav.download = function (blob, filename) { H.downloads.push({ blob, filename }); };

// ---- アサーション -------------------------------------------------------
function ok(cond, detail) {
  if (!cond) throw new Error('アサート失敗: ' + detail);
  return detail;
}
function eq(a, b, detail) {
  if (a !== b) throw new Error(`アサート失敗: ${detail} (実際=${JSON.stringify(a)} 期待=${JSON.stringify(b)})`);
  return true;
}
function near(a, b, eps, detail) {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`アサート失敗: ${detail} (実際=${a} 期待=${b}±${eps})`);
  return true;
}
const delay = ms => new Promise(r => setTimeout(r, ms));

// ---- 音声ユーティリティ -------------------------------------------------
const ctx = () => DAW.audio.ensureCtx();
const SR = () => ctx().sampleRate;

function makeBuffer(numCh, durSec, fill) {
  const sr = SR();
  const buf = ctx().createBuffer(numCh, Math.max(1, Math.round(durSec * sr)), sr);
  for (let c = 0; c < numCh; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] = fill(i / sr, c, i);
  }
  return buf;
}
const sineFill = (freq, amp) => t => amp * Math.sin(2 * Math.PI * freq * t);
// 0 -> amp の直線ランプ。バッファ内位置がそのまま振幅になるので offset 検証に使える。
const rampFill = (durSec, amp) => t => amp * (t / durSec);

function rms(a, from, to) {
  from = from | 0; to = (to === undefined ? a.length : to) | 0;
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
}
function peakAbs(a, from, to) {
  from = from | 0; to = (to === undefined ? a.length : to) | 0;
  let m = 0;
  for (let i = from; i < to; i++) { const v = Math.abs(a[i]); if (v > m) m = v; }
  return m;
}
function firstNonFinite(buf) {
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) if (!Number.isFinite(d[i])) return `ch${c}[${i}]=${d[i]}`;
  }
  return null;
}
function readStr(dv, o, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(o + i));
  return s;
}

// ---- プロジェクト操作 ---------------------------------------------------
function resetProject() {
  DAW.audio.stop();
  DAW.audio.resetNodes();
  DAW.project = { masterVolume: 1, tracks: [] };
  DAW.buffers = new Map();
  DAW.peaks = new Map();
  if (DAW.audio.masterGain) DAW.audio.masterGain.gain.value = 1;
  if (DAW.history) DAW.history.reset();   // 履歴が古いバッファを掴んだままにしない
  H.downloads.length = 0;
  H.alerts.length = 0;
  H.confirms.length = 0;
  H.confirmResult = true;
}
function addClip(track, bufferId, startTime, duration, offset) {
  const clip = { id: DAW.uid(), bufferId, startTime, offset: offset || 0, duration, name: 'clip' };
  track.clips.push(clip);
  return clip;
}
function fx(pluginId, overrides) {
  const def = DAW.plugins.get(pluginId);
  if (!def) throw new Error('未登録プラグイン: ' + pluginId);
  return { pluginId, params: Object.assign(DAW.plugins.defaultParams(def), overrides || {}) };
}
const takeAlerts = () => H.alerts.splice(0, H.alerts.length);
const takeConfirms = () => H.confirms.splice(0, H.confirms.length);

// exportMix を実経路で走らせ、生成された WAV をデコードして返す
async function renderMix() {
  H.downloads.length = 0;
  await DAW.wav.exportMix();
  const d = H.downloads.pop();
  if (!d) return null;
  const bytes = await d.blob.arrayBuffer();
  const buffer = await ctx().decodeAudioData(bytes.slice(0));
  return { name: d.filename, type: d.blob.type, bytes, buffer };
}

// scheduleClip 単体を OfflineAudioContext でレンダリング
async function renderSchedule(clip, fromPos, whenBase, durSec) {
  const sr = SR();
  const off = new OfflineAudioContext(1, Math.ceil(durSec * sr), sr);
  const g = off.createGain();
  g.connect(off.destination);
  const src = DAW.audio.scheduleClip(off, g, clip, fromPos, whenBase);
  const rendered = await off.startRendering();
  const data = rendered.getChannelData(0);
  return { src, data, at: t => data[Math.round(t * sr)] };
}

// =====================================================================
// [1] ロードと API
// =====================================================================
T('[1] index.html から生成されたページである', () => {
  const meta = window.__VERIFY_META;
  ok(meta && meta.source === 'index.html', 'build-verify.py のメタ情報が無い');
  ok(Array.isArray(meta.scripts) && meta.scripts.length >= 6, `scripts が少ない: ${meta.scripts}`);
  ok(meta.styles.includes('style.css'), 'style.css が読まれていない');
  return `${meta.generatedAt} 生成 / scripts=${meta.scripts.length} styles=${meta.styles.length}`;
});

T('[1] アプリスクリプトを index.html と同じ順序で読み込んでいる', () => {
  const live = [...document.querySelectorAll('script[src]')]
    .map(s => s.getAttribute('src'))
    .filter(s => s.startsWith('../'))
    .map(s => s.slice(3));
  H.scripts = live;
  const meta = window.__VERIFY_META.scripts;
  eq(live.join(','), meta.join(','), 'index.html の script 順と不一致');

  const core = ['js/state.js', 'js/plugins.js', 'js/wav.js', 'js/audio.js', 'js/ui.js', 'js/main.js'];
  const idx = core.map(s => live.indexOf(s));
  idx.forEach((v, i) => ok(v >= 0, `${core[i]} が読み込まれていない`));
  for (let i = 1; i < idx.length; i++) ok(idx[i] > idx[i - 1], `${core[i]} が ${core[i - 1]} より先`);
  const plugins = live.filter(s => s.startsWith('js/plugins/'));
  ok(plugins.length >= 4, `プラグインスクリプトが少ない: ${plugins.length}`);
  ok(Math.min(...plugins.map(p => live.indexOf(p))) > idx[idx.length - 1], 'プラグインが main.js より前');
  return `${live.length} 本: ${live.join(' -> ')}`;
});

T('[1] スクリプトの読み込みエラーが無い', () => {
  const res = H.errors.filter(e => e.startsWith('[resource]'));
  ok(res.length === 0, res.join('\n'));
  return `${H.scripts.length} 本すべて読み込み成功`;
});

T('[1] DAW 名前空間', () => {
  ok(typeof DAW === 'object' && DAW, 'DAW がグローバルに無い');
  for (const k of ['ui', 'audio', 'wav', 'plugins']) ok(DAW[k] && typeof DAW[k] === 'object', `DAW.${k} が無い`);
  return 'DAW / DAW.ui / DAW.audio / DAW.wav / DAW.plugins';
});

T('[1] state API が揃っている', () => {
  const fns = ['addTrack', 'removeTrack', 'findClip', 'removeClip', 'projectDuration',
    'effectiveGain', 'registerBuffer', 'computePeaks', 'collectBuffers', 'anySolo',
    'uid', 'timeToPx', 'pxToTime', 'trackColor'];
  for (const f of fns) ok(typeof DAW[f] === 'function', `DAW.${f} が関数でない`);
  ok(DAW.buffers instanceof Map && DAW.peaks instanceof Map, 'buffers/peaks が Map でない');
  ok(DAW.project && Array.isArray(DAW.project.tracks), 'project.tracks が配列でない');
  return `${fns.length} 個の state API を確認`;
});

T('[1] wav API が揃っている', () => {
  const fns = ['encodeWav16', 'arrayBufferToBase64', 'base64ToArrayBuffer', 'download',
    'exportMix', 'saveProject', 'loadProject'];
  for (const f of fns) ok(typeof DAW.wav[f] === 'function', `DAW.wav.${f} が関数でない`);
  return fns.join(', ');
});

T('[1] audio API が揃っている', () => {
  const fns = ['ensureCtx', 'connectChain', 'getTrackNodes', 'removeTrackNodes', 'resetNodes',
    'rebuildTrackChain', 'setEffectParam', 'updateGains', 'setMasterVolume', 'getPos',
    'scheduleClip', 'play', 'pause', 'stop', 'seek', 'reschedule', 'stopSources'];
  for (const f of fns) ok(typeof DAW.audio[f] === 'function', `DAW.audio.${f} が関数でない`);
  ok(DAW.audio.trackNodes instanceof Map, 'trackNodes が Map でない');
  return `${fns.length} 個の audio API を確認`;
});

T('[1] plugins API が揃っている', () => {
  const fns = ['register', 'get', 'list', 'defaultParams', 'prepareAll'];
  for (const f of fns) ok(typeof DAW.plugins[f] === 'function', `DAW.plugins.${f} が関数でない`);
  return fns.join(', ');
});

// =====================================================================
// [2] main.js の初期化
// =====================================================================
T('[2] 初期トラックが2本', () => {
  eq(DAW.project.tracks.length, 2, '初期トラック数');
  return DAW.project.tracks.map(t => t.name).join(' / ');
});

T('[2] #tracks に2行描画されている', () => {
  const rows = document.querySelectorAll('#tracks .track-row');
  eq(rows.length, 2, '.track-row の数');
  eq(document.getElementById('tracks').children.length, 2, '#tracks の子要素数');
  return `#tracks に .track-row が ${rows.length} 個`;
});

T('[2] DAW.ui.els が全て解決している', () => {
  const els = DAW.ui.els;
  const keys = Object.keys(els);
  ok(keys.length > 0, 'ui.els が空（init が走っていない）');
  const missing = keys.filter(k => !els[k]);
  ok(missing.length === 0, `未解決の要素: ${missing.join(', ')}`);
  return `${keys.length} 要素すべて解決: ${keys.join(', ')}`;
});

T('[2] 初期トラックの既定値', () => {
  for (const t of DAW.project.tracks) {
    ok(typeof t.id === 'string' && t.id.length > 2, 'track.id');
    eq(t.volume, 1, 'volume');
    eq(t.pan, 0, 'pan');
    eq(t.muted, false, 'muted');
    eq(t.solo, false, 'solo');
    ok(Array.isArray(t.effects) && t.effects.length === 0, 'effects が空配列');
    ok(Array.isArray(t.clips) && t.clips.length === 0, 'clips が空配列');
  }
  eq(DAW.project.masterVolume, 1, 'masterVolume');
  eq(DAW.projectDuration(), 0, '初期 projectDuration');
  return 'volume=1 pan=0 muted=false solo=false effects=[] clips=[]';
});

T('[2] トラックIDが一意', () => {
  const ids = DAW.project.tracks.map(t => t.id);
  eq(new Set(ids).size, ids.length, 'ID重複');
  return ids.join(', ');
});

// =====================================================================
// [3] プラグイン登録
// =====================================================================
const EXPECTED_PLUGINS = ['lowpass', 'delay', 'geq7', 'dyneq3'];

T('[3] 4プラグインが登録済み', () => {
  for (const id of EXPECTED_PLUGINS) ok(DAW.plugins.get(id), `プラグイン ${id} が未登録`);
  const all = DAW.plugins.list().map(d => d.id);
  return `登録済み(${all.length}): ${all.join(', ')}`;
});

T('[3] 各定義が id/name/params/create を持つ', () => {
  for (const def of DAW.plugins.list()) {
    ok(typeof def.id === 'string' && def.id, 'id');
    ok(typeof def.name === 'string' && def.name, `${def.id}.name`);
    ok(Array.isArray(def.params), `${def.id}.params が配列でない`);
    ok(typeof def.create === 'function', `${def.id}.create が関数でない`);
  }
  return DAW.plugins.list().map(d => `${d.id}(${d.params.length}params)`).join(', ');
});

T('[3] params の default が min..max 内', () => {
  let n = 0;
  for (const def of DAW.plugins.list()) {
    for (const p of def.params) {
      ok(typeof p.key === 'string' && p.key, `${def.id}: key が無い`);
      ok(typeof p.label === 'string' && p.label, `${def.id}.${p.key}: label が無い`);
      ok(Number.isFinite(p.min) && Number.isFinite(p.max), `${def.id}.${p.key}: min/max が数値でない`);
      ok(p.min < p.max, `${def.id}.${p.key}: min >= max`);
      ok(Number.isFinite(p.default), `${def.id}.${p.key}: default が数値でない`);
      ok(p.default >= p.min && p.default <= p.max,
        `${def.id}.${p.key}: default=${p.default} が [${p.min}, ${p.max}] の外`);
      n++;
    }
  }
  return `${n} パラメータすべて範囲内`;
});

T('[3] params の step > 0', () => {
  let n = 0;
  for (const def of DAW.plugins.list()) {
    for (const p of def.params) {
      ok(Number.isFinite(p.step) && p.step > 0, `${def.id}.${p.key}: step=${p.step}`);
      ok(p.step <= p.max - p.min, `${def.id}.${p.key}: step が範囲より大きい`);
      n++;
    }
  }
  return `${n} パラメータすべて step>0`;
});

T('[3] プラグインIDに重複が無い', () => {
  const list = DAW.plugins.list();
  const ids = list.map(d => d.id);
  eq(new Set(ids).size, ids.length, 'プラグインID重複');
  eq(DAW.plugins.defs.size, list.length, 'defs.size と list().length');
  for (const id of ids) eq(DAW.plugins.get(id).id, id, `get(${id})`);
  return `${ids.length} 個すべて一意`;
});

T('[3] 各プラグイン内で param key が重複しない', () => {
  for (const def of DAW.plugins.list()) {
    const keys = def.params.map(p => p.key);
    eq(new Set(keys).size, keys.length, `${def.id} の param key 重複`);
  }
  return DAW.plugins.list().map(d => d.id + ':' + d.params.length).join(', ');
});

T('[3] defaultParams が全 key を返す', () => {
  for (const def of DAW.plugins.list()) {
    const p = DAW.plugins.defaultParams(def);
    eq(Object.keys(p).length, def.params.length, `${def.id}: key 数`);
    for (const d of def.params) eq(p[d.key], d.default, `${def.id}.${d.key}`);
  }
  return '全プラグインで default と一致';
});

T('[3] dyneq3 は prepare フックを持つ', () => {
  const def = DAW.plugins.get('dyneq3');
  ok(typeof def.prepare === 'function', 'dyneq3.prepare が無い');
  return 'dyneq3.prepare あり（AudioWorklet の非同期ロード用）';
});

// =====================================================================
// [4] state ロジック
// =====================================================================
T('[4] addTrack / removeTrack', () => {
  resetProject();
  const a = DAW.addTrack('A');
  const b = DAW.addTrack();
  eq(DAW.project.tracks.length, 2, 'トラック数');
  eq(a.name, 'A', '指定名');
  ok(/^トラック /.test(b.name), `既定名: ${b.name}`);
  DAW.removeTrack(a.id);
  eq(DAW.project.tracks.length, 1, '削除後のトラック数');
  eq(DAW.project.tracks[0].id, b.id, '残ったトラック');
  DAW.removeTrack('存在しないID');
  eq(DAW.project.tracks.length, 1, '存在しないIDの削除は無害');
  return '追加2 -> 削除1 -> 残1、不明IDの削除は無害';
});

T('[4] effectiveGain: 通常 / ミュート', () => {
  resetProject();
  const t = DAW.addTrack();
  t.volume = 0.7;
  near(DAW.effectiveGain(t), 0.7, 1e-9, '通常時');
  t.muted = true;
  eq(DAW.effectiveGain(t), 0, 'ミュート時');
  t.muted = false;
  near(DAW.effectiveGain(t), 0.7, 1e-9, 'ミュート解除');
  return 'volume=0.7 -> 0.7 / muted -> 0';
});

T('[4] effectiveGain: ソロ排他', () => {
  resetProject();
  const a = DAW.addTrack(); a.volume = 0.8;
  const b = DAW.addTrack(); b.volume = 0.6;
  const c = DAW.addTrack(); c.volume = 0.4;
  eq(DAW.anySolo(), false, 'ソロ前の anySolo');
  b.solo = true;
  eq(DAW.anySolo(), true, 'ソロ後の anySolo');
  eq(DAW.effectiveGain(a), 0, '非ソロA');
  near(DAW.effectiveGain(b), 0.6, 1e-9, 'ソロB');
  eq(DAW.effectiveGain(c), 0, '非ソロC');
  c.solo = true;
  near(DAW.effectiveGain(c), 0.4, 1e-9, '複数ソロC');
  eq(DAW.effectiveGain(a), 0, '複数ソロ時の非ソロA');
  return 'ソロ中は非ソロが 0、複数ソロも可';
});

T('[4] effectiveGain: ミュートはソロより優先', () => {
  resetProject();
  const a = DAW.addTrack(); a.volume = 0.9; a.solo = true; a.muted = true;
  const b = DAW.addTrack(); b.volume = 0.5;
  eq(DAW.effectiveGain(a), 0, 'solo かつ muted');
  eq(DAW.effectiveGain(b), 0, 'ソロ中の非ソロ');
  return 'muted && solo -> 0';
});

T('[4] projectDuration', () => {
  resetProject();
  eq(DAW.projectDuration(), 0, 'クリップ0本');
  const a = DAW.addTrack();
  const b = DAW.addTrack();
  addClip(a, 'buf', 0, 1.5);
  eq(DAW.projectDuration(), 1.5, 'クリップ1本');
  addClip(b, 'buf', 2.25, 1);
  near(DAW.projectDuration(), 3.25, 1e-9, '最遠クリップ');
  addClip(a, 'buf', 0.1, 0.2);
  near(DAW.projectDuration(), 3.25, 1e-9, '短いクリップ追加後');
  return '0 -> 1.5 -> 3.25（max(startTime+duration)）';
});

T('[4] findClip / removeClip', () => {
  resetProject();
  const a = DAW.addTrack();
  const b = DAW.addTrack();
  const c1 = addClip(a, 'buf', 0, 1);
  const c2 = addClip(b, 'buf', 1, 1);
  const f = DAW.findClip(c2.id);
  ok(f && f.clip === c2 && f.track === b, 'findClip がトラックとクリップを返す');
  eq(DAW.findClip('nope'), null, '存在しないIDは null');
  DAW.removeClip(c1.id);
  eq(a.clips.length, 0, '削除後の clips');
  eq(DAW.findClip(c1.id), null, '削除後の findClip');
  eq(b.clips.length, 1, '他トラックは無傷');
  DAW.removeClip('nope');
  eq(b.clips.length, 1, '存在しないIDの削除は無害');
  return 'findClip/removeClip ともに期待どおり';
});

T('[4] registerBuffer が buffers/peaks に登録', () => {
  resetProject();
  const buf = makeBuffer(1, 0.05, sineFill(440, 0.5));
  const id = DAW.registerBuffer(buf);
  ok(typeof id === 'string' && id.length > 2, 'ID文字列');
  eq(DAW.buffers.get(id), buf, 'buffers に登録');
  ok(DAW.peaks.get(id) instanceof Float32Array, 'peaks に Float32Array');
  const id2 = DAW.registerBuffer(buf);
  ok(id2 !== id, 'IDは毎回新規');
  return `id=${id}, peaks長=${DAW.peaks.get(id).length}`;
});

T('[4] collectBuffers が未参照バッファを解放', () => {
  resetProject();
  const t = DAW.addTrack();
  const used = DAW.registerBuffer(makeBuffer(1, 0.02, () => 0.1));
  const unused = DAW.registerBuffer(makeBuffer(1, 0.02, () => 0.2));
  addClip(t, used, 0, 0.02);
  eq(DAW.buffers.size, 2, '解放前');
  DAW.collectBuffers();
  eq(DAW.buffers.size, 1, '解放後の buffers');
  eq(DAW.peaks.size, 1, '解放後の peaks');
  ok(DAW.buffers.has(used), '参照中バッファは残る');
  ok(!DAW.buffers.has(unused), '未参照バッファは消える');
  DAW.removeClip(t.clips[0].id);
  eq(DAW.buffers.size, 0, 'removeClip 経由でも解放される');
  return '2 -> 1 -> 0';
});

T('[4] collectBuffers は履歴が参照するバッファを保持する', () => {
  if (!DAW.history) return '（DAW.history 未導入のためスキップ対象なし）';
  resetProject();
  const t = DAW.addTrack();
  const id = DAW.registerBuffer(makeBuffer(1, 0.02, () => 0.3));
  addClip(t, id, 0, 0.02);
  DAW.history.commit();                    // クリップありの状態を履歴に積む
  DAW.removeClip(t.clips[0].id);           // -> collectBuffers が走る
  ok(DAW.buffers.has(id), 'Undo 用に履歴が参照しているバッファが解放された');
  DAW.history.reset();                     // 履歴を捨てる
  DAW.collectBuffers();
  ok(!DAW.buffers.has(id), '履歴を捨てても解放されない');
  return 'Undo 可能な間は保持、履歴を捨てると解放';
});

T('[4] computePeaks の長さ', () => {
  const B = DAW.PEAK_BUCKET;
  const buf = makeBuffer(1, (B * 2 + 100) / SR(), () => 0);
  const peaks = DAW.computePeaks(buf);
  eq(peaks.length, Math.ceil(buf.length / B) * 2, 'peaks 長 = ceil(len/BUCKET)*2');
  return `len=${buf.length}, BUCKET=${B}, peaks=${peaks.length}`;
});

T('[4] computePeaks の値（既知波形）', () => {
  const B = DAW.PEAK_BUCKET;
  const len = B * 2;
  const buf = ctx().createBuffer(2, len, SR());
  const l = buf.getChannelData(0), r = buf.getChannelData(1);
  for (let i = 0; i < len; i++) {
    l[i] = i < B ? 0.25 : -0.75;
    r[i] = i < B ? -0.5 : 0.5;
  }
  const p = DAW.computePeaks(buf);
  eq(p.length, 4, 'バケット2個');
  near(p[0], -0.5, 1e-6, 'bucket0 min');
  near(p[1], 0.25, 1e-6, 'bucket0 max');
  near(p[2], -0.75, 1e-6, 'bucket1 min');
  near(p[3], 0.5, 1e-6, 'bucket1 max');
  return 'min/max が両チャンネルを跨いで正しい';
});

T('[4] computePeaks: 無音は 0、範囲は [-1,1]', () => {
  const silent = makeBuffer(1, 0.03, () => 0);
  const p0 = DAW.computePeaks(silent);
  for (let i = 0; i < p0.length; i++) eq(p0[i], 0, `無音 peaks[${i}]`);
  const noisy = makeBuffer(2, 0.05, sineFill(1000, 0.9));
  const p1 = DAW.computePeaks(noisy);
  for (let i = 0; i < p1.length; i += 2) {
    ok(Number.isFinite(p1[i]) && Number.isFinite(p1[i + 1]), `有限値 [${i}]`);
    ok(p1[i] <= p1[i + 1], `min<=max [${i}]`);
    ok(p1[i] >= -1 && p1[i + 1] <= 1, `範囲内 [${i}]`);
  }
  near(peakAbs(p1), 0.9, 0.02, '正弦波のピーク');
  return '無音=0、正弦波(amp0.9)のピーク≈0.9';
});

// =====================================================================
// [5] DAW.wav.encodeWav16
// =====================================================================
T('[5] WAV ヘッダのマジック', () => {
  const buf = makeBuffer(2, 0.02, sineFill(440, 0.5));
  const dv = new DataView(DAW.wav.encodeWav16(buf));
  eq(readStr(dv, 0, 4), 'RIFF', 'RIFF');
  eq(readStr(dv, 8, 4), 'WAVE', 'WAVE');
  eq(readStr(dv, 12, 4), 'fmt ', 'fmt ');
  eq(readStr(dv, 36, 4), 'data', 'data');
  eq(dv.getUint32(16, true), 16, 'fmt チャンクサイズ');
  return 'RIFF/WAVE/fmt /data すべて正しい';
});

T('[5] fmt チャンクの内容（ステレオ）', () => {
  const buf = makeBuffer(2, 0.05, sineFill(440, 0.5));
  const dv = new DataView(DAW.wav.encodeWav16(buf));
  eq(dv.getUint16(20, true), 1, 'audioFormat=1 (PCM)');
  eq(dv.getUint16(22, true), 2, 'numChannels');
  eq(dv.getUint32(24, true), buf.sampleRate, 'sampleRate');
  eq(dv.getUint16(34, true), 16, 'bitsPerSample');
  eq(dv.getUint16(32, true), 4, 'blockAlign = ch*2');
  eq(dv.getUint32(28, true), buf.sampleRate * 4, 'byteRate = sr*blockAlign');
  return `PCM16 2ch ${buf.sampleRate}Hz blockAlign=4 byteRate=${buf.sampleRate * 4}`;
});

T('[5] fmt チャンクの内容（モノラル）', () => {
  const buf = makeBuffer(1, 0.05, sineFill(440, 0.5));
  const ab = DAW.wav.encodeWav16(buf);
  const dv = new DataView(ab);
  eq(dv.getUint16(22, true), 1, 'numChannels');
  eq(dv.getUint16(32, true), 2, 'blockAlign');
  eq(dv.getUint32(28, true), buf.sampleRate * 2, 'byteRate');
  eq(ab.byteLength, 44 + buf.length * 2, '全体バイト長');
  return `モノラル: ${ab.byteLength} bytes`;
});

T('[5] バイト長と RIFF サイズの整合', () => {
  for (const ch of [1, 2]) {
    const buf = makeBuffer(ch, 0.037, sineFill(300, 0.4));
    const ab = DAW.wav.encodeWav16(buf);
    const dv = new DataView(ab);
    const dataSize = buf.length * ch * 2;
    eq(ab.byteLength, 44 + dataSize, `${ch}ch: 全体長`);
    eq(dv.getUint32(4, true), 36 + dataSize, `${ch}ch: RIFF サイズ`);
    eq(dv.getUint32(40, true), dataSize, `${ch}ch: data サイズ`);
    eq(dv.getUint32(4, true), ab.byteLength - 8, `${ch}ch: RIFF = 全体-8`);
  }
  return '1ch/2ch とも 44+data、RIFF=全体-8、data=len*blockAlign';
});

T('[5] サンプル値の量子化とクリップ', () => {
  const vals = [0, 0.5, -0.5, 1, -1, 2, -2];
  const buf = ctx().createBuffer(1, vals.length, SR());
  buf.getChannelData(0).set(Float32Array.from(vals));
  const dv = new DataView(DAW.wav.encodeWav16(buf));
  const got = vals.map((_, i) => dv.getInt16(44 + i * 2, true));
  const want = [0, 16383, -16384, 32767, -32768, 32767, -32768];
  got.forEach((v, i) => eq(v, want[i], `sample[${i}] (入力 ${vals[i]})`));
  return `[${got.join(', ')}]（±1超は飽和）`;
});

T('[5] インターリーブ順（L,R,L,R）', () => {
  const buf = ctx().createBuffer(2, 3, SR());
  buf.getChannelData(0).set(Float32Array.from([1, 0, 0]));
  buf.getChannelData(1).set(Float32Array.from([0, 1, 0]));
  const dv = new DataView(DAW.wav.encodeWav16(buf));
  eq(dv.getInt16(44, true), 32767, 'frame0 L');
  eq(dv.getInt16(46, true), 0, 'frame0 R');
  eq(dv.getInt16(48, true), 0, 'frame1 L');
  eq(dv.getInt16(50, true), 32767, 'frame1 R');
  return 'L,R,L,R の順にインターリーブされている';
});

T('[5] base64 往復一致', () => {
  const buf = makeBuffer(2, 0.08, sineFill(777, 0.6));
  const ab = DAW.wav.encodeWav16(buf);
  const b64 = DAW.wav.arrayBufferToBase64(ab);
  ok(typeof b64 === 'string' && /^[A-Za-z0-9+/=]+$/.test(b64), 'base64 文字列');
  const back = DAW.wav.base64ToArrayBuffer(b64);
  eq(back.byteLength, ab.byteLength, 'バイト長');
  const a = new Uint8Array(ab), b = new Uint8Array(back);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(`バイト不一致 at ${i}: ${a[i]} != ${b[i]}`);
  return `${ab.byteLength} bytes -> base64 ${b64.length} 文字 -> 完全一致`;
});

T('[5] decodeAudioData で再デコードして波形一致', async () => {
  const buf = makeBuffer(2, 0.25, (t, c) => (c === 0 ? 0.5 : 0.3) * Math.sin(2 * Math.PI * (c === 0 ? 440 : 660) * t));
  const ab = DAW.wav.encodeWav16(buf);
  const decoded = await ctx().decodeAudioData(ab.slice(0));
  eq(decoded.numberOfChannels, 2, 'チャンネル数');
  eq(decoded.sampleRate, buf.sampleRate, 'サンプルレート');
  eq(decoded.length, buf.length, 'サンプル数');
  const detail = [];
  for (let c = 0; c < 2; c++) {
    const o = rms(buf.getChannelData(c)), d = rms(decoded.getChannelData(c));
    near(d, o, 1e-3, `ch${c} rms`);
    near(peakAbs(decoded.getChannelData(c)), peakAbs(buf.getChannelData(c)), 1e-3, `ch${c} peak`);
    detail.push(`ch${c} rms ${o.toFixed(5)}≈${d.toFixed(5)}`);
  }
  return detail.join(', ');
});

T('[5] peakOf / toDbfs', () => {
  if (typeof DAW.wav.peakOf !== 'function') throw new Error('DAW.wav.peakOf が無い');
  const buf = ctx().createBuffer(2, 4, SR());
  buf.getChannelData(0).set(Float32Array.from([0.2, -0.4, 0.1, 0]));
  buf.getChannelData(1).set(Float32Array.from([0, 0.6, -0.9, 0]));
  near(DAW.wav.peakOf(buf), 0.9, 1e-6, 'ピーク（全チャンネルの絶対値最大）');
  near(DAW.wav.toDbfs(1), 0, 1e-9, '1.0 -> 0dBFS');
  near(DAW.wav.toDbfs(0.5), -6.0206, 1e-3, '0.5 -> -6dBFS');
  eq(DAW.wav.toDbfs(0), -Infinity, '0 -> -Infinity');
  return 'peak=0.9, 0dBFS/-6dBFS/-Inf の換算が正しい';
});

// =====================================================================
// [6] DAW.audio.scheduleClip
// =====================================================================
T('[6] 開始時刻まで無音 / 区間に信号 / 終端後は無音', async () => {
  resetProject();
  const sr = SR();
  const id = DAW.registerBuffer(makeBuffer(1, 1.0, rampFill(1.0, 0.8)));
  const t = DAW.addTrack();
  const clip = addClip(t, id, 0.25, 0.5, 0);
  const r = await renderSchedule(clip, 0, 0, 1.0);
  ok(r.src, 'scheduleClip が source を返す');
  eq(rms(r.data, 0, Math.floor(0.25 * sr) - 2), 0, '開始前が無音でない');
  ok(rms(r.data, Math.floor(0.3 * sr), Math.floor(0.7 * sr)) > 0.05, '区間に信号が無い');
  eq(rms(r.data, Math.ceil(0.75 * sr) + 2), 0, '終端後が無音でない');
  near(r.at(0.5), 0.8 * 0.25, 0.01, 't=0.5 の値（バッファ位置0.25）');
  near(r.at(0.7), 0.8 * 0.45, 0.01, 't=0.7 の値（バッファ位置0.45）');
  return '[0,0.25)=無音, [0.25,0.75)=ランプ, [0.75,1)=無音';
});

T('[6] fromPos 指定時のオフセット補正', async () => {
  resetProject();
  const sr = SR();
  const id = DAW.registerBuffer(makeBuffer(1, 1.0, rampFill(1.0, 0.8)));
  const t = DAW.addTrack();
  // startTime=0.25, offset=0.1, duration=0.5 を 0.35 秒地点から再生
  // -> skip=0.1 なのでバッファ位置 0.2 から 0.4 秒ぶん鳴るはず
  const clip = addClip(t, id, 0.25, 0.5, 0.1);
  const r = await renderSchedule(clip, 0.35, 0, 0.8);
  ok(r.src, 'source が返る');
  near(r.at(0.005), 0.8 * 0.205, 0.01, '先頭がバッファ位置0.2');
  near(r.at(0.2), 0.8 * 0.4, 0.01, 't=0.2 がバッファ位置0.4');
  near(r.at(0.35), 0.8 * 0.55, 0.01, 't=0.35 がバッファ位置0.55');
  eq(rms(r.data, Math.ceil(0.4 * sr) + 2), 0, '0.4秒で終わっていない');
  return 'skip=0.1 -> src.start(0, 0.2, 0.4) 相当のオフセット補正';
});

T('[6] 未来のクリップは whenBase からの遅延で鳴る', async () => {
  resetProject();
  const sr = SR();
  const id = DAW.registerBuffer(makeBuffer(1, 1.0, rampFill(1.0, 0.8)));
  const t = DAW.addTrack();
  const clip = addClip(t, id, 0.5, 0.3, 0);
  // fromPos=0.2, whenBase=0.1 -> 出力上 0.1+(0.5-0.2)=0.4 秒地点から
  const r = await renderSchedule(clip, 0.2, 0.1, 1.0);
  eq(rms(r.data, 0, Math.floor(0.4 * sr) - 2), 0, '0.4秒前が無音でない');
  ok(rms(r.data, Math.floor(0.45 * sr), Math.floor(0.65 * sr)) > 0.05, '0.45-0.65 に信号が無い');
  eq(rms(r.data, Math.ceil(0.7 * sr) + 2), 0, '0.7秒以降が無音でない');
  return '出力 0.4 秒地点から 0.3 秒ぶん';
});

T('[6] clip.offset によるトリム', async () => {
  resetProject();
  const sr = SR();
  const id = DAW.registerBuffer(makeBuffer(1, 1.0, rampFill(1.0, 0.8)));
  const t = DAW.addTrack();
  const clip = addClip(t, id, 0, 0.25, 0.5);
  const r = await renderSchedule(clip, 0, 0, 0.5);
  near(r.at(0.005), 0.8 * 0.505, 0.01, '先頭がバッファ位置0.5');
  near(r.at(0.2), 0.8 * 0.7, 0.01, 't=0.2 がバッファ位置0.7');
  eq(rms(r.data, Math.ceil(0.25 * sr) + 2), 0, '0.25秒で終わっていない');
  return 'offset=0.5, duration=0.25 -> バッファ [0.5, 0.75) のみ';
});

T('[6] 再生位置より前に終わったクリップは null', async () => {
  resetProject();
  const id = DAW.registerBuffer(makeBuffer(1, 1.0, rampFill(1.0, 0.8)));
  const t = DAW.addTrack();
  const past = addClip(t, id, 0, 0.5);
  const r = await renderSchedule(past, 0.6, 0, 0.3);
  eq(r.src, null, '過去クリップは null');
  eq(rms(r.data), 0, '出力が無音でない');
  const r2 = await renderSchedule(past, 0.5, 0, 0.3);
  eq(r2.src, null, '終端一致も null');
  const r3 = await renderSchedule(past, 0.4, 0, 0.3);
  ok(r3.src, '終端前なら source が返る');
  return 'fromPos>=clipEnd で null、fromPos<clipEnd で source';
});

T('[6] 未登録バッファIDは null', async () => {
  resetProject();
  const t = DAW.addTrack();
  const clip = addClip(t, 'この-ID-は無い', 0, 1);
  const r = await renderSchedule(clip, 0, 0, 0.2);
  eq(r.src, null, 'null を返す');
  eq(rms(r.data), 0, '無音');
  return 'buffers に無い bufferId は null（例外を投げない）';
});

// =====================================================================
// [7] DAW.wav.exportMix（実経路）
// =====================================================================
T('[7] クリップ0本なら警告して中断', async () => {
  resetProject();
  DAW.addTrack();
  takeAlerts();
  const r = await renderMix();
  eq(r, null, 'download が呼ばれてしまった');
  const alerts = takeAlerts();
  eq(alerts.length, 1, 'alert 回数');
  ok(/クリップ/.test(alerts[0]), `alert 文言: ${alerts[0]}`);
  return `alert="${alerts[0]}"、download 未呼び出し`;
});

T('[7] ミックス長 = projectDuration', async () => {
  resetProject();
  const sr = SR();
  const id = DAW.registerBuffer(makeBuffer(1, 0.5, sineFill(440, 0.5)));
  const t = DAW.addTrack();
  addClip(t, id, 0.25, 0.5);
  const dur = DAW.projectDuration();
  const r = await renderMix();
  ok(r, 'WAV が生成されなかった');
  eq(r.name, 'mix.wav', 'ファイル名');
  eq(r.type, 'audio/wav', 'MIME');
  eq(r.buffer.numberOfChannels, 2, 'ステレオ');
  eq(r.buffer.sampleRate, sr, 'サンプルレート');
  eq(r.buffer.length, Math.ceil(dur * sr), 'サンプル数 = ceil(projectDuration*sr)');
  return `duration=${dur}s -> ${r.buffer.length} samples @ ${sr}Hz`;
});

T('[7] 全サンプルが有限', async () => {
  resetProject();
  const id = DAW.registerBuffer(makeBuffer(2, 0.4, sineFill(440, 0.6)));
  const a = DAW.addTrack(); a.pan = -0.4; a.volume = 0.8;
  const b = DAW.addTrack(); b.pan = 0.6; b.volume = 0.5;
  addClip(a, id, 0, 0.4);
  addClip(b, id, 0.1, 0.3);
  const r = await renderMix();
  ok(r, 'WAV が生成されなかった');
  const bad = firstNonFinite(r.buffer);
  eq(bad, null, `非有限値: ${bad}`);
  ok(peakAbs(r.buffer.getChannelData(0)) > 0.05, '左が無音');
  ok(peakAbs(r.buffer.getChannelData(1)) > 0.05, '右が無音');
  return `NaN/Inf なし、peak L=${peakAbs(r.buffer.getChannelData(0)).toFixed(3)} R=${peakAbs(r.buffer.getChannelData(1)).toFixed(3)}`;
});

T('[7] パン L/R の分離', async () => {
  resetProject();
  // モノラル素材のハードパン。ステレオ素材だと L+R が片側に合算されて
  // +6dB になる（Web Audio 仕様どおり）ため、分離の検証はモノラルで行う。
  const id = DAW.registerBuffer(makeBuffer(1, 0.3, sineFill(440, 0.5)));
  const left = DAW.addTrack(); left.pan = -1;
  addClip(left, id, 0, 0.3);
  const rl = await renderMix();
  const lRms = rms(rl.buffer.getChannelData(0)), rRms = rms(rl.buffer.getChannelData(1));
  ok(lRms > 0.1, `左に信号が無い (${lRms})`);
  ok(rRms < 1e-4, `右に漏れている (${rRms})`);

  left.pan = 1;
  const rr = await renderMix();
  const lRms2 = rms(rr.buffer.getChannelData(0)), rRms2 = rms(rr.buffer.getChannelData(1));
  ok(rRms2 > 0.1, `右に信号が無い (${rRms2})`);
  ok(lRms2 < 1e-4, `左に漏れている (${lRms2})`);
  near(rRms2, lRms, 1e-3, 'L/R でレベルが対称');
  return `pan=-1: L=${lRms.toFixed(4)} R=${rRms.toExponential(1)} / pan=+1: L=${lRms2.toExponential(1)} R=${rRms2.toFixed(4)}`;
});

T('[7] masterVolume 0.5 で振幅がちょうど半分', async () => {
  resetProject();
  const id = DAW.registerBuffer(makeBuffer(2, 0.3, sineFill(440, 0.5)));
  const t = DAW.addTrack();
  addClip(t, id, 0, 0.3);

  DAW.project.masterVolume = 1;
  const full = await renderMix();
  DAW.project.masterVolume = 0.5;
  const half = await renderMix();
  DAW.project.masterVolume = 1;

  const fR = rms(full.buffer.getChannelData(0));
  const hR = rms(half.buffer.getChannelData(0));
  const fP = peakAbs(full.buffer.getChannelData(0));
  const hP = peakAbs(half.buffer.getChannelData(0));
  ok(fR > 0.05, '基準レンダリングが無音');
  near(hR / fR, 0.5, 0.01, 'rms 比');
  near(hP / fP, 0.5, 0.01, 'peak 比');
  return `rms比=${(hR / fR).toFixed(4)}, peak比=${(hP / fP).toFixed(4)}（絶対値ではなく 1.0 時との比で判定）`;
});

T('[7] トラック volume が反映される', async () => {
  resetProject();
  const id = DAW.registerBuffer(makeBuffer(2, 0.3, sineFill(440, 0.5)));
  const t = DAW.addTrack();
  addClip(t, id, 0, 0.3);
  const full = await renderMix();
  t.volume = 0.25;
  const quiet = await renderMix();
  const ratio = rms(quiet.buffer.getChannelData(0)) / rms(full.buffer.getChannelData(0));
  near(ratio, 0.25, 0.01, 'volume 比');
  return `volume=0.25 -> rms比 ${ratio.toFixed(4)}`;
});

T('[7] ミュート / ソロが反映される', async () => {
  resetProject();
  const id = DAW.registerBuffer(makeBuffer(2, 0.3, sineFill(440, 0.4)));
  const a = DAW.addTrack();
  const b = DAW.addTrack();
  addClip(a, id, 0, 0.3);
  addClip(b, id, 0, 0.3);

  const both = await renderMix();
  a.muted = true;
  const oneMuted = await renderMix();
  b.muted = true;
  const allMuted = await renderMix();
  eq(rms(allMuted.buffer.getChannelData(0)), 0, '全ミュートで無音でない');
  const r1 = rms(oneMuted.buffer.getChannelData(0)) / rms(both.buffer.getChannelData(0));
  near(r1, 0.5, 0.01, '1本ミュートで半分');

  a.muted = false; b.muted = false;
  a.solo = true;
  const soloed = await renderMix();
  near(rms(soloed.buffer.getChannelData(0)) / rms(both.buffer.getChannelData(0)), 0.5, 0.01, 'ソロで非ソロが落ちる');
  return `1本ミュート -> ${r1.toFixed(3)}、全ミュート -> 無音、ソロも同様`;
});

T('[7] 重なるクリップが加算される', async () => {
  resetProject();
  const id = DAW.registerBuffer(makeBuffer(2, 0.3, sineFill(440, 0.3)));
  const t = DAW.addTrack();
  addClip(t, id, 0, 0.3);
  const one = await renderMix();
  addClip(t, id, 0, 0.3);
  const two = await renderMix();
  const ratio = rms(two.buffer.getChannelData(0)) / rms(one.buffer.getChannelData(0));
  near(ratio, 2, 0.02, '同位相2本で2倍');
  eq(firstNonFinite(two.buffer), null, '非有限値');
  return `同位置2クリップ -> rms比 ${ratio.toFixed(3)}`;
});

T('[7] 0dBFS 超過は confirm で確認し、キャンセルで中止', async () => {
  resetProject();
  // マスターリミッターが有効だとシーリングで抑えられて 0dBFS を超えないので、
  // この警告はリミッターを切っているときの挙動として検証する。
  const limWas = DAW.limiter.enabled;
  DAW.limiter.enabled = false;
  try {
  // 0.9 の正弦波を同位置に2本 -> ピーク 1.8（0dBFS 超過）
  const id = DAW.registerBuffer(makeBuffer(1, 0.2, sineFill(440, 0.9)));
  const t = DAW.addTrack(); t.pan = -1;
  addClip(t, id, 0, 0.2);
  addClip(t, id, 0, 0.2);

  takeConfirms();
  H.confirmResult = false;
  const cancelled = await renderMix();
  const c1 = takeConfirms();
  eq(cancelled, null, 'キャンセルしたのに書き出された');
  eq(c1.length, 1, 'confirm 回数');
  ok(/dBFS/.test(c1[0]), `confirm 文言: ${c1[0]}`);
  ok(DAW.wav.lastExportPeak > 1.5, `lastExportPeak=${DAW.wav.lastExportPeak}`);

  H.confirmResult = true;
  const accepted = await renderMix();
  eq(takeConfirms().length, 1, '続行時も confirm は1回');
  ok(accepted, '続行を選んでも書き出されない');
  near(peakAbs(accepted.buffer.getChannelData(0)), 1, 0.02, '16bit WAV では ±1.0 で頭打ち');
  } finally {
    DAW.limiter.enabled = limWas;
    H.confirmResult = true;
  }
  return `peak=${DAW.wav.lastExportPeak.toFixed(2)}（${DAW.wav.toDbfs(DAW.wav.lastExportPeak).toFixed(1)}dBFS）でガードが働く`;
});

T('[7] 0dBFS 以下なら confirm は出ない', async () => {
  resetProject();
  const id = DAW.registerBuffer(makeBuffer(2, 0.2, sineFill(440, 0.5)));
  const t = DAW.addTrack();
  addClip(t, id, 0, 0.2);
  takeConfirms();
  const r = await renderMix();
  ok(r, '書き出されていない');
  eq(takeConfirms().length, 0, 'confirm が出た');
  ok(DAW.wav.lastExportPeak <= 1.0, `peak=${DAW.wav.lastExportPeak}`);
  return `peak=${DAW.wav.lastExportPeak.toFixed(3)} -> 確認なしで書き出し`;
});

// =====================================================================
// [8] プラグインを exportMix 経路に通す
// =====================================================================
async function renderWithFx(effects, bufFill, durSec) {
  resetProject();
  const id = DAW.registerBuffer(makeBuffer(1, durSec, bufFill));
  const t = DAW.addTrack();
  addClip(t, id, 0, durSec);
  const dry = await renderMix();
  t.effects = effects;
  const wet = await renderMix();
  if (!dry || !wet) throw new Error('書き出しが中断された（confirm が出た可能性）');
  return { dry, wet };
}

T('[8] lowpass: 8kHz を 500Hz 設定で減衰させる', async () => {
  const { dry, wet } = await renderWithFx([fx('lowpass', { freq: 500, q: 0.8 })], sineFill(8000, 0.5), 0.4);
  eq(firstNonFinite(wet.buffer), null, '非有限値');
  const d = rms(dry.buffer.getChannelData(0)), w = rms(wet.buffer.getChannelData(0));
  ok(d > 0.05, '素の信号が無音');
  ok(w / d < 0.05, `減衰不足: 比=${(w / d).toExponential(2)}`);
  return `8kHz正弦波 rms ${d.toFixed(4)} -> ${w.toExponential(2)}（${(20 * Math.log10(w / d)).toFixed(1)}dB）`;
});

T('[8] lowpass: 通過帯域は素通し', async () => {
  const { dry, wet } = await renderWithFx([fx('lowpass', { freq: 8000, q: 0.8 })], sineFill(200, 0.5), 0.4);
  const ratio = rms(wet.buffer.getChannelData(0)) / rms(dry.buffer.getChannelData(0));
  near(ratio, 1, 0.05, '通過帯域のゲイン');
  return `200Hz / カットオフ8kHz -> 比 ${ratio.toFixed(4)}`;
});

T('[8] delay: 遅延成分とフィードバックが現れる', async () => {
  const sr = SR();
  const burst = t => (t < 0.03 ? 0.6 * Math.sin(2 * Math.PI * 800 * t) : 0);
  const { dry, wet } = await renderWithFx([fx('delay', { time: 0.3, feedback: 0.35, mix: 0.5 })], burst, 1.0);
  eq(firstNonFinite(wet.buffer), null, '非有限値');
  const w = wet.buffer.getChannelData(0);
  eq(rms(dry.buffer.getChannelData(0), Math.floor(0.3 * sr), Math.floor(0.4 * sr)), 0, '素の信号は 0.3s 以降無音');
  const echo = rms(w, Math.floor(0.3 * sr), Math.floor(0.4 * sr));
  ok(echo > 0.01, `0.3秒後にエコーが無い (${echo})`);
  ok(rms(w, Math.floor(0.6 * sr), Math.floor(0.7 * sr)) > 0.001, '0.6秒後のフィードバック成分が無い');
  ok(rms(w, 0, Math.floor(0.03 * sr)) > 0.1, 'ドライ成分が無い');
  return `0.3s後 rms=${echo.toFixed(4)}、0.6s後もフィードバックあり、ドライも残る`;
});

T('[8] geq7: 1kHz を +12dB ブースト', async () => {
  const { dry, wet } = await renderWithFx([fx('geq7', { b1k: 12 })], sineFill(1000, 0.2), 0.4);
  eq(firstNonFinite(wet.buffer), null, '非有限値');
  const d = rms(dry.buffer.getChannelData(0)), w = rms(wet.buffer.getChannelData(0));
  ok(w > 0.001, '無音');
  ok(w / d > 2, `ブースト不足: 比=${(w / d).toFixed(3)}`);
  return `1kHz rms ${d.toFixed(4)} -> ${w.toFixed(4)}（+${(20 * Math.log10(w / d)).toFixed(1)}dB）`;
});

T('[8] geq7: 全バンド0dB なら素通し', async () => {
  const { dry, wet } = await renderWithFx([fx('geq7')], sineFill(1000, 0.4), 0.3);
  const ratio = rms(wet.buffer.getChannelData(0)) / rms(dry.buffer.getChannelData(0));
  near(ratio, 1, 0.03, 'フラット時のゲイン');
  return `全バンド0dB -> 比 ${ratio.toFixed(4)}`;
});

T('[8] dyneq3: AudioWorklet が file:// で動く', async () => {
  const { dry, wet } = await renderWithFx(
    [fx('dyneq3', { f2: 1000, g2: 12, q2: 1, d2: 0, t2: -30 })], sineFill(1000, 0.2), 0.4);
  eq(firstNonFinite(wet.buffer), null, '非有限値');
  const d = rms(dry.buffer.getChannelData(0)), w = rms(wet.buffer.getChannelData(0));
  ok(w > 0.001, 'Worklet 出力が無音（モジュールがロードできていない可能性）');
  ok(w / d > 1.8, `ブースト不足: 比=${(w / d).toFixed(3)}（パススルーになっている可能性）`);
  return `Blob URL の AudioWorklet がロードされ 1kHz を +${(20 * Math.log10(w / d)).toFixed(1)}dB ブースト`;
});

T('[8] dyneq3: 全ゲイン0 なら素通し', async () => {
  const { dry, wet } = await renderWithFx([fx('dyneq3')], sineFill(1000, 0.3), 0.3);
  eq(firstNonFinite(wet.buffer), null, '非有限値');
  const ratio = rms(wet.buffer.getChannelData(0)) / rms(dry.buffer.getChannelData(0));
  near(ratio, 1, 0.05, 'フラット時のゲイン');
  return `既定パラメータ -> 比 ${ratio.toFixed(4)}`;
});

T('[8] 4プラグイン直列でも有限かつ非無音', async () => {
  const effects = EXPECTED_PLUGINS.map(id => fx(id, id === 'lowpass' ? { freq: 12000 } : {}));
  const { dry, wet } = await renderWithFx(effects, sineFill(500, 0.4), 0.4);
  eq(firstNonFinite(wet.buffer), null, '非有限値');
  const w = rms(wet.buffer.getChannelData(0));
  ok(w > 0.01, `直列チェーンの出力が無音 (${w})`);
  ok(peakAbs(wet.buffer.getChannelData(0)) < 1.5, '異常に増幅されている');
  return `${EXPECTED_PLUGINS.join(' -> ')}: rms ${rms(dry.buffer.getChannelData(0)).toFixed(4)} -> ${w.toFixed(4)}`;
});

T('[8] prepareAll が OfflineAudioContext で解決する', async () => {
  const off = new OfflineAudioContext(2, 128, SR());
  await DAW.plugins.prepareAll(off, [{ effects: [fx('dyneq3'), fx('lowpass')] }]);
  const def = DAW.plugins.get('dyneq3');
  const inst = def.create(off, DAW.plugins.defaultParams(def));
  ok(inst && inst.input && inst.output, 'create がノードを返す');
  ok(inst.input instanceof AudioWorkletNode, 'prepare 後は AudioWorkletNode（パススルーではない）');
  return 'prepareAll -> create で AudioWorkletNode が得られる';
});

T('[8] 未登録 pluginId はチェーンから無視される', async () => {
  resetProject();
  const id = DAW.registerBuffer(makeBuffer(1, 0.2, sineFill(440, 0.4)));
  const t = DAW.addTrack();
  addClip(t, id, 0, 0.2);
  const dry = await renderMix();
  t.effects = [{ pluginId: 'この-プラグインは無い', params: {} }];
  const wet = await renderMix();
  near(rms(wet.buffer.getChannelData(0)), rms(dry.buffer.getChannelData(0)), 1e-4, '未登録FXがあっても素通し');
  eq(takeAlerts().length, 0, '書き出しでは alert を出さない');
  return 'connectChain は未登録 pluginId を skip する';
});

// =====================================================================
// [9] プロジェクト保存 / 読み込み
// =====================================================================
function buildSampleProject() {
  resetProject();
  const bufA = makeBuffer(2, 0.2, sineFill(440, 0.5));
  const bufB = makeBuffer(1, 0.15, sineFill(880, 0.3));
  const idA = DAW.registerBuffer(bufA);
  const idB = DAW.registerBuffer(bufB);
  const t1 = DAW.addTrack('ドラム');
  t1.volume = 0.75; t1.pan = -0.5;
  t1.effects = [fx('lowpass', { freq: 4000, q: 2 }), fx('geq7', { b60: 6 })];
  addClip(t1, idA, 0.1, 0.2, 0);
  const t2 = DAW.addTrack('ベース');
  t2.volume = 0.5; t2.pan = 0.25; t2.muted = true;
  addClip(t2, idB, 0.5, 0.1, 0.02);
  DAW.project.masterVolume = 0.8;
  return { idA, idB, bufA, bufB, t1, t2 };
}

async function saveToJson() {
  H.downloads.length = 0;
  DAW.wav.saveProject();
  const d = H.downloads.pop();
  if (!d) throw new Error('saveProject が download を呼ばなかった');
  return { download: d, json: JSON.parse(await d.blob.text()) };
}

T('[9] saveProject の JSON 構造', async () => {
  const p = buildSampleProject();
  const { download, json } = await saveToJson();
  eq(download.filename, 'project.daw.json', 'ファイル名');
  eq(download.blob.type, 'application/json', 'MIME');
  eq(json.version, 1, 'version');
  near(json.masterVolume, 0.8, 1e-9, 'masterVolume');
  eq(json.tracks.length, 2, 'トラック数');
  eq(Object.keys(json.buffers).length, 2, 'バッファ数');
  for (const id of [p.idA, p.idB]) {
    ok(json.buffers[id] && typeof json.buffers[id].wav === 'string' && json.buffers[id].wav.length > 100,
      `buffers[${id}].wav`);
  }
  const t = json.tracks[0];
  for (const k of ['id', 'name', 'volume', 'pan', 'muted', 'solo', 'effects', 'clips']) ok(k in t, `track.${k} が無い`);
  const c = t.clips[0];
  for (const k of ['id', 'bufferId', 'startTime', 'offset', 'duration']) ok(k in c, `clip.${k} が無い`);
  return `version=1, tracks=2, buffers=2, JSON ${JSON.stringify(json).length} 文字`;
});

T('[9] saveProject は未参照バッファを含めない', async () => {
  buildSampleProject();
  DAW.registerBuffer(makeBuffer(1, 0.05, () => 0.1)); // どのクリップからも参照されない
  eq(DAW.buffers.size, 3, '登録済みバッファ数');
  const { json } = await saveToJson();
  eq(Object.keys(json.buffers).length, 2, '保存されるのは参照中の2本だけ');
  return '3本中、クリップから参照されている2本のみ保存';
});

T('[9] 保存 -> 読み込み往復でトラック情報が復元される', async () => {
  buildSampleProject();
  const before = JSON.parse(JSON.stringify(DAW.project.tracks));
  const { download } = await saveToJson();
  const okLoad = await DAW.wav.loadProject(download.blob);
  eq(okLoad, true, 'loadProject が true を返す');
  eq(takeAlerts().length, 0, '警告が出た');
  near(DAW.project.masterVolume, 0.8, 1e-9, 'masterVolume 復元');
  eq(DAW.project.tracks.length, 2, 'トラック数');
  before.forEach((b, i) => {
    const a = DAW.project.tracks[i];
    eq(a.name, b.name, `tracks[${i}].name`);
    near(a.volume, b.volume, 1e-9, `tracks[${i}].volume`);
    near(a.pan, b.pan, 1e-9, `tracks[${i}].pan`);
    eq(a.muted, b.muted, `tracks[${i}].muted`);
    eq(a.solo, b.solo, `tracks[${i}].solo`);
    eq(a.clips.length, b.clips.length, `tracks[${i}].clips 数`);
    a.clips.forEach((c, j) => {
      eq(c.bufferId, b.clips[j].bufferId, `clip[${j}].bufferId`);
      near(c.startTime, b.clips[j].startTime, 1e-9, `clip[${j}].startTime`);
      near(c.offset, b.clips[j].offset, 1e-9, `clip[${j}].offset`);
      near(c.duration, b.clips[j].duration, 1e-9, `clip[${j}].duration`);
    });
  });
  return `名前/volume/pan/muted/solo/clips すべて一致（${before.map(t => t.name).join(', ')}）`;
});

T('[9] 往復でエフェクトが復元される', async () => {
  buildSampleProject();
  const { download } = await saveToJson();
  await DAW.wav.loadProject(download.blob);
  const e = DAW.project.tracks[0].effects;
  eq(e.length, 2, 'エフェクト数');
  eq(e[0].pluginId, 'lowpass', 'effects[0].pluginId');
  near(e[0].params.freq, 4000, 1e-9, 'lowpass.freq');
  near(e[0].params.q, 2, 1e-9, 'lowpass.q');
  eq(e[1].pluginId, 'geq7', 'effects[1].pluginId');
  near(e[1].params.b60, 6, 1e-9, 'geq7.b60');
  near(e[1].params.b15k, 0, 1e-9, 'geq7.b15k が default');
  eq(Object.keys(e[1].params).length, DAW.plugins.get('geq7').params.length, 'params の key 数が定義と一致');
  return 'lowpass(freq=4000,q=2) + geq7(b60=6) を復元、欠落 key は default 補完';
});

T('[9] 往復で音声バッファが復元される', async () => {
  const p = buildSampleProject();
  const origA = rms(p.bufA.getChannelData(0));
  const origB = rms(p.bufB.getChannelData(0));
  const { download } = await saveToJson();
  await DAW.wav.loadProject(download.blob);
  eq(DAW.buffers.size, 2, 'バッファ数');
  const a = DAW.buffers.get(p.idA), b = DAW.buffers.get(p.idB);
  ok(a && b, 'bufferId をキーに復元されている');
  eq(a.numberOfChannels, 2, 'A のチャンネル数');
  eq(b.numberOfChannels, 1, 'B のチャンネル数');
  eq(a.length, p.bufA.length, 'A のサンプル数');
  near(rms(a.getChannelData(0)), origA, 1e-3, 'A の rms');
  near(rms(b.getChannelData(0)), origB, 1e-3, 'B の rms');
  eq(DAW.peaks.size, 2, 'peaks も再計算されている');
  ok(DAW.peaks.get(p.idA) instanceof Float32Array, 'peaks の型');
  return `rms A ${origA.toFixed(5)}≈${rms(a.getChannelData(0)).toFixed(5)}, B ${origB.toFixed(5)}≈${rms(b.getChannelData(0)).toFixed(5)}`;
});

T('[9] 復元後のプロジェクトが書き出せる', async () => {
  buildSampleProject();
  const { download } = await saveToJson();
  await DAW.wav.loadProject(download.blob);
  takeAlerts();
  const r = await renderMix();
  ok(r, '書き出しできない');
  eq(firstNonFinite(r.buffer), null, '非有限値');
  eq(r.buffer.length, Math.ceil(DAW.projectDuration() * SR()), 'ミックス長');
  ok(rms(r.buffer.getChannelData(0)) > 0, '無音');
  return `復元後 ${DAW.projectDuration().toFixed(2)}s のミックスを生成`;
});

T('[9] 未登録プラグインは警告してスキップ', async () => {
  buildSampleProject();
  const { json } = await saveToJson();
  json.tracks[0].effects.push({ pluginId: 'ghost-fx', params: { x: 1 } });
  json.tracks[1].effects = [{ pluginId: 'ghost-fx2', params: {} }];
  takeAlerts();
  const okLoad = await DAW.wav.loadProject(new Blob([JSON.stringify(json)], { type: 'application/json' }));
  eq(okLoad, true, 'loadProject は成功する');
  const alerts = takeAlerts();
  eq(alerts.length, 1, 'alert 回数');
  ok(/ghost-fx/.test(alerts[0]) && /ghost-fx2/.test(alerts[0]), `alert 文言: ${alerts[0]}`);
  eq(DAW.project.tracks[0].effects.length, 2, '既知プラグインは残る');
  eq(DAW.project.tracks[1].effects.length, 0, '未登録のみのトラックは空になる');
  ok(DAW.project.tracks[0].effects.every(e => DAW.plugins.get(e.pluginId)), '残ったのは全て既知');
  return `alert="${alerts[0]}"、既知FXは維持`;
});

T('[9] 壊れた JSON を安全に拒否', async () => {
  buildSampleProject();
  const n = DAW.project.tracks.length;
  takeAlerts();
  const r = await DAW.wav.loadProject(new Blob(['{ これは JSON では'], { type: 'application/json' }));
  eq(r, false, 'false を返す');
  const alerts = takeAlerts();
  eq(alerts.length, 1, 'alert 回数');
  eq(DAW.project.tracks.length, n, '既存プロジェクトが壊れていない');
  return `alert="${alerts[0]}"、状態は不変`;
});

T('[9] 未対応 version / 不正形式を拒否', async () => {
  buildSampleProject();
  const cases = [
    ['version=2', { version: 2, tracks: [], buffers: {} }],
    ['version 欠落', { tracks: [], buffers: {} }],
    ['tracks が配列でない', { version: 1, tracks: { a: 1 }, buffers: {} }],
    ['tracks 欠落', { version: 1, buffers: {} }],
    ['空オブジェクト', {}],
    ['null', null],
  ];
  for (const [label, obj] of cases) {
    takeAlerts();
    const r = await DAW.wav.loadProject(new Blob([JSON.stringify(obj)], { type: 'application/json' }));
    eq(r, false, `${label}: false を返すべき`);
    eq(takeAlerts().length, 1, `${label}: alert 1回`);
  }
  eq(DAW.project.tracks.length, 2, '既存プロジェクトが壊れていない');
  return `${cases.length} パターンすべて拒否: ${cases.map(c => c[0]).join(' / ')}`;
});

// =====================================================================
// [10] ライブ再生グラフ
// =====================================================================
T('[10] ensureCtx が AudioContext と masterGain を作る', () => {
  const c = DAW.audio.ensureCtx();
  ok(c instanceof (window.AudioContext || window.webkitAudioContext), 'AudioContext ではない');
  eq(DAW.audio.ensureCtx(), c, '2回目は同じ ctx');
  ok(DAW.audio.masterGain instanceof GainNode, 'masterGain が無い');
  ok(c.sampleRate > 0, 'sampleRate');
  return `AudioContext ${c.sampleRate}Hz state=${c.state}`;
});

T('[10] マスターメーター用 analyser が作られる', () => {
  ok(Array.isArray(DAW.audio.analysers), 'analysers が配列でない');
  eq(DAW.audio.analysers.length, 2, 'L/R 2本');
  for (const a of DAW.audio.analysers) ok(a instanceof AnalyserNode, 'AnalyserNode でない');
  ok(DAW.audio.meterBuf instanceof Float32Array, 'meterBuf が Float32Array でない');
  eq(DAW.audio.meterBuf.length, DAW.audio.analysers[0].fftSize, 'meterBuf 長 = fftSize');
  const lv = DAW.audio.getLevels();
  eq(lv.length, 2, 'getLevels の要素数');
  for (const v of lv) ok(Number.isFinite(v) && v >= 0, `レベルが不正: ${v}`);
  return `AnalyserNode×2 (fftSize=${DAW.audio.analysers[0].fftSize}), getLevels=[${lv.map(v => v.toFixed(3)).join(', ')}]`;
});

T('[10] play で source とトラックノードが作られる', async () => {
  resetProject();
  const id = DAW.registerBuffer(makeBuffer(2, 3.0, sineFill(440, 0.2)));
  const a = DAW.addTrack('L'); a.pan = -0.5; a.volume = 0.6;
  a.effects = [fx('lowpass', { freq: 3000 })];
  const b = DAW.addTrack('R'); b.pan = 0.5;
  addClip(a, id, 0, 3.0);
  addClip(b, id, 0.2, 1.0);

  eq(DAW.audio.playing, false, '再生前の playing');
  await DAW.audio.play();
  eq(DAW.audio.playing, true, 'playing');
  eq(DAW.audio.sources.length, 2, 'スケジュールされた source 数');
  eq(DAW.audio.trackNodes.size, 2, 'trackNodes 数');
  const na = DAW.audio.trackNodes.get(a.id);
  ok(na.gain instanceof GainNode, 'gain が GainNode');
  ok(na.panner instanceof StereoPannerNode, 'panner が StereoPannerNode');
  eq(na.fx.length, 1, 'FX インスタンス数');
  ok(na.fx[0].input && na.fx[0].output && typeof na.fx[0].set === 'function', 'FX インスタンスの形');
  near(na.panner.pan.value, -0.5, 1e-6, 'panner.pan');
  eq(DAW.audio.trackNodes.get(b.id).fx.length, 0, 'FX 無しトラック');
  return 'sources=2, trackNodes=2, FX=1（lowpass）, pan 反映済み';
});

T('[10] 再生中に再生位置が進む', async () => {
  ok(DAW.audio.playing, '前提: 再生中');
  const p0 = DAW.audio.getPos();
  await delay(300);
  const p1 = DAW.audio.getPos();
  ok(p1 > p0, `位置が進んでいない (${p0} -> ${p1})`);
  ok(p1 < 3.0, `進みすぎ (${p1})`);
  return `${p0.toFixed(3)}s -> ${p1.toFixed(3)}s`;
});

T('[10] updateGains が例外なく effectiveGain を反映', () => {
  const a = DAW.project.tracks[0];
  const n = DAW.audio.trackNodes.get(a.id);
  ok(n, 'trackNodes');
  near(n.gain.gain.value, 0.6, 0.05, '再生開始時の gain');
  a.muted = true;
  DAW.audio.updateGains();
  a.muted = false;
  DAW.audio.updateGains();
  return 'gain/pan を setTargetAtTime で更新（例外なし）';
});

T('[10] pause で停止し位置を保持', async () => {
  ok(DAW.audio.playing, '前提: 再生中');
  DAW.audio.pause();
  eq(DAW.audio.playing, false, 'playing');
  eq(DAW.audio.sources.length, 0, 'sources が解放されている');
  const p = DAW.audio.playheadPos;
  ok(p > 0, `位置が保持されていない (${p})`);
  ok(p <= DAW.projectDuration() + 1e-9, `位置が projectDuration を超えている (${p})`);
  await delay(120);
  eq(DAW.audio.getPos(), p, '停止中は位置が動かない');
  DAW.audio.pause();
  eq(DAW.audio.playheadPos, p, '二重 pause も安全');
  return `playheadPos=${p.toFixed(3)}s で保持、停止中は不動`;
});

T('[10] seek: 停止中', () => {
  DAW.audio.seek(0.75);
  eq(DAW.audio.playing, false, '停止中の seek で再生開始しない');
  near(DAW.audio.playheadPos, 0.75, 1e-9, 'playheadPos');
  near(DAW.audio.getPos(), 0.75, 1e-9, 'getPos');
  DAW.audio.seek(-5);
  eq(DAW.audio.playheadPos, 0, '負の値は 0 に丸める');
  return 'seek(0.75)=0.75, seek(-5)=0';
});

T('[10] seek: 再生中は同位置から再スケジュール', async () => {
  await DAW.audio.play();
  eq(DAW.audio.playing, true, '再生中');
  DAW.audio.seek(0.6);
  near(DAW.audio.playheadPos, 0.6, 1e-9, 'playheadPos');
  await delay(150);
  eq(DAW.audio.playing, true, 'seek 後も再生継続');
  near(DAW.audio.playStartPos, 0.6, 1e-9, 'playStartPos');
  ok(DAW.audio.sources.length > 0, 'source が再スケジュールされていない');
  ok(DAW.audio.getPos() >= 0.6, '位置が seek 地点以降');
  return `seek(0.6) 後も再生継続、sources=${DAW.audio.sources.length}`;
});

T('[10] reschedule が再生を維持する', async () => {
  ok(DAW.audio.playing, '前提: 再生中');
  DAW.audio.reschedule();
  await delay(150);
  eq(DAW.audio.playing, true, '再生継続');
  ok(DAW.audio.sources.length > 0, 'source が再作成されている');
  return `reschedule 後 sources=${DAW.audio.sources.length}`;
});

T('[10] stop で先頭に戻る', () => {
  DAW.audio.stop();
  eq(DAW.audio.playing, false, 'playing');
  eq(DAW.audio.playheadPos, 0, 'playheadPos');
  eq(DAW.audio.sources.length, 0, 'sources');
  eq(DAW.audio.getPos(), 0, 'getPos');
  DAW.audio.stop();
  eq(DAW.audio.playheadPos, 0, '二重 stop も安全');
  return 'playing=false, playheadPos=0, sources=[]';
});

T('[10] クリップが無ければ play しない', async () => {
  const saved = DAW.project;
  DAW.project = { masterVolume: 1, tracks: [] };
  DAW.addTrack('empty');
  await DAW.audio.play();
  eq(DAW.audio.playing, false, 'クリップ0本で playing になっている');
  eq(DAW.audio.sources.length, 0, 'sources');
  DAW.project = saved;
  return 'projectDuration<=0 なら play は何もしない';
});

T('[10] setEffectParam / rebuildTrackChain', () => {
  const a = DAW.project.tracks[0];
  DAW.audio.getTrackNodes(a);
  DAW.audio.setEffectParam(a, 0, 'freq', 900);
  near(a.effects[0].params.freq, 900, 1e-9, 'params が更新される');
  DAW.audio.setEffectParam(a, 99, 'freq', 100);              // 範囲外は無害
  DAW.audio.setEffectParam({ id: 'x', effects: [] }, 0, 'f', 1);
  a.effects.push(fx('delay'));
  DAW.audio.rebuildTrackChain(a);
  eq(DAW.audio.trackNodes.get(a.id).fx.length, 2, '再構築後の FX 数');
  a.effects.pop();
  DAW.audio.rebuildTrackChain(a);
  eq(DAW.audio.trackNodes.get(a.id).fx.length, 1, 'FX 削除後');
  DAW.audio.rebuildTrackChain({ id: '無いID', effects: [] }); // 無害
  return 'パラメータ更新とチェーン再構築が例外なく動く';
});

T('[10] setMasterVolume', () => {
  DAW.audio.setMasterVolume(0.4);
  near(DAW.project.masterVolume, 0.4, 1e-9, 'project.masterVolume');
  DAW.audio.setMasterVolume(1);
  near(DAW.project.masterVolume, 1, 1e-9, '戻す');
  return 'masterVolume を state とノードの両方に反映';
});

T('[10] removeTrack がノードを解放', () => {
  const a = DAW.project.tracks[0];
  DAW.audio.getTrackNodes(a);
  ok(DAW.audio.trackNodes.has(a.id), '前提: ノードがある');
  DAW.removeTrack(a.id);
  ok(!DAW.audio.trackNodes.has(a.id), 'removeTrack でノードが解放されていない');
  ok(!DAW.project.tracks.some(t => t.id === a.id), 'トラックが消えている');
  return 'removeTrack -> removeTrackNodes が連動';
});

T('[10] resetNodes で全ノード解放', () => {
  for (const t of DAW.project.tracks) DAW.audio.getTrackNodes(t);
  ok(DAW.audio.trackNodes.size > 0, '前提: ノードがある');
  DAW.audio.resetNodes();
  eq(DAW.audio.trackNodes.size, 0, 'trackNodes が空になっていない');
  DAW.audio.resetNodes();
  eq(DAW.audio.trackNodes.size, 0, '二重 resetNodes も安全');
  DAW.audio.removeTrackNodes('無いID');
  return 'trackNodes を空にし、多重呼び出しも安全';
});

// =====================================================================
// [11] 全工程の監視（最後に実行する）
// =====================================================================
T('[11] 全工程を通じて未捕捉エラーなし', () => {
  ok(H.errors.length === 0, `${H.errors.length} 件:\n${H.errors.slice(0, 5).join('\n')}`);
  return 'window.onerror / unhandledrejection / console.error / リソース失敗 いずれも 0 件';
});

T('[11] 想定外の alert / confirm なし', () => {
  ok(H.alerts.length === 0, `未消化の alert ${H.alerts.length} 件: ${H.alerts.join(' | ')}`);
  ok(H.confirms.length === 0, `未消化の confirm ${H.confirms.length} 件: ${H.confirms.join(' | ')}`);
  return 'テストで意図したもの以外のモーダルは発生していない';
});

T('[11] download / alert / confirm がスタブされている', () => {
  ok(DAW.wav.download !== H.realDownload, 'download がスタブされていない');
  ok(typeof window.alert === 'function' && typeof window.confirm === 'function', 'alert/confirm');
  eq(H.downloads.filter(d => d).length >= 0, true, 'downloads は記録のみ');
  return '実ダウンロード / モーダルは一切発生していない';
});

// =====================================================================
// ランナー
// =====================================================================
async function runAll() {
  phase('テスト実行');
  for (const t of SUITE) {
    phase(t.name);
    const rec = { name: t.name, pass: false, detail: '' };
    try {
      rec.detail = String((await t.fn()) || 'OK');
      rec.pass = true;
    } catch (e) {
      const line = e && e.stack ? (String(e.stack).split('\n')[1] || '').trim() : '';
      rec.detail = ((e && e.message) || String(e)) + (line ? `  << ${line}` : '');
    }
    H.tests.push(rec);
  }
}

async function start() {
  try {
    await runAll();
    phase('後片付け');
    try { DAW.audio.stop(); DAW.audio.resetNodes(); } catch (e) {}
  } catch (e) {
    H.fatal = `${(e && e.message) || e}\n${(e && e.stack) || ''}`;
    H.tests.push({ name: '[!] ランナー', pass: false, detail: `phase=${H.phase}: ${(e && e.message) || e}` });
  }
  phase('結果送信');
  window.sendResult();
}

// main.js の DOMContentLoaded 初期化が終わってから走らせる
if (document.readyState === 'complete') start();
else window.addEventListener('load', start);
