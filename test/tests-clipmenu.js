'use strict';
// =====================================================================
// クリップの右クリックメニューとツールバーの編集ボタン（カット/分割/削除）。
//
// キーボード・メニュー・ボタンは全て DAW.ui の同じ経路（***SelectedClip / pasteClipAt）を
// 通るので、ここでは「メニュー/ボタン入口でも結果と undo 粒度が同じになる」ことを確認する。
// 分割は常に再生ヘッド位置（S キーと同一。右クリック位置では割らない）。
// 貼り付けだけは右クリックした時刻・レーンのトラックに置かれる。
//
// 合成イベントの注意:
// - レーンのハンドラは e.offsetX を見るので、合成 MouseEvent には defineProperty で足す
//   （tests-nudge.js の U.18 と同じ流儀）。
// - undo すると history.apply が tracks を JSON から作り直すため、トラックやクリップの
//   参照は毎回 DAW.project.tracks から取り直すこと（古い参照は死んでいる）。
// - disabled なボタンは .click() しても何も起きない（それ自体が仕様の検証になる）。
// 他ファイルのヘルパには依存しない。
// =====================================================================

function clipmenuSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.grid.enabled = false; DAW.grid.division = 1;
    DAW.loop.enabled = false; DAW.loop.start = 0; DAW.loop.end = 0;
    DAW.setBpm(120);
    DAW.clipboard = null;
    DAW.addTrack('A'); DAW.addTrack('B');
    DAW.ui.selectedClipId = null;
    DAW.setPPS(DAW.DEFAULT_PPS);
    DAW.ui.renderTracks();
    DAW.collectBuffers();
    DAW.history.reset();
    try { await body(okf); } finally {
      try { DAW.audio.stop(); } catch (e) {}
      DAW.ui.closeMenu();
      DAW.clipboard = null;
      // 後続スイートへバッファを持ち越さない掃除。tests-edit の E.7 は DAW.buffers.size を
      // 数えるが、editSuite は collectBuffers() を history.reset() より先に呼ぶため、
      // ここで履歴の参照ごと切っておかないとこのスイートのバッファが残って数が合わなくなる。
      DAW.project.tracks.forEach(t => { t.clips = []; });
      DAW.history.reset();
      DAW.collectBuffers();
    }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

