'use strict';
// =====================================================================
// マスター設定のプロジェクト保存/復元のテスト。
//   - save→load 往復でマスターリミッター / 出力形式 / メトロノーム / グリッドが一致
//   - 出力形式は「ユーザーの明示選択」（binaural/speakers + 配置）だけを保存し、
//     autoHrtf の一時状態（equalpower/hrtf）を固定しない
//   - 欠落フィールドは既定値フォールバック（旧形式プロジェクトが従来どおり開ける）
//   - RENDERER のノブ（リミッター/ルームリバーブ）はドラッグ全体で undo 1エントリ
// 他ファイルのヘルパには依存しない。
// =====================================================================

function masterSaveSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    const OA = DAW.objaudio;
    const savedLim = DAW.limiter.toJSON();
    const savedRev = Object.assign({}, OA.revParams);
    const savedMode = OA.mode;
    const savedLayout = OA.layoutName;
    const savedAuto = OA.autoHrtf;
    const savedMetro = Object.assign({}, DAW.metronome);
    const savedGrid = Object.assign({}, DAW.grid);
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.project.masterVolume = 1;
    DAW.objects.clear();
    OA.autoHrtf = true;
    OA.loadOutput(null);      // 既定（バイノーラル=等パワー / 5.1）から始める
    OA.loadRevParams(null);
    DAW.limiter.load(null);
    DAW.loop.enabled = false; DAW.loop.start = 0; DAW.loop.end = 0;
    DAW.metronome.enabled = false; DAW.metronome.volume = 0.35;
    DAW.grid.enabled = false; DAW.grid.division = 1;
    DAW.setBpm(120);
    DAW.addTrack('src');
    DAW.ui.renderTracks();
    DAW.history.reset();
    try { await body(okf); } finally {
      DAW.objects.clear();
      DAW.limiter.load(savedLim);
      OA.loadRevParams(savedRev);
      OA.mode = savedMode;
      OA.layoutName = savedLayout;
      OA.autoHrtf = savedAuto;
      Object.assign(DAW.metronome, savedMetro);
      Object.assign(DAW.grid, savedGrid);
      if (DAW.objui && DAW.objui._inited) {
        DAW.objui.setView('panner');
        DAW.objui.render();
      }
      DAW.audio.resetNodes();
      try { DAW.audio.stop(); } catch (e) {}
    }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

