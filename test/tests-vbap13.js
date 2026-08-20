'use strict';
// =====================================================================
// スピーカーレイアウト拡充（2.0 / 5.0.5.3 = 13ch）+ VBAP N層一般化 と
// ch 別出力メーター / ピーク連動発光 のテスト。
// 他ファイルのヘルパには依存しない。
// =====================================================================

function vbap13Suite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    const savedMode = DAW.objaudio.mode, savedLayout = DAW.objaudio.layoutName, savedAuto = DAW.objaudio.autoHrtf;
    const savedView = DAW.objui && DAW.objui.view;
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.objects.clear();
    DAW.objaudio.autoHrtf = false;
    DAW.addTrack('src');
    DAW.ui.renderTracks();
    DAW.history.reset();
    try { await body(okf); } finally {
      DAW.objaudio.autoHrtf = savedAuto;
      DAW.objaudio.layoutName = savedLayout;
      DAW.objaudio.setModeQuiet(savedMode);
      if (DAW.objui && savedView) DAW.objui.setView(savedView);
      DAW.objects.clear();
      DAW.audio.resetNodes();
      try { DAW.audio.stop(); } catch (e) {}
      if (DAW.objui) { DAW.objui.peaks.clear(); DAW.objui._lastMeter = 0; DAW.objui.render(); }
    }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