clipmenuSuite('[36] 右クリックメニューと編集ボタン', async (okf) => {
  const ui = DAW.ui;
  const ctx0 = DAW.audio.ensureCtx();
  const buf = ctx0.createBuffer(1, ctx0.sampleRate * 2, ctx0.sampleRate);
  const bid = DAW.registerBuffer(buf);

  const addClipTo = (track, start, dur) => {
    const c = { id: DAW.uid(), bufferId: bid, startTime: start, offset: 0, duration: dur,
                name: 'c', fadeIn: 0, fadeOut: 0 };
    track.clips.push(c);
    ui.renderTracks();
    return c;
  };
  const clipEl = id => document.querySelector(`.clip[data-id="${id}"]`);
  const menu = () => document.getElementById('ctx-menu');
  const items = () => menu() ? [...menu().querySelectorAll('.ctx-item')] : [];
  const item = label => items().find(b => b.firstChild.textContent === label);
  // クリップ上での右クリック。戻り値は「既定メニューが抑止されなかったか」（dispatchEvent の戻り）
  const rmenu = (el, opts) => el.dispatchEvent(new MouseEvent('contextmenu',
    Object.assign({ bubbles: true, cancelable: true, clientX: 300, clientY: 200 }, opts)));
  // レーン空白部での右クリック。ハンドラが e.offsetX を見るので defineProperty で足す
  const laneMenu = (track, offsetX) => {
    const lane = document.querySelector(`.lane[data-track-id="${track.id}"]`);
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 });
    Object.defineProperty(e, 'offsetX', { value: offsetX });
    lane.dispatchEvent(e);
  };
  const tr = i => DAW.project.tracks[i];   // undo で作り直されるので毎回引き直す

  // ---- メニューの表示と作法 ----
  const c1 = addClipTo(tr(0), 1, 2);
  DAW.audio.playheadPos = 0;
  const notPrevented = rmenu(clipEl(c1.id));
  okf('M.1 クリップの右クリックでメニューが出る（既定メニューは抑止）', !!menu() && notPrevented === false);
  okf('M.2 項目は6つ（カット/コピー/複製/分割/ステム分離/削除）', items().length === 6,
    items().map(b => b.firstChild.textContent).join('/'));
  okf('M.3 右クリックしたクリップが選択される', ui.selectedClipId === c1.id);
  okf('M.4 ショートカット表記が右側に付く',
    item('カット').querySelector('.ctx-key').textContent === 'Ctrl+X'
    && item('削除').querySelector('.ctx-key').textContent === 'Delete');
  okf('M.5 再生ヘッドがクリップ外なら分割は無効', item('再生ヘッド位置で分割').disabled,
    'pos=' + DAW.audio.getPos());
  okf('M.6 メニューはFXパネル(z:20)より手前', +getComputedStyle(menu()).zIndex > 20,
    'z=' + getComputedStyle(menu()).zIndex);

  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
  okf('M.7 Escape で閉じる', !menu());

  rmenu(clipEl(c1.id));
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  okf('M.8 外側クリックで閉じる', !menu());

  rmenu(clipEl(c1.id));
  menu().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  okf('M.9 メニュー内のクリックでは閉じない', !!menu());
  ui.els.scroller.dispatchEvent(new Event('scroll'));
  okf('M.10 スクロールで閉じる', !menu());

  rmenu(clipEl(c1.id));
  const firstMenu = menu();
  rmenu(clipEl(c1.id));
  okf('M.11 開き直すと前のメニューは閉じる（常に1個）',
    document.querySelectorAll('#ctx-menu').length === 1 && menu() !== firstMenu);
  document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  okf('M.12 別の場所への右クリックで閉じる', !menu());

  // ---- 各項目の結果と undo 粒度（キー操作と同じ経路を通る）----
  // カット
  DAW.history.reset();
  rmenu(clipEl(c1.id));
  item('カット').click();
  okf('M.13 カットでクリップが消えクリップボードへ入る',
    tr(0).clips.length === 0 && !!DAW.clipboard && DAW.clipboard.bufferId === bid);
  okf('M.14 カット後は選択が外れメニューも閉じる', ui.selectedClipId === null && !menu());
  okf('M.15 カットは undo 1回ぶん', DAW.history.past.length === 1, 'past=' + DAW.history.past.length);
  await DAW.history.undo();
  okf('M.16 undo でクリップが戻る', tr(0).clips.length === 1);

  // コピー（状態を変えないので履歴に積まれない）
  DAW.clipboard = null;
  DAW.history.reset();
  rmenu(clipEl(tr(0).clips[0].id));
  item('コピー').click();
  okf('M.17 コピーでクリップボードへ入る（クリップは残る）',
    !!DAW.clipboard && tr(0).clips.length === 1);
  okf('M.18 コピーは履歴に積まれない', !DAW.history.canUndo());

  // 複製
  rmenu(clipEl(tr(0).clips[0].id));
  item('複製').click();
  okf('M.19 複製で元の直後に並ぶ',
    tr(0).clips.length === 2 && Math.abs(tr(0).clips[1].startTime - 3) < 1e-9,
    JSON.stringify(tr(0).clips.map(c => c.startTime)));
  okf('M.20 複製されたクリップが選択される', ui.selectedClipId === tr(0).clips[1].id);
  okf('M.21 複製は undo 1回ぶん', DAW.history.past.length === 1, 'past=' + DAW.history.past.length);
  await DAW.history.undo();

  // 分割（再生ヘッド位置。S キー・分割ボタンと同一）
  DAW.audio.playheadPos = 1.75;
  DAW.history.reset();
  rmenu(clipEl(tr(0).clips[0].id));
  okf('M.22 再生ヘッドがクリップ内なら分割は有効', !item('再生ヘッド位置で分割').disabled);
  item('再生ヘッド位置で分割').click();
  okf('M.23 分割は再生ヘッド位置で割れる（Sキーと同じ）',
    tr(0).clips.length === 2
    && Math.abs(tr(0).clips[0].duration - 0.75) < 1e-9
    && Math.abs(tr(0).clips[1].startTime - 1.75) < 1e-9,
    JSON.stringify(tr(0).clips.map(c => [c.startTime, c.duration])));
  okf('M.24 分割は undo 1回ぶん', DAW.history.past.length === 1, 'past=' + DAW.history.past.length);
  await DAW.history.undo();

  // 削除
  DAW.history.reset();
  rmenu(clipEl(tr(0).clips[0].id));
  item('削除').click();
  okf('M.25 削除でクリップが消える', tr(0).clips.length === 0);
  okf('M.26 削除は undo 1回ぶん', DAW.history.past.length === 1, 'past=' + DAW.history.past.length);
  await DAW.history.undo();

  // ---- レーン右クリックの貼り付け ----
  DAW.clipboard = null;
  laneMenu(tr(1), 300);
  okf('M.27 レーン右クリックで貼り付けメニューが出る', !!menu() && items().length === 1);
  okf('M.28 クリップボードが空なら貼り付けは無効', item('貼り付け').disabled);
  item('貼り付け').click();   // disabled なので何も起きないはず
  okf('M.29 無効な項目は押しても何も起きない', tr(1).clips.length === 0);
  ui.closeMenu();

  DAW.copyClip(tr(0).clips[0].id);   // コピー元はトラックA
  DAW.history.reset();
  laneMenu(tr(1), 300);              // 300px = 3.0秒（PPS=100）
  okf('M.30 クリップボードに有れば貼り付けは有効', !item('貼り付け').disabled);
  item('貼り付け').click();
  okf('M.31 貼り付け位置は右クリックした時刻・トラックはそのレーン',
    tr(1).clips.length === 1 && Math.abs(tr(1).clips[0].startTime - 3) < 1e-9,
    JSON.stringify(tr(1).clips.map(c => c.startTime)));
  okf('M.32 貼り付けたクリップが選択される', ui.selectedClipId === tr(1).clips[0].id);
  okf('M.33 貼り付けは undo 1回ぶん', DAW.history.past.length === 1, 'past=' + DAW.history.past.length);

  // グリッド有効時は貼り付け位置が拍に吸着する（120BPM・1拍 = 0.5秒）
  DAW.grid.enabled = true; DAW.grid.division = 1;
  laneMenu(tr(1), 137);              // 1.37秒 → 最寄りの拍 1.5秒
  item('貼り付け').click();
  const lastB = tr(1).clips[tr(1).clips.length - 1];
  okf('M.34 グリッド有効なら貼り付け位置は吸着', Math.abs(lastB.startTime - 1.5) < 1e-9, lastB.startTime);
  DAW.grid.enabled = false;

  // ---- ツールバーの編集ボタン ----
  ui.selectClip(null);
  okf('M.35 未選択なら編集ボタンは無効',
    ui.els.btnCut.disabled && ui.els.btnSplit.disabled && ui.els.btnClipDel.disabled);
  const c4 = tr(0).clips[0];         // startTime 1, duration 2
  ui.selectClip(c4.id);
  okf('M.36 選択すると編集ボタンが有効になる',
    !ui.els.btnCut.disabled && !ui.els.btnSplit.disabled && !ui.els.btnClipDel.disabled);

  DAW.audio.playheadPos = 2;
  DAW.history.reset();
  ui.els.btnSplit.click();
  okf('M.37 分割ボタンは再生ヘッド位置で割る（Sキーと同じ）',
    tr(0).clips.length === 2 && Math.abs(tr(0).clips[1].startTime - 2) < 1e-9,
    JSON.stringify(tr(0).clips.map(c => [c.startTime, c.duration])));
  okf('M.38 分割後も選択が残りボタンは有効なまま',
    ui.selectedClipId === c4.id && !ui.els.btnCut.disabled);

  ui.els.btnCut.click();
  okf('M.39 カットボタンで切り取られボタンは無効へ戻る',
    tr(0).clips.length === 1 && !!DAW.clipboard && ui.els.btnCut.disabled);
  ui.selectClip(tr(0).clips[0].id);
  ui.els.btnClipDel.click();
  okf('M.40 削除ボタンでクリップが消える',
    tr(0).clips.length === 0 && ui.els.btnClipDel.disabled);
  okf('M.41 ボタン操作もそれぞれ undo 1回ぶん（分割/カット/削除で3段）',
    DAW.history.past.length === 3, 'past=' + DAW.history.past.length);

  // ---- 画面端での位置補正 ----
  const c5 = addClipTo(tr(0), 0, 1);
  rmenu(clipEl(c5.id), { clientX: window.innerWidth + 500, clientY: window.innerHeight + 500 });
  const r = menu().getBoundingClientRect();
  okf('M.42 画面端では内側に補正される',
    r.right <= window.innerWidth && r.bottom <= window.innerHeight,
    `right=${r.right} bottom=${r.bottom} win=${window.innerWidth}x${window.innerHeight}`);
  ui.closeMenu();

  okf('M.43 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
