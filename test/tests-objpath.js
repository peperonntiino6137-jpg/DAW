'use strict';
// =====================================================================
// 経路（位置オートメーション）のテスト。グループ [37]。
//  - モデル: 補間（ease / 最短弧 / ホールド）、編集 API、保存/読み込み、lock、undo 粒度
//  - 書き出し: 経路がランプ列として焼き込まれること（等パワー / VBAP / width）を波形で数値検証
//  - ライブ/UI: followPaths の追従、TOP VIEW での編集操作一式
// 他ファイルのヘルパには依存しない（tests-*.js は名前順に読まれるため）。
// =====================================================================

function objPathSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.project.masterVolume = 1;
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
    DAW.objui.render();
    DAW.history.reset();
    try { await body(okf); } finally {
      DAW.objects.clear();
      DAW.objui.pathEdit = false;
      DAW.objui.pathSel = null;
      DAW.objui.pdrag = null;
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
// モデル
// ---------------------------------------------------------------------
objPathSuite('[37] 経路オートメーション（モデル）', async (okf) => {
  const O = DAW.objects;
  const near = (a, b, t) => Math.abs(a - b) <= (t == null ? 1e-9 : t);

  const obj = O.create('経路テスト');
  okf('M.1 create したオブジェクトは path を持つ（既定は無効・点なし）',
    obj.path && obj.path.enabled === false && Array.isArray(obj.path.points) && obj.path.points.length === 0,
    JSON.stringify(obj.path));

  // ---- posAt: 無効なら静的位置 ----
  O.setPosition(obj.id, 30, 10, 0.5);
  {
    const p = O.posAt(obj, 123);
    okf('M.2 path 無効なら posAt は静的 az/el/dist', p.az === 30 && p.el === 10 && p.dist === 0.5, JSON.stringify(p));
  }

  // ---- ease の補間（u=0.5 の値で式を固定）----
  {
    // az 0 → 80 の1セグメント。ease は「その点から次の点へ」のもの
    const mk = ease => ({ path: { enabled: true, points: [
      { t: 0, az: 0, el: 0, dist: 1, ease },
      { t: 1, az: 80, el: 0, dist: 1, ease: 'linear' },
    ] } });
    okf('M.3 linear は u=0.5 で中点（等速）', near(O.pathPosAt(mk('linear'), 0.5).az, 40),
      O.pathPosAt(mk('linear'), 0.5).az);
    okf('M.4 in（加速 u²）は u=0.5 で 1/4', near(O.pathPosAt(mk('in'), 0.5).az, 20),
      O.pathPosAt(mk('in'), 0.5).az);
    okf('M.5 out（減速 u(2-u)）は u=0.5 で 3/4', near(O.pathPosAt(mk('out'), 0.5).az, 60),
      O.pathPosAt(mk('out'), 0.5).az);
    okf('M.6 inout（S字 u²(3-2u)）は u=0.5 で中点・u=0.25 で加速側',
      near(O.pathPosAt(mk('inout'), 0.5).az, 40) && O.pathPosAt(mk('inout'), 0.25).az < 20 * 1.01,
      `u=.5→${O.pathPosAt(mk('inout'), 0.5).az} u=.25→${O.pathPosAt(mk('inout'), 0.25).az.toFixed(2)}`);
  }

  // ---- 最短弧（±180 跨ぎ）----
  {
    const o = { path: { enabled: true, points: [
      { t: 0, az: 170, el: 0, dist: 1, ease: 'linear' },
      { t: 1, az: -170, el: 0, dist: 1, ease: 'linear' },
    ] } };
    okf('M.7 +170→-170 は 180 経由の最短弧（u=0.5 で ±180）', near(Math.abs(O.pathPosAt(o, 0.5).az), 180),
      O.pathPosAt(o, 0.5).az);
    okf('M.8 u=0.25 は 175（+側を進む）', near(O.pathPosAt(o, 0.25).az, 175), O.pathPosAt(o, 0.25).az);
    okf('M.9 u=0.75 は -175（折り畳んで -側へ）', near(O.pathPosAt(o, 0.75).az, -175), O.pathPosAt(o, 0.75).az);
    okf('M.10 azLerp の結果は (-180,180] に畳まれる',
      [[170, -170, 0.5], [0, 350, 0.5], [-90, 90, 0.999]].every(([a, b, u]) => {
        const v = O.azLerp(a, b, u);
        return v > -180 - 1e-9 && v <= 180 + 1e-9;
      }));
  }

  // ---- ホールド（範囲外は端の位置）----
  {
    const o = { path: { enabled: true, points: [
      { t: 1, az: 10, el: 5, dist: 0.4, ease: 'linear' },
      { t: 2, az: 90, el: 0, dist: 1, ease: 'linear' },
    ] } };
    const before = O.pathPosAt(o, 0);
    const after = O.pathPosAt(o, 99);
    okf('M.11 最初の点より前は最初の点でホールド', before.az === 10 && before.el === 5 && before.dist === 0.4,
      JSON.stringify(before));
    okf('M.12 最後の点より後は最後の点でホールド', after.az === 90 && after.dist === 1, JSON.stringify(after));
  }

  // ---- 編集 API ----
  O.setPathEnabled(obj.id, true);
  okf('M.13 setPathEnabled で有効化できる', obj.path.enabled === true);
  {
    const p1 = O.addPathPoint(obj.id, { t: 1, az: 0, el: 0, dist: 1 });
    const p0 = O.addPathPoint(obj.id, { t: 0.5, az: 90, el: 0, dist: 0.5 });
    okf('M.14 addPathPoint は t 昇順に挿入される',
      obj.path.points[0] === p0 && obj.path.points[1] === p1,
      obj.path.points.map(p => p.t).join(','));
    const dup = O.addPathPoint(obj.id, { t: 1, az: 45 });
    okf('M.15 同時刻の追加は最小間隔 0.05s ぶん押し出される', near(dup.t, 1.05),
      `t=${dup.t}`);
    okf('M.16 押し出された点も昇順の位置に入る', obj.path.points[2] === dup,
      obj.path.points.map(p => p.t).join(','));

    O.movePathPoint(obj.id, 0, 200, 100, 2);
    okf('M.17 movePathPoint は normalize/clamp を通す（az 折返し・dist 上限）',
      near(obj.path.points[0].az, 20) && near(obj.path.points[0].el, 80) && obj.path.points[0].dist === 1,
      JSON.stringify(obj.path.points[0]));

    O.setPathPointTime(obj.id, 1, 0.51);
    okf('M.18 時刻は前の点 +0.05s でクランプ', near(obj.path.points[1].t, 0.55), obj.path.points[1].t);
    O.setPathPointTime(obj.id, 1, 99);
    okf('M.19 時刻は次の点 -0.05s でクランプ', near(obj.path.points[1].t, 1.0), obj.path.points[1].t);
    O.setPathPointTime(obj.id, 0, -5);
    okf('M.20 先頭の点は 0 まで', obj.path.points[0].t === 0, obj.path.points[0].t);

    okf('M.21 cyclePathEase は linear→in→out→inout→linear と循環する',
      ['in', 'out', 'inout', 'linear'].every(want => {
        O.cyclePathEase(obj.id, 0);
        return obj.path.points[0].ease === want;
      }), obj.path.points[0].ease);

    O.removePathPoint(obj.id, 2);
    okf('M.22 removePathPoint で点が減る', obj.path.points.length === 2, obj.path.points.length);
  }

  // ---- lock（位置編集と同じ扱い: 'none' のみ可）----
  {
    O.set(obj.id, 'lock', 'pos');
    const n = obj.path.points.length;
    const az0 = obj.path.points[0].az;
    okf('M.23 lock 中は経路を編集できない（add/move/time/ease/remove/enable すべて拒否）',
      O.addPathPoint(obj.id, { t: 9 }) === null
      && O.movePathPoint(obj.id, 0, 0, 0, 0) === false
      && O.setPathPointTime(obj.id, 0, 0.3) === false
      && O.cyclePathEase(obj.id, 0) === false
      && O.removePathPoint(obj.id, 0) === false
      && O.setPathEnabled(obj.id, false) === false
      && obj.path.points.length === n && obj.path.points[0].az === az0 && obj.path.enabled === true);
    O.set(obj.id, 'lock', 'none');
  }

  // ---- toJSON / load ----
  {
    const json = JSON.parse(JSON.stringify(O.toJSON()));
    O.load(json);
    const o2 = O.list.find(o => o.id === obj.id);
    okf('M.24 toJSON → load で経路が往復する',
      o2 && o2.path.enabled === true && o2.path.points.length === 2
      && near(o2.path.points[0].t, 0) && near(o2.path.points[1].t, 1.0)
      && near(o2.path.points[0].az, 20) && o2.path.points[0].ease === 'linear',
      JSON.stringify(o2 && o2.path));

    O.load([{ id: 'x1', az: 0 }]);
    okf('M.25 path の無い旧データは {enabled:false, points:[]} で開く',
      O.list[0].path && O.list[0].path.enabled === false && O.list[0].path.points.length === 0,
      JSON.stringify(O.list[0].path));

    O.load([{ id: 'x2', path: { enabled: 1, points: [
      { t: 2, az: 500, el: 100, dist: 7, ease: 'zigzag' },
      { t: -3, az: 0, el: 0, dist: 0.5, ease: 'in' },
      { t: 0.02, az: 10 },
      'こわれた点',
    ] } }]);
    const p = O.list[0].path;
    okf('M.26 load は t を昇順に並べ直す', p.points.every((q, i) => i === 0 || q.t >= p.points[i - 1].t),
      p.points.map(q => q.t).join(','));
    okf('M.27 load は同時刻（0.05s 未満）を押し出す',
      p.points.every((q, i) => i === 0 || q.t - p.points[i - 1].t >= O.PATH_MIN_DT - 1e-9),
      p.points.map(q => q.t.toFixed(2)).join(','));
    okf('M.28 不正な ease は linear、負の t は 0、範囲外の az/el/dist は正規化・クランプ',
      p.points[0].t === 0 && p.points[0].ease === 'in'
      && p.points.every(q => q.ease === 'linear' || q.ease === 'in')
      && p.points.every(q => q.az > -180 - 1e-9 && q.az <= 180 + 1e-9 && Math.abs(q.el) <= 90 && q.dist >= 0 && q.dist <= 1),
      JSON.stringify(p.points));
    okf('M.29 enabled は真偽値へ落ちる', p.enabled === true, typeof p.enabled);
  }

  // ---- undo の粒度（連続 move → commit 1回で 1 エントリ）----
  {
    O.clear();
    const o = O.create('undoテスト');
    O.setPathEnabled(o.id, true);
    O.addPathPoint(o.id, { t: 0, az: 0, el: 0, dist: 1 });
    DAW.history.reset();
    for (let i = 1; i <= 10; i++) O.movePathPoint(o.id, 0, i * 5, 0, null);
    okf('M.30 commit していなければ履歴は積まれない', !DAW.history.canUndo(), DAW.history.past.length);
    DAW.history.commit();
    okf('M.31 連続 move → commit 1回で undo 1エントリ', DAW.history.past.length === 1, DAW.history.past.length);
    await DAW.history.undo();
    okf('M.32 undo で move 前の経路に戻る', near(O.list[0].path.points[0].az, 0),
      O.list[0].path.points[0].az);
    await DAW.history.redo();
    okf('M.33 redo で move 後の経路に戻る', near(O.list[0].path.points[0].az, 50),
      O.list[0].path.points[0].az);
  }

  okf('M.34 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});

// ---------------------------------------------------------------------
// 書き出し（経路の焼き込み）
// ---------------------------------------------------------------------
objPathSuite('[37] 経路オートメーション（書き出し）', async (okf) => {
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
  const obj = O.create('経路音源', track.id);

  // 書き出して 16bit PCM を直接読む（多チャンネルは decodeAudioData が畳むため raw で見る）
  const render = async () => {
    H.downloads.length = 0;
    await DAW.wav.exportMix();
    const ab = await H.downloads[H.downloads.length - 1].blob.arrayBuffer();
    const dv = new DataView(ab);
    return { ch: dv.getUint16(22, true), bytes: ab };
  };
  // 全長に対する割合 [f0, f1) の区間の ch の RMS
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

  const setPath = points => {
    obj.path.points = points.map(p => Object.assign({ el: 0, dist: 1, ease: 'linear' }, p));
    obj.path.enabled = true;
  };

  // ---- 等パワー: az +90 → -90 の全長移動 ----
  {
    setPath([{ t: 0, az: 90 }, { t: 1, az: -90 }]);
    const r = await render();
    const L0 = rmsWin(r.bytes, 0, 2, 0.02, 0.3);
    const R0 = rmsWin(r.bytes, 1, 2, 0.02, 0.3);
    const L1 = rmsWin(r.bytes, 0, 2, 0.7, 0.98);
    const R1 = rmsWin(r.bytes, 1, 2, 0.7, 0.98);
    okf('E.1 [等パワー] 前半は L 優勢（+90 側から出発）', L0 > R0 * 2 && L0 > 0.2,
      `L=${L0.toFixed(4)} R=${R0.toFixed(4)}`);
    okf('E.2 [等パワー] 後半は R 優勢（-90 へ到達）', R1 > L1 * 2 && R1 > 0.2,
      `L=${L1.toFixed(4)} R=${R1.toFixed(4)}`);
    const Lm = rmsWin(r.bytes, 0, 2, 0.45, 0.55);
    const Rm = rmsWin(r.bytes, 1, 2, 0.45, 0.55);
    okf('E.3 [等パワー] 中間は正面相当（L≈R で両方鳴る）', Math.abs(Lm - Rm) < 0.05 && Lm > 0.15,
      `L=${Lm.toFixed(4)} R=${Rm.toFixed(4)}`);
    okf('E.4 書き出し後に exportRange が戻っている', OA.exportRange === null, String(OA.exportRange));
  }

  // ---- ホールド（1点だけの経路は全長その位置に定位）----
  {
    setPath([{ t: 0.5, az: 90 }]);
    const r = await render();
    const L0 = rmsWin(r.bytes, 0, 2, 0.02, 0.4);
    const R0 = rmsWin(r.bytes, 1, 2, 0.02, 0.4);
    const L1 = rmsWin(r.bytes, 0, 2, 0.6, 0.98);
    const R1 = rmsWin(r.bytes, 1, 2, 0.6, 0.98);
    okf('E.5 [ホールド] 点の前後とも同じ定位（az=+90 → L のみ）',
      L0 > 0.3 && R0 < 0.005 && L1 > 0.3 && R1 < 0.005,
      `前 L=${L0.toFixed(4)}/R=${R0.toFixed(5)} 後 L=${L1.toFixed(4)}/R=${R1.toFixed(5)}`);
  }

  // ---- ライブと書き出しの意味論: 無効なら静的位置のまま ----
  {
    obj.path.enabled = false;
    O.setPosition(obj.id, -90, 0, 1);
    const r = await render();
    okf('E.6 path 無効なら静的位置で書き出される（az=-90 → R のみ）',
      rmsWin(r.bytes, 1, 2, 0.1, 0.9) > 0.3 && rmsWin(r.bytes, 0, 2, 0.1, 0.9) < 0.005,
      `L=${rmsWin(r.bytes, 0, 2, 0.1, 0.9).toFixed(5)} R=${rmsWin(r.bytes, 1, 2, 0.1, 0.9).toFixed(4)}`);
    O.setPosition(obj.id, 0, 0, 1);
  }

  // ---- VBAP（5.1）: スピーカー跨ぎでもパワー和がほぼ一定 ----
  {
    OA.setModeQuiet(OA.MODE_SPEAKERS);
    OA.layoutName = '5.1';
    setPath([{ t: 0, az: 0 }, { t: 1, az: 110 }]);   // C → L → Ls と2本のペアを跨ぐ
    const r = await render();
    okf('E.7 [VBAP] 5.1 の 6ch で書き出される', r.ch === 6, `${r.ch}ch`);
    const power = (f0, f1) => {
      let s = 0;
      for (let c = 0; c < 6; c++) { const v = rmsWin(r.bytes, c, 6, f0, f1); s += v * v; }
      return s;
    };
    const p0 = power(0.05, 0.15);
    const p1 = power(0.45, 0.55);
    const p2 = power(0.85, 0.95);
    const ratio = Math.max(p0, p1, p2) / Math.max(1e-12, Math.min(p0, p1, p2));
    okf('E.8 [VBAP] 移動中もパワー和がほぼ一定（跨ぎで音量が凹まない）', ratio < 1.3,
      `p=${p0.toExponential(2)}/${p1.toExponential(2)}/${p2.toExponential(2)} 比=${ratio.toFixed(3)}`);
    okf('E.9 [VBAP] 出発点は C、終点は Ls が優勢',
      rmsWin(r.bytes, 2, 6, 0.02, 0.1) > 0.2 && rmsWin(r.bytes, 4, 6, 0.9, 0.98) > 0.2,
      `C=${rmsWin(r.bytes, 2, 6, 0.02, 0.1).toFixed(4)} Ls=${rmsWin(r.bytes, 4, 6, 0.9, 0.98).toFixed(4)}`);
    OA.setModeQuiet(OA.MODE_EQUALPOWER);
  }

  // ---- width ≠ 0: 2ソースの両方が経路に追従する ----
  {
    O.set(obj.id, 'width', 100);
    setPath([{ t: 0, az: 90 }, { t: 1, az: -90 }]);
    const r = await render();
    const L0 = rmsWin(r.bytes, 0, 2, 0.02, 0.2);
    const R0 = rmsWin(r.bytes, 1, 2, 0.02, 0.2);
    const L1 = rmsWin(r.bytes, 0, 2, 0.8, 0.98);
    const R1 = rmsWin(r.bytes, 1, 2, 0.8, 0.98);
    okf('E.10 [width] 広がりごと L 側 → R 側へ移動する', L0 > R0 * 1.5 && R1 > L1 * 1.5,
      `前 L=${L0.toFixed(4)}/R=${R0.toFixed(4)} 後 L=${L1.toFixed(4)}/R=${R1.toFixed(4)}`);
    okf('E.11 [width] 2ソースなので反対側も無音にはならない', R0 > 0.02 && L1 > 0.02,
      `R0=${R0.toFixed(4)} L1=${L1.toFixed(4)}`);
    O.set(obj.id, 'width', 0);
  }

  // ---- bakeTimes（ホールド区間の省略と waypoint 時刻の包含）----
  {
    const pts = [
      { t: 2, az: 0, el: 0, dist: 1, ease: 'linear' },
      { t: 2.5, az: 90, el: 0, dist: 1, ease: 'linear' },
    ];
    const ts = OA.bakeTimes(pts, 0, 10);
    okf('E.12 ホールド区間には刻みを入れない（前=区間端のみ・移動中だけ 20ms 刻み）',
      ts[0] === 0 && ts[1] === 2 && ts[ts.length - 1] === 10 && Math.abs(ts[ts.length - 2] - 2.5) < 1e-3
      && ts.length < 0.5 / OA.PATH_BAKE_DT + 6,
      `n=${ts.length} 先頭=${ts.slice(0, 3).join(',')} 末尾=${ts.slice(-3).join(',')}`);
    okf('E.13 時刻列は昇順かつ重複なし',
      ts.every((t, i) => i === 0 || t > ts[i - 1]),
      ts.length);
  }

  okf('E.14 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});

// ---------------------------------------------------------------------
// ライブ追従と UI
// ---------------------------------------------------------------------
objPathSuite('[37] 経路オートメーション（ライブ/UI）', async (okf) => {
  const O = DAW.objects;
  const OA = DAW.objaudio;
  const U = DAW.objui;
  const near = (a, b, t) => Math.abs(a - b) <= (t == null ? 1e-9 : t);

  // ---- followPaths（ライブ追従）----
  {
    const ctx0 = DAW.audio.ensureCtx();
    const SRT = ctx0.sampleRate;
    const buf = ctx0.createBuffer(1, SRT, SRT);
    const d0 = buf.getChannelData(0);
    for (let i = 0; i < d0.length; i++) d0[i] = 0.3 * Math.sin(2 * Math.PI * 220 * i / SRT);
    const bid = DAW.registerBuffer(buf);
    const track = DAW.project.tracks[0];
    track.clips.push({ id: DAW.uid(), bufferId: bid, startTime: 0, offset: 0, duration: 1, name: 's', fadeIn: 0, fadeOut: 0 });
    const obj = O.create('ライブ', track.id);
    obj.path.enabled = true;
    obj.path.points = [
      { t: 0, az: 90, el: 0, dist: 1, ease: 'linear' },
      { t: 1, az: -90, el: 0, dist: 1, ease: 'linear' },
    ];

    const calls = [];
    const orig = OA.applyObjPosition;
    OA.applyObjPosition = function (nodes, o, pos, t) { calls.push({ id: o.id, pos }); return orig.call(this, nodes, o, pos, t); };
    try {
      okf('L.1 停止中の followPaths は no-op', (OA.followPaths(), calls.length === 0), calls.length);

      OA.autoHrtf = false;
      OA.setModeQuiet(OA.MODE_EQUALPOWER);
      await DAW.audio.play();
      calls.length = 0;
      OA.followPaths();
      okf('L.2 再生中は経路オブジェクトへ applyObjPosition が飛ぶ',
        calls.length === 1 && calls[0].id === obj.id, `calls=${calls.length}`);
      okf('L.3 渡される位置は pathPosAt の値（出発直後は +90 付近）',
        calls.length === 1 && calls[0].pos.az > 45, calls.length ? calls[0].pos.az : '-');

      obj.path.enabled = false;
      calls.length = 0;
      OA.followPaths();
      okf('L.4 path 無効のオブジェクトには飛ばない', calls.length === 0, calls.length);
      obj.path.enabled = true;

      DAW.audio.stop();
      calls.length = 0;
      OA.followPaths();
      okf('L.5 停止すると再び no-op', calls.length === 0, calls.length);
    } finally {
      OA.applyObjPosition = orig;
      OA.autoHrtf = true;
      DAW.audio.resetNodes();
    }
    // 後続の UI テストのために片付ける
    track.clips.length = 0;
    O.clear();
    DAW.audio.playheadPos = 0;
    U.render();
    DAW.history.reset();
  }

  // ---- UI（TOP VIEW での経路編集）----
  const canvas = document.getElementById('obj-top');
  const pev = (type, x, y, opts) => {
    canvas.dispatchEvent(new PointerEvent(type, Object.assign({
      bubbles: true, cancelable: true, pointerId: 1, button: 0,
      clientX: Math.round(x), clientY: Math.round(y),
    }, opts)));
  };
  const rclick = (x, y) => {
    canvas.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2,
      clientX: Math.round(x), clientY: Math.round(y),
    }));
  };
  const btnEnable = document.getElementById('obj-path-enable');
  const btnEdit = document.getElementById('obj-path-edit');
  okf('U.1 TOP VIEW ヘッダに「経路」「編集」トグルがある', !!btnEnable && !!btnEdit,
    `enable=${!!btnEnable} edit=${!!btnEdit}`);
  okf('U.2 未選択なら両ボタンとも無効', btnEnable.disabled && btnEdit.disabled);

  const a = O.create('経路UI', DAW.project.tracks[0].id);
  O.select(a.id);
  U.render();
  okf('U.3 選択すると有効になる', !btnEnable.disabled && !btnEdit.disabled);

  const hist = () => DAW.history.past.length;
  {
    const h0 = hist();
    btnEnable.click();
    okf('U.4 「経路」クリックで path.enabled が切り替わり履歴1エントリ',
      a.path.enabled === true && btnEnable.classList.contains('on') && hist() === h0 + 1,
      `enabled=${a.path.enabled} past=${hist()}`);
    btnEdit.click();
    okf('U.5 「編集」クリックで編集モードに入る', U.pathEdit === true && btnEdit.classList.contains('on'));
  }

  // ---- 空きクリックで waypoint 追加（座標と時刻）----
  {
    const g = U.topGeom();
    const h0 = hist();
    pev('pointerdown', g.cx, g.cy - g.R * 0.5);   // 正面 az=0 dist=0.5
    pev('pointerup', g.cx, g.cy - g.R * 0.5);
    okf('U.6 空きクリックで waypoint が追加される（az/dist はクリック位置）',
      a.path.points.length === 1 && near(a.path.points[0].az, 0, 2) && near(a.path.points[0].dist, 0.5, 0.02),
      JSON.stringify(a.path.points[0]));
    okf('U.7 ヘッドが 0 のままなら最初の点は t=0', a.path.points[0].t === 0, a.path.points[0].t);
    okf('U.8 追加は直後に履歴1エントリ', hist() === h0 + 1, hist());

    pev('pointerdown', g.cx - g.R * 0.9, g.cy);   // 左 az=+90 dist=0.9
    pev('pointerup', g.cx - g.R * 0.9, g.cy);
    okf('U.9 2点目は 1s 間隔で末尾へ（t=1）',
      a.path.points.length === 2 && a.path.points[1].t === 1 && near(a.path.points[1].az, 90, 2),
      JSON.stringify(a.path.points[1]));
    okf('U.10 追加した点が選択され時間チップの対象になる', U.pathSel === 1, U.pathSel);

    // 再生ヘッドを動かすと max(ヘッド, 最終点+0.1) になる
    DAW.audio.playheadPos = 5;
    pev('pointerdown', g.cx, g.cy + g.R * 0.7);   // 背後 az=180 dist=0.7
    pev('pointerup', g.cx, g.cy + g.R * 0.7);
    okf('U.11 ヘッドがあるときは max(ヘッド位置, 最終点+0.1s)', a.path.points[2].t === 5, a.path.points[2].t);
    DAW.audio.playheadPos = 0;
    rclick(U.posToXY(a.path.points[2].az, a.path.points[2].dist, U.topGeom()).x,
           U.posToXY(a.path.points[2].az, a.path.points[2].dist, U.topGeom()).y);
  }

  // ---- waypoint のドラッグ（pointerup で commit 1回）----
  {
    const g = U.topGeom();
    const h0 = hist();
    const p0 = U.posToXY(a.path.points[0].az, a.path.points[0].dist, g);
    pev('pointerdown', p0.x, p0.y);
    pev('pointermove', g.cx + g.R * 0.8, g.cy);   // 右 az=-90 dist=0.8
    okf('U.12 ドラッグ中は履歴を積まない', hist() === h0, hist());
    pev('pointermove', g.cx + g.R * 0.9, g.cy);
    pev('pointerup', g.cx + g.R * 0.9, g.cy);
    okf('U.13 waypoint ドラッグで az/dist が動く（az=-90, dist=0.9）',
      near(a.path.points[0].az, -90, 2) && near(a.path.points[0].dist, 0.9, 0.02),
      JSON.stringify(a.path.points[0]));
    okf('U.14 ドラッグ全体で履歴は1エントリ', hist() === h0 + 1, hist());
    await DAW.history.undo();
    const aa = O.get(a.id);
    okf('U.15 undo 1回でドラッグ前の経路に戻る（stateSig に path が入っている証左）',
      near(aa.path.points[0].az, 0, 2) && near(aa.path.points[0].dist, 0.5, 0.02),
      JSON.stringify(aa.path.points[0]));
    await DAW.history.redo();
  }

  // ---- stateSig が経路の変化を拾う ----
  {
    const s0 = U.stateSig();
    O.movePathPoint(a.id, 0, 45, null, null);
    okf('U.16 waypoint の変化で stateSig が変わる', U.stateSig() !== s0);
    U.sync();
    O.movePathPoint(a.id, 0, -90, null, 0.9);
    U.sync();
  }

  // ---- 時間チップのドラッグ（8px = 0.1s）----
  {
    const obj = O.get(a.id);
    U.pathSel = 0;
    U.render();
    const g = U.topGeom();
    const wp = U.posToXY(obj.path.points[0].az, obj.path.points[0].dist, g);
    const chip = U.chipRect(wp.x, wp.y, obj.path.points[0].t);
    const cx = chip.x + chip.w / 2;
    const cy = chip.y + chip.h / 2;
    const h0 = hist();
    pev('pointerdown', cx, cy);
    pev('pointermove', cx + 120, cy);   // +120px = +1.5s だが次の点 -0.05s でクランプ
    pev('pointerup', cx + 120, cy);
    okf('U.17 時間チップの右ドラッグで時刻が進む（前後 ±0.05s でクランプ）',
      near(obj.path.points[0].t, 0.95), obj.path.points[0].t);
    okf('U.18 チップのドラッグも履歴1エントリ', hist() === h0 + 1, hist());
    pev('pointerdown', cx, cy);
    pev('pointermove', cx - 400, cy);
    pev('pointerup', cx - 400, cy);
    okf('U.19 左いっぱいへ戻すと 0 まで', obj.path.points[0].t === 0, obj.path.points[0].t);
  }

  // ---- セグメント中点のクリックで ease 循環 ----
  {
    const obj = O.get(a.id);
    const g = U.topGeom();
    const mid = U.posToXY(
      O.pathSegPos(obj.path.points[0], obj.path.points[1], 0.5).az,
      O.pathSegPos(obj.path.points[0], obj.path.points[1], 0.5).dist, g);
    const h0 = hist();
    pev('pointerdown', mid.x, mid.y);
    pev('pointerup', mid.x, mid.y);
    okf('U.20 セグメント中点のクリックで ease が循環する（linear → in）',
      obj.path.points[0].ease === 'in', obj.path.points[0].ease);
    okf('U.21 ease の切替は直後に履歴1エントリ', hist() === h0 + 1, hist());
  }

  // ---- 右クリックで waypoint 削除 ----
  {
    const obj = O.get(a.id);
    const n0 = obj.path.points.length;
    const g = U.topGeom();
    const wp = U.posToXY(obj.path.points[1].az, obj.path.points[1].dist, g);
    const h0 = hist();
    rclick(wp.x, wp.y);
    okf('U.22 waypoint の右クリックで削除される', obj.path.points.length === n0 - 1,
      `${n0} → ${obj.path.points.length}`);
    okf('U.23 削除は直後に履歴1エントリ', hist() === h0 + 1, hist());
  }

  // ---- 通常モードでは経路オブジェクトをドラッグできない ----
  {
    btnEdit.click();   // 編集モードを抜ける
    okf('U.24 「編集」を再クリックで編集モードを抜ける', U.pathEdit === false);
    const obj = O.get(a.id);
    const az0 = obj.az;
    const p0 = JSON.stringify(obj.path.points);
    const g = U.topGeom();
    pev('pointerdown', g.cx + g.R * 0.3, g.cy + g.R * 0.3);
    pev('pointermove', g.cx - g.R * 0.6, g.cy);
    pev('pointerup', g.cx - g.R * 0.6, g.cy);
    okf('U.25 path 有効中は通常ドラッグで動かない（静的位置も waypoint も不変）',
      obj.az === az0 && JSON.stringify(obj.path.points) === p0,
      `az=${obj.az}`);
    okf('U.26 path 有効中はストリップの Az/El が無効化される（理由の title 付き）', (() => {
      const s = document.querySelector(`#obj-strips .obj-strip[data-obj-id="${a.id}"]`);
      if (!s) return false;
      const az = s.querySelector('.os-in-az');
      const el = s.querySelector('.os-in-el');
      const wd = s.querySelector('.os-in-width');
      return az.disabled && el.disabled && !wd.disabled && az.title.length > 0;
    })());
  }

  // ---- lock 中は経路も編集できない（UI 経由）----
  {
    const obj = O.get(a.id);
    O.set(a.id, 'lock', 'pos');
    U.pathEdit = true;
    U.render();
    const n0 = obj.path.points.length;
    const g = U.topGeom();
    pev('pointerdown', g.cx + g.R * 0.6, g.cy - g.R * 0.6);
    pev('pointerup', g.cx + g.R * 0.6, g.cy - g.R * 0.6);
    okf('U.27 lock 中は空きクリックでも waypoint が増えない', obj.path.points.length === n0,
      obj.path.points.length);
    O.set(a.id, 'lock', 'none');
    U.pathEdit = false;
    U.render();
  }

  okf('U.28 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