// ---------------------------------------------------------------------
// save → load 往復と欠落フィールドのフォールバック
// ---------------------------------------------------------------------
masterSaveSuite('[43] マスター設定の保存/復元', async (okf) => {
  const L = DAW.limiter;
  const OA = DAW.objaudio;

  // ---- 全設定を非デフォルトにして保存 ----
  L.set('gainDb', 3); L.set('releaseMs', 250); L.set('ceilingDb', -3); L.set('lookaheadMs', 10);
  L.setEnabled(false);
  OA.setRevParam('decay', 3.2); OA.setRevParam('damp', 0.8); OA.setRevParam('level', 0.4);
  OA.setModeQuiet(OA.MODE_SPEAKERS);
  OA.layoutName = '7.1.4';
  DAW.metronome.enabled = true; DAW.metronome.volume = 0.5;
  DAW.grid.enabled = true; DAW.grid.division = 0.25;
  DAW.setBpm(140);
  H.downloads.length = 0;
  DAW.wav.saveProject();
  const txt = await H.downloads[H.downloads.length - 1].blob.text();
  const json = JSON.parse(txt);

  okf('S.1 version は 1 のまま（追加フィールドのみ）', json.version === 1, json.version);
  okf('S.2 limiter が params + enabled ごと保存される',
    json.limiter && json.limiter.enabled === false && json.limiter.params
    && json.limiter.params.gainDb === 3 && json.limiter.params.releaseMs === 250
    && json.limiter.params.ceilingDb === -3 && json.limiter.params.lookaheadMs === 10,
    JSON.stringify(json.limiter));
  okf('S.3 output は明示選択（speakers + 配置）で保存される',
    json.output && json.output.mode === 'speakers' && json.output.layout === '7.1.4',
    JSON.stringify(json.output));
  okf('S.4 metronome が保存される',
    json.metronome && json.metronome.enabled === true && json.metronome.volume === 0.5,
    JSON.stringify(json.metronome));
  okf('S.5 grid が保存される',
    json.grid && json.grid.enabled === true && json.grid.division === 0.25,
    JSON.stringify(json.grid));

  // ---- 既定値へ戻してから読み込み → 全設定が一致する ----
  L.load(null);
  OA.loadRevParams(null);
  OA.loadOutput(null);
  DAW.metronome.enabled = false; DAW.metronome.volume = 0.35;
  DAW.grid.enabled = false; DAW.grid.division = 1;
  DAW.setBpm(120);
  const ok = await DAW.wav.loadProject(new File([txt], 'p.json'));
  okf('S.6 読み込みが成功する', ok === true);
  okf('S.7 リミッターが復元される（enabled 含む）',
    L.enabled === false && L.params.gainDb === 3 && L.params.releaseMs === 250
    && L.params.ceilingDb === -3 && L.params.lookaheadMs === 10,
    JSON.stringify(L.toJSON()));
  okf('S.8 出力形式が復元される（speakers / 7.1.4）',
    OA.mode === OA.MODE_SPEAKERS && OA.layoutName === '7.1.4',
    `mode=${OA.mode} layout=${OA.layoutName}`);
  okf('S.9 ルームリバーブが復元される',
    OA.revParams.decay === 3.2 && OA.revParams.damp === 0.8 && OA.revParams.level === 0.4,
    JSON.stringify(OA.revParams));
  okf('S.10 メトロノームが復元される',
    DAW.metronome.enabled === true && DAW.metronome.volume === 0.5,
    JSON.stringify(DAW.metronome));
  okf('S.11 グリッドが復元される',
    DAW.grid.enabled === true && DAW.grid.division === 0.25,
    JSON.stringify(DAW.grid));
  okf('S.12 BPM も従来どおり復元される', DAW.project.bpm === 140, DAW.project.bpm);

  // ---- 出力形式: autoHrtf の一時状態（HRTF）は保存されない ----
  OA.loadOutput(null);                 // バイノーラル（等パワー）へ
  OA.setModeQuiet(OA.MODE_HRTF);       // 試聴中の自動切替を模擬
  H.downloads.length = 0;
  DAW.wav.saveProject();
  const txt2 = await H.downloads[H.downloads.length - 1].blob.text();
  const json2 = JSON.parse(txt2);
  okf('S.13 HRTF 中に保存しても output.mode は binaural（明示選択のみ）',
    json2.output && json2.output.mode === 'binaural', JSON.stringify(json2.output));
  await DAW.wav.loadProject(new File([txt2], 'p2.json'));
  okf('S.14 復元後は等パワーから始まる（HRTF 化は autoHrtf に任せる）',
    OA.mode === OA.MODE_EQUALPOWER && OA.autoHrtf === true, OA.mode);

  // ---- 欠落フィールドは既定値フォールバック（旧形式互換）----
  const old = JSON.parse(txt);
  delete old.limiter;
  delete old.output;
  delete old.metronome;
  delete old.grid;
  delete old.roomReverb;
  // 現在の状態を非デフォルトにしてから読む（フォールバックが「据え置き」でないことを確認）
  L.set('gainDb', -6); L.setEnabled(false);
  OA.setModeQuiet(OA.MODE_SPEAKERS); OA.layoutName = '7.1.4';
  OA.setRevParam('level', 0.9);
  DAW.metronome.enabled = true; DAW.metronome.volume = 0.9;
  DAW.grid.enabled = true; DAW.grid.division = 4;
  const okOld = await DAW.wav.loadProject(new File([JSON.stringify(old)], 'old.json'));
  okf('S.15 これらのフィールドを持たない旧形式でも開ける', okOld === true);
  okf('S.16 リミッターは既定値（有効・0dB/100ms/-1dB/5ms）へ戻る',
    L.enabled === true && JSON.stringify(L.params) === JSON.stringify(
      { gainDb: 0, releaseMs: 100, ceilingDb: -1, lookaheadMs: 5 }),
    JSON.stringify(L.toJSON()));
  okf('S.17 出力形式は既定（バイノーラル / 5.1）へ戻る',
    OA.mode === OA.MODE_EQUALPOWER && OA.layoutName === '5.1',
    `mode=${OA.mode} layout=${OA.layoutName}`);
  okf('S.18 ルームリバーブは既定値（level=0）へ戻る',
    JSON.stringify(OA.revParams) === JSON.stringify(OA.REV_DEFAULTS), JSON.stringify(OA.revParams));
  okf('S.19 メトロノーム/グリッドは既定値へ戻る',
    DAW.metronome.enabled === false && DAW.metronome.volume === 0.35
    && DAW.grid.enabled === false && DAW.grid.division === 1,
    JSON.stringify({ m: DAW.metronome, g: DAW.grid }));

  // ---- 最小構成の version:1（初期のプロジェクト形式）も従来どおり開ける ----
  const legacy = { version: 1, masterVolume: 0.8, tracks: [], buffers: {} };
  const okLegacy = await DAW.wav.loadProject(new File([JSON.stringify(legacy)], 'legacy.json'));
  okf('S.20 初期形式（tracks + masterVolume のみ）が開ける',
    okLegacy === true && DAW.project.masterVolume === 0.8, DAW.project.masterVolume);
  okf('S.21 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});

// ---------------------------------------------------------------------
// RENDERER のノブの undo 粒度（保存対象になったので履歴にも入る）
// ---------------------------------------------------------------------
masterSaveSuite('[44] マスターノブの undo 粒度', async (okf) => {
  const L = DAW.limiter;
  const OA = DAW.objaudio;
  const U = DAW.objui;
  if (!U || !U._inited) {
    okf('K.0 objui が初期化されていない環境ではスキップ', true, 'skip');
    return;
  }
  U.setView('renderer');
  U.render();
  const knob = key => U.knobs.get(key);
  const kev = (el, type, y) => {
    const target = type === 'pointerdown' ? el : window;
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 9, button: 0, clientX: 0, clientY: y,
    }));
  };
  const drag = (el, dy) => {
    kev(el, 'pointerdown', 300);
    kev(el, 'pointermove', 300 - dy);
    kev(el, 'pointerup', 300 - dy);
  };

  // ---- stateSig の確認（undo 後にノブ表示が追従できる前提）----
  const sig0 = U.stateSig();
  L.set('gainDb', 1);
  okf('K.1 リミッター変更で stateSig が変わる', U.stateSig() !== sig0);
  L.set('gainDb', 0);
  const sig1 = U.stateSig();
  OA.setRevParam('level', 0.2);
  okf('K.2 revParams 変更で stateSig が変わる', U.stateSig() !== sig1);
  OA.setRevParam('level', 0);

  // ---- リミッターのノブ: ドラッグ全体で undo 1エントリ ----
  DAW.history.reset();
  // 17px / KNOB_PX(170px) × レンジ48dB = +4.8dB（0 → 4.8）
  drag(knob('gainDb'), 17);
  okf('K.3 ドラッグで gainDb が変わる', Math.abs(L.params.gainDb - 4.8) < 1e-9, L.params.gainDb);
  okf('K.4 ドラッグ全体で undo 1エントリ', DAW.history.past.length === 1, DAW.history.past.length);
  U.sync();   // rAF の1フレームぶん（_sig を現在値へ）。実アプリでは tick() が担う
  await DAW.history.undo();
  okf('K.5 undo で gainDb が戻る', L.params.gainDb === 0, L.params.gainDb);
  U.sync();
  okf('K.6 undo 後にノブ表示が追従する',
    knob('gainDb').querySelector('.ok-val').textContent === '0.0dB',
    knob('gainDb').querySelector('.ok-val').textContent);
  await DAW.history.redo();
  okf('K.7 redo で再適用される', Math.abs(L.params.gainDb - 4.8) < 1e-9, L.params.gainDb);

  // ---- ルームリバーブのノブも同じ粒度 ----
  DAW.history.reset();
  // 34px / 170px × レンジ(0〜1) = +0.2（0 → 0.2）
  drag(knob('level'), 34);
  okf('K.8 ドラッグで level が変わる', Math.abs(OA.revParams.level - 0.2) < 1e-9, OA.revParams.level);
  okf('K.9 ドラッグ全体で undo 1エントリ', DAW.history.past.length === 1, DAW.history.past.length);
  U.sync();   // 同上（undo 前の表示状態を確定させる）
  await DAW.history.undo();
  U.sync();
  okf('K.10 undo で level が戻り、表示も追従する',
    OA.revParams.level === 0 && knob('level').querySelector('.ok-val').textContent === '0.00',
    `level=${OA.revParams.level} 表示=${knob('level').querySelector('.ok-val').textContent}`);

  // ---- ダブルクリック（既定値へ）も 1操作 = undo 1エントリ ----
  L.set('releaseMs', 400);   // set は commit しない（ここまでは履歴に積まれない）
  DAW.history.reset();
  knob('releaseMs').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  okf('K.11 ダブルクリックで既定値へ戻る', L.params.releaseMs === 100, L.params.releaseMs);
  okf('K.12 ダブルクリックは undo 1エントリ', DAW.history.past.length === 1, DAW.history.past.length);
  await DAW.history.undo();
  okf('K.13 undo でダブルクリック前の値へ戻る', L.params.releaseMs === 400, L.params.releaseMs);

  // ---- バイパスボタン（enabled も履歴スナップショットの一部）----
  DAW.history.reset();
  U.els.limByp.click();
  okf('K.14 バイパス切替は undo 1エントリ', L.enabled === false && DAW.history.past.length === 1,
    `enabled=${L.enabled} past=${DAW.history.past.length}`);
  await DAW.history.undo();
  okf('K.15 undo でバイパスが戻る', L.enabled === true, L.enabled);

  okf('K.16 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