// ---------------------------------------------------------------------
// [45] レイアウト拡充と VBAP N層一般化（項目⑦）
// ---------------------------------------------------------------------
vbap13Suite('[45] レイアウト拡充（2.0/13ch）と VBAP N層', async (okf) => {
  const OA = DAW.objaudio;
  const near = (a, b, t) => Math.abs(a - b) <= (t == null ? 1e-6 : t);
  const L20 = OA.LAYOUTS['2.0'];
  const L13 = OA.LAYOUTS['5.0.5.3'];
  const L51 = OA.LAYOUTS['5.1'];
  const L714 = OA.LAYOUTS['7.1.4'];
  const idx = (layout, name) => layout.findIndex(s => s.name === name);
  const psum = g => g.reduce((s, v) => s + v * v, 0);

  // ---- 配置の定義 ----
  okf('N.1 2.0 は L(+30°)/R(-30°) の2本', !!L20 && L20.length === 2
    && L20[0].name === 'L' && L20[0].az === 30 && L20[1].name === 'R' && L20[1].az === -30,
    L20 ? L20.map(s => `${s.name}(${s.az},${s.el})`).join(' ') : 'なし');
  okf('N.2 5.0.5.3 は 13本・LFE なし', !!L13 && L13.length === 13 && L13.every(s => !s.lfe),
    L13 ? `${L13.length}本` : 'なし');
  okf('N.3 13ch の層構成（耳高5 / 上層+30°×5 / 下層-20°×3）',
    L13.filter(s => s.el === 0).length === 5
    && L13.filter(s => s.el === 30).length === 5
    && L13.filter(s => s.el === -20).length === 3,
    L13.map(s => s.el).join(','));
  okf('N.4 13ch のチャンネル順（耳高 → 上層 → 下層）',
    L13.map(s => s.name).join(',') === 'L,R,C,Ls,Rs,Lt,Rt,Ct,Lst,Rst,Lb,Rb,Cb',
    L13.map(s => s.name).join(','));
  okf('N.5 出力チャンネル数が追従する',
    (OA.setModeQuiet(OA.MODE_SPEAKERS), OA.setLayout('2.0'), OA.outputChannels() === 2)
    && (OA.setLayout('5.0.5.3'), OA.outputChannels() === 13)
    && (OA.setLayout('5.1'), OA.outputChannels() === 6));
  OA.setModeQuiet(OA.MODE_EQUALPOWER);

  // ---- 層分割（vbapLayers）----
  {
    const l51 = OA.vbapLayers(L51);
    const l714 = OA.vbapLayers(L714);
    const l13 = OA.vbapLayers(L13);
    okf('N.6 5.1 は1層（LFE 除外で5本）', l51.length === 1 && l51[0].spk.length === 5 && near(l51[0].el, 0));
    okf('N.7 7.1.4 は2層（0° と 45°）', l714.length === 2
      && near(l714[0].el, 0) && l714[0].spk.length === 7
      && near(l714[1].el, 45) && l714[1].spk.length === 4,
      l714.map(l => `${l.el}°x${l.spk.length}`).join(' '));
    okf('N.8 13ch は3層（-20° / 0° / +30°）', l13.length === 3
      && near(l13[0].el, -20) && l13[0].spk.length === 3
      && near(l13[1].el, 0) && l13[1].spk.length === 5
      && near(l13[2].el, 30) && l13[2].spk.length === 5,
      l13.map(l => `${l.el}°x${l.spk.length}`).join(' '));
  }

  // ---- 2.0 のゲイン（等パワー整合）----
  {
    const g = (az, el) => OA.vbapGains(az, el, L20);
    let v = g(30, 0);
    okf('N.9 2.0: az=+30 は L のみ', near(v[0], 1) && near(v[1], 0), v.map(x => x.toFixed(3)).join(','));
    v = g(-30, 0);
    okf('N.10 2.0: az=-30 は R のみ', near(v[1], 1) && near(v[0], 0));
    v = g(0, 0);
    okf('N.11 2.0: 正面は等パワーで半々（各 0.7071）',
      near(v[0], Math.SQRT1_2) && near(v[1], Math.SQRT1_2), v.map(x => x.toFixed(4)).join(','));
    okf('N.12 2.0: どの方位・仰角でもパワー和は1',
      [[0, 0], [30, 0], [90, 0], [180, 0], [-45, 0], [0, 45], [110, -30]]
        .every(([a, e]) => near(psum(g(a, e)), 1)));
    okf('N.13 2.0: 1層なので仰角は水平へ落ちる（el=60 でも同じ配分）',
      near(g(0, 60)[0], Math.SQRT1_2) && near(g(0, 60)[1], Math.SQRT1_2));
  }

  // ---- 13ch のゲイン（各層の既知方位）----
  {
    const g = (az, el) => OA.vbapGains(az, el, L13);
    const only = (v, i) => near(v[i], 1) && v.every((x, k) => k === i || near(x, 0));
    okf('N.14 13ch: az=+30,el=0 は L のみ', only(g(30, 0), idx(L13, 'L')));
    okf('N.15 13ch: az=+110,el=0 は Ls のみ', only(g(110, 0), idx(L13, 'Ls')));
    okf('N.16 13ch: az=+30,el=+30 は Lt のみ', only(g(30, 30), idx(L13, 'Lt')));
    okf('N.17 13ch: az=0,el=-20 は Cb のみ（下層が実際に鳴る）', only(g(0, -20), idx(L13, 'Cb')));
    okf('N.18 13ch: az=+30,el=-20 は Lb のみ', only(g(30, -20), idx(L13, 'Lb')));
    let v = g(0, -10);
    okf('N.19 13ch: el=-10 は C と Cb の等パワー中点（各 0.7071）',
      near(v[idx(L13, 'C')], Math.SQRT1_2, 1e-4) && near(v[idx(L13, 'Cb')], Math.SQRT1_2, 1e-4)
      && near(psum(v), 1),
      `C=${v[idx(L13, 'C')].toFixed(4)} Cb=${v[idx(L13, 'Cb')].toFixed(4)}`);
    v = g(30, 15);
    okf('N.20 13ch: el=+15 は L と Lt の等パワー中点',
      near(v[idx(L13, 'L')], Math.SQRT1_2, 1e-4) && near(v[idx(L13, 'Lt')], Math.SQRT1_2, 1e-4));
    v = g(70, 0);
    okf('N.21 13ch: az=70 は L と Ls の中点（各 0.7071）',
      near(v[idx(L13, 'L')], Math.SQRT1_2, 1e-4) && near(v[idx(L13, 'Ls')], Math.SQRT1_2, 1e-4));
    okf('N.22 13ch: el=+90 は上層へクランプ（Ct のみ）', only(g(0, 90), idx(L13, 'Ct')));
    okf('N.23 13ch: el=-90 は下層へクランプ（Cb のみ）', only(g(0, -90), idx(L13, 'Cb')));
    okf('N.24 13ch: どの位置でもパワー和は1',
      [[0, 0], [45, 10], [110, 25], [180, -20], [-70, -10], [135, 45], [-30, -90], [90, 90], [22, 7]]
        .every(([a, e]) => near(psum(g(a, e)), 1)),
      '9点で確認');
  }

  // ---- 既存レイアウトの回帰（一般化で出力を変えない）----
  {
    const g51 = (az, el) => OA.vbapGains(az, el, L51);
    const g714 = (az, el) => OA.vbapGains(az, el, L714);
    let v = g51(70, 0);
    okf('N.25 回帰: 5.1 az=70 は L/Ls 各 0.7071（従来値）',
      near(v[idx(L51, 'L')], Math.SQRT1_2, 1e-6) && near(v[idx(L51, 'Ls')], Math.SQRT1_2, 1e-6));
    okf('N.26 回帰: 5.1 el=45 は水平へ落ちる（C のみ・従来どおり）', near(g51(0, 45)[idx(L51, 'C')], 1));
    okf('N.27 回帰: 5.1 el=-45 も水平へ落ちる（旧クランプと同値）', near(g51(0, -45)[idx(L51, 'C')], 1));
    // 7.1.4 の層間クロスフェードの数値固定（旧実装 t=el/45 と厳密一致するはずの値）
    v = g714(45, 22.5);
    const c225 = Math.cos(Math.PI / 8), s225 = Math.sin(Math.PI / 8);   // 層内 t=0.25 のペア比
    okf('N.28 回帰: 7.1.4 az=45,el=22.5 の分配値（L/Lss/Ltf）',
      near(v[idx(L714, 'L')], c225 * Math.SQRT1_2, 1e-9)
      && near(v[idx(L714, 'Lss')], s225 * Math.SQRT1_2, 1e-9)
      && near(v[idx(L714, 'Ltf')], Math.SQRT1_2, 1e-9),
      `L=${v[idx(L714, 'L')].toFixed(6)} Lss=${v[idx(L714, 'Lss')].toFixed(6)} Ltf=${v[idx(L714, 'Ltf')].toFixed(6)}`);
    okf('N.29 回帰: 7.1.4 el=45 は上層のみ / el=-30 は水平のみ',
      near(g714(45, 45)[idx(L714, 'Ltf')], 1) && near(g714(30, -30)[idx(L714, 'L')], 1));
    okf('N.30 回帰: 7.1.4 のパワー和は1のまま',
      [[0, 0], [45, 30], [120, 45], [-90, 10], [180, 45]].every(([a, e]) => near(psum(g714(a, e)), 1)));
  }

  // ---- ラウドネスのチャンネル重み（配置から導出）----
  {
    const w13 = DAW.loudness.weightsFor(13);
    okf('N.31 13ch の重みは Ls/Rs(±110°) だけ 1.41',
      w13.length === 13 && near(w13[3], 1.41) && near(w13[4], 1.41)
      && w13.every((v, i) => (i === 3 || i === 4) ? true : near(v, 1)),
      w13.join(','));
    okf('N.32 2ch/6ch/12ch の重みは従来どおり',
      DAW.loudness.weightsFor(2).join(',') === '1,1'
      && DAW.loudness.weightsFor(6).join(',') === '1,1,1,0,1.41,1.41'
      && DAW.loudness.weightsFor(12).join(',') === '1,1,1,0,1.41,1.41,1,1,1,1,1,1');
  }

  // ---- 書き出し（2ch / 13ch の実レンダリング）----
  {
    const ctx0 = DAW.audio.ensureCtx();
    const SRT = ctx0.sampleRate;
    const buf = ctx0.createBuffer(1, SRT / 2, SRT);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / SRT);
    const bid = DAW.registerBuffer(buf);
    const track = DAW.project.tracks[0];
    track.clips = [{ id: DAW.uid(), bufferId: bid, startTime: 0, offset: 0, duration: 0.5, name: 'c', fadeIn: 0, fadeOut: 0 }];
    const obj = DAW.objects.create('o', track.id);
    H.confirmResult = true;

    const renderCh = async () => {
      H.downloads.length = 0;
      await DAW.wav.exportMix();
      const ab = await H.downloads[H.downloads.length - 1].blob.arrayBuffer();
      const dv = new DataView(ab);
      return { ch: dv.getUint16(22, true), bytes: ab };
    };
    const rmsOfCh = (ab, ch, nch) => {
      const dv = new DataView(ab);
      const frames = (ab.byteLength - 44) / (nch * 2);
      let s = 0;
      for (let i = Math.round(frames * 0.1); i < Math.round(frames * 0.9); i++) {
        const v = dv.getInt16(44 + (i * nch + ch) * 2, true) / 32768;
        s += v * v;
      }
      return Math.sqrt(s / (frames * 0.8));
    };

    OA.setModeQuiet(OA.MODE_SPEAKERS);
    OA.setLayout('2.0');
    DAW.objects.setPosition(obj.id, 30, 0, 1);
    let r = await renderCh();
    okf('N.33 2.0 では 2ch の WAV を書き出す', r.ch === 2, `${r.ch}ch`);
    okf('N.34 2.0: az=+30 の音は L チャンネルにだけ出る',
      rmsOfCh(r.bytes, 0, 2) > 0.2 && rmsOfCh(r.bytes, 1, 2) < 0.01,
      `L=${rmsOfCh(r.bytes, 0, 2).toFixed(4)} R=${rmsOfCh(r.bytes, 1, 2).toFixed(4)}`);

    OA.setLayout('5.0.5.3');
    r = await renderCh();
    okf('N.35 5.0.5.3 では 13ch の WAV を書き出す', r.ch === 13, `${r.ch}ch`);
    okf('N.36 13ch: az=+30,el=0 は L（1ch目）だけ',
      rmsOfCh(r.bytes, 0, 13) > 0.2 && rmsOfCh(r.bytes, 5, 13) < 0.01 && rmsOfCh(r.bytes, 10, 13) < 0.01,
      `L=${rmsOfCh(r.bytes, 0, 13).toFixed(4)} Lt=${rmsOfCh(r.bytes, 5, 13).toFixed(4)} Lb=${rmsOfCh(r.bytes, 10, 13).toFixed(4)}`);

    DAW.objects.setPosition(obj.id, 30, -20, 1);
    r = await renderCh();
    okf('N.37 13ch: az=+30,el=-20 は下層 Lb（11ch目）へ実際に鳴る',
      rmsOfCh(r.bytes, 10, 13) > 0.2 && rmsOfCh(r.bytes, 0, 13) < 0.02 && rmsOfCh(r.bytes, 5, 13) < 0.01,
      `Lb=${rmsOfCh(r.bytes, 10, 13).toFixed(4)} L=${rmsOfCh(r.bytes, 0, 13).toFixed(4)}`);

    // 既存レイアウトの書き出し回帰（[30] V.20 と同じ数値傾向のまま）
    OA.setLayout('5.1');
    DAW.objects.setPosition(obj.id, 30, 0, 1);
    r = await renderCh();
    okf('N.38 回帰: 5.1 の書き出しは 6ch・az=+30 は L のみ',
      r.ch === 6 && rmsOfCh(r.bytes, 0, 6) > 0.2 && rmsOfCh(r.bytes, 1, 6) < 0.01,
      `L=${rmsOfCh(r.bytes, 0, 6).toFixed(4)}`);
    OA.setModeQuiet(OA.MODE_EQUALPOWER);
  }
  okf('N.39 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});

// ---------------------------------------------------------------------
// [46] ch 別出力メーターとピーク連動発光（項目①）
// ---------------------------------------------------------------------
vbap13Suite('[46] ch別出力メーター/ピーク発光', async (okf) => {
  const OA = DAW.objaudio;
  const U = DAW.objui;
  const O = DAW.objects;
  const until = async (fn, ms) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (fn()) return true;
      await new Promise(r => setTimeout(r, 50));
    }
    return !!fn();
  };

  // ---- メーター列の生成（本数はレイアウトの ch 数から可変）----
  {
    U.setView('renderer');
    OA.setModeQuiet(OA.MODE_SPEAKERS);
    OA.setLayout('5.1');
    U.render();
    const bars = () => document.querySelectorAll('#obj-chmeters .obj-chm');
    const labels = () => [...bars()].map(b => b.querySelector('span').textContent);
    okf('P.1 スピーカー出力時は配置の ch 数ぶんバーが出る', bars().length === 6, `${bars().length}本`);
    okf('P.2 ラベルは配置のスピーカー名（= WAV のチャンネル順）',
      labels().join(',') === 'L,R,C,LFE,Ls,Rs', labels().join(','));
    OA.setLayout('5.0.5.3');
    U.render();
    okf('P.3 13ch へ切り替えると 13 本に追従する', bars().length === 13, `${bars().length}本`);
    okf('P.4 13ch のラベルも配置どおり', labels().join(',') === 'L,R,C,Ls,Rs,Lt,Rt,Ct,Lst,Rst,Lb,Rb,Cb',
      labels().join(','));
    OA.setLayout('2.0');
    U.render();
    okf('P.5 2.0 は 2 本', bars().length === 2 && labels().join(',') === 'L,R');
    OA.setModeQuiet(OA.MODE_EQUALPOWER);
    U.render();
    okf('P.6 バイノーラル時は L/R の 2 本', bars().length === 2 && labels().join(',') === 'L,R');
    okf('P.7 スピーカー一覧・3D球の番号も同じ配置定義（LAYOUTS が正）を使う',
      U.layoutTable() === OA.LAYOUTS && U.speakers('5.0.5.3').length === 13);
  }

  // ---- ライブ再生での ch 分配（既知方位の正弦波）----
  {
    const ctx0 = DAW.audio.ensureCtx();
    const SRT = ctx0.sampleRate;
    const buf = ctx0.createBuffer(1, SRT * 4, SRT);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / SRT);
    const bid = DAW.registerBuffer(buf);
    const track = DAW.project.tracks[0];
    track.clips = [{ id: DAW.uid(), bufferId: bid, startTime: 0, offset: 0, duration: 4, name: 'c', fadeIn: 0, fadeOut: 0 }];
    const obj = O.create('o', track.id);

    OA.setModeQuiet(OA.MODE_SPEAKERS);
    OA.setLayout('5.1');
    O.setPosition(obj.id, 30, 0, 1);
    await DAW.audio.play();
    const gotL = await until(() => DAW.audio.getChannelLevels(6)[0] > 0.2, 5000);
    let lv = DAW.audio.getChannelLevels(6);
    okf('P.8 az=+30 の正弦波は L メーターだけ振れる',
      gotL && lv[1] < 0.02 && lv[2] < 0.02 && lv[3] < 0.02 && lv[4] < 0.02 && lv[5] < 0.02,
      lv.map(v => v.toFixed(3)).join(','));
    okf('P.9 L のレベルはソース振幅どおり（0.5 ± 許容）', lv[0] > 0.35 && lv[0] < 0.65, lv[0].toFixed(3));

    // ピーク発光: 再生中は peaks が貯まり glow が正になる
    U._lastMeter = 0;
    U.updateMeters(1e9);
    const glow = U.glowOf(obj.id);
    okf('P.10 再生中はピークに応じた発光量になる', glow > 0.3 && glow <= 1, glow.toFixed(3));
    // 3ビューの描画がハロ（drawGlow）に発光量を渡す
    {
      let maxGlow = 0;
      const orig = U.drawGlow;
      U.drawGlow = function (g2, x, y, r, color, gl) { if (gl > maxGlow) maxGlow = gl; return orig.apply(this, arguments); };
      try {
        U.setView('panner');
        U.drawTop(); U.drawFront(); U.drawSphere();
      } finally {
        U.drawGlow = orig;
      }
      okf('P.11 3ビュー（TOP/FRONT/3D球）の描画で発光が乗る', maxGlow > 0.3, maxGlow.toFixed(3));
    }
    DAW.audio.stop();
    okf('P.12 停止中は発光しない（peaks が残っていても 0）', U.glowOf(obj.id) === 0, String(U.glowOf(obj.id)));

    // 13ch の下層がライブでも実際に鳴る（メーターで確認）
    OA.setLayout('5.0.5.3');
    O.setPosition(obj.id, 30, -20, 1);
    await DAW.audio.play();
    const gotLb = await until(() => DAW.audio.getChannelLevels(13)[10] > 0.2, 5000);
    lv = DAW.audio.getChannelLevels(13);
    okf('P.13 13ch: az=+30,el=-20 は Lb（11本目）のメーターだけ振れる',
      gotLb && lv[0] < 0.03 && lv[5] < 0.02 && lv[12] < 0.02,
      `Lb=${lv[10].toFixed(3)} L=${lv[0].toFixed(3)} Lt=${lv[5].toFixed(3)}`);
    DAW.audio.stop();
    OA.setLayout('5.1');
    OA.setModeQuiet(OA.MODE_EQUALPOWER);
  }

  // ---- 発光量のマップ（-60dB → 0、0dB → 1。再生中のみ）----
  {
    const obj = O.list[0];
    const savedPlaying = DAW.audio.playing;
    DAW.audio.playing = true;   // isPlaying() を立てるだけ（ソースは無い）
    try {
      U.peaks.set(obj.id, 1);
      okf('P.14 0dB は発光 1', Math.abs(U.glowOf(obj.id) - 1) < 1e-9);
      U.peaks.set(obj.id, Math.pow(10, -30 / 20));
      okf('P.15 -30dB は発光 0.5', Math.abs(U.glowOf(obj.id) - 0.5) < 1e-9, U.glowOf(obj.id).toFixed(3));
      U.peaks.set(obj.id, Math.pow(10, -60 / 20));
      okf('P.16 -60dB 以下は発光 0', U.glowOf(obj.id) === 0);
      U.peaks.set(obj.id, 0);
      okf('P.17 無音（-∞）は発光 0', U.glowOf(obj.id) === 0);
    } finally {
      DAW.audio.playing = savedPlaying;
    }
    okf('P.18 drawGlow は glow=0 なら何も描かない（例外なく戻る）',
      (() => { U.drawGlow(U.els.top.getContext('2d'), 10, 10, 5, '#fff', 0); return true; })());
  }

  // ---- 停止中の計測は従来どおり可視ストリップのみ（負荷方針の回帰）----
  {
    while (O.count() < 40) O.create();   // 可視ストリップ数 < 全オブジェクト数 の状況を作る
    const savedPeakDb = OA.peakDb;
    let calls = 0;
    OA.peakDb = () => { calls++; return -30; };
    try {
      U.setView('panner');
      U.render();
      U._lastMeter = 0;
      U.updateMeters(2e9);
      okf('P.19 停止中は可視ストリップぶんだけ計測する', calls === U.strips.size && calls < O.count(),
        `計測=${calls} / ストリップ=${U.strips.size} / オブジェクト=${O.count()}`);
      // 再生中はビュー発光のため全オブジェクトを読む（30fps 間引きの中でだけ）
      const savedPlaying = DAW.audio.playing;
      DAW.audio.playing = true;
      calls = 0;
      U._lastMeter = 0;
      U.updateMeters(3e9);
      DAW.audio.playing = savedPlaying;
      okf('P.20 再生中は全オブジェクトぶん計測する（発光用）', calls === O.count(),
        `計測=${calls} / オブジェクト=${O.count()}`);
    } finally {
      OA.peakDb = savedPeakDb;
    }
  }
  okf('P.21 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
