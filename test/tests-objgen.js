'use strict';
// =====================================================================
// 軌道ジェネレータ + 経路ループのテスト。グループ [45]。
//  - 生成: 各形状（circle / spiral / eight / pingpong）の waypoint 座標列を数値で固定
//  - ループ: pathPosAt の剰余（スパン跨ぎ・負にならない）、書き出しランプの一致、保存往復
//  - UI: 「生成」メニュー → パラメータ枠 → 生成、ループ切替、undo 粒度、lock 拒否
// 他ファイルのヘルパには依存しない（tests-*.js は名前順に読まれるため）。
// =====================================================================

function objGenSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.project.masterVolume = 1;
    DAW.project.bpm = 120;
    DAW.objects.clear();
    DAW.objaudio.mode = DAW.objaudio.MODE_EQUALPOWER;
    DAW.objaudio.exportRange = null;
    DAW.loop.enabled = false; DAW.loop.start = 0; DAW.loop.end = 0;
    DAW.metronome.enabled = false;
    DAW.audio.playheadPos = 0;
    DAW.addTrack('src');
    DAW.ui.renderTracks();
    DAW.objui.init();
    DAW.objui.setView('panner');
    DAW.objui.pathEdit = false;
    DAW.objui.pathSel = null;
    DAW.objui.closeGenBox();
    DAW.ui.closeMenu();
    DAW.objui.render();
    DAW.history.reset();
    try { await body(okf); } finally {
      DAW.objects.clear();
      DAW.objui.pathEdit = false;
      DAW.objui.pathSel = null;
      DAW.objui.pdrag = null;
      DAW.objui.closeGenBox();
      DAW.ui.closeMenu();
      DAW.objaudio.mode = DAW.objaudio.MODE_EQUALPOWER;
      DAW.objaudio.exportRange = null;
      DAW.objaudio.autoHrtf = true;
      DAW.audio.resetNodes();
      DAW.objui.render();
      try { DAW.audio.stop(); } catch (e) {}
    }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

