'use strict';

// オブジェクトベース音響の操作UI。
// PANNER（3D球ビュー / トップビュー / 正面ビュー / オブジェクトストリップ）と
// RENDERER（スピーカー配置の選択 / マスターリミッターのノブ）、そしてメータリング。
//
// 方針:
//  - state は js/objects.js の DAW.objects 一本。ここは「描く」「入力を state に流す」だけ。
//    ビュー側に値を複製して持たない（トップビューとストリップで値がずれる事故を根絶するため）。
//  - 再描画の入口は render() ひとつ。3D球ビューなど後から増えるビューもここに足せばよい。
//  - オブジェクトの実体は undo（DAW.objects.load）で作り直されるので、
//    DOM もハンドラも「id で引く」。オブジェクト参照を握ったままにすると undo 後に古い実体を書く。
//  - ストリップは可視ぶんだけ DOM を作る。128本ぶんを常時置くと入力欄が 128×6 個になり、
//    生成もレイアウトもメーター更新も重い。横スクロールで差分だけ作り直す。
//  - 座標規約は ADM のまま扱う（0°=正面、正=反時計回り、el 正=上）。
//    画面は y が下向きなので、極座標→画面 の変換で符号が入れ替わる点だけ注意（posToXY を参照）。
//  - 極座標→直交座標は DAW.objaudio.toCartesian() を使う（変換規約を二重に持たない）。
//    3D球ビューはその直交座標を自前の透視投影で画面へ落とすだけ。
DAW.objui = {
  STRIP_W: 92,        // ストリップ1本の幅(px)。仮想化の単位でもある
  OVERSCAN: 1,        // 可視範囲の左右に余分に作る本数（スクロール時のちらつき防止）
  TOP_PAD: 20,        // トップビューの外周余白(px)。方位ラベルを置く場所
  HIT_PX: 14,         // トップビューのヒット判定半径(px)
  FRONT_PAD: 20,      // 正面ビューの外周余白(px)。上下左右のラベルを置く場所
  FRONT_HIT_PX: 14,   // 正面ビューのヒット判定半径(px)
  METER_FPS: 30,      // ピーク表示の更新レート

  // ---- 3D球ビュー ----
  // カメラはリスナーの「真後ろやや上」に置く（front = -z なので +z 側）。
  // こうするとリスナーと同じ向きを見ることになり、ADM の +az（左）が画面の左に出る。
  SPH_PAD: 14,        // 外周余白(px)
  SPH_CAM_EL: 22,     // カメラの仰角(度)。0 にすると正面/背面が重なって見分けられない
  SPH_CAM_D: 3.2,     // カメラ距離（球半径=1 とした値）
  SPH_FOV: 0.9,       // 球の中心を通る大円が描画半径の何割になるか
  SPH_HIT_PX: 15,     // ヒット判定半径(px)

  // ---- リミッターのノブ ----
  // 実装は共通ノブ（js/knob.js の DAW.knob）に乗っている。KNOB_PX は DAW.knob.KNOB_PX と
  // 同じ値（挙動の基準値としてテストが参照するためここにも残す）。
  KNOB_PX: 170,       // フルレンジぶん動かすのに必要なドラッグ量(px)
  KNOBS: [
    { key: 'gainDb', label: 'Gain', unit: 'dB', digits: 1, def: 0 },
    { key: 'releaseMs', label: 'Release', unit: 'ms', digits: 0, def: 100 },
    { key: 'ceilingDb', label: 'Output', unit: 'dB', digits: 1, def: -1 },
    { key: 'lookaheadMs', label: 'Look', unit: 'ms', digits: 1, def: 5 },
  ],

  // ---- ルームリバーブのノブ（RENDERER）----
  // 値の正は DAW.objaudio.revParams。既定はレンダラー層（REV_DEFAULTS）と揃えること。
  REV_KNOBS: [
    { key: 'decay', label: 'Decay', unit: 's', digits: 1, def: 1.8, jp: '残響長' },
    { key: 'damp', label: 'Bright', unit: '', digits: 2, def: 0.5, jp: '明るさ' },
    { key: 'level', label: 'Return', unit: '', digits: 2, def: 0, jp: 'リターン量' },
  ],

  // スピーカー配置（ADM 準拠の az/el）。正はレンダラー側 DAW.objaudio.LAYOUTS。
  // ここに持つのは「まだ objaudio が配置を持っていない場合」のための控えで、
  // 両方あるときは必ずレンダラー側を使う（定義が二重にならないようにする）。
  FALLBACK_LAYOUTS: {
    '5.1': [
      { name: 'L', az: 30, el: 0 }, { name: 'R', az: -30, el: 0 },
      { name: 'C', az: 0, el: 0 }, { name: 'LFE', az: 0, el: -30, lfe: true },
      { name: 'Ls', az: 110, el: 0 }, { name: 'Rs', az: -110, el: 0 },
    ],
    '7.1.4': [
      { name: 'L', az: 30, el: 0 }, { name: 'R', az: -30, el: 0 },
      { name: 'C', az: 0, el: 0 }, { name: 'LFE', az: 0, el: -30, lfe: true },
      { name: 'Lss', az: 90, el: 0 }, { name: 'Rss', az: -90, el: 0 },
      { name: 'Lrs', az: 135, el: 0 }, { name: 'Rrs', az: -135, el: 0 },
      { name: 'Ltf', az: 45, el: 45 }, { name: 'Rtf', az: -45, el: 45 },
      { name: 'Ltr', az: 135, el: 45 }, { name: 'Rtr', az: -135, el: 45 },
    ],
  },

  els: {},
  view: 'panner',     // 'panner' | 'renderer'
  layoutName: '5.1',  // RENDERER で選択中のスピーカー配置
  drag: null,         // トップビューのドラッグ中の状態 { id, moved }
  fdrag: null,        // 正面ビューのドラッグ中の状態 { id, back, moved }
  sdrag: null,        // 3D球ビューのドラッグ中の状態 { id, near, moved }
  pdrag: null,        // 経路編集のドラッグ中の状態 { id, view, kind:'move'|'time', index, ... }
  pathEdit: false,    // 経路の編集モード（TOP VIEW ヘッダの「編集」トグル）
  pathSel: null,      // 選択中の waypoint 番号（時間チップの表示・ドラッグ対象）
  // セグメントの緩急をひと目で示すグリフ（= 等速 / ↗ 加速 / ↘ 減速 / ~ S字）
  EASE_GLYPHS: { linear: '=', in: '↗', out: '↘', inout: '~' },
  PATH_EASE_HIT: 9,   // イージンググリフのヒット判定半径(px)
  CHIP_PX_PER_STEP: 8,   // 時間チップのドラッグ: 8px = 0.1s
  strips: new Map(),  // id -> ストリップDOM（可視ぶんだけ）
  peaks: new Map(),   // id -> ピーク（線形）。0 なら -∞ 表示
  knobs: new Map(),   // key -> ノブDOM
  _inited: false,
  _sig: '',           // 外部（undo など）による state 変更を検知するための署名
  _lastMeter: 0,

  init() {
    if (this._inited) return;
    const $ = id => document.getElementById(id);
    this.els = {
      dock: $('obj-dock'),
      tabPanner: $('tab-panner'),
      tabRenderer: $('tab-renderer'),
      tabMetering: $('tab-metering'),
      panner: $('obj-panner'),
      renderer: $('obj-renderer'),
      count: $('obj-count'),
      add: $('obj-add'),
      del: $('obj-del'),
      topWrap: $('obj-topview'),
      top: $('obj-top'),
      frontWrap: $('obj-frontview'),
      front: $('obj-front'),
      sphereWrap: $('obj-sphereview'),
      sphere: $('obj-sphere'),
      pathEnable: $('obj-path-enable'),
      pathEditBtn: $('obj-path-edit'),
      stripScroll: $('obj-strip-scroll'),
      strips: $('obj-strips'),
      master: $('obj-master'),
      masterPeak: document.querySelector('#obj-master .os-peak'),
      mmL: $('obj-mm-l'),
      mmR: $('obj-mm-r'),
      mdb: $('obj-mdb'),
      layouts: $('obj-layouts'),
      spkList: $('obj-spk-list'),
      knobs: $('obj-knobs'),
      revKnobs: $('obj-rev-knobs'),
      limByp: $('obj-lim-byp'),
      out: $('obj-out'),
    };
    if (!this.els.dock || !this.els.top) return;   // DOM が無いページでは何もしない
    this._inited = true;

    this.els.tabPanner.addEventListener('click', () => this.setView('panner'));
    this.els.tabRenderer.addEventListener('click', () => this.setView('renderer'));
    if (this.els.tabMetering) this.els.tabMetering.addEventListener('click', () => this.setView('metering'));

    this.els.add.addEventListener('click', () => this.addObject());
    this.els.del.addEventListener('click', () => this.removeSelected());

    // 経路（位置オートメーション）のトグルと編集モード
    if (this.els.pathEnable) this.els.pathEnable.addEventListener('click', () => this.togglePathEnabled());
    if (this.els.pathEditBtn) this.els.pathEditBtn.addEventListener('click', () => this.togglePathEdit());

    // トップビューのドラッグ。move/up は window で受ける（canvas の外へ出ても追従させる）
    this.els.top.addEventListener('pointerdown', e => this.onTopDown(e));
    window.addEventListener('pointermove', e => this.onTopMove(e));
    window.addEventListener('pointerup', e => this.onTopUp(e));
    window.addEventListener('pointercancel', e => this.onTopUp(e));

    // 経路編集のドラッグ（waypoint 移動 / 時間チップ）。トップ・正面ビュー共通で pdrag が持つ
    window.addEventListener('pointermove', e => this.onPathMove(e));
    window.addEventListener('pointerup', () => this.onPathUp());
    window.addEventListener('pointercancel', () => this.onPathUp());
    // waypoint の右クリック = 削除（編集モード中のみ。ブラウザメニューは出さない）
    this.els.top.addEventListener('contextmenu', e => this.onPathContext(e, 'top'));

    // 正面ビューのドラッグ（az/el のみ。距離はトップビュー側で操作する）
    if (this.els.front) {
      this.els.front.addEventListener('pointerdown', e => this.onFrontDown(e));
      window.addEventListener('pointermove', e => this.onFrontMove(e));
      window.addEventListener('pointerup', e => this.onFrontUp(e));
      window.addEventListener('pointercancel', e => this.onFrontUp(e));
      this.els.front.addEventListener('contextmenu', e => this.onPathContext(e, 'front'));
    }

    // 3D球ビューのドラッグ（az/el のみ。距離はトップビュー側で操作する）
    if (this.els.sphere) {
      this.els.sphere.addEventListener('pointerdown', e => this.onSphereDown(e));
      window.addEventListener('pointermove', e => this.onSphereMove(e));
      window.addEventListener('pointerup', e => this.onSphereUp(e));
      window.addEventListener('pointercancel', e => this.onSphereUp(e));
    }

    // ノブのドラッグは共通ノブ（DAW.knob）が window で受ける

    this.buildRenderer();
    this.buildMetering();

    // 横スクロールで可視範囲が変わったらストリップを差分更新する
    this.els.stripScroll.addEventListener('scroll', () => this.renderStrips());
    window.addEventListener('resize', () => this.render());

    // syncStrip はフォーカス中の欄を書き換えない（入力の邪魔をしない）ので、
    // フォーカスしたまま undo されると表示だけ古い値で残り、署名は更新済みのため
    // rAF 同期も二度と拾わない。フォーカスが外れた時に一度描き直して取り返す。
    this.els.stripScroll.addEventListener('focusout', () => this.render());

    this.render();
    requestAnimationFrame(t => this.tick(t));
  },

  // ---- 表示の切り替え ----

  setView(name) {
    this.view = name === 'renderer' || name === 'metering' ? name : 'panner';
    const v = this.view;
    this.els.panner.classList.toggle('hidden', v !== 'panner');
    this.els.renderer.classList.toggle('hidden', v !== 'renderer');
    if (this.els.metering) this.els.metering.classList.toggle('hidden', v !== 'metering');
    this.els.tabPanner.classList.toggle('on', v === 'panner');
    this.els.tabRenderer.classList.toggle('on', v === 'renderer');
    if (this.els.tabMetering) this.els.tabMetering.classList.toggle('on', v === 'metering');
    // RENDERER / METERING ではストリップ帯が無いぶん球ビューを広く取る
    if (this.els.sphereWrap) this.els.sphereWrap.classList.toggle('wide', v !== 'panner');
    // METERING を開いたらラウドネス計測タップ（AudioWorklet）を仕掛ける。
    // 一度付けば閉じても計測は続く（Integrated は聴取全体の蓄積が意味を持つため）。
    if (v === 'metering' && DAW.audio && DAW.audio.ensureLoudness) {
      Promise.resolve(DAW.audio.ensureLoudness()).catch(() => {});
    }
    this.render();   // 隠れている間は描いていないので、戻ったときに描き直す
  },

  // ---- 再描画の入口（全ビューはここから）----

  render() {
    if (!this._inited) return;
    // フォーカス中のストリップを renderStrips が外すと focusout が同期発火し、
    // そのハンドラ（下の focusout → render）が再入して DOM 操作が衝突する。
    // 再入時は何もしない（外側の render がこの後どうせ全体を流し込む）。
    if (this._rendering) return;
    this._rendering = true;
    try {
      this.updateCount();
      this.syncPathTools();
      this.drawTop();
      this.drawFront();
      this.drawSphere();
      this.renderStrips();
      this.renderRenderer();
      if (this.view === 'metering') this.updateLoudness();
      this.syncTrackBadges();
      this._sig = this.stateSig();
    } finally {
      this._rendering = false;
    }
  },

  updateCount() {
    this.els.count.textContent = `${DAW.objects.count()} / ${DAW.objects.MAX}`;
    this.els.add.disabled = DAW.objects.isFull();
    this.els.del.disabled = !DAW.objects.selected();
  },

  addObject() {
    // 音源トラックは「まだオブジェクトに割り当てていない先頭のトラック」を仮に結ぶ。
    // 後からストリップのトラックセレクタ（os-track）で付け替えられる。
    const used = new Set(DAW.objects.list.map(o => o.trackId));
    const free = DAW.project.tracks.find(t => !used.has(t.id));
    const obj = DAW.objects.create(null, free ? free.id : null);
    if (!obj) return null;
    // UI から作るオブジェクトは width=100（±45°）を初期値にする。モデル既定の 0 だと
    // ステレオ素材が (L+R)/2 のモノラル1点に畳まれ、「繋いだら元のステレオより平坦」
    // という体験になるため（モノラル素材は widthGain の正規化で音量が変わらず無害）。
    // ADM 準拠の既定値そのもの（objects.defaults()）は変えない。
    DAW.objects.set(obj.id, 'width', 100);
    DAW.objects.select(obj.id);
    this.render();
    DAW.history.commit();
    return obj;
  },

  removeSelected() {
    const obj = DAW.objects.selected();
    if (!obj) return false;
    DAW.objects.remove(obj.id);
    this.render();
    DAW.history.commit();
    return true;
  },

  // セレクタからのトラック割り当て変更。奪い取り等の不変条件は DAW.objects.assignTrack が守る。
  // どのトラックがオブジェクト行きかは trackDest() が**ノード生成時**に決めるので、
  // 変わったらグラフを組み直す（width の点音源⇔2ソース切り替えと同じ扱い）。
  // undo はセレクト系の既存パターンどおり change で1回だけ commit する。
  setTrack(id, trackId) {
    if (!DAW.objects.assignTrack(id, trackId)) { this.render(); return false; }
    DAW.audio.resetNodes();
    DAW.audio.reschedule();   // 再生中ならその位置から組み直す（停止中は何もしない）
    this.render();
    DAW.history.commit();
    return true;
  },

  // ---- トップビュー ----

  // 極座標 → 画面。0°=上（正面）、正=反時計回り。
  // 画面の y は下向きなので x は -sin、y は -cos になる（ここを間違えると鏡像になる）。
  posToXY(az, dist, g) {
    const r = Math.PI / 180 * az;
    return {
      x: g.cx - g.R * dist * Math.sin(r),
      y: g.cy - g.R * dist * Math.cos(r),
    };
  },

  // 画面 → 極座標。posToXY の逆変換。distance は 0〜1 に丸める。
  xyToPos(x, y, g) {
    const dx = x - g.cx;
    const dy = y - g.cy;
    return {
      az: Math.atan2(-dx, -dy) * 180 / Math.PI,
      dist: Math.min(1, Math.hypot(dx, dy) / g.R),
    };
  },

  // トップビューの幾何。cx/cy は「クライアント座標」（ポインタ座標と直接比べられる）。
  topGeom() {
    const rect = this.els.top.getBoundingClientRect();
    return {
      rect,
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      R: Math.max(8, Math.min(rect.width, rect.height) / 2 - this.TOP_PAD),
    };
  },

  // 点の大きさ・明るさで elevation を示す（真上からの図には高さが出せないため）
  dotRadius(el) { return 4.5 + 3.5 * ((el + 90) / 180); },
  // el は表示位置の仰角（経路が動かすので obj.el と別に渡せる。省略時は obj.el）
  dotAlpha(obj, el) {
    const e = el == null ? obj.el : el;
    const base = 0.5 + 0.5 * ((e + 90) / 180);
    // ミュート / 他がソロ中のオブジェクトは薄くして「鳴っていない」ことを示す
    return DAW.objects.effectiveGain(obj) > 0 ? base : base * 0.3;
  },

  drawTop() {
    const c = this.els.top;
    const rect = c.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return;   // 非表示中は描かない
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g2 = c.getContext('2d');
    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    g2.clearRect(0, 0, rect.width, rect.height);

    const g = { cx: rect.width / 2, cy: rect.height / 2, R: Math.max(8, Math.min(rect.width, rect.height) / 2 - this.TOP_PAD) };

    // 背景の円（聴取空間）
    g2.fillStyle = '#101014';
    g2.beginPath();
    g2.arc(g.cx, g.cy, g.R, 0, Math.PI * 2);
    g2.fill();

    // 同心円 = 距離
    for (const f of [0.25, 0.5, 0.75, 1]) {
      g2.strokeStyle = f === 1 ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.10)';
      g2.lineWidth = 1;
      g2.beginPath();
      g2.arc(g.cx, g.cy, g.R * f, 0, Math.PI * 2);
      g2.stroke();
    }

    // 放射線 = 方位（30°刻み。正面/真横/真後ろだけ強調）
    for (let a = 0; a < 360; a += 30) {
      const p = this.posToXY(a, 1, g);
      g2.strokeStyle = (a % 90 === 0) ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.07)';
      g2.beginPath();
      g2.moveTo(g.cx, g.cy);
      g2.lineTo(p.x, p.y);
      g2.stroke();
    }

    // 方位ラベル。円周に沿って置くと外周で見切れるので、キャンバスの縁に固定で置く。
    // 反時計回りが正であることが一目で分かるように符号付きの角度を出す。
    g2.fillStyle = '#8b8b99';
    g2.font = '10px Consolas, monospace';
    g2.textBaseline = 'middle';
    g2.textAlign = 'center';
    g2.fillText('前 0°', g.cx, Math.max(8, g.cy - g.R - 10));
    g2.fillText('後 180°', g.cx, Math.min(rect.height - 8, g.cy + g.R + 10));
    g2.textAlign = 'left';
    g2.fillText('左 +90°', 4, g.cy);
    g2.textAlign = 'right';
    g2.fillText('右 -90°', rect.width - 4, g.cy);
    g2.textAlign = 'left';
    g2.textBaseline = 'bottom';
    g2.fillStyle = '#5f5f6b';
    g2.fillText('同心円=距離 / +=反時計回り', 4, rect.height - 3);
    g2.textBaseline = 'middle';

    // 中央のリスナー（鼻先を上に出して正面を示す）
    g2.strokeStyle = '#8b8b99';
    g2.beginPath();
    g2.arc(g.cx, g.cy, 5, 0, Math.PI * 2);
    g2.moveTo(g.cx, g.cy - 5);
    g2.lineTo(g.cx, g.cy - 10);
    g2.stroke();

    // 選択中オブジェクトの経路（点より下のレイヤーに描く）
    const sel = DAW.objects.selected();
    if (sel && sel.path && sel.path.enabled && sel.path.points.length) {
      this.drawPath(g2, sel, p => this.posToXY(p.az, p.dist, g));
    }

    // オブジェクト。選択中は最後に重ねて必ず手前に出す
    // （ドラッグ中は毎フレーム走るので、並べ替え用の配列は作らない）。
    for (const obj of DAW.objects.list) {
      if (obj !== sel) this.drawObject(g2, obj, g, false);
    }
    if (sel) this.drawObject(g2, sel, g, true);
  },

  // 表示用の現在位置。経路が有効なら再生ヘッド位置の経路上の点（停止中も追従する）。
  dispPos(obj) {
    return DAW.objects.posAt(obj, DAW.audio.displayPos ? DAW.audio.displayPos() : 0);
  },

  drawObject(g2, obj, g, isSel) {
    const pos = this.dispPos(obj);
    const p = this.posToXY(pos.az, pos.dist, g);
    const r = this.dotRadius(pos.el);
    g2.globalAlpha = this.dotAlpha(obj, pos.el);
    g2.fillStyle = obj.color;
    g2.beginPath();
    g2.arc(p.x, p.y, r, 0, Math.PI * 2);
    g2.fill();
    g2.globalAlpha = 1;
    // 固定中と経路有効中は輪郭を破線にする（どちらも「手では直接動かせない」印）
    if (obj.lock !== 'none' || (obj.path && obj.path.enabled)) {
      g2.strokeStyle = 'rgba(255,255,255,0.55)';
      g2.setLineDash([2, 2]);
      g2.beginPath();
      g2.arc(p.x, p.y, r + 1.5, 0, Math.PI * 2);
      g2.stroke();
      g2.setLineDash([]);
    }
    if (!isSel) return;
    g2.strokeStyle = '#fff';
    g2.lineWidth = 2;
    g2.beginPath();
    g2.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
    g2.stroke();
    g2.fillStyle = '#fff';
    g2.textAlign = 'center';
    g2.textBaseline = 'bottom';
    g2.font = '11px "Segoe UI", sans-serif';
    g2.fillText(obj.name, p.x, p.y - r - 7);
  },

  // ポインタ位置に最も近いオブジェクト（HIT_PX 以内）。描画と同じ表示位置（経路込み）で判定する
  hitTest(clientX, clientY, g) {
    let best = null;
    let bestD = this.HIT_PX;
    for (const obj of DAW.objects.list) {
      const pos = this.dispPos(obj);
      const p = this.posToXY(pos.az, pos.dist, g);
      const d = Math.hypot(clientX - p.x, clientY - p.y);   // topGeom の cx/cy はクライアント座標
      if (d <= bestD) { bestD = d; best = obj; }
    }
    return best;
  },

  onTopDown(e) {
    if (e.button !== 0) return;
    const g = this.topGeom();
    // 経路の編集モード中はすべて経路の操作（追加 / 移動 / 緩急 / 時刻）に振り分ける
    if (this.pathEditActive() && this.onPathDown(e, g, 'top')) return;
    const hit = this.hitTest(e.clientX, e.clientY, g);
    if (hit) DAW.objects.select(hit.id);
    const obj = DAW.objects.selected();
    if (!obj) return;
    // 経路が有効なオブジェクトは位置を経路が決めるので、通常モードでは選択のみ（動かさない）
    if (obj.path && obj.path.enabled) { this.render(); return; }
    // ドラッグ中は history.commit() を呼ばない。pointerup で1回だけ呼んで
    // 「ドラッグ開始〜終了で undo 1エントリ」にする（js/ui.js の startClipDrag と同じ方式）。
    this.drag = { id: obj.id, moved: false };
    if (!hit) this.moveTo(obj.id, e.clientX, e.clientY, g);   // 空きをクリック＝選択中を移動
    try { this.els.top.setPointerCapture(e.pointerId); } catch (err) { /* 合成イベントでは失敗する */ }
    this.render();
  },

  onTopMove(e) {
    if (!this.drag) return;
    this.drag.moved = true;
    this.moveTo(this.drag.id, e.clientX, e.clientY, this.topGeom());
    this.render();
  },

  onTopUp() {
    if (!this.drag) return;
    this.drag = null;
    this.render();
    DAW.history.commit();   // ドラッグ全体で 1 エントリ
  },

  // lock されていれば setPosition が false を返すので、UI 側では何もしない（動かない）
  moveTo(id, clientX, clientY, g) {
    const p = this.xyToPos(clientX, clientY, g);
    return DAW.objects.setPosition(id, p.az, null, p.dist);
  },

  // ---- 経路（位置オートメーション）の編集 ----
  //
  // state は DAW.objects の path 編集 API 一本（ここは座標変換とヒット判定だけ）。
  // undo の粒度は既存の流儀どおり: ドラッグ系は pointerup で commit 1回、
  // クリック追加 / 緩急切替 / 削除 / トグルは直後に 1回。

  togglePathEnabled() {
    const obj = DAW.objects.selected();
    if (!obj) return false;
    if (!DAW.objects.setPathEnabled(obj.id, !(obj.path && obj.path.enabled))) {
      this.render();   // lock 中などで拒否されてもボタンの見た目は揃え直す
      return false;
    }
    this.render();
    DAW.history.commit();
    return true;
  },

  togglePathEdit() {
    this.pathEdit = !this.pathEdit;
    this.render();
    return this.pathEdit;
  },

  // ボタンの状態同期（render から呼ばれる）。選択が消えた/点が減ったときの pathSel もここで直す
  syncPathTools() {
    const e = this.els;
    if (!e.pathEnable) return;
    const obj = DAW.objects.selected();
    const on = !!(obj && obj.path && obj.path.enabled);
    e.pathEnable.disabled = !obj;
    e.pathEnable.classList.toggle('on', on);
    e.pathEditBtn.disabled = !obj;
    e.pathEditBtn.classList.toggle('on', this.pathEdit);
    // undo などで waypoint が減って番号が範囲外になったら選択を外す
    if (this.pathSel != null && (!obj || !obj.path || this.pathSel >= obj.path.points.length)) this.pathSel = null;
  },

  // 経路編集の操作が生きているか（編集トグル ON かつ選択オブジェクトの経路が有効）
  pathEditActive() {
    const obj = DAW.objects.selected();
    return this.pathEdit && !!obj && !!(obj.path && obj.path.enabled);
  },

  // waypoint → 画面座標（view ごとの射影）。g は各ビューの幾何（クライアント/キャンバスどちらでも）
  pathProj(view, g) {
    return view === 'front'
      ? p => this.frontXY(p.az, p.el, p.dist, g)
      : p => this.posToXY(p.az, p.dist, g);
  },

  // ポインタに最も近い waypoint 番号（HIT_PX 以内。無ければ -1）
  pathHit(clientX, clientY, pts, toXY) {
    let best = -1;
    let bestD = this.HIT_PX;
    for (let i = 0; i < pts.length; i++) {
      const q = toXY(pts[i]);
      const d = Math.hypot(clientX - q.x, clientY - q.y);
      if (d <= bestD) { bestD = d; best = i; }
    }
    return best;
  },

  // ポインタ位置のイージンググリフ（セグメント中点）の番号（無ければ -1）
  easeHit(clientX, clientY, pts, toXY) {
    for (let i = 0; i < pts.length - 1; i++) {
      const mid = toXY(DAW.objects.pathSegPos(pts[i], pts[i + 1], 0.5));
      if (Math.hypot(clientX - mid.x, clientY - mid.y) <= this.PATH_EASE_HIT) return i;
    }
    return -1;
  },

  // 選択 waypoint の下に出す時間チップの矩形。描画とヒット判定で同じ式を使う
  chipRect(x, y, t) {
    const text = '@' + t.toFixed(1) + 's';
    const w = 10 + text.length * 5.5;
    return { x: x - w / 2, y: y + 9, w, h: 13, text };
  },

  // pointerdown の振り分け（pathEditActive のときだけ呼ばれる）。常に true を返して
  // 通常のドラッグ処理へは流さない（編集モード中の誤爆防止）。
  onPathDown(e, g, view) {
    const obj = DAW.objects.selected();
    const pts = obj.path.points;
    const toXY = this.pathProj(view, g);
    const canvas = view === 'front' ? this.els.front : this.els.top;
    // 1) 選択 waypoint の時間チップ = 左右ドラッグで時刻調整
    if (this.pathSel != null && pts[this.pathSel]) {
      const wp = toXY(pts[this.pathSel]);
      const r = this.chipRect(wp.x, wp.y, pts[this.pathSel].t);
      if (e.clientX >= r.x && e.clientX <= r.x + r.w && e.clientY >= r.y && e.clientY <= r.y + r.h) {
        this.pdrag = { id: obj.id, view, kind: 'time', index: this.pathSel, x0: e.clientX, t0: pts[this.pathSel].t };
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 合成イベントでは失敗する */ }
        return true;
      }
    }
    // 2) waypoint = 選択してドラッグ移動
    const wi = this.pathHit(e.clientX, e.clientY, pts, toXY);
    if (wi >= 0) {
      this.pathSel = wi;
      this.pdrag = {
        id: obj.id, view, kind: 'move', index: wi, moved: false,
        // 正面ビューは前後（z の符号）が画面から決められないので、掴んだ時点の半球を保持する
        back: view === 'front' ? DAW.objaudio.toCartesian(pts[wi].az, pts[wi].el, 1).z > 0 : false,
      };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 合成イベント */ }
      this.render();
      return true;
    }
    // 3) セグメント中点のグリフ = 緩急の循環
    const si = this.easeHit(e.clientX, e.clientY, pts, toXY);
    if (si >= 0) {
      if (DAW.objects.cyclePathEase(obj.id, si)) {
        this.render();
        DAW.history.commit();
      }
      return true;
    }
    // 4) 空き = waypoint 追加
    this.addWaypointAt(obj, e.clientX, e.clientY, g, view);
    return true;
  },

  // 追加する waypoint の時刻。基本は max(再生ヘッド位置, 最終点 t + 0.1s)。
  // ヘッドが 0 のまま（動かしていない）なら 1s 間隔で末尾へ足していく。
  nextPathTime(obj) {
    const pts = obj.path.points;
    const head = DAW.audio.displayPos ? DAW.audio.displayPos() : 0;
    const lastT = pts.length ? pts[pts.length - 1].t : null;
    if (head > 0) return lastT == null ? head : Math.max(head, lastT + 0.1);
    return lastT == null ? 0 : lastT + 1;
  },

  // 空きクリックでの waypoint 追加。ビューが持たない座標軸は直前の点（無ければ静的位置）から継ぐ
  addWaypointAt(obj, clientX, clientY, g, view) {
    const pts = obj.path.points;
    const prev = pts.length ? pts[pts.length - 1] : null;
    let az, el, dist;
    if (view === 'front') {
      dist = prev ? prev.dist : obj.dist;
      const back = prev
        ? DAW.objaudio.toCartesian(prev.az, prev.el, 1).z > 0
        : DAW.objaudio.toCartesian(obj.az, obj.el, 1).z > 0;
      const d = this.frontToDir(clientX, clientY, g, dist, back);
      az = d.az;
      el = d.el;
    } else {
      const p = this.xyToPos(clientX, clientY, g);
      az = p.az;
      dist = p.dist;
      el = prev ? prev.el : obj.el;
    }
    const pt = DAW.objects.addPathPoint(obj.id, { t: this.nextPathTime(obj), az, el, dist });
    if (!pt) { this.render(); return false; }   // lock 中は追加できない
    this.pathSel = obj.path.points.indexOf(pt);
    this.render();
    DAW.history.commit();
    return true;
  },

  onPathMove(e) {
    const d = this.pdrag;
    if (!d) return;
    d.moved = true;
    const obj = DAW.objects.get(d.id);
    if (!obj || !obj.path || !obj.path.points[d.index]) { this.pdrag = null; return; }
    if (d.kind === 'time') {
      // 8px = 0.1s。前後の点 ±0.05s のクランプはモデル側（setPathPointTime）が守る
      DAW.objects.setPathPointTime(d.id, d.index, d.t0 + (e.clientX - d.x0) / this.CHIP_PX_PER_STEP * 0.1);
    } else if (d.view === 'front') {
      const pt = obj.path.points[d.index];
      const dir = this.frontToDir(e.clientX, e.clientY, this.frontGeom(), pt.dist, d.back);
      DAW.objects.movePathPoint(d.id, d.index, dir.az, dir.el, null);
    } else {
      const p = this.xyToPos(e.clientX, e.clientY, this.topGeom());
      DAW.objects.movePathPoint(d.id, d.index, p.az, null, p.dist);
    }
    this.render();
  },

  onPathUp() {
    if (!this.pdrag) return;
    this.pdrag = null;
    this.render();
    DAW.history.commit();   // ドラッグ全体で 1 エントリ（変化が無ければ何も積まれない）
  },

  // waypoint の右クリック = 削除。編集モード中だけ反応し、当たったときのみメニューを抑止する
  onPathContext(e, view) {
    if (!this.pathEditActive()) return;
    const obj = DAW.objects.selected();
    const g = view === 'front' ? this.frontGeom() : this.topGeom();
    const wi = this.pathHit(e.clientX, e.clientY, obj.path.points, this.pathProj(view, g));
    if (wi < 0) return;
    e.preventDefault();
    if (!DAW.objects.removePathPoint(obj.id, wi)) return;
    if (this.pathSel != null) {
      if (this.pathSel === wi) this.pathSel = null;
      else if (this.pathSel > wi) this.pathSel--;
    }
    this.render();
    DAW.history.commit();
  },

  // 経路の描画（選択中オブジェクトのみ。トップ/正面ビュー共通で toXY だけ差し替える）。
  // ポリラインは 2° 刻み程度でサンプリングし、±180 跨ぎの最短弧が曲線として見えるようにする。
  drawPath(g2, obj, toXY) {
    const O = DAW.objects;
    const pts = obj.path.points;
    g2.save();
    // 半透明ポリライン（オブジェクト色）
    if (pts.length > 1) {
      g2.globalAlpha = 0.45;
      g2.strokeStyle = obj.color;
      g2.lineWidth = 1.5;
      g2.beginPath();
      const q0 = toXY(pts[0]);
      g2.moveTo(q0.x, q0.y);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        // 最短弧の角距離に応じて分割数を決める（約2°刻み。直線的な区間は少なくて済む）
        let arc = ((b.az - a.az) % 360 + 360) % 360;
        if (arc > 180) arc = 360 - arc;
        const steps = Math.max(4, Math.ceil(arc / 2));
        for (let s = 1; s <= steps; s++) {
          const q = toXY(O.pathSegPos(a, b, s / steps));
          g2.lineTo(q.x, q.y);
        }
      }
      g2.stroke();
      g2.globalAlpha = 1;
    }
    // セグメント中点の緩急グリフ（= / ↗ / ↘ / ~）
    g2.font = '10px Consolas, monospace';
    g2.textAlign = 'center';
    g2.textBaseline = 'middle';
    for (let i = 0; i < pts.length - 1; i++) {
      const mid = toXY(O.pathSegPos(pts[i], pts[i + 1], 0.5));
      g2.fillStyle = 'rgba(255,255,255,0.85)';
      g2.fillText(this.EASE_GLYPHS[pts[i].ease] || '=', mid.x, mid.y);
    }
    // waypoint（菱形 + 番号）。選択中は白の輪郭で強調
    for (let i = 0; i < pts.length; i++) {
      const q = toXY(pts[i]);
      const r = 5;
      g2.fillStyle = obj.color;
      g2.strokeStyle = i === this.pathSel ? '#fff' : 'rgba(255,255,255,0.5)';
      g2.lineWidth = i === this.pathSel ? 2 : 1;
      g2.beginPath();
      g2.moveTo(q.x, q.y - r);
      g2.lineTo(q.x + r, q.y);
      g2.lineTo(q.x, q.y + r);
      g2.lineTo(q.x - r, q.y);
      g2.closePath();
      g2.fill();
      g2.stroke();
      g2.fillStyle = '#cfcfda';
      g2.font = '9px Consolas, monospace';
      g2.textAlign = 'left';
      g2.textBaseline = 'bottom';
      g2.fillText(String(i + 1), q.x + r + 2, q.y - 2);
    }
    // 始点マーカー ▶（進行方向が分かるように最初の点の左に置く）
    if (pts.length) {
      const q = toXY(pts[0]);
      g2.fillStyle = 'rgba(255,255,255,0.85)';
      g2.beginPath();
      g2.moveTo(q.x - 13, q.y - 4);
      g2.lineTo(q.x - 7, q.y);
      g2.lineTo(q.x - 13, q.y + 4);
      g2.closePath();
      g2.fill();
    }
    // 選択 waypoint の時間チップ「@2.0s」（左右ドラッグで時刻調整）
    if (this.pathSel != null && pts[this.pathSel]) {
      const q = toXY(pts[this.pathSel]);
      const r = this.chipRect(q.x, q.y, pts[this.pathSel].t);
      g2.fillStyle = 'rgba(10,10,14,0.75)';
      g2.strokeStyle = 'rgba(255,255,255,0.4)';
      g2.lineWidth = 1;
      g2.beginPath();
      g2.rect(r.x, r.y, r.w, r.h);
      g2.fill();
      g2.stroke();
      g2.fillStyle = '#dfe7ff';
      g2.font = '9px Consolas, monospace';
      g2.textAlign = 'center';
      g2.textBaseline = 'middle';
      g2.fillText(r.text, r.x + r.w / 2, r.y + r.h / 2 + 0.5);
    }
    g2.restore();
  },

  // ---- 正面ビュー（FRONT VIEW）----
  //
  // リスナーを背後から見る（3D球ビューと同じ向き。+az＝左が画面の左に出る）。
  // 横軸=左右（直交座標の x）、縦軸=高さ（y）。前後（z）は画面に出ない正射影で、
  // トップビューが点の大きさでしか示せない「高さ」をまっすぐ縦軸で編集する。
  // 距離はトップビューの担当なのでここでは変えない（3D球ビューと同じ分担）。

  // 極座標 → 画面。変換は DAW.objaudio.toCartesian に一本化する（式をここに複製すると
  // 片方だけ直したときに鏡像になる。トップビュー・3D球ビューで踏んだ轍）。
  // back は「リスナーの後方（z>0）か」。正射影では前後が画面に出ないので描き分けに使う。
  frontXY(az, el, dist, g) {
    const c = DAW.objaudio.toCartesian(az, el, dist);
    return { x: g.cx + g.R * c.x, y: g.cy - g.R * c.y, back: c.z > 0 };   // 画面 y は下向きなので反転
  },

  // 画面 → az/el（frontXY の逆）。dist は変えないので、その dist の円上へ戻す。
  // 前後（z の符号）は画面から決められないため、掴んだ時点の半球（back）を呼び出し側が
  // 保持して渡す（3D球ビューの sdrag.near と同じ理屈。無いとドラッグ中に前後が跳ねる）。
  // 円の外は方向を正規化して縁に貼り付ける。dist=0 付近は向きが定まらないので下限を敷く。
  frontToDir(clientX, clientY, g, dist, back) {
    const r = g.R * Math.max(0.05, dist);
    let x = (clientX - g.cx) / r;
    let y = -(clientY - g.cy) / r;
    const n = Math.hypot(x, y);
    if (n > 1) { x /= n; y /= n; }
    const z = (back ? 1 : -1) * Math.sqrt(Math.max(0, 1 - x * x - y * y));
    return this.fromCartesian(x, y, z);
  },

  // 幾何。cx/cy はクライアント座標（ポインタ座標と直接比べられる）。
  frontGeom() {
    const rect = this.els.front.getBoundingClientRect();
    return {
      rect,
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      R: Math.max(8, Math.min(rect.width, rect.height) / 2 - this.FRONT_PAD),
    };
  },

  drawFront() {
    const c = this.els.front;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return;   // 非表示中（RENDERER など）は描かない
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g2 = c.getContext('2d');
    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    g2.clearRect(0, 0, rect.width, rect.height);

    const g = { cx: rect.width / 2, cy: rect.height / 2, R: Math.max(8, Math.min(rect.width, rect.height) / 2 - this.FRONT_PAD) };

    // 背景の円（dist=1 の輪郭。オブジェクトは dist ぶん内側に入る）
    g2.fillStyle = '#101014';
    g2.beginPath();
    g2.arc(g.cx, g.cy, g.R, 0, Math.PI * 2);
    g2.fill();
    g2.strokeStyle = 'rgba(255,255,255,0.28)';
    g2.lineWidth = 1;
    g2.beginPath();
    g2.arc(g.cx, g.cy, g.R, 0, Math.PI * 2);
    g2.stroke();

    // 水平線 = 仰角（±30°/±60°。dist=1 での高さ）。el=0（耳の高さ）だけ基準線として強調
    for (const el of [-60, -30, 0, 30, 60]) {
      const y = g.cy - g.R * Math.sin(Math.PI / 180 * el);
      const half = g.R * Math.cos(Math.PI / 180 * el);
      g2.strokeStyle = el === 0 ? 'rgba(120,170,255,0.30)' : 'rgba(255,255,255,0.10)';
      g2.beginPath();
      g2.moveTo(g.cx - half, y);
      g2.lineTo(g.cx + half, y);
      g2.stroke();
    }
    // 縦の中心線（真正面/真後ろの面）
    g2.strokeStyle = 'rgba(255,255,255,0.10)';
    g2.beginPath();
    g2.moveTo(g.cx, g.cy - g.R);
    g2.lineTo(g.cx, g.cy + g.R);
    g2.stroke();

    // ラベル。トップビューと同じくキャンバスの縁に固定で置く（外周に置くと見切れる）
    g2.fillStyle = '#8b8b99';
    g2.font = '10px Consolas, monospace';
    g2.textBaseline = 'middle';
    g2.textAlign = 'center';
    g2.fillText('上 +90°', g.cx, Math.max(8, g.cy - g.R - 10));
    g2.fillText('下 -90°', g.cx, Math.min(rect.height - 8, g.cy + g.R + 10));
    g2.textAlign = 'left';
    g2.fillText('左 +90°', 4, g.cy);
    g2.textAlign = 'right';
    g2.fillText('右 -90°', rect.width - 4, g.cy);
    g2.textAlign = 'left';
    g2.textBaseline = 'bottom';
    g2.fillStyle = '#5f5f6b';
    g2.fillText('横=左右 / 縦=高さ（距離はトップビュー）', 4, rect.height - 3);
    g2.textBaseline = 'middle';

    // 中央のリスナー（背後から見た後頭部。正面を向いているので鼻先は描かない）
    g2.strokeStyle = '#8b8b99';
    g2.beginPath();
    g2.arc(g.cx, g.cy, 5, 0, Math.PI * 2);
    g2.stroke();

    // 選択中オブジェクトの経路（点より下のレイヤーに描く。トップビューと同じ流儀）
    const sel = DAW.objects.selected();
    if (sel && sel.path && sel.path.enabled && sel.path.points.length) {
      this.drawPath(g2, sel, p => this.frontXY(p.az, p.el, p.dist, g));
    }

    // オブジェクト。後方（z>0）を先に描き、前方が上書きする＝実際の見え方と一致する。
    // 選択中は最後に重ねて必ず手前に出す（トップビューと同じ流儀）。
    for (const pass of [true, false]) {
      for (const obj of DAW.objects.list) {
        if (obj === sel) continue;
        const pos = this.dispPos(obj);
        const p = this.frontXY(pos.az, pos.el, pos.dist, g);
        if (p.back === pass) this.drawFrontObject(g2, obj, p, false);
      }
    }
    if (sel) {
      const pos = this.dispPos(sel);
      this.drawFrontObject(g2, sel, this.frontXY(pos.az, pos.el, pos.dist, g), true);
    }
  },

  drawFrontObject(g2, obj, p, isSel) {
    const r = p.back ? 4.5 : 6;   // 後方は少し小さく描いて前後を区別する
    const on = DAW.objects.effectiveGain(obj) > 0;   // ミュート/他がソロ中は薄く
    g2.globalAlpha = (on ? 1 : 0.3) * (p.back ? 0.55 : 1);
    g2.fillStyle = obj.color;
    g2.beginPath();
    g2.arc(p.x, p.y, r, 0, Math.PI * 2);
    g2.fill();
    g2.globalAlpha = 1;
    // 固定中と経路有効中は輪郭を破線にする（他ビューと同じ）
    if (obj.lock !== 'none' || (obj.path && obj.path.enabled)) {
      g2.strokeStyle = 'rgba(255,255,255,0.55)';
      g2.setLineDash([2, 2]);
      g2.beginPath();
      g2.arc(p.x, p.y, r + 1.5, 0, Math.PI * 2);
      g2.stroke();
      g2.setLineDash([]);
    }
    if (!isSel) return;
    g2.strokeStyle = '#fff';
    g2.lineWidth = 2;
    g2.beginPath();
    g2.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
    g2.stroke();
    g2.lineWidth = 1;
    g2.fillStyle = '#fff';
    g2.textAlign = 'center';
    g2.textBaseline = 'bottom';
    g2.font = '11px "Segoe UI", sans-serif';
    g2.fillText(obj.name, p.x, p.y - r - 7);
  },

  // ポインタ位置に最も近いオブジェクト（FRONT_HIT_PX 以内）。表示位置（経路込み）で判定する
  frontHit(clientX, clientY, g) {
    let best = null;
    let bestD = this.FRONT_HIT_PX;
    for (const obj of DAW.objects.list) {
      const pos = this.dispPos(obj);
      const p = this.frontXY(pos.az, pos.el, pos.dist, g);
      const d = Math.hypot(clientX - p.x, clientY - p.y);   // frontGeom の cx/cy はクライアント座標
      if (d <= bestD) { bestD = d; best = obj; }
    }
    return best;
  },

  onFrontDown(e) {
    if (e.button !== 0) return;
    const g = this.frontGeom();
    // 経路の編集モード中はすべて経路の操作へ（トップビューと同じ振り分け）
    if (this.pathEditActive() && this.onPathDown(e, g, 'front')) return;
    const hit = this.frontHit(e.clientX, e.clientY, g);
    if (hit) DAW.objects.select(hit.id);
    const obj = DAW.objects.selected();
    if (!obj) return;
    // 経路が有効なオブジェクトは通常モードでは選択のみ（位置は経路が決める）
    if (obj.path && obj.path.enabled) { this.render(); return; }
    // 掴んだ時点の半球（前/後）を覚える。移動前の位置から決めること
    // （frontMoveTo がこれを参照するので、fdrag を作ってから動かす）。
    this.fdrag = { id: obj.id, back: DAW.objaudio.toCartesian(obj.az, obj.el, 1).z > 0, moved: false };
    if (!hit) this.frontMoveTo(obj.id, e.clientX, e.clientY, g);   // 空きをクリック＝選択中を移動
    try { this.els.front.setPointerCapture(e.pointerId); } catch (err) { /* 合成イベントでは失敗する */ }
    this.render();
  },

  onFrontMove(e) {
    if (!this.fdrag) return;
    this.fdrag.moved = true;
    this.frontMoveTo(this.fdrag.id, e.clientX, e.clientY, this.frontGeom());
    this.render();
  },

  onFrontUp() {
    if (!this.fdrag) return;
    this.fdrag = null;
    this.render();
    DAW.history.commit();   // ドラッグ全体で 1 エントリ（トップビューと同じ方式）
  },

  // 距離は変えない（トップビュー側の担当）。lock されていれば setPosition が false を返す。
  frontMoveTo(id, clientX, clientY, g) {
    const obj = DAW.objects.get(id);
    if (!obj) return false;
    const back = this.fdrag ? this.fdrag.back : DAW.objaudio.toCartesian(obj.az, obj.el, 1).z > 0;
    const d = this.frontToDir(clientX, clientY, g, obj.dist, back);
    return DAW.objects.setPosition(id, d.az, d.el, null);
  },

  // ---- 3D球ビュー（自前の透視投影。ライブラリは使わない）----
  //
  // カメラはリスナーの真後ろやや上（world (0, D·sinφ, D·cosφ)）から原点を見る。
  // front が -z なので「+z 側 = 背後」であり、リスナーと同じ向きを見る配置になる。
  // その結果:
  //   az=0（正面）  … 画面中央のやや上、カメラから最も遠い
  //   az=180（背後）… 画面中央のやや下、カメラに最も近い
  //   az=+90（左）  … 画面の左、el=+90（上）… 画面の上
  // 「遠いものから先に描く」ためだけに深度が要るのではなく、
  // この配置だと背後のオブジェクトが手前に来る＝実際の見え方と一致する。
  sphereCam() {
    const p = Math.PI / 180 * this.SPH_CAM_EL;
    const D = this.SPH_CAM_D;
    const s = Math.sin(p);
    const c = Math.cos(p);
    return {
      D,
      pos: { x: 0, y: D * s, z: D * c },
      fwd: { x: 0, y: -s, z: -c },     // カメラの視線（原点向き）
      right: { x: 1, y: 0, z: 0 },     // 画面右 = world +x
      up: { x: 0, y: c, z: -s },
    };
  },

  // 幾何。cx/cy はクライアント座標（ポインタ座標と直接比べられる）。
  sphereGeom() {
    const rect = this.els.sphere.getBoundingClientRect();
    return {
      rect,
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      R: Math.max(8, Math.min(rect.width, rect.height) / 2 - this.SPH_PAD),
      cam: this.sphereCam(),
    };
  },

  // 直交座標 → 画面。depth はカメラからの奥行き（大きいほど遠い）。
  project(p, g) {
    const cam = g.cam;
    const dx = p.x - cam.pos.x;
    const dy = p.y - cam.pos.y;
    const dz = p.z - cam.pos.z;
    const depth = dx * cam.fwd.x + dy * cam.fwd.y + dz * cam.fwd.z;
    const X = dx * cam.right.x + dy * cam.right.y + dz * cam.right.z;
    const Y = dx * cam.up.x + dy * cam.up.y + dz * cam.up.z;
    const k = g.R * this.SPH_FOV * cam.D / Math.max(0.05, depth);
    return { x: g.cx + k * X, y: g.cy - k * Y, depth, k };   // 画面 y は下向きなので Y は反転
  },

  // 極座標 → 画面。変換規約は DAW.objaudio.toCartesian に一本化してある。
  projectDir(az, el, g, r) {
    return this.project(DAW.objaudio.toCartesian(az, el, r == null ? 1 : r), g);
  },

  // 直交座標 → 極座標（toCartesian の逆）。半径は無視して方向だけ返す。
  fromCartesian(x, y, z) {
    const n = Math.hypot(x, y, z) || 1;
    const yy = Math.max(-1, Math.min(1, y / n));
    return {
      az: Math.atan2(-x / n, -z / n) * 180 / Math.PI,
      el: Math.asin(yy) * 180 / Math.PI,
    };
  },

  // 画面 → 単位球上の方向。near=true なら「カメラ側の半球」の交点を採る。
  // ドラッグ中に半球を跨がせないため、掴んだ時点の側を呼び出し側が保持して渡す。
  // 球を外したときは最接近点を球面へ寄せる（＝輪郭に貼り付く）。
  unproject(clientX, clientY, g, near) {
    const cam = g.cam;
    const f = g.R * this.SPH_FOV * cam.D;
    const a = (clientX - g.cx) / f;
    const b = -(clientY - g.cy) / f;
    const dir = {
      x: cam.right.x * a + cam.up.x * b + cam.fwd.x,
      y: cam.right.y * a + cam.up.y * b + cam.fwd.y,
      z: cam.right.z * a + cam.up.z * b + cam.fwd.z,
    };
    const C = cam.pos;
    const dd = dir.x * dir.x + dir.y * dir.y + dir.z * dir.z;
    const cd = C.x * dir.x + C.y * dir.y + C.z * dir.z;
    const cc = C.x * C.x + C.y * C.y + C.z * C.z - 1;
    const disc = cd * cd - dd * cc;
    let t;
    if (disc <= 0) {
      t = -cd / dd;                                   // 最接近点（正規化して輪郭へ）
    } else {
      const s = Math.sqrt(disc);
      t = (near ? -cd - s : -cd + s) / dd;
    }
    return this.fromCartesian(C.x + t * dir.x, C.y + t * dir.y, C.z + t * dir.z);
  },

  // 描画順（遠い順）。ドラッグ中に毎フレーム走るので配列は1本だけ作る。
  // 位置は表示位置（経路込み）で決める（トップ/正面ビューと同じ）。
  sphereOrder(g) {
    const out = [];
    for (const obj of DAW.objects.list) {
      const pos = this.dispPos(obj);
      out.push({ obj, pos, p: this.projectDir(pos.az, pos.el, g) });
    }
    out.sort((a, b) => b.p.depth - a.p.depth);   // depth が大きい = 遠い を先頭に
    return out;
  },

  // 球の輪郭半径(px)。透視投影なので大円の投影より少し大きい（接点までの距離で決まる）。
  sphereRimR(g) {
    const D = g.cam.D;
    return g.R * this.SPH_FOV * D / Math.sqrt(D * D - 1);
  },

  drawSphere() {
    const c = this.els.sphere;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g2 = c.getContext('2d');
    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    g2.clearRect(0, 0, rect.width, rect.height);

    // 描画用の幾何（cx/cy はキャンバス内座標。sphereGeom はクライアント座標）
    const g = {
      cx: rect.width / 2,
      cy: rect.height / 2,
      R: Math.max(8, Math.min(rect.width, rect.height) / 2 - this.SPH_PAD),
      cam: this.sphereCam(),
    };

    // 球体（塗り）。奥のワイヤーはこの上に薄く描くので中が透けて見える
    const rim = this.sphereRimR(g);
    const grad = g2.createRadialGradient(g.cx - rim * 0.3, g.cy - rim * 0.4, rim * 0.1, g.cx, g.cy, rim);
    grad.addColorStop(0, '#191922');
    grad.addColorStop(1, '#0d0d11');
    g2.fillStyle = grad;
    g2.beginPath();
    g2.arc(g.cx, g.cy, rim, 0, Math.PI * 2);
    g2.fill();

    this.drawSphereWire(g2, g);
    this.drawSphereMarks(g2, g);
    if (this.view === 'renderer') this.drawSpeakers(g2, g);

    // オブジェクトは遠い順に描く（奥のものが手前を上書きしない）
    const order = this.sphereOrder(g);
    for (const it of order) this.drawSphereObject(g2, it.obj, it.p, g, it.obj.id === DAW.objects.selectedId, it.pos);
    // ラベルだけは最後に重ねる（点の重なりで名前が読めなくならないように）
    const sel = order.find(it => it.obj.id === DAW.objects.selectedId);
    if (sel) {
      g2.fillStyle = '#fff';
      g2.textAlign = 'center';
      g2.textBaseline = 'bottom';
      g2.font = '11px "Segoe UI", sans-serif';
      g2.fillText(sel.obj.name, sel.p.x, sel.p.y - 10);
    }
  },

  // 水平円（仰角一定）と子午線（方位一定）。
  // 手前側と奥側で濃さを変えるのが立体感の肝。線ごとに stroke すると本数ぶん
  // 呼び出しが増えるので、手前/奥の2本のパスにまとめて2回だけ stroke する。
  drawSphereWire(g2, g) {
    const near = [];
    const far = [];
    const seg = (p0, p1) => {
      ((p0.depth + p1.depth) / 2 <= g.cam.D ? near : far).push(p0, p1);
    };
    const STEP = 15;
    for (const el of [-60, -30, 0, 30, 60]) {
      let prev = this.projectDir(-180, el, g);
      for (let az = -180 + STEP; az <= 180; az += STEP) {
        const p = this.projectDir(az, el, g);
        seg(prev, p);
        prev = p;
      }
    }
    for (const az of [0, 45, 90, 135, 180, -45, -90, -135]) {
      let prev = this.projectDir(az, -90, g);
      for (let el = -90 + STEP; el <= 90; el += STEP) {
        const p = this.projectDir(az, el, g);
        seg(prev, p);
        prev = p;
      }
    }
    const paint = (pts, style) => {
      if (!pts.length) return;
      g2.strokeStyle = style;
      g2.lineWidth = 1;
      g2.beginPath();
      for (let i = 0; i < pts.length; i += 2) {
        g2.moveTo(pts[i].x, pts[i].y);
        g2.lineTo(pts[i + 1].x, pts[i + 1].y);
      }
      g2.stroke();
    };
    paint(far, 'rgba(255,255,255,0.06)');
    paint(near, 'rgba(255,255,255,0.17)');

    // 赤道だけは方位の基準線なので少し強く出す（手前側のみ）
    g2.strokeStyle = 'rgba(120,170,255,0.30)';
    g2.beginPath();
    let started = false;
    for (let az = -180; az <= 180; az += 5) {
      const p = this.projectDir(az, 0, g);
      if (p.depth > g.cam.D) { started = false; continue; }
      if (!started) { g2.moveTo(p.x, p.y); started = true; } else g2.lineTo(p.x, p.y);
    }
    g2.stroke();
    g2.strokeStyle = 'rgba(255,255,255,0.22)';
    g2.beginPath();
    g2.arc(g.cx, g.cy, this.sphereRimR(g), 0, Math.PI * 2);
    g2.stroke();
  },

  // 正面/背面/左右が一目で分かる目印。前は「▲ 前 0°」、後ろは「後 180°」。
  drawSphereMarks(g2, g) {
    const front = this.projectDir(0, 0, g);
    const back = this.projectDir(180, 0, g);
    const left = this.projectDir(90, 0, g);
    const right = this.projectDir(-90, 0, g);
    const top = this.projectDir(0, 90, g);

    // 正面マーカー（塗りの三角）。背面は輪郭だけにして前後を区別する
    g2.fillStyle = 'rgba(120,170,255,0.95)';
    g2.beginPath();
    g2.moveTo(front.x, front.y - 6);
    g2.lineTo(front.x - 5, front.y + 4);
    g2.lineTo(front.x + 5, front.y + 4);
    g2.closePath();
    g2.fill();
    g2.strokeStyle = 'rgba(255,255,255,0.35)';
    g2.beginPath();
    g2.arc(back.x, back.y, 4.5, 0, Math.PI * 2);
    g2.stroke();

    g2.font = '10px Consolas, monospace';
    g2.fillStyle = '#8b8b99';
    g2.textAlign = 'center';
    g2.textBaseline = 'bottom';
    g2.fillText('前 0°', front.x, front.y - 8);
    g2.textBaseline = 'top';
    g2.fillText('後 180°', back.x, back.y + 7);
    // 左右は輪郭の「内側」へ置く。外側に出すと 260px 幅のペインでは必ず見切れる。
    g2.textBaseline = 'middle';
    g2.textAlign = 'left';
    g2.fillText('左 +90°', left.x + 6, left.y);
    g2.textAlign = 'right';
    g2.fillText('右 -90°', right.x - 6, right.y);
    g2.textAlign = 'center';
    g2.textBaseline = 'bottom';
    g2.fillText('上 +90°', top.x, top.y - 4);
    g2.textAlign = 'left';
    g2.textBaseline = 'bottom';
    g2.fillStyle = '#5f5f6b';
    g2.fillText(this.view === 'renderer' ? `番号=${this.layoutName} のスピーカー` : 'ドラッグで方位/仰角', 4, g.cy + g.R + this.SPH_PAD - 2);
  },

  // RENDERER のときだけスピーカー番号を球面へ重畳する（配置は speakers()）。
  drawSpeakers(g2, g) {
    const list = this.speakers();
    const items = list.map((s, i) => ({ s, i, p: this.projectDir(s.az, s.el, g) }));
    items.sort((a, b) => b.p.depth - a.p.depth);   // ここも遠い順
    for (const it of items) {
      const behind = it.p.depth > g.cam.D;
      g2.globalAlpha = behind ? 0.45 : 1;
      g2.fillStyle = it.s.lfe ? '#6b5a1e' : '#2b3b58';
      g2.strokeStyle = it.s.lfe ? '#d0b14a' : '#7fb0ff';
      g2.lineWidth = 1;
      const r = 8;
      g2.beginPath();
      g2.rect(it.p.x - r, it.p.y - r, r * 2, r * 2);
      g2.fill();
      g2.stroke();
      g2.fillStyle = '#dfe7ff';
      g2.font = '9px Consolas, monospace';
      g2.textAlign = 'center';
      g2.textBaseline = 'middle';
      g2.fillText(String(it.i + 1), it.p.x, it.p.y + 0.5);
      g2.fillStyle = '#9aa8c0';
      g2.textBaseline = 'top';
      g2.fillText(it.s.name, it.p.x, it.p.y + r + 1);
      g2.globalAlpha = 1;
    }
    g2.textBaseline = 'middle';
  },

  // 1個ぶんの点。近いほど大きく描く（透視の k をそのまま使う）。
  // pos は表示位置（経路込み。省略時は静的位置）。
  drawSphereObject(g2, obj, p, g, isSel, pos) {
    const behind = p.depth > g.cam.D;
    const r = Math.max(3, 6 * (g.cam.D / Math.max(0.2, p.depth)));
    g2.globalAlpha = this.dotAlpha(obj, pos ? pos.el : null) * (behind ? 0.65 : 1);
    g2.fillStyle = obj.color;
    g2.beginPath();
    g2.arc(p.x, p.y, r, 0, Math.PI * 2);
    g2.fill();
    g2.globalAlpha = 1;
    if (obj.lock !== 'none' || (obj.path && obj.path.enabled)) {
      g2.strokeStyle = 'rgba(255,255,255,0.55)';
      g2.setLineDash([2, 2]);
      g2.beginPath();
      g2.arc(p.x, p.y, r + 1.5, 0, Math.PI * 2);
      g2.stroke();
      g2.setLineDash([]);
    }
    if (!isSel) return;
    g2.strokeStyle = '#fff';
    g2.lineWidth = 2;
    g2.beginPath();
    g2.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
    g2.stroke();
    g2.lineWidth = 1;
  },

  // 画面上で最も近いオブジェクト（SPH_HIT_PX 以内）。重なりは「手前」を優先する。
  sphereHit(clientX, clientY, g) {
    let best = null;
    let bestD = this.SPH_HIT_PX;
    let bestDepth = Infinity;
    for (const obj of DAW.objects.list) {
      const pos = this.dispPos(obj);
      const p = this.projectDir(pos.az, pos.el, g);
      const d = Math.hypot(clientX - p.x, clientY - p.y);
      if (d > this.SPH_HIT_PX) continue;
      if (d < bestD - 2 || (d < bestD + 2 && p.depth < bestDepth)) {
        bestD = Math.min(bestD, d);
        bestDepth = p.depth;
        best = obj;
      }
    }
    return best;
  },

  onSphereDown(e) {
    if (e.button !== 0) return;
    const g = this.sphereGeom();
    const hit = this.sphereHit(e.clientX, e.clientY, g);
    if (hit) DAW.objects.select(hit.id);
    const obj = DAW.objects.selected();
    if (!obj) return;
    // 経路が有効なオブジェクトは通常モードでは選択のみ（位置は経路が決める）
    if (obj.path && obj.path.enabled) { this.render(); return; }
    // 掴んだ時点の半球を覚える。これが無いとドラッグ中に前後が跳ねる。
    const p = this.projectDir(obj.az, obj.el, g);
    this.sdrag = { id: obj.id, near: p.depth <= g.cam.D, moved: false };
    if (!hit) this.sphereMoveTo(obj.id, e.clientX, e.clientY, g);   // 空きをドラッグ＝選択中を動かす
    try { this.els.sphere.setPointerCapture(e.pointerId); } catch (err) { /* 合成イベントでは失敗する */ }
    this.render();
  },

  onSphereMove(e) {
    if (!this.sdrag) return;
    this.sdrag.moved = true;
    this.sphereMoveTo(this.sdrag.id, e.clientX, e.clientY, this.sphereGeom());
    this.render();
  },

  onSphereUp() {
    if (!this.sdrag) return;
    this.sdrag = null;
    this.render();
    DAW.history.commit();   // ドラッグ全体で 1 エントリ（トップビューと同じ方式）
  },

  // 距離は変えない（トップビュー側の担当）。lock されていれば setPosition が false を返す。
  sphereMoveTo(id, clientX, clientY, g) {
    const near = this.sdrag ? this.sdrag.near : true;
    const d = this.unproject(clientX, clientY, g, near);
    return DAW.objects.setPosition(id, d.az, d.el, null);
  },

  // ---- オブジェクトストリップ（可視ぶんだけ生成）----

  // いま作るべきストリップの範囲 [first, last]（該当なしなら last < first）
  visibleRange() {
    const n = DAW.objects.count();
    const sc = this.els.stripScroll;
    const viewW = sc.clientWidth;
    if (!n || viewW <= 0) return { first: 0, last: -1 };
    const first = Math.max(0, Math.floor(sc.scrollLeft / this.STRIP_W) - this.OVERSCAN);
    const last = Math.min(n - 1, Math.ceil((sc.scrollLeft + viewW) / this.STRIP_W) - 1 + this.OVERSCAN);
    return { first, last };
  },

  renderStrips() {
    const list = DAW.objects.list;
    this.els.strips.style.width = (list.length * this.STRIP_W) + 'px';
    const { first, last } = this.visibleRange();

    const keep = new Set();
    for (let i = first; i <= last; i++) {
      const obj = list[i];
      keep.add(obj.id);
      let el = this.strips.get(obj.id);
      if (!el) {
        el = this.buildStrip(obj);
        this.strips.set(obj.id, el);
        this.els.strips.appendChild(el);
      }
      el.style.left = (i * this.STRIP_W) + 'px';
      this.syncStrip(el, obj);
    }
    // 範囲外になったものは DOM から外す（128本ぶんを常に置かないための肝）
    for (const [id, el] of this.strips) {
      if (keep.has(id)) continue;
      el.remove();
      this.strips.delete(id);
    }
  },

  buildStrip(obj) {
    const id = obj.id;                 // undo で実体が作り直されるので id を捕まえる
    const el = document.createElement('div');
    el.className = 'obj-strip';
    el.dataset.objId = id;
    el.addEventListener('pointerdown', () => {
      if (DAW.objects.selectedId === id) return;
      DAW.objects.select(id);
      this.render();
    });

    // 名前 + 識別色
    const head = document.createElement('div');
    head.className = 'os-head';
    const dot = document.createElement('i');
    dot.className = 'os-dot';
    const name = document.createElement('input');
    name.className = 'os-name';
    name.addEventListener('input', () => DAW.objects.set(id, 'name', name.value));
    name.addEventListener('change', () => { this.render(); DAW.history.commit(); });
    head.append(dot, name);

    // 音源トラックのセレクタ。選択肢は「(未割り当て)」+ 全トラック。
    // options はトラック構成が変わったときだけ syncStrip が作り直す（_sig で判定）。
    const track = document.createElement('select');
    track.className = 'os-track';
    track.title = '音源トラック（他のオブジェクトが使用中のトラックを選ぶと、そちらは未割り当てに戻る）';
    track.addEventListener('pointerdown', e => e.stopPropagation());
    track.addEventListener('change', () => this.setTrack(id, track.value || null));

    // Az / El / Width の数値ボックス（双方向バインド）
    const nums = document.createElement('div');
    nums.className = 'os-nums';
    nums.append(
      this.buildNumBox(id, 'az', 'Az', 1),
      this.buildNumBox(id, 'el', 'El', 1),
      this.buildNumBox(id, 'width', 'Wd', 5),
    );

    // Rev センド（ルームリバーブへ送る量）。共通ノブに乗せる。
    // undo は commit 1回（ドラッグ全体 / ホイール1操作で1エントリ。revSend は履歴の
    // スナップショット（objects.toJSON）に入っているので commit だけでよい）。
    const rev = document.createElement('div');
    rev.className = 'os-rev';
    const revLab = document.createElement('span');
    revLab.textContent = 'Rev';
    const revKnob = DAW.knob.create({
      label: 'Rev センド',
      size: 22,
      range: { min: DAW.objects.LIMITS.revSend[0], max: DAW.objects.LIMITS.revSend[1], step: 0.01 },
      def: 0.25,
      get: () => { const o = DAW.objects.get(id); return o ? o.revSend : 0.25; },
      set: v => DAW.objects.set(id, 'revSend', v),   // lock='all' はモデル側が拒否する
      commit: () => { this.render(); DAW.history.commit(); },
      format: v => Math.round(v * 100) + '%',
      active: () => DAW.objects.canEditParams(DAW.objects.get(id)),
    });
    rev.title = 'ルームリバーブへのセンド量。実効量は距離と連動する（遠いほど湿る）';
    rev.append(revLab, revKnob);

    // Lock（none → pos → all → none）
    const lock = document.createElement('button');
    lock.className = 'os-lock';
    lock.addEventListener('click', e => {
      e.stopPropagation();
      const cur = (DAW.objects.get(id) || {}).lock || 'none';
      const next = cur === 'none' ? 'pos' : cur === 'pos' ? 'all' : 'none';
      DAW.objects.set(id, 'lock', next);
      this.render();
      DAW.history.commit();
    });

    // ピーク dB（後日メーターと接続する。今は値が 0 = -∞ のまま）
    const peak = document.createElement('div');
    peak.className = 'os-peak';

    // 縦フェーダー + 数値
    const fader = document.createElement('input');
    fader.className = 'os-fader';
    fader.type = 'range';
    fader.min = DAW.objects.LIMITS.gainDb[0];
    fader.max = DAW.objects.LIMITS.gainDb[1];
    fader.step = 0.1;
    fader.addEventListener('input', () => {
      DAW.objects.set(id, 'gainDb', +fader.value);
      this.render();
    });
    fader.addEventListener('change', () => { this.render(); DAW.history.commit(); });
    const gain = document.createElement('div');
    gain.className = 'os-gain';

    // M / S
    const ms = document.createElement('div');
    ms.className = 'os-ms';
    const mute = document.createElement('button');
    mute.className = 'os-mute';
    mute.textContent = 'M';
    mute.title = 'ミュート';
    mute.addEventListener('click', e => {
      e.stopPropagation();
      const o = DAW.objects.get(id);
      if (!o || !DAW.objects.set(id, 'mute', !o.mute)) return;
      this.render();     // ソロ状態次第で他のストリップの見た目も変わる
      DAW.history.commit();
    });
    const solo = document.createElement('button');
    solo.className = 'os-solo';
    solo.textContent = 'S';
    solo.title = 'ソロ';
    solo.addEventListener('click', e => {
      e.stopPropagation();
      const o = DAW.objects.get(id);
      if (!o || !DAW.objects.set(id, 'solo', !o.solo)) return;
      this.render();
      DAW.history.commit();
    });
    ms.append(mute, solo);

    el.append(head, track, nums, rev, lock, peak, fader, gain, ms);
    // 子要素の参照を控えておく（syncStrip はドラッグ中に毎フレーム走るので、
    // そのたびに querySelector を10回叩かない。js/ui.js の el._clip と同じ発想）。
    el._r = {
      dot, name, track, lock, peak, fader, gain, mute, solo, revKnob,
      az: nums.querySelector('.os-in-az'),
      el: nums.querySelector('.os-in-el'),
      width: nums.querySelector('.os-in-width'),
    };
    return el;
  },

  buildNumBox(id, key, label, step) {
    const wrap = document.createElement('label');
    wrap.className = 'os-num';
    const span = document.createElement('span');
    span.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.className = 'os-in-' + key;
    inp.min = DAW.objects.LIMITS[key][0];
    inp.max = DAW.objects.LIMITS[key][1];
    inp.step = step;
    inp.addEventListener('pointerdown', e => e.stopPropagation());
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      if (!isFinite(v)) return;              // "-" だけ打った途中経過は無視する
      DAW.objects.set(id, key, v);
      this.render();                          // 数値ボックス → state → 全ビュー
    });
    inp.addEventListener('change', () => {
      const o = DAW.objects.get(id);
      if (o) inp.value = this.fmtNum(o[key]);  // 正規化・クランプ後の値へ揃える
      this.render();
      DAW.history.commit();
    });
    wrap.append(span, inp);
    return wrap;
  },

  fmtNum(v) { return String(Math.round(v * 10) / 10); },

  // dB 表示。線形ピーク 0 は -∞（メーター未接続の今は常にこれ）
  fmtDb(linear) {
    if (!(linear > 0)) return '-∞';
    return (20 * Math.log10(linear)).toFixed(1);
  },

  peakClass(linear) {
    if (!(linear > 0)) return '';
    const db = 20 * Math.log10(linear);
    return db >= -0.5 ? 'hot' : db >= -6 ? 'warn' : '';
  },

  // DOM を作り直さずに値だけ流し込む（フォーカス中の入力欄は触らない＝入力の邪魔をしない）
  syncStrip(el, obj) {
    const r = el._r;
    const act = document.activeElement;   // 入力中の欄は書き換えない（打鍵の邪魔をしない）
    el.classList.toggle('selected', obj.id === DAW.objects.selectedId);
    r.dot.style.background = obj.color;
    if (r.name !== act) r.name.value = obj.name;
    r.name.disabled = obj.lock === 'all';

    // トラックセレクタ。options はトラック構成（追加/削除/改名/並び替え）が変わったときだけ
    // 作り直す。ストリップは仮想化でスクロールのたびに DOM ごと作り直されるので、
    // 「作った時点の選択肢を持ち続ける」実装にはできない（ここで毎回 state から流し込む）。
    const tsig = this.tracksSig();
    if (r.track._sig !== tsig) {
      r.track._sig = tsig;
      r.track.textContent = '';
      const ph = document.createElement('option');
      ph.value = '';
      ph.textContent = '(未割り当て)';
      r.track.appendChild(ph);
      for (const t of DAW.project.tracks) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.name;
        r.track.appendChild(opt);
      }
    }
    if (r.track !== act) {
      // 参照先のトラックが消えていたら表示は「(未割り当て)」に落とす（state は書き換えない。
      // rAF から勝手に state を触ると履歴の署名とずれる。削除時の解除は DAW.removeTrack の担当）。
      const has = obj.trackId && DAW.project.tracks.some(t => t.id === obj.trackId);
      r.track.value = has ? obj.trackId : '';
      r.track.classList.toggle('none', !has);
    }

    const movable = DAW.objects.canEditPosition(obj);   // 'pos' / 'all' は位置を編集させない
    const pathOn = !!(obj.path && obj.path.enabled);    // 経路有効中は Az/El を経路が決める
    for (const key of ['az', 'el', 'width']) {
      const inp = r[key];
      if (inp !== act) inp.value = this.fmtNum(obj[key]);
      const byPath = pathOn && (key === 'az' || key === 'el');
      inp.disabled = !movable || byPath;
      inp.title = byPath ? '経路（位置オートメーション）が位置を決めるため編集できません' : '';
    }

    r.lock.textContent = obj.lock === 'none' ? '自由' : obj.lock === 'pos' ? '位置固定' : '全固定';
    r.lock.className = 'os-lock lock-' + obj.lock;
    r.lock.title = `ロック: ${obj.lock}（クリックで none → pos → all）`;

    r.revKnob.update();   // 外部変更（undo / 読み込み）に追従。lock='all' は灰色になる（active）

    const editable = DAW.objects.canEditParams(obj);
    if (r.fader !== act) r.fader.value = obj.gainDb;
    r.fader.disabled = !editable;
    r.gain.textContent = obj.gainDb.toFixed(1);
    r.mute.classList.toggle('on', obj.mute);
    r.solo.classList.toggle('on', obj.solo);
    r.mute.disabled = r.solo.disabled = !editable;
    this.syncPeak(el, obj.id);
  },

  syncPeak(el, id) {
    const p = this.peaks.get(id) || 0;
    el._r.peak.textContent = this.fmtDb(p);
    el._r.peak.className = 'os-peak ' + this.peakClass(p);
  },

  // トラック構成の署名。セレクタの options を作り直すべきか（syncStrip）の判定に使う。
  tracksSig() {
    let s = '';
    for (const t of DAW.project.tracks) s += t.id + '\u0000' + t.name + '\u0001';
    return s;
  },

  // ---- タイムライン側トラックヘッダのバッジ ----
  //
  // 「このトラックはオブジェクトに割り当て済み」をトラック側からも見えるようにする。
  // js/ui.js はフックしない: renderTracks() は DOM を丸ごと作り直すので、フックしても
  // バッジはすぐ消える。代わりにこちら側から render() と 30fps のメーター更新のたびに
  // 貼り直す（既存の stateSig() 同期と同じ「rAF で追従する」方式）。
  // トラックヘッダ自体は id を持たないので、隣の .lane[data-track-id] から辿る。
  syncTrackBadges() {
    const lanes = document.querySelectorAll('.lane[data-track-id]');
    for (const lane of lanes) {
      const head = lane.previousElementSibling;   // buildTrackRow は head → lane の順で並べる
      if (!head || !head.classList.contains('track-head')) continue;
      const obj = DAW.objects.list.find(o => o.trackId === lane.dataset.trackId) || null;
      let badge = head.querySelector('.th-obj');
      if (!obj) {
        if (badge) badge.remove();
        continue;
      }
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'th-obj';
        badge.title = 'オブジェクトベース音響へ出力中（PANNER のストリップで割り当てを変更）';
        // M/S ボタンの行の右端に置く（無ければヘッダ末尾）
        const row = head.querySelector('.th-btns');
        (row || head).appendChild(badge);
      }
      const text = '◆ ' + obj.name;
      if (badge.textContent !== text) badge.textContent = text;
      // style.color は正規化された rgb() が返るので、比較用に元の色を dataset に控える
      if (badge.dataset.c !== obj.color) { badge.dataset.c = obj.color; badge.style.color = obj.color; }
    }
  },

  // ---- メータリング ----
  //
  // ピークは「線形」で持つ（0 = 無音 = -∞ 表示）。DAW.objaudio.peakDb() は
  // 呼ばれたときだけ解析するので、**可視ストリップぶんだけ**呼ぶこと。
  // 128個ぶん毎フレーム呼ぶと解析だけで数ms持っていかれる。
  setPeak(id, linear) {
    this.peaks.set(id, linear);
  },

  dbToLinear(db) { return isFinite(db) ? Math.pow(10, db / 20) : 0; },

  // rAF をそのまま使うと 60fps 以上で回るので 30fps に間引く。
  // 戻り値は「実際に更新したか」（テストで間引きを確認できるようにしてある）。
  updateMeters(now) {
    if (now - this._lastMeter < 1000 / this.METER_FPS) return false;
    this._lastMeter = now;
    const peak = DAW.objaudio && DAW.objaudio.peakDb;
    for (const [id, el] of this.strips) {
      if (peak) this.setPeak(id, this.dbToLinear(DAW.objaudio.peakDb(id)));
      this.syncPeak(el, id);
    }
    this.updateMasterMeter();
    if (this.view === 'metering') this.updateLoudness();   // ラウドネスも同じ 30fps で
    // トラックヘッダのバッジもここで貼り直す。renderTracks() は state を変えずに
    // DOM を作り直すことがある（リサイズ・ズーム等）ので、署名同期だけでは拾えない。
    this.syncTrackBadges();
    return true;
  },

  // ヘッダーのマスターメーター（ドック側）。タイムライン側のメーターは js/ui.js の担当。
  updateMasterMeter() {
    const e = this.els;
    if (!e.mmL) return;
    const lv = (DAW.audio && DAW.audio.getLevels) ? DAW.audio.getLevels() : [0, 0];
    const l = lv[0] || 0;
    const r = lv[1] || 0;
    e.mmL.style.width = this.meterPct(l) + '%';
    e.mmR.style.width = this.meterPct(r) + '%';
    const p = Math.max(l, r);
    e.mdb.textContent = this.fmtDb(p);
    if (e.masterPeak) {
      e.masterPeak.textContent = this.fmtDb(p);
      e.masterPeak.className = 'os-peak ' + this.peakClass(p);
    }
  },

  // dB 目盛（-72dB を 0%）。js/ui.js の meterPct と同じ考え方。
  meterPct(peak) {
    if (!(peak > 0)) return 0;
    const db = 20 * Math.log10(peak);
    return Math.max(0, Math.min(100, (1 + db / 72) * 100)).toFixed(1);
  },

  // ---- RENDERER 画面 ----

  // 選択中の配置のスピーカー一覧。定義はレンダラー層（DAW.objaudio.LAYOUTS）を正とし、
  // 無ければ控えを使う。UI とレンダラーで配置が食い違うと「表示と音が違う」最悪の不具合になる。
  layoutTable() {
    const oa = DAW.objaudio;
    return (oa && oa.LAYOUTS) ? oa.LAYOUTS : this.FALLBACK_LAYOUTS;
  },

  layoutNames() { return Object.keys(this.layoutTable()); },

  speakers(name) {
    const t = this.layoutTable();
    return t[name || this.layoutName] || t[this.layoutNames()[0]] || [];
  },

  // 配置の選択。音を出す側（VBAP）は DAW.objaudio.setLayout() が担当する。
  // ここは「選んだ」ことを両方へ伝えるだけ。
  setLayout(name) {
    if (!this.layoutTable()[name]) return false;
    this.layoutName = name;
    if (DAW.objaudio && DAW.objaudio.setLayout) DAW.objaudio.setLayout(name);
    this.render();
    return true;
  },

  // 出力形式。データは同じで「どう鳴らすか」だけを差し替える（レンダラー抽象化の要）。
  OUT_MODES: [
    { key: 'binaural', label: 'バイノーラル', title: 'ヘッドホン向け。編集中は等パワー、試聴中だけ HRTF に切り替わる' },
    { key: 'speakers', label: 'スピーカー', title: '選択中の配置へ VBAP で分配する。書き出しも配置のチャンネル数になる' },
  ],

  outMode() {
    return DAW.objaudio && DAW.objaudio.mode === DAW.objaudio.MODE_SPEAKERS ? 'speakers' : 'binaural';
  },

  setOutMode(key) {
    const oa = DAW.objaudio;
    if (!oa || !oa.setMode) return false;
    if (key === 'speakers') {
      oa.setMode(oa.MODE_SPEAKERS);
    } else {
      // バイノーラルへ戻す。自動切替に任せるので、まずは軽い等パワーから始める
      oa.setMode(oa.MODE_EQUALPOWER);
    }
    this.render();
    return true;
  },

  buildRenderer() {
    const e = this.els;
    if (!e.layouts || !e.knobs || !e.limByp || !e.spkList) return;
    if (e.out) {
      for (const m of this.OUT_MODES) {
        const b = document.createElement('button');
        b.dataset.out = m.key;
        b.textContent = m.label;
        b.title = m.title;
        b.addEventListener('click', () => this.setOutMode(m.key));
        e.out.appendChild(b);
      }
    }
    for (const name of this.layoutNames()) {
      const b = document.createElement('button');
      b.className = 'obj-layout-btn';
      b.dataset.layout = name;
      b.textContent = name;
      b.title = `${name}（${this.speakers(name).length}ch）を 3D ビューに重ねる`;
      b.addEventListener('click', () => this.setLayout(name));
      e.layouts.appendChild(b);
    }
    for (const spec of this.KNOBS) e.knobs.appendChild(this.buildKnob(spec));
    if (e.revKnobs) for (const spec of this.REV_KNOBS) e.revKnobs.appendChild(this.buildRevKnob(spec));
    e.limByp.addEventListener('click', () => {
      DAW.limiter.setEnabled(!DAW.limiter.enabled);
      this.renderRenderer();
    });
  },

  // 共通ノブ（DAW.knob）に乗せる。挙動は従来のリミッターノブと互換:
  // 縦ドラッグ（KNOB_PX で1周）/ Ctrl・Shift で微調整 / ダブルクリックで既定値 /
  // 表示は v.toFixed(digits)+unit（"0.0dB" 形式のまま）。
  buildKnob(spec) {
    const r = DAW.limiter.LIMITS[spec.key];
    const el = DAW.knob.create({
      label: spec.label,
      range: { min: r[0], max: r[1] },   // step 無し = 連続値（従来のドラッグ解像度を維持）
      def: spec.def,
      get: () => DAW.limiter.params[spec.key],
      set: v => { DAW.limiter.set(spec.key, v); this.renderRenderer(); },
      // リミッターの設定はプロジェクト状態（履歴のスナップショット）に入っていないので
      // commit は何もしない。入るようになったらここで DAW.history.commit() を呼ぶ。
      commit: () => {},
      format: v => v.toFixed(spec.digits) + spec.unit,
      active: () => DAW.limiter.enabled,
    });
    el.classList.add('obj-knob');
    el.dataset.key = spec.key;
    el.title = `${spec.label}（${r[0]}〜${r[1]}${spec.unit}）: 上下ドラッグで変更 / Ctrl か Shift で微調整 / ダブルクリックで既定値`;
    this.knobs.set(spec.key, el);
    return el;
  },

  // ルームリバーブのノブ。作法はリミッターのノブ（buildKnob）と同じ。
  // Return（level）が 0 のとき全ノブを灰色で描き、「オフ」を見た目でも示す。
  buildRevKnob(spec) {
    const r = DAW.objaudio.REV_LIMITS[spec.key];
    const el = DAW.knob.create({
      label: spec.label,
      range: { min: r[0], max: r[1] },   // step 無し = 連続値
      def: spec.def,
      get: () => DAW.objaudio.revParams[spec.key],
      set: v => { DAW.objaudio.setRevParam(spec.key, v); this.renderRenderer(); },
      // リミッターと同じく履歴のスナップショット外（保存はプロジェクト保存 roomReverb が担う）。
      // 履歴に入るようになったらここで DAW.history.commit() を呼ぶ。
      commit: () => {},
      format: v => v.toFixed(spec.digits) + spec.unit,
      active: () => DAW.objaudio.revParams.level > 0,
    });
    el.classList.add('obj-knob');
    el.dataset.key = spec.key;
    el.title = `${spec.jp}（${r[0]}〜${r[1]}${spec.unit}）: 上下ドラッグで変更 / Ctrl か Shift で微調整 / ダブルクリックで既定値`;
    this.knobs.set(spec.key, el);
    return el;
  },

  // METERING 画面（ラウドネスメーター）。index.html は最小限に保つ規約なので、
  // ペインの DOM はここで組み立てて #obj-body へ差し込む（タブのボタンだけ HTML にある）。
  buildMetering() {
    const body = document.getElementById('obj-body');
    if (!body || !this.els.renderer) return;
    const pane = document.createElement('div');
    pane.id = 'obj-metering';
    pane.className = 'obj-view hidden';

    // ラウドネス（M / S / I / TP の4行 + リセット）
    const sec = document.createElement('div');
    sec.className = 'obj-rend-sec';
    sec.id = 'obj-loud-sec';
    const title = document.createElement('div');
    title.className = 'obj-sec-title';
    const tl = document.createElement('span');
    tl.textContent = 'ラウドネス（ITU-R BS.1770-4）';
    const reset = document.createElement('button');
    reset.id = 'obj-loud-reset';
    reset.textContent = 'リセット';
    reset.title = 'Integrated と True Peak の蓄積をやり直す（Momentary / Short Term は流れてくる音からすぐ再構築される）';
    reset.addEventListener('click', () => { DAW.loudness.reset(); this.updateLoudness(); });
    title.append(tl, reset);
    sec.appendChild(title);

    const rows = {};
    for (const [key, lab, unit, tip] of [
      ['m', 'MOMENTARY', 'LUFS', '瞬時ラウドネス（400ms 窓）'],
      ['s', 'SHORT TERM', 'LUFS', '短期ラウドネス（3s 窓）'],
      ['i', 'INTEGRATED', 'LUFS', '統合ラウドネス（-70 LUFS 絶対 / -10 LU 相対ゲーティング付き。リセットからの蓄積）'],
      ['tp', 'TRUE PEAK', 'dBTP', 'トゥルーピーク（4倍オーバーサンプリング。サンプル点の間に隠れたピークも検出）'],
    ]) {
      const row = document.createElement('div');
      row.className = 'obj-loud-row';
      row.title = tip;
      const l = document.createElement('span');
      l.className = 'ol-lab';
      l.textContent = lab;
      const barWrap = document.createElement('div');
      barWrap.className = 'ol-bar';
      const bar = document.createElement('i');
      barWrap.appendChild(bar);
      const val = document.createElement('span');
      val.className = 'ol-val';
      val.textContent = '-∞ ' + unit;
      row.append(l, barWrap, val);
      sec.appendChild(row);
      rows[key] = { bar, val, unit };
    }
    const note = document.createElement('div');
    note.id = 'obj-loud-note';
    note.textContent = 'タップはリミッター前（どれだけ突っ込んでいるかが見える）。一度開くと閉じても計測は続く';
    sec.appendChild(note);

    // 書き出しレポート（最後の WAV 書き出しの Integrated / True Peak）
    const rsec = document.createElement('div');
    rsec.className = 'obj-rend-sec';
    rsec.id = 'obj-loud-report-sec';
    const rtitle = document.createElement('div');
    rtitle.className = 'obj-sec-title';
    rtitle.textContent = '書き出しレポート';
    const report = document.createElement('div');
    report.id = 'obj-loud-report';
    rsec.append(rtitle, report);

    pane.append(sec, rsec);
    body.appendChild(pane);
    this.els.metering = pane;
    this.els.loud = { m: rows.m, s: rows.s, i: rows.i, tp: rows.tp, reset, report };
  },

  // LUFS の目盛（-60 LUFS を 0%、0 を 100%）。ピークの meterPct と同じ考え方
  lufsPct(v) {
    if (!isFinite(v)) return 0;
    return Math.max(0, Math.min(100, (1 + v / 60) * 100)).toFixed(1);
  },

  // METERING 画面の値を流し込む。計算は AudioWorklet 側（DAW.loudness.live を読むだけ）
  updateLoudness() {
    const r = this.els.loud;
    if (!r) return;
    const lv = DAW.loudness.live;
    const F = v => DAW.loudness.fmt(v);
    const set = (row, v) => {
      const txt = `${F(v)} ${row.unit}`;
      if (row.val.textContent !== txt) row.val.textContent = txt;
      row.bar.style.width = this.lufsPct(v) + '%';
    };
    set(r.m, lv.momentary);
    set(r.s, lv.shortTerm);
    set(r.i, lv.integrated);
    set(r.tp, lv.truePeakDb);
    r.tp.val.className = 'ol-val ' + this.peakClass(lv.truePeak);   // 0dBTP 超過を色で示す
    const rep = DAW.wav && DAW.wav.lastExportLoudness;
    const txt = rep
      ? `${rep.file}: Integrated ${F(rep.integrated)} LUFS / True Peak ${F(rep.truePeakDb)} dBTP`
      : 'まだ書き出していません（WAV書き出し時に計測されます）';
    if (r.report.textContent !== txt) r.report.textContent = txt;
  },

  renderRenderer() {
    const e = this.els;
    if (!e.layouts || this.view !== 'renderer') return;   // 隠れている間は描かない
    // 配置はレンダラー層が持っているならそちらが正。外から切り替えられても追従する。
    const oa = DAW.objaudio;
    if (oa && oa.layoutName && this.layoutTable()[oa.layoutName]) this.layoutName = oa.layoutName;
    for (const b of e.layouts.children) b.classList.toggle('on', b.dataset.layout === this.layoutName);
    if (e.out) {
      const cur = this.outMode();
      for (const b of e.out.children) b.classList.toggle('on', b.dataset.out === cur);
    }
    for (const el of this.knobs.values()) el.update();
    e.limByp.classList.toggle('on', !DAW.limiter.enabled);
    e.limByp.textContent = DAW.limiter.enabled ? 'BYPASS' : 'BYPASSED';

    // スピーカー表。3D ビューに重ねた番号と同じ順（＝出力チャンネル順）で出す。
    const list = this.speakers();
    if (e.spkList._sig !== this.layoutName) {
      e.spkList._sig = this.layoutName;
      e.spkList.textContent = '';
      list.forEach((s, i) => {
        const row = document.createElement('div');
        row.className = 'obj-spk-row' + (s.lfe ? ' lfe' : '');
        const n = document.createElement('b');
        n.textContent = String(i + 1);
        const nm = document.createElement('span');
        nm.className = 'sn';
        nm.textContent = s.name;
        const p = document.createElement('span');
        p.textContent = `${s.az > 0 ? '+' : ''}${s.az}° / ${s.el > 0 ? '+' : ''}${s.el}°`;
        row.append(n, nm, p);
        e.spkList.appendChild(row);
      });
    }
  },

  // ---- 外部変更の検知 ----

  // undo / プロジェクト読み込みなど、このUIを経由しない変更に追従するための署名。
  // 文字列を毎フレーム組み立てると GC を叩くので数値ハッシュにしてある。
  stateSig() {
    let h = 2166136261;
    const mix = v => { h = Math.imul(h ^ (v | 0), 16777619); };
    const mixStr = s => { for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i)); };
    mix(DAW.objects.count());
    mixStr(String(DAW.objects.selectedId));
    for (const o of DAW.objects.list) {
      mixStr(o.id);
      mixStr(o.name);
      mixStr(o.color);
      mixStr(String(o.trackId));   // 割り当ての undo / 奪い取りの巻き添えにセレクタが追従する
      mix(o.az * 1000); mix(o.el * 1000); mix(o.dist * 10000);
      mix(o.width * 100); mix(o.gainDb * 100);
      mix(o.revSend * 1000);   // Rev センド。混ぜ忘れると undo 後にノブが追従しない
      mix((o.mute ? 1 : 0) | (o.solo ? 2 : 0) | (o.lock === 'pos' ? 4 : o.lock === 'all' ? 8 : 0));
      // 経路（有効フラグ + 各点の t/az/el/dist/ease）。混ぜ忘れると undo 後にビューが追従しない
      const path = o.path || { enabled: false, points: [] };
      mix(path.enabled ? 1 : 0);
      mix(path.points.length);
      for (const p of path.points) {
        mix(p.t * 1000); mix(p.az * 1000); mix(p.el * 1000); mix(p.dist * 10000);
        mix(DAW.objects.EASES.indexOf(p.ease) + 1);
      }
    }
    // 経路の編集モード / waypoint 選択もビューの見た目を変える
    mix(this.pathEdit ? 1 : 0);
    mix(this.pathSel == null ? -1 : this.pathSel);
    // トラックの追加/削除/改名/並び替えにも追従する（セレクタの options とバッジの表示が変わる）
    for (const t of DAW.project.tracks) {
      mixStr(t.id);
      mixStr(String(t.name));
    }
    // このUIを経由しないリミッター/配置の変更にも追従させる
    mixStr(this.view);
    mixStr(String((DAW.objaudio && DAW.objaudio.layoutName) || this.layoutName));
    mixStr(String(DAW.objaudio && DAW.objaudio.mode));
    const lp = DAW.limiter.params;
    mix(lp.gainDb * 100); mix(lp.releaseMs * 10); mix(lp.ceilingDb * 100); mix(lp.lookaheadMs * 100);
    mix(DAW.limiter.enabled ? 1 : 0);
    // ルームリバーブのマスターパラメータ（プロジェクト読み込み等の外部変更にノブが追従する）
    const rp = (DAW.objaudio && DAW.objaudio.revParams) || {};
    mix(rp.decay * 100); mix(rp.damp * 1000); mix(rp.level * 1000);
    return String(h >>> 0);
  },

  sync() {
    if (this.stateSig() !== this._sig) this.render();
  },

  tick(now) {
    this.sync();
    DAW.objaudio.followPaths();   // 経路のライブ追従（再生中でなければ no-op）
    // 経路上を動くオブジェクトの現在位置を追う。canvas だけ描き直す
    // （ストリップは値が変わらないので触らない。触ると入力中の欄と衝突する）
    if (DAW.audio.isPlaying() && DAW.objects.list.some(o => o.path && o.path.enabled && o.path.points.length)) {
      this.drawTop();
      this.drawFront();
      this.drawSphere();
    }
    this.updateMeters(now || 0);
    requestAnimationFrame(t => this.tick(t));
  },
};

// 自己初期化。main.js の DAW.ui.init() とは独立（このUIは DAW.ui に依存しない）ので、
// どちらが先に走っても問題ない。二重に呼ばれても _inited で弾く。
window.addEventListener('DOMContentLoaded', () => DAW.objui.init());
