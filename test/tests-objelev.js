'use strict';
// =====================================================================
// 正面ビュー（FRONT VIEW / 高さ方向の編集）
//   ① DOM 配置（PANNER にだけ出る / TOP VIEW の隣 / RENDERER には出ない）
//   ② 投影の規約（az=+90 が画面左・el=+90 が上・el=0 が中央・dist で内側へ）
//   ③ 変換は DAW.objaudio.toCartesian 経由（式の複製が無い）と往復
//   ④ ドラッグ（縦=el / 横=az / dist 不変 / 半球の保持 / Undo 1エントリ / lock）
//
// 他ファイルのヘルパには依存しない（tests-*.js は名前順に読まれるため）。
// rAF は headless=new で発火しないので、render() 等を直接呼んで検証する。
// =====================================================================

function objelevSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;

    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.objects.clear();
    DAW.addTrack('T1');
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
      DAW.objui.render();
      try { DAW.audio.stop(); } catch (e) {}
    }

    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

objelevSuite('[35] 正面ビュー（高さ方向）', async (okf) => {
  const O = DAW.objects;
  const U = DAW.objui;
  const EPS = 0.6;   // ドラッグ座標→角度の許容誤差（度）。tests-objui2 と同じ

  // ---------------------------------------------------------------
  // A. DOM 配置（PANNER にだけ出る）
  // ---------------------------------------------------------------
  const front = document.getElementById('obj-front');
  const wrap = document.getElementById('obj-frontview');
  okf('E.1 正面ビューのペインが TOP VIEW の隣（PANNER 内）にある',
    !!wrap && wrap.parentElement.id === 'obj-panner'
    && wrap.previousElementSibling && wrap.previousElementSibling.id === 'obj-topview',
    wrap ? wrap.parentElement.id : 'なし');
  okf('E.2 canvas とビューラベルがある',
    !!front && front.parentElement === wrap
    && wrap.querySelector('.obj-view-label').textContent === 'FRONT VIEW');
  okf('E.3 RENDERER 側のペインには存在しない',
    !document.querySelector('#obj-renderer #obj-frontview'));

  {
    U.setView('renderer');
    okf('E.4 RENDERER に切り替えると隠れる（PANNER ごと hidden）',
      front.getBoundingClientRect().width === 0,
      'width=' + front.getBoundingClientRect().width);
    U.setView('panner');
    okf('E.5 PANNER に戻すと描画領域がある',
      front.getBoundingClientRect().width > 50,
      'width=' + Math.round(front.getBoundingClientRect().width));
  }

  // ---------------------------------------------------------------
  // B. 投影の規約（ADM が画面座標で正しく出ているか）
  // ---------------------------------------------------------------
  const g = U.frontGeom();
  okf('E.6 描画領域の幾何がある', g.rect.width > 50 && g.rect.height > 50 && g.R > 30,
    `${Math.round(g.rect.width)}x${Math.round(g.rect.height)} R=${Math.round(g.R)}`);

  const pLeft = U.frontXY(90, 0, 1, g);
  const pRight = U.frontXY(-90, 0, 1, g);
  const pUp = U.frontXY(0, 90, 1, g);
  const pDown = U.frontXY(0, -90, 1, g);
  const pFront = U.frontXY(0, 0, 1, g);
  const pBack = U.frontXY(180, 0, 1, g);

  okf('E.7 az=+90 は画面の左いっぱい（ADM は正=左回り）',
    Math.abs(pLeft.x - (g.cx - g.R)) < 1e-9 && Math.abs(pLeft.y - g.cy) < 1e-9,
    `x-cx=${(pLeft.x - g.cx).toFixed(1)} y-cy=${(pLeft.y - g.cy).toFixed(3)}`);
  okf('E.8 az=-90 は画面の右（+90 と左右対称）',
    Math.abs(pRight.x - (g.cx + g.R)) < 1e-9 && Math.abs((pRight.x - g.cx) + (pLeft.x - g.cx)) < 1e-9,
    `x-cx=${(pRight.x - g.cx).toFixed(1)}`);
  okf('E.9 el=+90 は画面の上いっぱい・el=-90 は下',
    Math.abs(pUp.y - (g.cy - g.R)) < 1e-9 && Math.abs(pUp.x - g.cx) < 1e-9
    && Math.abs(pDown.y - (g.cy + g.R)) < 1e-9,
    `y-cy(上)=${(pUp.y - g.cy).toFixed(1)} y-cy(下)=${(pDown.y - g.cy).toFixed(1)}`);
  okf('E.10 el=0 はどの方位でも縦中央（耳の高さの基準線）',
    Math.abs(pLeft.y - g.cy) < 1e-9 && Math.abs(pFront.y - g.cy) < 1e-9
    && Math.abs(pBack.y - g.cy) < 1e-9);
  okf('E.11 az=0/180 はどちらも横中央で、back フラグだけが違う（正射影）',
    Math.abs(pFront.x - g.cx) < 1e-9 && Math.abs(pBack.x - g.cx) < 1e-9
    && pFront.back === false && pBack.back === true,
    `back(0°)=${pFront.back} back(180°)=${pBack.back}`);
  okf('E.12 dist で内側に入る（半径=dist の縮尺）',
    Math.abs(U.frontXY(90, 0, 0.5, g).x - (g.cx - g.R * 0.5)) < 1e-9,
    `x-cx=${(U.frontXY(90, 0, 0.5, g).x - g.cx).toFixed(1)}`);

  // 3D球ビューの「+az が画面左」規約と左右が一致していること（鏡像事故の再発防止）
  {
    const gs = U.sphereGeom();
    const sLeft = U.projectDir(90, 0, gs);
    okf('E.13 3D球ビューと左右の向きが一致する（az=+90 は両方とも左）',
      pLeft.x < g.cx && sLeft.x < gs.cx,
      `front:x-cx=${(pLeft.x - g.cx).toFixed(1)} sphere:x-cx=${(sLeft.x - gs.cx).toFixed(1)}`);
  }

  // 変換規約は DAW.objaudio.toCartesian に一本化されている（式の複製が無い）
  {
    const orig = DAW.objaudio.toCartesian;
    let called = 0;
    DAW.objaudio.toCartesian = function (a, e, d) { called++; return orig.call(this, a, e, d); };
    let p;
    try { p = U.frontXY(33, 21, 0.8, g); } finally { DAW.objaudio.toCartesian = orig; }
    const c = orig.call(DAW.objaudio, 33, 21, 0.8);
    okf('E.14 投影は DAW.objaudio.toCartesian の結果をそのまま使う',
      called === 1 && Math.abs(p.x - (g.cx + g.R * c.x)) < 1e-12
      && Math.abs(p.y - (g.cy - g.R * c.y)) < 1e-12,
      `呼び出し=${called}回`);
  }

  // 画面 → az/el（ドラッグの逆変換）が投影と往復する
  {
    const p = U.frontXY(37, 25, 0.7, g);
    const d = U.frontToDir(p.x, p.y, g, 0.7, p.back);
    okf('E.15 frontXY と frontToDir は往復する（同じ半球を指定したとき）',
      Math.abs(d.az - 37) < 1e-6 && Math.abs(d.el - 25) < 1e-6,
      `az=${d.az.toFixed(4)} el=${d.el.toFixed(4)} back=${p.back}`);
    const outside = U.frontToDir(g.cx - g.R * 5, g.cy, g, 0.7, false);
    okf('E.16 円の外をつかんでも角度が壊れない（縁へ寄って az=+90）',
      isFinite(outside.az) && Math.abs(outside.az - 90) < 1e-6 && Math.abs(outside.el) < 1e-6,
      `az=${outside.az.toFixed(1)} el=${outside.el.toFixed(1)}`);
  }

  // ---------------------------------------------------------------
  // C. ドラッグ（縦=el / 横=az / dist 不変 / Undo 1エントリ）
  // ---------------------------------------------------------------
  const fev = (type, x, y, opts) => {
    front.dispatchEvent(new PointerEvent(type, Object.assign({
      bubbles: true, cancelable: true, pointerId: 5, button: 0, clientX: x, clientY: y,
    }, opts)));
  };

  const a = O.create('声', DAW.project.tracks[0].id);
  O.setPosition(a.id, 0, 0, 0.6);
  O.select(a.id);
  U.render();

  {
    DAW.history.reset();
    const gg = U.frontGeom();
    const start = U.frontXY(0, 0, 0.6, gg);
    const mid = U.frontXY(0, 30, 0.6, gg);        // 真上へ＝el だけが変わる
    const end = U.frontXY(40, 25, 0.6, gg);       // 斜めへ＝az との複合
    fev('pointerdown', start.x, start.y);
    fev('pointermove', mid.x, mid.y);
    const m = O.get(a.id);
    okf('E.17 縦ドラッグで el が変わり az は動かない',
      Math.abs(m.az) < EPS && Math.abs(m.el - 30) < EPS,
      `az=${m.az.toFixed(2)} el=${m.el.toFixed(2)}`);
    okf('E.18 ドラッグ中は履歴を積まない（commit は pointerup のみ）',
      !DAW.history.canUndo(), 'past=' + DAW.history.past.length);
    fev('pointermove', end.x, end.y);
    fev('pointerup', end.x, end.y);
    const o = O.get(a.id);
    okf('E.19 斜めドラッグは az/el の複合で終点に入る',
      Math.abs(o.az - 40) < EPS && Math.abs(o.el - 25) < EPS,
      `az=${o.az.toFixed(2)} el=${o.el.toFixed(2)}`);
    okf('E.20 距離は変えない（トップビュー側の担当）',
      Math.abs(o.dist - 0.6) < 1e-9, 'dist=' + o.dist);
    okf('E.21 ドラッグ全体で履歴は1エントリ', DAW.history.past.length === 1,
      'past=' + DAW.history.past.length);

    await DAW.history.undo();
    const u = O.get(a.id);
    okf('E.22 undo 1回でドラッグ前の位置に戻る',
      Math.abs(u.az) < 1e-9 && Math.abs(u.el) < 1e-9 && Math.abs(u.dist - 0.6) < 1e-9,
      `az=${u.az} el=${u.el} dist=${u.dist}`);
  }

  {
    // 横ドラッグ（el=0 のまま左へ）＝az だけが変わる
    const gg = U.frontGeom();
    const start = U.frontXY(0, 0, 0.6, gg);
    const to = U.frontXY(30, 0, 0.6, gg);
    fev('pointerdown', start.x, start.y);
    fev('pointermove', to.x, to.y);
    fev('pointerup', to.x, to.y);
    const o = O.get(a.id);
    okf('E.23 横ドラッグで az が変わり el は 0 のまま',
      Math.abs(o.az - 30) < EPS && Math.abs(o.el) < EPS,
      `az=${o.az.toFixed(2)} el=${o.el.toFixed(2)}`);
    // ストリップの数値ボックスへも即反映される
    const strip = document.querySelector(`#obj-strips .obj-strip[data-obj-id="${a.id}"]`);
    okf('E.24 正面ビューでの移動が数値ボックスへ即反映される',
      !!strip && Math.abs(parseFloat(strip.querySelector('.os-in-az').value) - 30) < 1.5,
      strip ? 'Az=' + strip.querySelector('.os-in-az').value : 'ストリップなし');
  }

  {
    // 後方（|az|>90）のオブジェクトを掴んでも前方へ跳ばない（半球の保持）
    O.setPosition(a.id, 150, 0, 0.6);
    U.render();
    const gg = U.frontGeom();
    const from = U.frontXY(150, 0, 0.6, gg);
    const to = U.frontXY(150, 20, 0.6, gg);   // 同じ横位置のまま上へ
    fev('pointerdown', from.x, from.y);
    fev('pointermove', to.x, to.y);
    fev('pointerup', to.x, to.y);
    const o = O.get(a.id);
    okf('E.25 後方のオブジェクトは後方のままドラッグされる（前へ跳ばない）',
      Math.abs(o.az - 150) < EPS && Math.abs(o.el - 20) < EPS,
      `az=${o.az.toFixed(2)} el=${o.el.toFixed(2)}`);
  }

  {
    // lock 中は動かない
    O.setPosition(a.id, 10, 5, 0.5);
    O.set(a.id, 'lock', 'pos');
    U.render();
    DAW.history.reset();
    const gg = U.frontGeom();
    const from = U.frontXY(10, 5, 0.5, gg);
    const to = U.frontXY(-60, 40, 0.5, gg);
    fev('pointerdown', from.x, from.y);
    fev('pointermove', to.x, to.y);
    fev('pointerup', to.x, to.y);
    const o = O.get(a.id);
    okf("E.26 lock='pos' は正面ビューでも動かない",
      Math.abs(o.az - 10) < 1e-9 && Math.abs(o.el - 5) < 1e-9 && Math.abs(o.dist - 0.5) < 1e-9,
      `az=${o.az} el=${o.el}`);
    okf('E.27 動いていないので履歴も積まれない', !DAW.history.canUndo(),
      'past=' + DAW.history.past.length);
    O.set(a.id, 'lock', 'all');
    fev('pointerdown', from.x, from.y);
    fev('pointermove', to.x, to.y);
    fev('pointerup', to.x, to.y);
    const o2 = O.get(a.id);
    okf("E.28 lock='all' も同じく動かない",
      Math.abs(o2.az - 10) < 1e-9 && Math.abs(o2.el - 5) < 1e-9, `az=${o2.az} el=${o2.el}`);
    O.set(a.id, 'lock', 'none');
    U.render();
  }

  {
    // 点をクリックすると選択が移り、そのときは位置を動かさない
    const other = O.create('別');
    O.setPosition(a.id, 0, 0, 1);
    O.setPosition(other.id, -60, 40, 1);
    O.select(a.id);
    U.render();
    const gg = U.frontGeom();
    const p = U.frontXY(-60, 40, 1, gg);
    fev('pointerdown', p.x, p.y);
    fev('pointerup', p.x, p.y);
    okf('E.29 正面ビューで点をクリックすると選択が移る', O.selectedId === other.id);
    const o = O.get(other.id);
    okf('E.30 選択のクリックでは位置を動かさない',
      Math.abs(o.az + 60) < 1e-9 && Math.abs(o.el - 40) < 1e-9, `az=${o.az} el=${o.el}`);
    O.remove(other.id);
    O.select(a.id);
    U.render();
  }

  {
    // 空きをクリック＝選択中を移動（トップビュー・3D球ビューと同じ流儀）
    O.setPosition(a.id, 0, 0, 0.8);
    U.render();
    const gg = U.frontGeom();
    const p = U.frontXY(60, 30, 0.8, gg);
    fev('pointerdown', p.x, p.y);
    fev('pointerup', p.x, p.y);
    const o = O.get(a.id);
    okf('E.31 空きをクリックすると選択中がそこへ移動する（dist は不変）',
      Math.abs(o.az - 60) < EPS && Math.abs(o.el - 30) < EPS && Math.abs(o.dist - 0.8) < 1e-9,
      `az=${o.az.toFixed(2)} el=${o.el.toFixed(2)} dist=${o.dist}`);
  }

  {
    // dist=0（中心）でも角度が壊れない（スケールの下限で向きだけ拾う）
    O.setPosition(a.id, 0, 0, 0);
    U.render();
    const gg = U.frontGeom();
    fev('pointerdown', gg.cx, gg.cy);
    fev('pointermove', gg.cx, gg.cy - gg.R * 0.03);
    fev('pointerup', gg.cx, gg.cy - gg.R * 0.03);
    const o = O.get(a.id);
    okf('E.32 dist=0 でもドラッグで NaN にならず dist も 0 のまま',
      isFinite(o.az) && isFinite(o.el) && o.el > 0 && Math.abs(o.dist) < 1e-9,
      `az=${o.az.toFixed(2)} el=${o.el.toFixed(2)} dist=${o.dist}`);
  }

  okf('E.33 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
