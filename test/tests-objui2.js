'use strict';
// =====================================================================
// オブジェクトベース音響の操作UI その2
//   ⑤ 3D球ビュー（自前の透視投影 / 遠い順の描画 / az・el のドラッグ）
//   ⑦ RENDERER 画面（リミッターの自作ノブ / スピーカー配置の選択と重畳）
//   ⑧ メータリング（実測ピークの接続 / 30fps への間引き / 可視ぶんだけ計測）
//
// 他ファイルのヘルパには依存しない（tests-*.js は名前順に読まれるため）。
// rAF は headless=new で発火しないので、更新関数を直接呼んで検証する。
// =====================================================================

function objui2Suite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;

    // ---- 触る可能性のあるグローバルを退避（後続スイートへ漏らさない）----
    const savedLimiter = Object.assign({}, DAW.limiter.params);
    const savedEnabled = DAW.limiter.enabled;
    const savedLayout = (DAW.objaudio && DAW.objaudio.layoutName) || '5.1';
    const savedPeakDb = DAW.objaudio.peakDb;
    const savedLevels = DAW.audio.getLevels;

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
      DAW.objaudio.peakDb = savedPeakDb;
      DAW.audio.getLevels = savedLevels;
      for (const k of Object.keys(savedLimiter)) DAW.limiter.set(k, savedLimiter[k]);
      DAW.limiter.setEnabled(savedEnabled);
      if (DAW.objaudio.setLayout) DAW.objaudio.setLayout(savedLayout);
      DAW.objui.layoutName = savedLayout;
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

