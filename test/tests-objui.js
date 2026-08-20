'use strict';
// =====================================================================
// オブジェクトベース音響の操作UI（PANNER画面：トップビュー / オブジェクトストリップ）。
// 他ファイルのヘルパには依存しない（tests-*.js は名前順に読まれるため）。
// =====================================================================

function objuiSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.objects.clear();
    DAW.addTrack('T1'); DAW.addTrack('T2');
    DAW.ui.selectedClipId = null;
    DAW.ui.renderTracks();
    DAW.objui.init();              // 既に初期化済みなら何もしない
    DAW.objui.setView('panner');   // 前のテストが RENDERER にしていても揃える
    DAW.objui.render();
    DAW.history.reset();
    try { await body(okf); } finally {
      DAW.objects.clear();
      DAW.objui.setView('panner');
      DAW.objui.els.stripScroll.scrollLeft = 0;
      DAW.objui.render();
      try { DAW.audio.stop(); } catch (e) {}
    }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

objuiSuite('[28] オブジェクトUI', async (okf) => {
  const O = DAW.objects;
  const U = DAW.objui;
  const AZ_EPS = 1.5;    // クリック座標を整数に丸めるぶんの誤差（半径 100px 前後で 0.5° 程度）
  const D_EPS = 0.02;

  // ---- 使用数の表示 ----
  const countText = () => document.getElementById('obj-count').textContent;
  okf('V.1 使用数は 0 / 128 から始まる', countText() === '0 / 128', countText());

  const a = O.create('ボーカル', DAW.project.tracks[0].id);
  U.render();
  okf('V.2 オブジェクトを足すと使用数が増える', countText() === '1 / 128', countText());

  const b = O.create('ギター');
  U.render();
  okf('V.3 2個目も追従する', countText() === '2 / 128', countText());
  O.remove(b.id);
  U.render();
  okf('V.4 削除すると減る', countText() === '1 / 128', countText());

  // ---- トップビューの座標規約（ADM: 0°=上、正=反時計回り）----
  const canvas = document.getElementById('obj-top');
  const pev = (type, x, y, opts) => {
    const e = new PointerEvent(type, Object.assign({
      bubbles: true, cancelable: true, pointerId: 1, button: 0,
      clientX: Math.round(x), clientY: Math.round(y),
    }, opts));
    canvas.dispatchEvent(e);
  };
  const click = (x, y) => { pev('pointerdown', x, y); pev('pointerup', x, y); };

  O.select(a.id);
  U.render();
  {
    const g = U.topGeom();
    okf('V.5 トップビューに描画領域がある', g.rect.width > 50 && g.rect.height > 50 && g.R > 30,
      `${Math.round(g.rect.width)}x${Math.round(g.rect.height)} R=${Math.round(g.R)}`);

    // 4方位。az の符号（反時計回りが正）をここで固定する
    const dirs = [
      ['V.6 上へのクリックは正面 az=0°', 0, -0.5, 0, 0.5],
      ['V.7 左へのクリックは az=+90°（反時計回りが正）', -0.5, 0, 90, 0.5],
      ['V.8 下へのクリックは背後 az=180°', 0, 0.6, 180, 0.6],
      ['V.9 右へのクリックは az=-90°', 0.75, 0, -90, 0.75],
    ];
    for (const [name, fx, fy, az, dist] of dirs) {
      click(g.cx + g.R * fx, g.cy + g.R * fy);
      const o = O.get(a.id);
      const daz = Math.abs(o.az - az) > 180 ? 360 - Math.abs(o.az - az) : Math.abs(o.az - az);
      okf(name, daz < AZ_EPS && Math.abs(o.dist - dist) < D_EPS,
        `az=${o.az.toFixed(2)} dist=${o.dist.toFixed(3)}`);
    }

    click(g.cx, g.cy);
    okf('V.10 中心へのクリックで距離0', Math.abs(O.get(a.id).dist) < D_EPS, O.get(a.id).dist);
    click(g.cx + g.R * 3, g.cy);
    okf('V.11 円の外へ出しても距離は1で頭打ち', Math.abs(O.get(a.id).dist - 1) < 1e-9, O.get(a.id).dist);

    // 変換の往復（描画とヒット判定が同じ式であることの担保）
    const p = U.posToXY(37, 0.42, g);
    const back = U.xyToPos(p.x, p.y, g);
    okf('V.12 posToXY と xyToPos は往復する',
      Math.abs(back.az - 37) < 1e-6 && Math.abs(back.dist - 0.42) < 1e-6,
      JSON.stringify(back));
  }

  // ---- ドラッグは Undo 1エントリ ----
  {
    O.setPosition(a.id, 0, 0, 1);
    U.render();
    DAW.history.reset();
    const g = U.topGeom();
    pev('pointerdown', g.cx + g.R * 0.2, g.cy);
    pev('pointermove', g.cx + g.R * 0.4, g.cy);
    pev('pointermove', g.cx + g.R * 0.6, g.cy);
    pev('pointermove', g.cx, g.cy - g.R * 0.8);
    okf('V.13 ドラッグ中は履歴を積まない（commit は pointerup のみ）',
      !DAW.history.canUndo() && Math.abs(O.get(a.id).dist - 0.8) < D_EPS,
      `past=${DAW.history.past.length} dist=${O.get(a.id).dist.toFixed(3)}`);
    pev('pointerup', g.cx, g.cy - g.R * 0.8);
    okf('V.14 ドラッグ全体で履歴は1エントリ', DAW.history.past.length === 1,
      'past=' + DAW.history.past.length);
    await DAW.history.undo();
    const o = O.get(a.id);
    okf('V.15 undo 1回でドラッグ前の位置に戻る',
      Math.abs(o.az) < 1e-9 && Math.abs(o.dist - 1) < 1e-9, `az=${o.az} dist=${o.dist}`);
  }

  // ---- lock ----
  {
    O.setPosition(a.id, 30, 0, 0.5);
    O.set(a.id, 'lock', 'pos');
    U.render();
    const g = U.topGeom();
    pev('pointerdown', g.cx, g.cy - g.R * 0.9);
    pev('pointermove', g.cx + g.R * 0.5, g.cy);
    pev('pointerup', g.cx + g.R * 0.5, g.cy);
    const o = O.get(a.id);
    okf("V.16 lock='pos' はドラッグしても動かない",
      Math.abs(o.az - 30) < 1e-9 && Math.abs(o.dist - 0.5) < 1e-9, `az=${o.az} dist=${o.dist}`);
    O.set(a.id, 'lock', 'none');
    U.render();
  }

  // ---- 点のクリックで選択が移る ----
  {
    O.setPosition(a.id, 0, 0, 0.9);
    const c = O.create('シンセ');
    O.setPosition(c.id, 180, 0, 0.9);
    O.select(a.id);
    U.render();
    const g = U.topGeom();
    const p = U.posToXY(180, 0.9, g);
    pev('pointerdown', p.x, p.y);
    pev('pointerup', p.x, p.y);
    okf('V.17 オブジェクトの点をクリックすると選択が移る', O.selectedId === c.id);
    okf('V.18 選択のクリックでは位置を動かさない',
      Math.abs(O.get(c.id).az - 180) < 1e-9 && Math.abs(O.get(c.id).dist - 0.9) < 1e-9,
      `az=${O.get(c.id).az} dist=${O.get(c.id).dist}`);
    O.remove(c.id);
    O.select(a.id);
    U.render();
  }

  // ---- ストリップ ----
  const stripEls = () => document.querySelectorAll('#obj-strips .obj-strip');
  const stripOf = id => document.querySelector(`#obj-strips .obj-strip[data-obj-id="${id}"]`);
  okf('V.19 オブジェクト1個にストリップ1本', stripEls().length === 1, stripEls().length);

  // 双方向バインド（ストリップ → state）
  {
    const az = stripOf(a.id).querySelector('.os-in-az');
    az.value = '90';
    az.dispatchEvent(new Event('input', { bubbles: true }));
    okf('V.20 数値ボックスの入力が state に入る', O.get(a.id).az === 90, O.get(a.id).az);
    const wd = stripOf(a.id).querySelector('.os-in-width');
    wd.value = '-150';
    wd.dispatchEvent(new Event('input', { bubbles: true }));
    okf('V.21 Width も双方向（負値=L/R反転も入る）', O.get(a.id).width === -150, O.get(a.id).width);
  }

  // 双方向バインド（state → ストリップ / トップビュー）
  {
    O.setPosition(a.id, -45, 20, 0.5);
    U.render();
    const s = stripOf(a.id);
    okf('V.22 state の変更が数値ボックスに反映される',
      s.querySelector('.os-in-az').value === '-45' && s.querySelector('.os-in-el').value === '20',
      `az=${s.querySelector('.os-in-az').value} el=${s.querySelector('.os-in-el').value}`);
    // トップビューの点も同じ座標系で動いている（描画位置を式で確認する）
    const g = U.topGeom();
    const p = U.posToXY(-45, 0.5, g);
    okf('V.23 同じ値からトップビューの描画位置が決まる（右前方＝右上）',
      p.x > g.cx && p.y < g.cy, `x-cx=${(p.x - g.cx).toFixed(1)} y-cy=${(p.y - g.cy).toFixed(1)}`);
  }

  // ドラッグ → 数値ボックスの即時反映
  {
    const g = U.topGeom();
    pev('pointerdown', g.cx - g.R * 0.5, g.cy);
    pev('pointermove', g.cx - g.R * 0.5, g.cy);
    pev('pointerup', g.cx - g.R * 0.5, g.cy);
    const shown = stripOf(a.id).querySelector('.os-in-az').value;
    okf('V.24 トップビューでの移動が数値ボックスに即反映される',
      Math.abs(parseFloat(shown) - 90) < AZ_EPS, 'Az ボックス=' + shown);
  }

  // M / S / lock / フェーダー / 名前
  {
    const s = () => stripOf(a.id);
    s().querySelector('.os-mute').click();
    okf('V.25 M ボタンが state に反映される', O.get(a.id).mute === true);
    okf('V.26 M ボタンの見た目も on になる', s().querySelector('.os-mute').classList.contains('on'));
    s().querySelector('.os-mute').click();
    okf('V.27 もう一度押すと解除', O.get(a.id).mute === false);

    s().querySelector('.os-solo').click();
    okf('V.28 S ボタンが state に反映される', O.get(a.id).solo === true && O.anySolo());
    s().querySelector('.os-solo').click();
    okf('V.29 S も解除できる', O.get(a.id).solo === false);

    s().querySelector('.os-lock').click();
    okf("V.30 Lock は none → pos", O.get(a.id).lock === 'pos', O.get(a.id).lock);
    okf('V.31 位置固定中は Az ボックスが無効になる',
      s().querySelector('.os-in-az').disabled === true);
    s().querySelector('.os-lock').click();
    okf("V.32 Lock は pos → all", O.get(a.id).lock === 'all', O.get(a.id).lock);
    okf('V.33 全固定中はフェーダーも無効になる', s().querySelector('.os-fader').disabled === true);
    s().querySelector('.os-lock').click();
    okf("V.34 Lock は all → none に戻る", O.get(a.id).lock === 'none', O.get(a.id).lock);

    const fader = s().querySelector('.os-fader');
    fader.value = '-6';
    fader.dispatchEvent(new Event('input', { bubbles: true }));
    okf('V.35 縦フェーダーが gainDb に反映される', O.get(a.id).gainDb === -6, O.get(a.id).gainDb);
    okf('V.36 ゲインの数値表示も追従する', s().querySelector('.os-gain').textContent === '-6.0',
      s().querySelector('.os-gain').textContent);
    fader.value = '0';
    fader.dispatchEvent(new Event('input', { bubbles: true }));

    const name = s().querySelector('.os-name');
    name.value = 'ボーカル2';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    okf('V.37 名前ボックスが state に反映される', O.get(a.id).name === 'ボーカル2', O.get(a.id).name);

    okf('V.38 ピーク dB は未接続なので -∞ 表示', s().querySelector('.os-peak').textContent === '-∞',
      s().querySelector('.os-peak').textContent);
    okf('V.39 識別色がストリップに出る', s().querySelector('.os-dot').style.background !== '',
      s().querySelector('.os-dot').style.background);
    okf('V.40 選択中のストリップが強調される', s().classList.contains('selected'));
  }

  // ---- 仮想化（可視ぶんだけ DOM を作る）----
  {
    while (!O.isFull()) O.create();
    U.render();
    okf('V.41 128個まで作れて使用数表示も追従する', O.count() === 128 && countText() === '128 / 128',
      countText());
    const sc = U.els.stripScroll;
    const viewW = sc.clientWidth;
    const maxVisible = Math.ceil(viewW / U.STRIP_W) + 2 * U.OVERSCAN + 1;
    const n = stripEls().length;
    okf('V.42 128個でもストリップの DOM は可視ぶんだけ', n > 0 && n < 128 && n <= maxVisible,
      `DOM=${n} 可視上限=${maxVisible} 幅=${viewW}px`);
    okf('V.43 ストリップ帯の幅は全本数ぶん確保される（スクロールできる）',
      U.els.strips.style.width === (128 * U.STRIP_W) + 'px', U.els.strips.style.width);

    // 横スクロールで差分更新される
    sc.scrollLeft = U.STRIP_W * 40;
    U.renderStrips();
    const range = U.visibleRange();
    const first = document.querySelector('#obj-strips .obj-strip');
    okf('V.44 横スクロールで可視範囲が入れ替わる',
      range.first === 39 && first && first.dataset.objId === O.list[39].id,
      `range=${range.first}〜${range.last}`);
    okf('V.45 スクロール後も DOM 本数は可視ぶんのまま', stripEls().length <= maxVisible,
      stripEls().length);
    okf('V.46 画面外のストリップは DOM から外れている', !stripOf(a.id), 'a のストリップ=' + !!stripOf(a.id));

    sc.scrollLeft = 0;
    U.renderStrips();
    okf('V.47 先頭へ戻すと元のストリップが再生成される', !!stripOf(a.id));

    // 128個から削っても追従する
    for (let i = O.count() - 1; i >= 1; i--) O.remove(O.list[i].id);
    U.render();
    okf('V.48 削除しても使用数とストリップが追従する',
      countText() === '1 / 128' && stripEls().length === 1, countText());
  }

  // ---- タブ ----
  {
    document.getElementById('tab-renderer').click();
    okf('V.49 RENDERER タブに切り替わる',
      document.getElementById('obj-renderer').classList.contains('hidden') === false
      && document.getElementById('obj-panner').classList.contains('hidden') === true);
    document.getElementById('tab-panner').click();
    okf('V.50 PANNER タブに戻る',
      document.getElementById('obj-panner').classList.contains('hidden') === false
      && document.getElementById('tab-panner').classList.contains('on'));
    okf('V.51 後日実装の枠（バイパス/CPU/マスターメーター/書き出し/電球/A/B/METERING）がある',
      !!document.getElementById('obj-bypass') && !!document.getElementById('obj-cpu')
      && !!document.getElementById('obj-mmeter') && !!document.getElementById('obj-mdb')
      && !!document.getElementById('obj-bounce') && !!document.getElementById('obj-light')
      && !!document.getElementById('obj-ab') && !!document.getElementById('tab-metering'));
    // METERING タブは実装済み（[43]）になったので disabled 群からは外れている
    okf('V.52 枠だけのものは無効化されている（押しても何も起きない）',
      document.getElementById('obj-bypass').disabled && !document.getElementById('tab-metering').disabled
      && document.getElementById('obj-ceiling').disabled);
    okf('V.53 マスターストリップがストリップ帯の右端にある',
      !!document.getElementById('obj-master')
      && document.getElementById('obj-master').parentElement.id === 'obj-strip-area');
  }

  // ---- 追加 / 削除ボタンと外部変更への追従 ----
  {
    const before = O.count();
    const hist0 = DAW.history.past.length;
    document.getElementById('obj-add').click();
    okf('V.54 ＋ボタンでオブジェクトを追加できる', O.count() === before + 1 && countText() === `${before + 1} / 128`,
      countText());
    okf('V.55 追加は履歴に1エントリ積まれる', DAW.history.past.length === hist0 + 1,
      `${hist0} → ${DAW.history.past.length}`);
    document.getElementById('obj-del').click();
    okf('V.56 －ボタンで選択中を削除できる', O.count() === before, countText());

    // undo / プロジェクト読み込みなど、UI を経由しない変更も検知して描き直す
    const o0 = O.list[0];
    O.setPosition(o0.id, 123, 0, 0.3);
    U.sync();
    okf('V.57 UI を経由しない state 変更にも追従する（署名で検知して再描画）',
      stripOf(o0.id).querySelector('.os-in-az').value === '123',
      stripOf(o0.id).querySelector('.os-in-az').value);
  }

  okf('V.58 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
