'use strict';
// =====================================================================
// オブジェクト⇔トラック割り当ての編集UI
//   ① ストリップのトラックセレクタ（options の生成 / 現在値の表示 / 仮想化との両立）
//   ② セレクタの変更で state とルーティング（forTrack / グラフ組み直し）が変わる
//   ③ 重複割り当ての奪い取り（不変条件「1トラック = 最大1オブジェクト」）
//   ④ undo / redo（実体が入れ替わるので id で引き直す）
//   ⑤ トラック削除時の未割り当てフォールバックと保存/読み込みの往復
//   ⑥ タイムライン側トラックヘッダのバッジ（ui.js をフックしない rAF 追従）
//
// 他ファイルのヘルパには依存しない（tests-*.js は名前順に読まれるため）。
// rAF は headless=new で発火しないので、render() / sync() / updateMeters() を直接呼ぶ。
// =====================================================================

function objlinkSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;

    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.objects.clear();
    DAW.addTrack('ボーカル');
    DAW.addTrack('ギター');
    DAW.addTrack('ドラム');
    DAW.ui.selectedClipId = null;
    DAW.ui.renderTracks();
    DAW.objui.init();
    DAW.objui.setView('panner');
    DAW.objui.render();
    DAW.history.reset();

    try {
      await body(okf);
    } finally {
      DAW.objects.clear();
      DAW.objui.setView('panner');
      DAW.objui.els.stripScroll.scrollLeft = 0;
      DAW.objui.peaks.clear();
      DAW.objui._lastMeter = 0;
      DAW.objui.render();
      try { DAW.audio.stop(); } catch (e) {}
    }

    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