// ---------------------------------------------------------------------
// 生成（モデル）: 座標列の数値固定
// ---------------------------------------------------------------------
objGenSuite('[45] 軌道ジェネレータ（生成）', async (okf) => {
  const O = DAW.objects;
  const near = (a, b, t) => Math.abs(a - b) <= (t == null ? 1e-9 : t);
  const seq = (pts, key, digits) => pts.map(p => +p[key].toFixed(digits == null ? 6 : digits)).join(',');

  const obj = O.create('生成テスト');
  O.setPosition(obj.id, 0, 0, 0.8);

  // ---- 円: 一定 el で az を一周（45° 刻み・閉じ点あり）----
  {
    const pts = O.generatePath(obj.id, 'circle', { t0: 0, period: 4, cycles: 1, az: 0, el: 15, dist: 0.8 });
    okf('G.1 [circle] 1周は 9 点（1/8 周期ごと + 閉じ点）', pts && pts.length === 9, pts && pts.length);
    okf('G.2 [circle] t は 0.5s 刻み', seq(pts, 't', 3) === '0,0.5,1,1.5,2,2.5,3,3.5,4', seq(pts, 't', 3));
    okf('G.3 [circle] az は 45° 刻みで一周し (-180,180] に畳まれる',
      seq(pts, 'az', 3) === '0,45,90,135,180,-135,-90,-45,0', seq(pts, 'az', 3));
    okf('G.4 [circle] el/dist は一定・ease は linear',
      pts.every(p => p.el === 15 && p.dist === 0.8 && p.ease === 'linear'),
      `${seq(pts, 'el', 2)} / ${seq(pts, 'dist', 2)}`);
    okf('G.5 [circle] 終端 = 始点の閉じ点（loop で途切れない）',
      pts[0].az === pts[8].az && pts[0].el === pts[8].el && pts[0].dist === pts[8].dist);
  }

  // ---- 円: 右回り（dir=-1）----
  {
    const pts = O.generatePath(obj.id, 'circle', { t0: 0, period: 4, cycles: 1, az: 0, el: 0, dist: 1, dir: -1 });
    okf('G.6 [circle] dir=-1 は右回り（az が負方向へ進む）',
      seq(pts, 'az', 3) === '0,-45,-90,-135,180,135,90,45,0', seq(pts, 'az', 3));
  }

  // ---- スパイラル: az 回転しながら el を漸変（dist も指定時は漸変）----
  {
    const pts = O.generatePath(obj.id, 'spiral', { t0: 0, period: 2, cycles: 2, az: 0, el: 0, el1: 60, dist: 1, dist1: 0.5 });
    okf('G.7 [spiral] 2周は 17 点・t は 0.25s 刻み', pts.length === 17 && near(pts[1].t, 0.25) && near(pts[16].t, 4),
      `n=${pts.length} t=${seq(pts, 't', 2)}`);
    okf('G.8 [spiral] az は回転し続ける（1周後・2周後は 0 に戻る）',
      near(pts[4].az, 180) && near(pts[8].az, 0) && near(pts[16].az, 0),
      `az[4]=${pts[4].az} az[8]=${pts[8].az} az[16]=${pts[16].az}`);
    okf('G.9 [spiral] el は 0 → 60 へ線形（中間 30・各点 3.75° 刻み）',
      near(pts[8].el, 30) && near(pts[16].el, 60) && near(pts[1].el, 3.75),
      seq(pts, 'el', 3));
    okf('G.10 [spiral] dist1 指定で dist も 1 → 0.5 へ漸変',
      near(pts[0].dist, 1) && near(pts[8].dist, 0.75) && near(pts[16].dist, 0.5),
      seq(pts, 'dist', 4));
    const pts2 = O.generatePath(obj.id, 'spiral', { t0: 0, period: 2, cycles: 1, az: 0, el: 10, el1: 40, dist: 0.6 });
    okf('G.11 [spiral] dist1 省略時は dist 一定', pts2.every(p => near(p.dist, 0.6)), seq(pts2, 'dist', 3));
  }

  // ---- 8の字: az が ±振幅で行き来し el が倍速で上下（リサージュ 1:2）----
  {
    const pts = O.generatePath(obj.id, 'eight', { t0: 0, period: 4, cycles: 1, az: 10, el: 0, dist: 1, radius: 40 });
    okf('G.12 [eight] 1周は 9 点で閉じる', pts.length === 9 && near(pts[8].az, 10, 1e-6) && near(pts[8].el, 0, 1e-6),
      `n=${pts.length} 終点=(${pts[8].az}, ${pts[8].el})`);
    okf('G.13 [eight] az = 10 + 40·sin(2πu)（u=1/8 で +28.284、u=1/4 で +40）',
      near(pts[1].az, 10 + 40 * Math.SQRT1_2, 1e-6) && near(pts[2].az, 50, 1e-6) && near(pts[6].az, -30, 1e-6),
      seq(pts, 'az', 3));
    okf('G.14 [eight] el = 20·sin(4πu)（az の倍の周波数で ±半振幅）',
      near(pts[1].el, 20, 1e-6) && near(pts[2].el, 0, 1e-6) && near(pts[3].el, -20, 1e-6) && near(pts[5].el, 20, 1e-6),
      seq(pts, 'el', 3));
  }

  // ---- 往復: 中心±振幅の2点間（点は折り返しにだけ置く）----
  {
    const pts = O.generatePath(obj.id, 'pingpong', { t0: 0, period: 2, cycles: 2, az: 0, el: 5, dist: 1, radius: 60 });
    okf('G.15 [pingpong] 2往復は 5 点（A,B,A,B,A）', pts.length === 5, pts.length);
    okf('G.16 [pingpong] t は半周期刻み・az は -60/+60 の往復',
      seq(pts, 't', 3) === '0,1,2,3,4' && seq(pts, 'az', 3) === '-60,60,-60,60,-60',
      `t=${seq(pts, 't', 2)} az=${seq(pts, 'az', 2)}`);
    okf('G.17 [pingpong] el/dist は一定', pts.every(p => p.el === 5 && p.dist === 1));
  }

  // ---- 検証（normalize / clamp / PATH_MIN_DT / 拍指定）----
  {
    const pts = O.generatePath(obj.id, 'circle', { t0: 0, period: 0.1, cycles: 1 });
    okf('G.18 短すぎる周期は div×PATH_MIN_DT へ引き上げ（点間 0.05s を守る）',
      pts.every((p, i) => i === 0 || p.t - pts[i - 1].t >= O.PATH_MIN_DT - 1e-9) && near(pts[8].t, 0.4),
      seq(pts, 't', 3));
    const pb = O.generatePath(obj.id, 'circle', { t0: 1, beats: 4, cycles: 1 });
    okf('G.19 beats 指定は BPM から周期を決める（120bpm・4拍 = 2s）', near(pb[8].t, 3), pb[8].t);
    const pr = O.generatePath(obj.id, 'pingpong', { period: 2, radius: 150, az: 0 });
    okf('G.20 振幅は 90° まで（最短弧が裏へ回らない）', near(pr[0].az, -90) && near(pr[1].az, 90),
      seq(pr, 'az', 1));
    const pd = O.generatePath(obj.id, 'circle', { period: 4, el: 200, dist: 7 });
    okf('G.21 範囲外の el/dist は normalize/clamp を通る',
      pd.every(p => Math.abs(p.el) <= 90 && p.dist >= 0 && p.dist <= 1),
      `el=${seq(pd, 'el', 1)} dist=${pd[0].dist}`);
    okf('G.22 未知の形状は null', O.generatePath(obj.id, 'zigzag', {}) === null);
    okf('G.23 生成は既存の点を置き換える（前回の circle 9点 → pingpong 3点）',
      (O.generatePath(obj.id, 'pingpong', { period: 2, cycles: 1 }) || []).length === 3,
      obj.path.points.length);
  }

  // ---- 中心の既定値はオブジェクトの現在位置 ----
  {
    O.setPosition(obj.id, 30, 20, 0.5);
    const pts = O.generatePath(obj.id, 'eight', { period: 4, radius: 10 });
    okf('G.24 az/el/dist 省略時はオブジェクトの現在位置が中心',
      near(pts[0].az, 30, 1e-6) && near(pts[0].el, 20, 1e-6) && near(pts[0].dist, 0.5),
      `(${pts[0].az}, ${pts[0].el}, ${pts[0].dist})`);
  }

  // ---- lock 拒否 ----
  {
    O.set(obj.id, 'lock', 'pos');
    const before = JSON.stringify(obj.path.points);
    okf('G.25 lock 中は generatePath / setPathLoop とも拒否（経路は不変）',
      O.generatePath(obj.id, 'circle', {}) === null
      && O.setPathLoop(obj.id, true) === false
      && obj.path.loop === false && JSON.stringify(obj.path.points) === before);
    O.set(obj.id, 'lock', 'none');
  }

  okf('G.26 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});

// ---------------------------------------------------------------------
// 経路ループ（モデル + 保存往復）
// ---------------------------------------------------------------------
objGenSuite('[45] 経路ループ（モデル）', async (okf) => {
  const O = DAW.objects;
  const near = (a, b, t) => Math.abs(a - b) <= (t == null ? 1e-9 : t);

  const obj = O.create('ループテスト');
  okf('P.1 create したオブジェクトは path.loop=false', obj.path.loop === false, JSON.stringify(obj.path));

  // pts: t=1〜3（スパン 2s）。az 0 → 80 → -40 と動く開いた経路
  obj.path.enabled = true;
  obj.path.points = [
    { t: 1, az: 0, el: 10, dist: 0.5, ease: 'linear' },
    { t: 2, az: 80, el: 0, dist: 1, ease: 'linear' },
    { t: 3, az: -40, el: -20, dist: 0.8, ease: 'linear' },
  ];

  // ---- loop 無効: 従来のホールド ----
  {
    const p = O.pathPosAt(obj, 99);
    okf('P.2 loop 無効なら最後の点でホールド（従来仕様は不変）',
      p.az === -40 && p.el === -20 && near(p.dist, 0.8), JSON.stringify(p));
  }

  // ---- loop 有効: スパンで剰余 ----
  O.setPathLoop(obj.id, true);
  okf('P.3 setPathLoop で有効化できる', obj.path.loop === true);
  {
    const ref = t => O.pathPosAt(obj, t);
    const p0 = ref(3);      // 折り返しの瞬間 = 剰余 0 = 最初の点
    okf('P.4 t=最後の点は剰余 0 で最初の点', p0.az === 0 && p0.el === 10 && near(p0.dist, 0.5), JSON.stringify(p0));
    const a = ref(3.5), b = ref(1.5);
    okf('P.5 1周先（t=3.5）は t=1.5 と同じ位置', near(a.az, b.az) && near(a.el, b.el) && near(a.dist, b.dist),
      `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    const c = ref(2.5 + 2 * 5), d = ref(2.5);
    okf('P.6 複数スパン跨ぎ（5周先）も同じ位置', near(c.az, d.az) && near(c.el, d.el) && near(c.dist, d.dist),
      `${JSON.stringify(c)} vs ${JSON.stringify(d)}`);
    const far = ref(100001.25), farRef = ref(1.25);
    okf('P.7 遠い時刻でも剰余は [0, span) に落ちる（負にならない・発散しない）',
      near(far.az, farRef.az, 1e-6) && near(far.dist, farRef.dist, 1e-6),
      `${JSON.stringify(far)} vs ${JSON.stringify(farRef)}`);
    const before = ref(0);
    okf('P.8 最初の点より前は loop でも従来どおり先頭でホールド',
      before.az === 0 && before.el === 10 && near(before.dist, 0.5), JSON.stringify(before));
  }

  // ---- 1点だけ / スパン 0 は loop でもホールド ----
  {
    const one = O.create('1点');
    one.path.enabled = true;
    one.path.loop = true;
    one.path.points = [{ t: 1, az: 30, el: 0, dist: 1, ease: 'linear' }];
    const p = O.pathPosAt(one, 50);
    okf('P.9 1点だけの経路は loop でもその点でホールド（0 除算しない）',
      p.az === 30 && isFinite(p.az), JSON.stringify(p));
    O.remove(one.id);
  }

  // ---- bakeTimes のループ展開 ----
  {
    const pts = [
      { t: 0, az: 0, el: 0, dist: 1, ease: 'linear' },
      { t: 0.3, az: 90, el: 0, dist: 1, ease: 'linear' },
      { t: 0.5, az: -90, el: 0, dist: 1, ease: 'linear' },
    ];
    const ts = DAW.objaudio.bakeTimes(pts, 0, 2, true);
    okf('B.1 loop 時は until まで刻みが続く（最後の点で止まらない）',
      ts[ts.length - 1] === 2 && ts.some(t => t > 0.5 + 1e-6),
      `末尾=${ts.slice(-3).join(',')}`);
    const has = v => ts.some(t => Math.abs(t - v) < 1e-6);
    okf('B.2 waypoint 時刻が周回ごとに展開される（0.3/0.5/0.8/1.0/1.3/1.5/1.8）',
      [0.3, 0.5, 0.8, 1.0, 1.3, 1.5, 1.8].every(has),
      ts.filter(t => Math.abs(t * 10 - Math.round(t * 10)) < 1e-6).join(','));
    okf('B.3 時刻列は昇順かつ重複なし', ts.every((t, i) => i === 0 || t > ts[i - 1]), ts.length);
    const ts2 = DAW.objaudio.bakeTimes(pts, 0, 2, false);
    okf('B.4 loop 無効なら従来どおり最後の点で刻みが止まる',
      ts2.filter(t => t > 0.5 + 1e-6 && t < 2 - 1e-6).length === 0,
      `n=${ts2.length}`);
    // from が後ろの周回に食い込むケース（書き出し範囲がループ途中から始まる）
    const ts3 = DAW.objaudio.bakeTimes(pts, 1.1, 2, true);
    okf('B.5 from より前の周回の waypoint は入らない（範囲内だけ展開）',
      ts3[0] === 1.1 && ts3.some(t => Math.abs(t - 1.3) < 1e-6) && !ts3.some(t => t < 1.1 - 1e-9),
      ts3.slice(0, 5).join(','));
  }

  // ---- 保存往復 ----
  {
    const json = JSON.parse(JSON.stringify(O.toJSON()));
    okf('P.10 toJSON に loop が入る', json.find(o => o.id === obj.id).path.loop === true);
    O.load(json);
    const o2 = O.list.find(o => o.id === obj.id);
    okf('P.11 toJSON → load で loop が往復する', o2 && o2.path.loop === true && o2.path.points.length === 3,
      JSON.stringify(o2 && o2.path.loop));
    O.load([{ id: 'x1', path: { enabled: true, points: [{ t: 0, az: 0 }] } }]);
    okf('P.12 loop の無い旧データは false で開く', O.list[0].path.loop === false, O.list[0].path.loop);
    O.load([{ id: 'x2', path: { enabled: true, loop: 1, points: [] } }]);
    okf('P.13 不正な loop 値は真偽値へ落ちる', O.list[0].path.loop === true, typeof O.list[0].path.loop);
  }

  // ---- undo（loop の切替も 1 コミット = 1 エントリ）----
  {
    O.clear();
    const o = O.create('undoループ');
    o.path.enabled = true;
    o.path.points = [
      { t: 0, az: 0, el: 0, dist: 1, ease: 'linear' },
      { t: 1, az: 90, el: 0, dist: 1, ease: 'linear' },
    ];
    DAW.history.reset();
    O.setPathLoop(o.id, true);
    DAW.history.commit();
    okf('P.14 loop 切替はコミット 1 回で履歴 1 エントリ', DAW.history.past.length === 1, DAW.history.past.length);
    await DAW.history.undo();
    okf('P.15 undo で loop=false に戻る', O.list[0].path.loop === false, O.list[0].path.loop);
    await DAW.history.redo();
    okf('P.16 redo で loop=true に戻る', O.list[0].path.loop === true, O.list[0].path.loop);
  }

  okf('P.17 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});

// ---------------------------------------------------------------------
// ループの書き出し（焼き込んだランプがライブの posAt と一致する）
// ---------------------------------------------------------------------
objGenSuite('[45] 経路ループ（書き出し）', async (okf) => {
  const O = DAW.objects;
  const OA = DAW.objaudio;
  const ctx0 = DAW.audio.ensureCtx();
  const SRT = ctx0.sampleRate;

  // 1秒の 440Hz 正弦をトラックに置き、オブジェクトへ割り当てる
  const buf = ctx0.createBuffer(1, SRT, SRT);
  {
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / SRT);
  }
  const bid = DAW.registerBuffer(buf);
  const track = DAW.project.tracks[0];
  track.clips.push({ id: DAW.uid(), bufferId: bid, startTime: 0, offset: 0, duration: 1, name: 'sine', fadeIn: 0, fadeOut: 0 });
  const obj = O.create('ループ音源', track.id);

  const render = async () => {
    H.downloads.length = 0;
    await DAW.wav.exportMix();
    const ab = await H.downloads[H.downloads.length - 1].blob.arrayBuffer();
    return ab;
  };
  const rmsWin = (ab, ch, nch, f0, f1) => {
    const dv = new DataView(ab);
    const frames = (ab.byteLength - 44) / (nch * 2);
    const i0 = Math.round(frames * f0);
    const i1 = Math.round(frames * f1);
    let s = 0;
    for (let i = i0; i < i1; i++) {
      const v = dv.getInt16(44 + (i * nch + ch) * 2, true) / 32768;
      s += v * v;
    }
    return Math.sqrt(s / Math.max(1, i1 - i0));
  };

  // 経路: 0〜0.5s で az +90 → -90（スパン 0.5s）。loop で 1s のクリップを2周する
  obj.path.enabled = true;
  obj.path.loop = true;
  obj.path.points = [
    { t: 0, az: 90, el: 0, dist: 1, ease: 'linear' },
    { t: 0.5, az: -90, el: 0, dist: 1, ease: 'linear' },
  ];

  {
    const ab = await render();
    // 1周目と2周目の同位相の窓は同じ定位・同じ音量になる（ランプがループ展開されている証左）
    const L1 = rmsWin(ab, 0, 2, 0.05, 0.15);
    const R1 = rmsWin(ab, 1, 2, 0.05, 0.15);
    const L2 = rmsWin(ab, 0, 2, 0.55, 0.65);
    const R2 = rmsWin(ab, 1, 2, 0.55, 0.65);
    okf('X.1 1周目前半は L 優勢（+90 側から出発）', L1 > R1 * 2 && L1 > 0.2, `L=${L1.toFixed(4)} R=${R1.toFixed(4)}`);
    okf('X.2 2周目前半も L 優勢（折り返して +90 へ戻っている）', L2 > R2 * 2 && L2 > 0.2,
      `L=${L2.toFixed(4)} R=${R2.toFixed(4)}`);
    okf('X.3 1周目と2周目の同位相の窓は同じ音量（相対差 5% 以内）',
      Math.abs(L1 - L2) / Math.max(L1, L2) < 0.05 && Math.abs(R1 - R2) / Math.max(R1, R2, 1e-6) < 0.3,
      `L1=${L1.toFixed(4)} L2=${L2.toFixed(4)}`);
    const L3 = rmsWin(ab, 0, 2, 0.85, 0.95);
    const R3 = rmsWin(ab, 1, 2, 0.85, 0.95);
    okf('X.4 2周目後半は R 優勢（loop 無しなら -90 ホールドと同じ側）', R3 > L3 * 2 && R3 > 0.2,
      `L=${L3.toFixed(4)} R=${R3.toFixed(4)}`);

    // 焼き込んだランプの定位がライブの posAt（= pathPosAt）と一致することを、
    // 等パワーのゲイン比で数値照合する（窓中心の期待比と実測比）
    const pg = t => {
      const pos = O.posAt(obj, t);
      return OA.panGains(pos.az, pos.el);
    };
    const wantRatio = pg(0.6).l / Math.max(1e-9, pg(0.6).r);   // 2周目・折り返し直後の窓中心
    const gotRatio = rmsWin(ab, 0, 2, 0.58, 0.62) / Math.max(1e-9, rmsWin(ab, 1, 2, 0.58, 0.62));
    okf('X.5 焼き込んだランプの L/R 比がライブ posAt のゲイン比と一致（±25%）',
      Math.abs(gotRatio - wantRatio) / wantRatio < 0.25,
      `want=${wantRatio.toFixed(3)} got=${gotRatio.toFixed(3)}`);
  }

  // ---- 対照: loop 無効なら 0.5s 以降は最後の点（-90 = R）でホールド ----
  {
    obj.path.loop = false;
    const ab = await render();
    const L2 = rmsWin(ab, 0, 2, 0.55, 0.65);
    const R2 = rmsWin(ab, 1, 2, 0.55, 0.65);
    okf('X.6 loop 無効の同じ経路は 0.5s 以降 R ホールド（ループとの差分が音に出る）',
      R2 > 0.3 && L2 < 0.02, `L=${L2.toFixed(4)} R=${R2.toFixed(4)}`);
    obj.path.loop = true;
  }

  // ---- ADM の audioBlockFormat もループを周回ぶん展開する ----
  {
    const blocks = DAW.adm.bakeBlocks(obj, 0, 1);
    const last = blocks[blocks.length - 1];
    okf('X.7 ADM ブロックは until まで続く', Math.abs(last.rtime + last.duration - 1) < 1e-6,
      `末尾=${(last.rtime + last.duration).toFixed(3)}`);
    // 0.75s（2周目の中点 = 1周目の 0.25s と同位相）付近のブロック位置は剰余した経路上
    // （+90 → -90 は最短弧で背面 180 を通るので az ≈ ±180）
    const mid = blocks.find(b => b.rtime > 0.7 && b.rtime + b.duration < 0.8);
    const want = mid && O.posAt(obj, mid.rtime + mid.duration);
    okf('X.8 2周目のブロック位置も剰余した経路（posAt）と一致し背面 ±180 付近を通る',
      mid && Math.abs(mid.az - want.az) < 1e-6 && Math.abs(Math.abs(want.az) - 180) < 30,
      mid ? `az=${mid.az.toFixed(1)} want=${want.az.toFixed(1)}` : 'ブロックなし');
  }

  okf('X.9 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});

// ---------------------------------------------------------------------
// UI（「生成」メニュー / パラメータ枠 / ループ切替 / undo 粒度）
// ---------------------------------------------------------------------
objGenSuite('[45] 軌道ジェネレータ（UI）', async (okf) => {
  const O = DAW.objects;
  const U = DAW.objui;
  const near = (a, b, t) => Math.abs(a - b) <= (t == null ? 1e-9 : t);
  const hist = () => DAW.history.past.length;

  const btn = document.getElementById('obj-path-gen');
  okf('V.1 経路ツールに「生成」ボタンがある', !!btn && btn.parentElement.id === 'obj-path-tools',
    btn && btn.parentElement.id);
  okf('V.2 未選択なら無効', btn.disabled === true);

  const a = O.create('生成UI', DAW.project.tracks[0].id);
  O.select(a.id);
  U.render();
  okf('V.3 選択すると有効になる', !btn.disabled);

  // ---- メニュー（形状4種 + ループ切替）----
  {
    btn.click();
    const menu = document.getElementById('ctx-menu');
    const items = menu ? Array.from(menu.querySelectorAll('.ctx-item')) : [];
    okf('V.4 クリックで形状4種 + ループ切替のメニューが開く', menu && items.length === 5, items.length);
    okf('V.5 ヒントバーにジェネレータの説明が出る',
      (document.getElementById('hint-bar').textContent || '').includes('軌道ジェネレータ'),
      document.getElementById('hint-bar').textContent);
    // 1項目目 = 円 → パラメータ枠が開く
    items[0].click();
    const box = document.getElementById('obj-gen-box');
    okf('V.6 形状を選ぶとパラメータ枠（数値3個 + 生成）が開く',
      box && box.querySelectorAll('input[type="number"]').length === 3 && !!box.querySelector('.ogb-apply'),
      box ? box.querySelectorAll('input').length : 'なし');
  }

  // ---- 生成の実行（既存の点を置き換え・undo 1回で戻る）----
  {
    // 手で組んだ経路を先に置いて「置き換え」を確かめる
    O.setPathEnabled(a.id, true);
    O.addPathPoint(a.id, { t: 0, az: 11, el: 0, dist: 1 });
    U.render();
    DAW.history.reset();
    const h0 = hist();
    const box = document.getElementById('obj-gen-box');
    const inputs = box.querySelectorAll('input[type="number"]');
    inputs[0].value = 2;    // 周期 2s
    inputs[1].value = 1;    // 1回
    inputs[2].value = 30;   // 仰角 30°
    box.querySelector('.ogb-apply').click();
    okf('V.7 「生成」で円の経路に置き換わる（9点・el=30・t は 0.25s 刻み）',
      a.path.points.length === 9 && a.path.points.every(p => p.el === 30) && near(a.path.points[1].t, 0.25),
      `n=${a.path.points.length} el=${a.path.points[0] && a.path.points[0].el}`);
    okf('V.8 経路が自動で有効になる・枠は閉じる',
      a.path.enabled === true && !document.getElementById('obj-gen-box'));
    okf('V.9 生成は履歴 1 エントリ', hist() === h0 + 1, hist());
    okf('V.10 ヒントバーに生成結果が出る',
      (document.getElementById('hint-bar').textContent || '').includes('生成'),
      document.getElementById('hint-bar').textContent);
    await DAW.history.undo();
    const aa = O.get(a.id);
    okf('V.11 undo 1回で生成前の経路（手で置いた1点）に戻る',
      aa.path.points.length === 1 && near(aa.path.points[0].az, 11),
      JSON.stringify(aa.path.points));
    await DAW.history.redo();
    okf('V.12 redo で生成後の経路に戻る', O.get(a.id).path.points.length === 9, O.get(a.id).path.points.length);
  }

  // ---- ループ切替（メニューの5項目目）----
  {
    const h0 = hist();
    const s0 = U.stateSig();
    btn.click();
    const items = Array.from(document.getElementById('ctx-menu').querySelectorAll('.ctx-item'));
    okf('V.13 メニューのループ項目は現在の状態を表示する', items[4].textContent.includes('OFF → ON'),
      items[4].textContent);
    items[4].click();
    const aa = O.get(a.id);
    okf('V.14 ループ切替で path.loop が立ち履歴 1 エントリ', aa.path.loop === true && hist() === h0 + 1,
      `loop=${aa.path.loop} past=${hist()}`);
    okf('V.15 loop の変化で stateSig が変わる（undo 後にビューが追従する）', U.stateSig() !== s0);
    await DAW.history.undo();
    okf('V.16 undo でループ前に戻る', O.get(a.id).path.loop === false, O.get(a.id).path.loop);
    await DAW.history.redo();
  }

  // ---- lock 中の拒否（UI 経由）----
  {
    O.set(a.id, 'lock', 'pos');
    const before = JSON.stringify(O.get(a.id).path.points);
    const h0 = hist();
    okf('V.17 lock 中の生成は拒否され履歴も積まれない',
      U.applyGenerate('circle', 2, 1, 0) === false
      && JSON.stringify(O.get(a.id).path.points) === before && hist() === h0,
      `past=${hist()}`);
    okf('V.18 lock 中のループ切替も拒否', U.togglePathLoop() === false && O.get(a.id).path.loop === true);
    O.set(a.id, 'lock', 'none');
  }

  // ---- 選択が消えたら枠も片付く ----
  {
    U.openGenBox('eight');
    okf('V.19 パラメータ枠が開いている', !!document.getElementById('obj-gen-box'));
    O.remove(a.id);
    U.render();
    okf('V.20 オブジェクトが消えるとボタンは無効・枠は閉じる',
      btn.disabled && !document.getElementById('obj-gen-box'));
  }

  okf('V.21 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