objui2Suite('[32] 3D球ビュー/RENDERER/メーター', async (okf) => {
  const O = DAW.objects;
  const U = DAW.objui;
  const EPS = 0.6;   // ドラッグ座標→角度の許容誤差（度）

  // ---------------------------------------------------------------
  // A. 3D球ビューの投影（ADM 規約が画面座標で正しく出ているか）
  // ---------------------------------------------------------------
  const sphere = document.getElementById('obj-sphere');
  okf('W.1 3D球ビューの canvas がトップビューの隣にある',
    !!sphere && sphere.parentElement.id === 'obj-sphereview'
    && !!document.getElementById('obj-topview'),
    sphere ? sphere.parentElement.id : 'なし');

  const g = U.sphereGeom();
  okf('W.2 3D球ビューに描画領域がある',
    g.rect.width > 50 && g.rect.height > 50 && g.R > 30,
    `${Math.round(g.rect.width)}x${Math.round(g.rect.height)} R=${Math.round(g.R)}`);

  const pFront = U.projectDir(0, 0, g);
  const pBack = U.projectDir(180, 0, g);
  const pLeft = U.projectDir(90, 0, g);
  const pRight = U.projectDir(-90, 0, g);
  const pUp = U.projectDir(0, 90, g);
  const pDown = U.projectDir(0, -90, g);

  okf('W.3 az=0（正面）は画面の中央・カメラから最も遠い',
    Math.abs(pFront.x - g.cx) < 0.01 && pFront.y < g.cy
    && pFront.depth > pBack.depth && pFront.depth > pLeft.depth,
    `x-cx=${(pFront.x - g.cx).toFixed(3)} y-cy=${(pFront.y - g.cy).toFixed(1)} depth=${pFront.depth.toFixed(3)}`);
  okf('W.4 az=180（背面）は正面と上下が逆・カメラに最も近い',
    Math.abs(pBack.x - g.cx) < 0.01 && pBack.y > g.cy && pBack.depth < pFront.depth,
    `y-cy=${(pBack.y - g.cy).toFixed(1)} depth=${pBack.depth.toFixed(3)}`);
  okf('W.5 az=+90 は画面の左（ADM は正=左回り）',
    pLeft.x < g.cx - g.R * 0.5 && Math.abs(pLeft.y - g.cy) < 0.01,
    `x-cx=${(pLeft.x - g.cx).toFixed(1)} y-cy=${(pLeft.y - g.cy).toFixed(3)}`);
  okf('W.6 az=-90 は画面の右（+90 と左右対称）',
    pRight.x > g.cx + g.R * 0.5 && Math.abs((pRight.x - g.cx) + (pLeft.x - g.cx)) < 1e-9,
    `x-cx=${(pRight.x - g.cx).toFixed(1)}`);
  okf('W.7 el=+90 は画面の上（4方位より上）',
    pUp.y < g.cy && Math.abs(pUp.x - g.cx) < 0.01
    && pUp.y < Math.min(pFront.y, pBack.y, pLeft.y, pRight.y),
    `y-cy=${(pUp.y - g.cy).toFixed(1)}`);
  okf('W.8 el=-90 は画面の下（4方位より下）',
    pDown.y > g.cy && pDown.y > Math.max(pFront.y, pBack.y, pLeft.y, pRight.y),
    `y-cy=${(pDown.y - g.cy).toFixed(1)}`);

  // 透視投影であること（同じ方向でも奥行きで倍率が変わる）
  okf('W.9 透視投影になっている（遠いほど倍率が小さい）',
    pFront.k < pLeft.k && pLeft.k < pBack.k,
    `k(前)=${pFront.k.toFixed(2)} k(横)=${pLeft.k.toFixed(2)} k(後)=${pBack.k.toFixed(2)}`);

  // 変換規約は DAW.objaudio.toCartesian に一本化されている
  {
    const c = DAW.objaudio.toCartesian(33, 21, 1);
    const p1 = U.project(c, g);
    const p2 = U.projectDir(33, 21, g);
    okf('W.10 投影は DAW.objaudio.toCartesian の結果をそのまま使う',
      Math.abs(p1.x - p2.x) < 1e-12 && Math.abs(p1.y - p2.y) < 1e-12);
    const back = U.fromCartesian(c.x, c.y, c.z);
    okf('W.11 fromCartesian は toCartesian の逆変換',
      Math.abs(back.az - 33) < 1e-9 && Math.abs(back.el - 21) < 1e-9, JSON.stringify(back));
  }

  // 画面 → 球面（ドラッグの逆変換）が投影と往復する
  {
    const p = U.projectDir(37, 25, g);
    const near = p.depth <= g.cam.D;
    const d = U.unproject(p.x, p.y, g, near);
    okf('W.12 projectDir と unproject は往復する（同じ半球を指定したとき）',
      Math.abs(d.az - 37) < 1e-6 && Math.abs(d.el - 25) < 1e-6,
      `az=${d.az.toFixed(4)} el=${d.el.toFixed(4)} near=${near}`);
    const outside = U.unproject(g.cx - g.R * 5, g.cy, g, true);
    okf('W.13 球の外をつかんでも角度が壊れない（輪郭へ寄る）',
      isFinite(outside.az) && isFinite(outside.el) && Math.abs(outside.el) <= 90,
      `az=${outside.az.toFixed(1)} el=${outside.el.toFixed(1)}`);
  }

  // ---------------------------------------------------------------
  // B. 描画順（遠いオブジェクトから先に描く）
  // ---------------------------------------------------------------
  const a = O.create('前', DAW.project.tracks[0].id);
  const b = O.create('横');
  const c3 = O.create('後');
  O.setPosition(a.id, 0, 0, 1);
  O.setPosition(b.id, 90, 0, 1);
  O.setPosition(c3.id, 180, 0, 1);
  O.select(a.id);
  U.render();

  {
    const order = U.sphereOrder(g);
    let mono = true;
    for (let i = 1; i < order.length; i++) if (order[i].p.depth > order[i - 1].p.depth) mono = false;
    okf('W.14 sphereOrder は奥行きの降順（遠いものが先頭）',
      mono && order.length === 3 && order[0].obj.id === a.id && order[2].obj.id === c3.id,
      order.map(o => `${o.obj.name}:${o.p.depth.toFixed(2)}`).join(' '));
  }

  {
    // 実際の描画でも遠い順に呼ばれているか（描画関数を差し替えて記録する）
    const orig = U.drawSphereObject;
    const seen = [];
    U.drawSphereObject = function (g2, obj, p, gg, isSel) {
      seen.push({ name: obj.name, depth: p.depth });
      return orig.call(this, g2, obj, p, gg, isSel);
    };
    try { U.drawSphere(); } finally { U.drawSphereObject = orig; }
    let mono = true;
    for (let i = 1; i < seen.length; i++) if (seen[i].depth > seen[i - 1].depth) mono = false;
    okf('W.15 drawSphere は遠いオブジェクトから順に描く',
      seen.length === 3 && mono && seen[0].name === '前' && seen[2].name === '後',
      seen.map(s => `${s.name}:${s.depth.toFixed(2)}`).join(' → '));
  }

  // ---------------------------------------------------------------
  // C. 3D球ビューのドラッグ（az/el のみ / Undo 1エントリ / lock）
  // ---------------------------------------------------------------
  const sev = (type, x, y, opts) => {
    sphere.dispatchEvent(new PointerEvent(type, Object.assign({
      bubbles: true, cancelable: true, pointerId: 3, button: 0, clientX: x, clientY: y,
    }, opts)));
  };

  {
    O.remove(b.id);
    O.remove(c3.id);
    O.setPosition(a.id, 0, 0, 0.6);
    O.select(a.id);
    U.render();
    DAW.history.reset();

    const gg = U.sphereGeom();
    const start = U.projectDir(0, 0, gg);
    const mid = U.projectDir(20, 15, gg);
    const end = U.projectDir(40, 30, gg);
    sev('pointerdown', start.x, start.y);
    sev('pointermove', mid.x, mid.y);
    const m = O.get(a.id);
    okf('W.16 3D球ビューのドラッグで az/el が変わる',
      Math.abs(m.az - 20) < EPS && Math.abs(m.el - 15) < EPS,
      `az=${m.az.toFixed(2)} el=${m.el.toFixed(2)}`);
    okf('W.17 ドラッグ中は履歴を積まない（commit は pointerup のみ）',
      !DAW.history.canUndo(), 'past=' + DAW.history.past.length);
    sev('pointermove', end.x, end.y);
    sev('pointerup', end.x, end.y);
    const o = O.get(a.id);
    okf('W.18 ドラッグ全体で履歴は1エントリ', DAW.history.past.length === 1,
      'past=' + DAW.history.past.length);
    okf('W.19 終点の az/el が入る',
      Math.abs(o.az - 40) < EPS && Math.abs(o.el - 30) < EPS,
      `az=${o.az.toFixed(2)} el=${o.el.toFixed(2)}`);
    okf('W.20 距離は変えない（距離はトップビュー側の担当）',
      Math.abs(o.dist - 0.6) < 1e-9, 'dist=' + o.dist);

    await DAW.history.undo();
    const u = O.get(a.id);
    okf('W.21 undo 1回でドラッグ前の位置に戻る',
      Math.abs(u.az) < 1e-9 && Math.abs(u.el) < 1e-9 && Math.abs(u.dist - 0.6) < 1e-9,
      `az=${u.az} el=${u.el} dist=${u.dist}`);
  }

  {
    // ドラッグで数値ボックス（ストリップ）にも即反映される
    const gg = U.sphereGeom();
    const p = U.projectDir(-50, 20, gg);
    const st = U.projectDir(0, 0, gg);
    sev('pointerdown', st.x, st.y);
    sev('pointermove', p.x, p.y);
    sev('pointerup', p.x, p.y);
    const strip = document.querySelector(`#obj-strips .obj-strip[data-obj-id="${a.id}"]`);
    okf('W.22 3D球ビューでの移動が数値ボックスへ即反映される',
      !!strip && Math.abs(parseFloat(strip.querySelector('.os-in-az').value) + 50) < 1.5
      && Math.abs(parseFloat(strip.querySelector('.os-in-el').value) - 20) < 1.5,
      strip ? `Az=${strip.querySelector('.os-in-az').value} El=${strip.querySelector('.os-in-el').value}` : 'ストリップなし');
  }

  {
    // lock='pos' は動かない
    O.setPosition(a.id, 10, 5, 0.5);
    O.set(a.id, 'lock', 'pos');
    U.render();
    const gg = U.sphereGeom();
    const from = U.projectDir(10, 5, gg);
    const to = U.projectDir(-120, 40, gg);
    sev('pointerdown', from.x, from.y);
    sev('pointermove', to.x, to.y);
    sev('pointerup', to.x, to.y);
    const o = O.get(a.id);
    okf("W.23 lock='pos' は 3D球ビューでも動かない",
      Math.abs(o.az - 10) < 1e-9 && Math.abs(o.el - 5) < 1e-9, `az=${o.az} el=${o.el}`);
    O.set(a.id, 'lock', 'all');
    sev('pointerdown', from.x, from.y);
    sev('pointermove', to.x, to.y);
    sev('pointerup', to.x, to.y);
    const o2 = O.get(a.id);
    okf("W.24 lock='all' も同じく動かない",
      Math.abs(o2.az - 10) < 1e-9 && Math.abs(o2.el - 5) < 1e-9, `az=${o2.az} el=${o2.el}`);
    O.set(a.id, 'lock', 'none');
    U.render();
  }

  {
    // 点をクリックすると選択が移り、そのときは位置を動かさない
    const other = O.create('別');
    O.setPosition(a.id, 0, 0, 1);
    O.setPosition(other.id, 150, 30, 1);
    O.select(a.id);
    U.render();
    const gg = U.sphereGeom();
    const p = U.projectDir(150, 30, gg);
    sev('pointerdown', p.x, p.y);
    sev('pointerup', p.x, p.y);
    okf('W.25 3D球ビューで点をクリックすると選択が移る', O.selectedId === other.id);
    const o = O.get(other.id);
    okf('W.26 選択のクリックでは位置を動かさない',
      Math.abs(o.az - 150) < 1e-9 && Math.abs(o.el - 30) < 1e-9, `az=${o.az} el=${o.el}`);
    O.remove(other.id);
    O.select(a.id);
    U.render();
  }

  // ---------------------------------------------------------------
  // D. RENDERER: リミッターの自作ノブ
  // ---------------------------------------------------------------
  document.getElementById('tab-renderer').click();
  okf('W.27 RENDERER タブに切り替わる',
    U.view === 'renderer'
    && document.getElementById('obj-renderer').classList.contains('hidden') === false);

  const knobs = document.querySelectorAll('#obj-knobs .obj-knob');
  okf('W.28 リミッターのノブが4つある（Gain / Release / Output / Lookahead）',
    knobs.length === 4
    && Array.from(knobs).map(k => k.dataset.key).join(',') === 'gainDb,releaseMs,ceilingDb,lookaheadMs',
    Array.from(knobs).map(k => k.dataset.key).join(','));
  okf('W.29 ノブは自作（canvas に描いている。<input> ではない）',
    Array.from(knobs).every(k => k.querySelector('canvas') && !k.querySelector('input')));

  const knob = key => document.querySelector(`#obj-knobs .obj-knob[data-key="${key}"]`);
  const kev = (el, type, y, opts) => {
    const target = type === 'pointerdown' ? el : window;
    target.dispatchEvent(new PointerEvent(type, Object.assign({
      bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: 0, clientY: y,
    }, opts)));
  };
  const drag = (key, dy, opts) => {
    kev(knob(key), 'pointerdown', 300);
    kev(knob(key), 'pointermove', 300 - dy, opts);
    kev(knob(key), 'pointerup', 300 - dy);
  };

  {
    DAW.limiter.set('gainDb', 0);
    U.renderRenderer();
    const range = DAW.limiter.LIMITS.gainDb;
    const expect = (range[1] - range[0]) * (34 / U.KNOB_PX);
    drag('gainDb', 34);
    okf('W.30 ノブを上へドラッグすると値が増える（DAW.limiter.params に反映）',
      Math.abs(DAW.limiter.params.gainDb - expect) < 1e-6,
      `gainDb=${DAW.limiter.params.gainDb.toFixed(3)} 期待=${expect.toFixed(3)}`);
    okf('W.31 ノブの数値表示が params と一致する',
      knob('gainDb').querySelector('.ok-val').textContent === DAW.limiter.params.gainDb.toFixed(1) + 'dB',
      knob('gainDb').querySelector('.ok-val').textContent);

    DAW.limiter.set('gainDb', 0);
    drag('gainDb', -34);
    okf('W.32 下へドラッグすると値が減る',
      Math.abs(DAW.limiter.params.gainDb + expect) < 1e-6, DAW.limiter.params.gainDb.toFixed(3));

    DAW.limiter.set('gainDb', 0);
    drag('gainDb', 5000);
    okf('W.33 上限を超えるドラッグは丸められる',
      DAW.limiter.params.gainDb === DAW.limiter.LIMITS.gainDb[1], DAW.limiter.params.gainDb);
    drag('gainDb', -5000);
    okf('W.34 下限を下回るドラッグも丸められる',
      DAW.limiter.params.gainDb === DAW.limiter.LIMITS.gainDb[0], DAW.limiter.params.gainDb);

    // Shift で微調整（同じドラッグ量でも変化が小さい）
    DAW.limiter.set('gainDb', 0);
    drag('gainDb', 34, { shiftKey: true });
    okf('W.35 Shift ドラッグは微調整になる',
      Math.abs(DAW.limiter.params.gainDb - expect * 0.2) < 1e-6, DAW.limiter.params.gainDb.toFixed(3));
  }

  {
    // 残り3つのノブも同じ規則で動く
    for (const [key, unit, digits] of [['releaseMs', 'ms', 0], ['ceilingDb', 'dB', 1], ['lookaheadMs', 'ms', 1]]) {
      const r = DAW.limiter.LIMITS[key];
      DAW.limiter.set(key, r[0]);
      drag(key, U.KNOB_PX / 2);
      const mid = r[0] + (r[1] - r[0]) / 2;
      okf(`W.36 ${key} のノブが半分ぶんで中央値になる`,
        Math.abs(DAW.limiter.params[key] - mid) < 1e-6,
        `${DAW.limiter.params[key]} 期待=${mid}`);
      okf(`W.37 ${key} の表示に単位が付く`,
        knob(key).querySelector('.ok-val').textContent === DAW.limiter.params[key].toFixed(digits) + unit,
        knob(key).querySelector('.ok-val').textContent);
    }
  }

  {
    DAW.limiter.set('ceilingDb', -12);
    knob('ceilingDb').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    okf('W.38 ダブルクリックで既定値に戻る', DAW.limiter.params.ceilingDb === -1,
      DAW.limiter.params.ceilingDb);
  }

  {
    const byp = document.getElementById('obj-lim-byp');
    const was = DAW.limiter.enabled;
    byp.click();
    okf('W.39 バイパスボタンが DAW.limiter.setEnabled に届く', DAW.limiter.enabled === !was,
      'enabled=' + DAW.limiter.enabled);
    okf('W.40 バイパス中は見た目が変わる', byp.classList.contains('on') === !DAW.limiter.enabled);
    byp.click();
    okf('W.41 もう一度押すと元に戻る', DAW.limiter.enabled === was);
    okf('W.42 枠だけのボタン（ヘッダーの BYPASS）は無効のまま',
      document.getElementById('obj-bypass').disabled === true);
  }

  // ---------------------------------------------------------------
  // E. RENDERER: スピーカー配置
  // ---------------------------------------------------------------
  {
    const SPEC = {
      '5.1': [['L', 30, 0], ['R', -30, 0], ['C', 0, 0], ['LFE', 0, -30], ['Ls', 110, 0], ['Rs', -110, 0]],
      '7.1.4': [['L', 30, 0], ['R', -30, 0], ['C', 0, 0], ['LFE', 0, -30],
        ['Lss', 90, 0], ['Rss', -90, 0], ['Lrs', 135, 0], ['Rrs', -135, 0],
        ['Ltf', 45, 45], ['Rtf', -45, 45], ['Ltr', 135, 45], ['Rtr', -135, 45]],
    };
    okf('W.43 5.1 は 6ch ぶんの定義を持つ', U.speakers('5.1').length === 6, U.speakers('5.1').length);
    okf('W.44 7.1.4 は 12ch ぶんの定義を持つ', U.speakers('7.1.4').length === 12, U.speakers('7.1.4').length);
    for (const name of ['5.1', '7.1.4']) {
      const got = U.speakers(name);
      const bad = SPEC[name].filter(([n, az, el], i) =>
        !got[i] || got[i].name !== n || got[i].az !== az || got[i].el !== el);
      okf(`W.45 ${name} の名前と az/el が ADM 規約どおり`, bad.length === 0,
        bad.length ? JSON.stringify(bad) : got.map(s => `${s.name}(${s.az},${s.el})`).join(' '));
    }
    okf('W.46 LFE は LFE として区別されている',
      U.speakers('5.1').filter(s => s.lfe).length === 1
      && U.speakers('7.1.4').filter(s => s.lfe).length === 1);
  }

  {
    const btn = n => document.querySelector(`#obj-layouts .obj-layout-btn[data-layout="${n}"]`);
    okf('W.47 配置の選択ボタンが LAYOUTS の全配置ぶんある',   // 2.0 / 5.0.5.3 追加で 4 つ（[45] 参照）
      !!btn('5.1') && !!btn('7.1.4') && !!btn('2.0') && !!btn('5.0.5.3')
      && document.querySelectorAll('#obj-layouts .obj-layout-btn').length === U.layoutNames().length);
    btn('7.1.4').click();
    okf('W.48 ボタンで選択中の配置が変わる', U.layoutName === '7.1.4', U.layoutName);
    okf('W.49 選択がレンダラー層（VBAP）にも伝わる',
      !DAW.objaudio.layoutName || DAW.objaudio.layoutName === '7.1.4', DAW.objaudio.layoutName);
    okf('W.50 選択中のボタンだけ on になる',
      btn('7.1.4').classList.contains('on') && !btn('5.1').classList.contains('on'));
    okf('W.51 スピーカー一覧が選択した配置ぶん出る',
      document.querySelectorAll('#obj-spk-list .obj-spk-row').length === 12,
      document.querySelectorAll('#obj-spk-list .obj-spk-row').length);
    btn('5.1').click();
    okf('W.52 5.1 に戻すと一覧も 6 行になる',
      U.layoutName === '5.1' && document.querySelectorAll('#obj-spk-list .obj-spk-row').length === 6,
      document.querySelectorAll('#obj-spk-list .obj-spk-row').length);
  }

  {
    // RENDERER のときだけ球ビューにスピーカーを重ねる
    const orig = U.drawSpeakers;
    let calls = 0;
    let drawn = 0;
    U.drawSpeakers = function (g2, gg) { calls++; drawn = this.speakers().length; return orig.call(this, g2, gg); };
    try {
      U.setView('renderer');
      U.drawSphere();
      const inRenderer = calls;
      const drawnR = drawn;
      calls = 0;
      U.setView('panner');
      U.drawSphere();
      okf('W.53 RENDERER 選択時は 3D球ビューにスピーカーを重畳する',
        inRenderer > 0 && drawnR === 6, `呼び出し=${inRenderer} スピーカー=${drawnR}`);
      okf('W.54 PANNER 選択時は重畳しない', calls === 0, '呼び出し=' + calls);
    } finally {
      U.drawSpeakers = orig;
    }
    U.setView('renderer');
    U.render();
    okf('W.55 重畳しても球ビューは同じ投影を使う（番号1のスピーカーが左前に出る）',
      (() => {
        const gg = U.sphereGeom();
        const p = U.projectDir(U.speakers()[0].az, U.speakers()[0].el, gg);   // L(+30,0)
        return p.x < gg.cx && p.depth > gg.cam.D;
      })(), 'L(+30°,0°)');
    U.setView('panner');
  }

  // ---------------------------------------------------------------
  // F. メータリング
  // ---------------------------------------------------------------
  {
    U.render();
    const ids = O.list.map(o => o.id);
    const seen = [];
    DAW.objaudio.peakDb = id => { seen.push(id); return -12; };

    U._lastMeter = 0;
    const r1 = U.updateMeters(1000);
    const strip = document.querySelector(`#obj-strips .obj-strip[data-obj-id="${ids[0]}"]`);
    okf('W.56 メーターが DAW.objaudio.peakDb の値を表示する',
      r1 === true && !!strip && strip.querySelector('.os-peak').textContent === '-12.0',
      strip ? strip.querySelector('.os-peak').textContent : 'ストリップなし');

    const n1 = seen.length;
    const r2 = U.updateMeters(1010);   // 10ms 後 → 30fps(33.3ms) に満たないので間引かれる
    okf('W.57 30fps に満たない間隔では更新しない（rAF を間引く）',
      r2 === false && seen.length === n1, `戻り値=${r2} 呼び出し=${seen.length - n1}`);
    const r3 = U.updateMeters(1040);   // 40ms 後 → 更新する
    okf('W.58 33.3ms 以上あいたら更新する', r3 === true && seen.length > n1,
      `戻り値=${r3} 呼び出し=${seen.length - n1}`);
    okf('W.59 更新レートは 30fps', U.METER_FPS === 30, U.METER_FPS);

    // 白 → 黄 → 赤（既存の peakClass に合わせる）
    DAW.objaudio.peakDb = () => -20;
    U._lastMeter = 0; U.updateMeters(2000);
    const cls = () => document.querySelector(`#obj-strips .obj-strip[data-obj-id="${ids[0]}"] .os-peak`).className;
    okf('W.60 -20dB は通常色（白）', cls() === 'os-peak ', `"${cls()}"`);
    DAW.objaudio.peakDb = () => -3;
    U._lastMeter = 0; U.updateMeters(3000);
    okf('W.61 -3dB は警告色（黄）', cls().indexOf('warn') >= 0, cls());
    DAW.objaudio.peakDb = () => -0.2;
    U._lastMeter = 0; U.updateMeters(4000);
    okf('W.62 -0.2dB は危険色（赤）', cls().indexOf('hot') >= 0, cls());
    DAW.objaudio.peakDb = () => -Infinity;
    U._lastMeter = 0; U.updateMeters(5000);
    okf('W.63 鳴っていなければ -∞ 表示',
      document.querySelector(`#obj-strips .obj-strip[data-obj-id="${ids[0]}"] .os-peak`).textContent === '-∞');
  }

  {
    // 可視ストリップだけ計測する（128個ぶん毎フレーム呼ぶと重い）
    while (!O.isFull()) O.create();
    U.render();
    let calls = 0;
    DAW.objaudio.peakDb = () => { calls++; return -30; };
    U._lastMeter = 0;
    U.updateMeters(10000);
    okf('W.64 128個あっても計測は可視ストリップぶんだけ',
      calls > 0 && calls === U.strips.size && calls < 128,
      `計測=${calls}回 / オブジェクト=${O.count()}個 / DOM上のストリップ=${U.strips.size}本`);

    // 画面外へスクロールしても「そのとき見えているぶん」だけになる
    U.els.stripScroll.scrollLeft = U.STRIP_W * 60;
    U.renderStrips();
    calls = 0;
    U._lastMeter = 0;
    U.updateMeters(11000);
    okf('W.65 スクロール後も可視ぶんだけ計測する', calls === U.strips.size && calls < 128,
      `計測=${calls}回 / ストリップ=${U.strips.size}本`);
    U.els.stripScroll.scrollLeft = 0;
    U.renderStrips();
    for (let i = O.count() - 1; i >= 1; i--) O.remove(O.list[i].id);
    U.render();
  }

  {
    // マスターメーター（ドック側）は DAW.audio.getLevels() を反映する
    DAW.audio.getLevels = () => [0.5, 0.1];
    U._lastMeter = 0;
    U.updateMeters(20000);
    const l = parseFloat(document.getElementById('obj-mm-l').style.width);
    const r = parseFloat(document.getElementById('obj-mm-r').style.width);
    okf('W.66 マスターメーターが実値を反映する（L > R）',
      l > r && l > 0 && l <= 100, `L=${l}% R=${r}%`);
    okf('W.67 マスターの dB 表示が実値になる',
      document.getElementById('obj-mdb').textContent === (20 * Math.log10(0.5)).toFixed(1),
      document.getElementById('obj-mdb').textContent);
    DAW.audio.getLevels = () => [0, 0];
    U._lastMeter = 0;
    U.updateMeters(21000);
    okf('W.68 無音なら -∞', document.getElementById('obj-mdb').textContent === '-∞',
      document.getElementById('obj-mdb').textContent);
  }

  // ---------------------------------------------------------------
  // G. UI を経由しない変更への追従（署名で検知して描き直す）
  // ---------------------------------------------------------------
  {
    U.setView('renderer');
    U.render();
    DAW.limiter.set('gainDb', 5);            // UI を経由せずに変更する
    U.sync();
    okf('W.69 UI を経由しないリミッター変更にも追従する',
      knob('gainDb').querySelector('.ok-val').textContent === '5.0dB',
      knob('gainDb').querySelector('.ok-val').textContent);

    if (DAW.objaudio.setLayout) {
      DAW.objaudio.setLayout('7.1.4');       // レンダラー層側から配置が変わった場合
      U.sync();
      okf('W.70 レンダラー層の配置変更にも追従する（表示が正）',
        U.layoutName === '7.1.4'
        && document.querySelectorAll('#obj-spk-list .obj-spk-row').length === 12,
        `${U.layoutName} / ${document.querySelectorAll('#obj-spk-list .obj-spk-row').length}行`);
      DAW.objaudio.setLayout('5.1');
      U.sync();
    }
    U.setView('panner');
  }

  okf('W.71 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