objlinkSuite('[34] オブジェクト⇔トラック割り当て', async (okf) => {
  const O = DAW.objects;
  const U = DAW.objui;
  const tracks = DAW.project.tracks;
  const sel = id => document.querySelector(`#obj-strips .obj-strip[data-obj-id="${id}"] .os-track`);
  const change = (el, value) => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  // ---------------------------------------------------------------
  // A. セレクタの生成（選択肢と現在値）
  // ---------------------------------------------------------------
  const a = O.create('声', tracks[0].id);
  const b = O.create('鈴');                 // 未割り当て
  O.select(a.id);
  U.render();

  {
    const s = sel(a.id);
    okf('L.1 ストリップにトラックセレクタがある', !!s && s.tagName === 'SELECT');
    okf('L.2 選択肢は「(未割り当て)」+ 全トラック',
      s.options.length === 1 + tracks.length && s.options[0].value === ''
      && s.options[0].textContent === '(未割り当て)',
      `options=${s.options.length}`);
    const bad = tracks.filter((t, i) =>
      s.options[i + 1].value !== t.id || s.options[i + 1].textContent !== t.name);
    okf('L.3 選択肢の表示はトラック名・値はトラックid', bad.length === 0,
      Array.from(s.options).map(o => o.textContent).join(','));
    okf('L.4 現在の割り当てが選択されている', s.value === tracks[0].id, s.value);
    okf('L.5 未割り当てのストリップは「(未割り当て)」表示',
      sel(b.id).value === '' && sel(b.id).classList.contains('none'), sel(b.id).value);
  }

  // ---------------------------------------------------------------
  // B. 変更 → state / ルーティング / undo 1回
  // ---------------------------------------------------------------
  {
    DAW.history.reset();
    let resets = 0;
    const origReset = DAW.audio.resetNodes;
    DAW.audio.resetNodes = function () { resets++; return origReset.call(this); };
    try {
      change(sel(a.id), tracks[1].id);
    } finally {
      DAW.audio.resetNodes = origReset;
    }
    okf('L.6 セレクタの変更が state に入る', O.get(a.id).trackId === tracks[1].id,
      O.get(a.id).trackId);
    okf('L.7 レンダラーのルーティング（forTrack）が付け替わる',
      DAW.objaudio.forTrack(tracks[1].id) === O.get(a.id)
      && DAW.objaudio.forTrack(tracks[0].id) === null);
    okf('L.8 割り当てはノード生成時に固定されるので音声グラフを組み直す', resets === 1,
      `resetNodes=${resets}回`);
    okf('L.9 変更で履歴は1エントリ（change で commit 1回）', DAW.history.past.length === 1,
      'past=' + DAW.history.past.length);

    change(sel(a.id), tracks[1].id);   // 同じ値を選び直しても何も起きない
    okf('L.10 同じ値の選び直しは履歴を積まない', DAW.history.past.length === 1,
      'past=' + DAW.history.past.length);

    change(sel(a.id), '');
    okf('L.11 「(未割り当て)」を選ぶと trackId が null になる',
      O.get(a.id).trackId === null && sel(a.id).value === '', O.get(a.id).trackId);
    change(sel(a.id), tracks[1].id);   // 次の節のために戻す
  }

  // ---------------------------------------------------------------
  // C. 重複割り当ての奪い取り（1トラック = 最大1オブジェクト）
  // ---------------------------------------------------------------
  {
    DAW.history.reset();
    change(sel(b.id), tracks[1].id);   // a が使用中のトラックを b が選ぶ
    okf('L.12 使用中のトラックを選ぶと奪い取る', O.get(b.id).trackId === tracks[1].id,
      O.get(b.id).trackId);
    okf('L.13 元のオブジェクトは未割り当てへ外れる', O.get(a.id).trackId === null,
      O.get(a.id).trackId);
    okf('L.14 同じトラックを指すオブジェクトは常に1個以下',
      O.list.filter(o => o.trackId === tracks[1].id).length === 1);
    okf('L.15 外れた側のセレクタも「(未割り当て)」表示に変わる',
      sel(a.id).value === '' && sel(a.id).classList.contains('none'), sel(a.id).value);
    okf('L.16 奪い取り全体で履歴は1エントリ', DAW.history.past.length === 1,
      'past=' + DAW.history.past.length);

    // undo で両方のオブジェクトの割り当てが戻る（実体が入れ替わるので id で引く）
    await DAW.history.undo();
    okf('L.17 undo で奪った側・奪われた側の両方が戻る',
      O.get(a.id).trackId === tracks[1].id && O.get(b.id).trackId === null,
      `a=${O.get(a.id).trackId} b=${O.get(b.id).trackId}`);
    U.sync();   // rAF の代わり。署名（trackId 込み）の変化で再描画される
    okf('L.18 undo 後のセレクタ表示が署名同期で追従する',
      sel(a.id).value === tracks[1].id && sel(b.id).value === '',
      `a=${sel(a.id).value} b=${sel(b.id).value}`);

    await DAW.history.redo();
    U.sync();
    okf('L.19 redo で奪い取りが再適用される',
      O.get(b.id).trackId === tracks[1].id && O.get(a.id).trackId === null
      && sel(b.id).value === tracks[1].id,
      `a=${O.get(a.id).trackId} b=${O.get(b.id).trackId}`);
    await DAW.history.undo();
    U.sync();
  }

  // ---------------------------------------------------------------
  // D. トラック削除 → 未割り当てへフォールバック
  // ---------------------------------------------------------------
  {
    DAW.history.reset();
    // ui.js の削除ハンドラと同じ手順（removeTrack → commit）
    DAW.removeTrack(tracks[1].id);
    DAW.ui.renderTracks();
    DAW.history.commit();
    okf('L.20 割り当て先のトラックを削除すると未割り当てへ戻る',
      O.get(a.id).trackId === null, O.get(a.id).trackId);
    U.sync();
    okf('L.21 セレクタの選択肢からも消え「(未割り当て)」表示になる',
      sel(a.id).value === '' && sel(a.id).options.length === 1 + DAW.project.tracks.length,
      `options=${sel(a.id).options.length}`);

    await DAW.history.undo();   // 削除と解除は1エントリなので、undo で割り当てごと復活する
    U.sync();
    const t1 = DAW.project.tracks.find(t => t.id !== null && t.name === 'ギター');
    okf('L.22 undo でトラックと割り当てが一緒に復活する',
      !!t1 && O.get(a.id).trackId === t1.id && sel(a.id).value === t1.id,
      `trackId=${O.get(a.id).trackId}`);
  }

  // ---------------------------------------------------------------
  // E. 保存/読み込みの往復と壊れたファイルの補正
  // ---------------------------------------------------------------
  {
    const json = O.toJSON();
    okf('L.23 保存データに trackId が入る',
      json.find(o => o.id === a.id).trackId === O.get(a.id).trackId
      && json.find(o => o.id === b.id).trackId === null);
    const before = O.get(a.id).trackId;
    O.load(JSON.parse(JSON.stringify(json)));
    okf('L.24 読み込みの往復で割り当てが保持される', O.get(a.id).trackId === before,
      O.get(a.id).trackId);

    // 手で編集されたファイル等で同じトラックが重複していたら先勝ちで解消する
    const dup = JSON.parse(JSON.stringify(json));
    for (const o of dup) o.trackId = before;
    O.load(dup);
    okf('L.25 重複した trackId は読み込み時に先勝ちで解消される',
      O.get(a.id).trackId === before && O.get(b.id).trackId === null
      && O.list.filter(o => o.trackId === before).length === 1,
      O.list.map(o => o.trackId).join(','));
    O.load(JSON.parse(JSON.stringify(json)));   // 元へ戻す
    U.render();
  }

  // ---------------------------------------------------------------
  // F. タイムライン側トラックヘッダのバッジ
  // ---------------------------------------------------------------
  {
    U.render();   // render() が syncTrackBadges() を含む
    const tid = O.get(a.id).trackId;
    const lane = document.querySelector(`.lane[data-track-id="${tid}"]`);
    const head = lane && lane.previousElementSibling;
    const badge = head && head.querySelector('.th-obj');
    okf('L.26 割り当て済みトラックのヘッダにバッジが出る',
      !!badge && badge.textContent.indexOf(O.get(a.id).name) >= 0,
      badge ? badge.textContent : 'なし');
    okf('L.27 未割り当てのトラックにはバッジが無い',
      Array.from(document.querySelectorAll('.lane[data-track-id]'))
        .filter(l => l.dataset.trackId !== tid)
        .every(l => !l.previousElementSibling.querySelector('.th-obj')));

    // renderTracks() は DOM を丸ごと作り直す。ui.js をフックしていないので一瞬消えるが、
    // 30fps のメーター更新（rAF）で貼り直される
    DAW.ui.renderTracks();
    okf('L.28 renderTracks 直後はバッジが消えている（ui.js は未変更）',
      !document.querySelector('.th-obj'));
    U._lastMeter = 0;
    U.updateMeters(50000);
    const badge2 = document.querySelector(`.lane[data-track-id="${tid}"]`)
      .previousElementSibling.querySelector('.th-obj');
    okf('L.29 メーター更新のたびに貼り直されて復活する',
      !!badge2 && badge2.textContent.indexOf(O.get(a.id).name) >= 0,
      badge2 ? badge2.textContent : 'なし');

    // オブジェクト名の変更にも追従する
    O.set(a.id, 'name', '主役');
    U.render();
    okf('L.30 オブジェクト名の変更がバッジに追従する',
      document.querySelector('.th-obj').textContent === '◆ 主役',
      document.querySelector('.th-obj').textContent);

    change(sel(a.id), '');
    okf('L.31 未割り当てへ戻すとバッジが消える', !document.querySelector('.th-obj'));
    change(sel(a.id), tid);   // 戻す
  }

  // ---------------------------------------------------------------
  // G. 仮想化との両立（スクロールで DOM が作り直されても選択状態が正しい）
  // ---------------------------------------------------------------
  {
    while (O.count() < 40) O.create();
    const far = O.list[30];
    O.assignTrack(far.id, DAW.project.tracks[2].id);
    U.render();
    okf('L.32 画面外のストリップは DOM に無い（仮想化の前提）', !sel(far.id));

    U.els.stripScroll.scrollLeft = U.STRIP_W * 29;
    U.renderStrips();
    const s = sel(far.id);
    okf('L.33 スクロールで作り直されたセレクタも割り当てを正しく表示する',
      !!s && s.value === DAW.project.tracks[2].id && s.options.length === 1 + DAW.project.tracks.length,
      s ? s.value : 'ストリップなし');

    U.els.stripScroll.scrollLeft = 0;
    U.renderStrips();
    for (let i = O.count() - 1; i >= 2; i--) O.remove(O.list[i].id);
    U.render();
  }

  okf('L.34 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});

// フォーカス中に undo された欄の「取り返し」。syncStrip はフォーカス中の欄を
// 書き換えない（入力の邪魔をしない）ため、そのまま undo すると表示だけ古い値で残る。
// 署名(_sig)は render() で更新済みになるので rAF 同期も拾わない。
// stripScroll の focusout で一度 render() して取り返す（js/objui.js init 参照）。
objlinkSuite('[34F] フォーカス中 undo の取り返し', async (okf) => {
  const O = DAW.objects;
  const U = DAW.objui;
  const sel = id => document.querySelector(`#obj-strips .obj-strip[data-obj-id="${id}"] .os-track`);

  const a = O.create();
  U.render();
  DAW.history.commit();
  const t0 = DAW.project.tracks[0].id, t1 = DAW.project.tracks[1].id;

  O.assignTrack(a.id, t0);
  U.render();
  DAW.history.commit();

  const s = sel(a.id);
  s.focus();
  s.value = t1;
  s.dispatchEvent(new Event('change', { bubbles: true }));   // setTrack → render + commit
  okf('F.1 変更が state に入る', O.get(a.id).trackId === t1);

  DAW.history.undo();                                        // フォーカスは s のまま
  U.sync();                                                  // rAF 相当を直接呼ぶ
  okf('F.2 state は戻る', O.get(a.id).trackId === t0);
  // フォーカス中の欄は書き換えない仕様なので、この時点では表示が古くてもよい

  s.blur();                                                  // 実際にフォーカスを外す（focusout が発火）
  const s2 = sel(a.id);
  okf('F.3 フォーカスが外れたら表示が state に追従する', s2 && s2.value === t0,
    s2 ? s2.value : 'ストリップなし');

  okf('F.4 未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
