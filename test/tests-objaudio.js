'use strict';
// =====================================================================
// オブジェクトレンダラー（等パワー / HRTF）のテスト。
// 受け入れ条件2「az=±90°の書き出し波形でL/R振幅差を数値検証（等パワー・HRTF両方）」を含む。
// 他ファイルのヘルパには依存しない。
// =====================================================================

function objAudioSuite(group, body) {
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
    DAW.loop.enabled = false; DAW.loop.start = 0; DAW.loop.end = 0;
    DAW.metronome.enabled = false;
    DAW.addTrack('src');
    DAW.ui.renderTracks();
    DAW.history.reset();
    try { await body(okf); } finally {
      DAW.objects.clear();
      DAW.objaudio.mode = DAW.objaudio.MODE_EQUALPOWER;
      DAW.audio.resetNodes();
      try { DAW.audio.stop(); } catch (e) {}
    }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

objAudioSuite('[27] オブジェクトの定位（レンダラー）', async (okf) => {
  const OA = DAW.objaudio, O = DAW.objects;
  const ctx0 = DAW.audio.ensureCtx();
  const SRT = ctx0.sampleRate;
  const near3 = (a, b, t) => Math.abs(a - b) <= t;

  // ---- 極座標 → 直交座標（変換はレンダラー層だけの責務） ----
  {
    const c = (az, el, d) => OA.toCartesian(az, el, d);
    okf('A.1 正面 az=0 は -z 方向', near3(c(0, 0, 1).z, -1, 1e-9) && near3(c(0, 0, 1).x, 0, 1e-9),
      JSON.stringify(c(0, 0, 1)));
    okf('A.2 az=+90（ADM では左）は -x 方向', near3(c(90, 0, 1).x, -1, 1e-9), JSON.stringify(c(90, 0, 1)));
    okf('A.3 az=-90（右）は +x 方向', near3(c(-90, 0, 1).x, 1, 1e-9), JSON.stringify(c(-90, 0, 1)));
    okf('A.4 az=180（後ろ）は +z 方向', near3(c(180, 0, 1).z, 1, 1e-9), JSON.stringify(c(180, 0, 1)));
    okf('A.5 el=+90（真上）は +y 方向', near3(c(0, 90, 1).y, 1, 1e-9), JSON.stringify(c(0, 90, 1)));
    okf('A.6 距離が半径として掛かる', near3(c(0, 0, 0.5).z, -0.5, 1e-9), JSON.stringify(c(0, 0, 0.5)));
    okf('A.7 単位球上にある（|v| = dist）',
      near3(Math.hypot(c(37, 21, 1).x, c(37, 21, 1).y, c(37, 21, 1).z), 1, 1e-9));
  }

  // ---- 等パワーパンのゲイン ----
  {
    const g = (az, el) => OA.panGains(az, el);
    okf('A.8 az=+90 は左いっぱい', near3(g(90, 0).l, 1, 1e-9) && near3(g(90, 0).r, 0, 1e-9),
      `L=${g(90, 0).l.toFixed(4)} R=${g(90, 0).r.toFixed(4)}`);
    okf('A.9 az=-90 は右いっぱい', near3(g(-90, 0).l, 0, 1e-9) && near3(g(-90, 0).r, 1, 1e-9),
      `L=${g(-90, 0).l.toFixed(4)} R=${g(-90, 0).r.toFixed(4)}`);
    okf('A.10 正面は等パワー（各 0.707）',
      near3(g(0, 0).l, Math.SQRT1_2, 1e-9) && near3(g(0, 0).r, Math.SQRT1_2, 1e-9),
      `L=${g(0, 0).l.toFixed(4)} R=${g(0, 0).r.toFixed(4)}`);
    okf('A.11 パワー保存（L²+R²=1）',
      [0, 30, 90, 150, 180, -45].every(a => near3(g(a, 0).l ** 2 + g(a, 0).r ** 2, 1, 1e-9)));
    okf('A.12 真上は左右中央', near3(g(90, 90).l, Math.SQRT1_2, 1e-9), `L=${g(90, 90).l.toFixed(4)}`);
  }

  // ---- 書き出し経路での実測（受け入れ条件2） ----
  // 440Hz の正弦をトラックに置き、オブジェクトへ割り当てて書き出す
  const buf = ctx0.createBuffer(1, SRT, SRT);
  {
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / SRT);
  }
  const bid = DAW.registerBuffer(buf);
  const track = DAW.project.tracks[0];
  track.clips.push({ id: DAW.uid(), bufferId: bid, startTime: 0, offset: 0, duration: 1, name: 'sine', fadeIn: 0, fadeOut: 0 });
  const obj = O.create('テスト音源', track.id);

  const rmsCh = (b, ch) => {
    const a = b.getChannelData(ch);
    let s = 0;
    for (let i = Math.round(0.1 * b.sampleRate); i < Math.round(0.9 * b.sampleRate); i++) s += a[i] * a[i];
    return Math.sqrt(s / (0.8 * b.sampleRate));
  };
  const renderMix = async () => {
    H.downloads.length = 0;
    await DAW.wav.exportMix();
    const ab = await H.downloads[H.downloads.length - 1].blob.arrayBuffer();
    return new OfflineAudioContext(2, 128, new DataView(ab).getUint32(24, true)).decodeAudioData(ab.slice(0));
  };

  // 等パワー
  {
    O.setPosition(obj.id, 90, 0, 1);
    let m = await renderMix();
    let L = rmsCh(m, 0), R = rmsCh(m, 1);
    okf('A.13 [受入2/等パワー] az=+90 は L のみ（R はほぼ無音）',
      L > 0.3 && R < 0.001 && L / Math.max(R, 1e-9) > 100,
      `L=${L.toFixed(4)} R=${R.toFixed(6)} 差=${(20 * Math.log10(L / Math.max(R, 1e-12))).toFixed(1)}dB`);

    O.setPosition(obj.id, -90, 0, 1);
    m = await renderMix();
    L = rmsCh(m, 0); R = rmsCh(m, 1);
    okf('A.14 [受入2/等パワー] az=-90 は R のみ',
      R > 0.3 && L < 0.001 && R / Math.max(L, 1e-9) > 100,
      `L=${L.toFixed(6)} R=${R.toFixed(4)} 差=${(20 * Math.log10(R / Math.max(L, 1e-12))).toFixed(1)}dB`);

    O.setPosition(obj.id, 0, 0, 1);
    m = await renderMix();
    L = rmsCh(m, 0); R = rmsCh(m, 1);
    okf('A.15 [受入2/等パワー] 正面は L=R', near3(L, R, 0.001) && L > 0.2,
      `L=${L.toFixed(4)} R=${R.toFixed(4)}`);

    O.setPosition(obj.id, 45, 0, 1);
    m = await renderMix();
    L = rmsCh(m, 0); R = rmsCh(m, 1);
    okf('A.16 中間角は左が優勢（ADM: 正=左）', L > R * 2 && R > 0.01,
      `L=${L.toFixed(4)} R=${R.toFixed(4)}`);
  }

  // HRTF
  {
    OA.mode = OA.MODE_HRTF;
    O.setPosition(obj.id, 90, 0, 1);
    let m = await renderMix();
    let L = rmsCh(m, 0), R = rmsCh(m, 1);
    const diffL = 20 * Math.log10(L / Math.max(R, 1e-12));
    okf('A.17 [受入2/HRTF] az=+90 は L が明確に優勢', L > R * 1.5 && R > 0,
      `L=${L.toFixed(4)} R=${R.toFixed(4)} 差=${diffL.toFixed(1)}dB`);

    O.setPosition(obj.id, -90, 0, 1);
    m = await renderMix();
    const L2 = rmsCh(m, 0), R2 = rmsCh(m, 1);
    const diffR = 20 * Math.log10(R2 / Math.max(L2, 1e-12));
    okf('A.18 [受入2/HRTF] az=-90 は R が明確に優勢', R2 > L2 * 1.5,
      `L=${L2.toFixed(4)} R=${R2.toFixed(4)} 差=${diffR.toFixed(1)}dB`);
    okf('A.19 [受入2/HRTF] 左右対称（差の大きさがほぼ同じ）', Math.abs(diffL - diffR) < 3,
      `+90側=${diffL.toFixed(1)}dB / -90側=${diffR.toFixed(1)}dB`);

    O.setPosition(obj.id, 0, 0, 1);
    m = await renderMix();
    okf('A.20 [受入2/HRTF] 正面は左右ほぼ同じ',
      near3(rmsCh(m, 0), rmsCh(m, 1), 0.02) && rmsCh(m, 0) > 0.05,
      `L=${rmsCh(m, 0).toFixed(4)} R=${rmsCh(m, 1).toFixed(4)}`);
    OA.mode = OA.MODE_EQUALPOWER;
  }

  // ---- オブジェクトのゲイン / ミュート / ソロ ----
  {
    O.setPosition(obj.id, 0, 0, 1);
    O.set(obj.id, 'gainDb', 0);
    let m = await renderMix();
    const base = rmsCh(m, 0);
    O.set(obj.id, 'gainDb', -6);
    m = await renderMix();
    okf('A.21 gainDb が書き出しに反映される', near3(rmsCh(m, 0) / base, 0.5012, 0.01),
      `比=${(rmsCh(m, 0) / base).toFixed(4)}（-6dB = 0.501）`);
    O.set(obj.id, 'gainDb', 0);

    O.set(obj.id, 'mute', true);
    m = await renderMix();
    okf('A.22 ミュートで無音', rmsCh(m, 0) < 1e-4, `rms=${rmsCh(m, 0).toExponential(2)}`);
    O.set(obj.id, 'mute', false);

    const other = O.create('別オブジェクト');
    O.set(other.id, 'solo', true);
    m = await renderMix();
    okf('A.23 他がソロなら鳴らない', rmsCh(m, 0) < 1e-4, `rms=${rmsCh(m, 0).toExponential(2)}`);
    O.remove(other.id);
  }

  // ---- 未割り当てのトラックは従来経路のまま ----
  {
    obj.trackId = null;
    const m = await renderMix();
    // 従来のステレオ経路（モノラル素材 → StereoPanner の等パワー則で各ch 1/√2）
    okf('A.24 オブジェクト未割り当てのトラックは従来のステレオ経路',
      near3(rmsCh(m, 0), rmsCh(m, 1), 0.001) && rmsCh(m, 0) > 0.2,
      `L=${rmsCh(m, 0).toFixed(4)} R=${rmsCh(m, 1).toFixed(4)}`);
    obj.trackId = track.id;
  }

  // ---- ライブ再生でもノードが作られ、変更が反映される ----
  {
    // ここでは等パワー経路そのものを見たいので、自動 HRTF 切替は切っておく
    OA.autoHrtf = false;
    OA.setModeQuiet(OA.MODE_EQUALPOWER);
    O.setPosition(obj.id, 90, 0, 1);
    await DAW.audio.play();
    okf('A.25 再生でオブジェクトのノードが作られる', OA.live.has(obj.id), `live=${OA.live.size}`);
    const n = OA.live.get(obj.id);
    const pt = n.points[0];
    okf('A.26 等パワー時は L/R ゲインで構成される', !!pt.gl && !!pt.gr && !pt.panner,
      `gl=${pt.gl.gain.value.toFixed(3)} gr=${pt.gr.gain.value.toFixed(3)}`);
    O.setPosition(obj.id, -90, 0, 1);   // onChange 経由でライブへ伝わる
    // setTargetAtTime は指数的に寄せるので、少し実時間を進めてから確認する
    await delay(150);
    okf('A.27 位置変更がライブのノードへ伝わる（左いっぱい → 右いっぱいへ移動中）',
      pt.gl.gain.value < 0.5 && pt.gr.gain.value > 0.5,
      `変更後 gl=${pt.gl.gain.value.toFixed(3)} gr=${pt.gr.gain.value.toFixed(3)}`);
    DAW.audio.stop();
    DAW.audio.resetNodes();
    okf('A.28 リセットでライブのノードも解放される', OA.live.size === 0);
    OA.autoHrtf = true;
  }

  // ---- モード切替 ----
  {
    OA.autoHrtf = false;
    OA.setModeQuiet(OA.MODE_EQUALPOWER);
    okf('A.29 同じモードへの切替は何もしない', OA.setMode(OA.MODE_EQUALPOWER) === false);
    okf('A.30 モードを切り替えるとグラフを組み直す', OA.setMode(OA.MODE_HRTF) === true && OA.mode === OA.MODE_HRTF);
    await DAW.audio.play();
    const n = OA.live.get(obj.id);
    okf('A.31 HRTF 時は PannerNode が使われる',
      !!n && !!n.points[0].panner && n.points[0].panner.panningModel === 'HRTF');
    DAW.audio.stop();
    OA.setMode(OA.MODE_EQUALPOWER);
    OA.autoHrtf = true;
  }
  // ---- HRTF の自動切替（編集中は等パワー・試聴時のみ HRTF） ----
  {
    OA.autoHrtf = true;
    OA.editing = false;
    OA.setModeQuiet(OA.MODE_EQUALPOWER);
    okf('A.33 停止中は等パワー（軽いモード）', OA.wantedMode(false) === OA.MODE_EQUALPOWER);
    okf('A.34 試聴中は HRTF', OA.wantedMode(true) === OA.MODE_HRTF);
    OA.editing = true;
    okf('A.35 編集中は再生中でも等パワー（CPU対策）', OA.wantedMode(true) === OA.MODE_EQUALPOWER);
    OA.editing = false;

    await DAW.audio.play();
    okf('A.36 再生開始で HRTF に切り替わる', OA.mode === OA.MODE_HRTF, OA.mode);
    OA.beginEdit();
    okf('A.37 ドラッグ開始で等パワーへ落ちる', OA.mode === OA.MODE_EQUALPOWER && OA.editing === true, OA.mode);
    okf('A.38 等パワーへ落ちても再生は続く（再スケジュール中も意図は保たれる）',
      DAW.audio.isPlaying() === true, `playing=${DAW.audio.playing} restarting=${DAW.audio.restarting}`);
    OA.endEdit();
    okf('A.39 ドラッグ終了で HRTF に戻る', OA.mode === OA.MODE_HRTF && OA.editing === false, OA.mode);
    DAW.audio.stop();
    okf('A.40 停止で等パワーに戻る', OA.mode === OA.MODE_EQUALPOWER, OA.mode);

    OA.autoHrtf = false;
    OA.setModeQuiet(OA.MODE_HRTF);
    await DAW.audio.play();
    okf('A.41 自動切替を切れば手動指定が保たれる', OA.mode === OA.MODE_HRTF);
    DAW.audio.stop();
    OA.autoHrtf = true;
    OA.setModeQuiet(OA.MODE_EQUALPOWER);
  }

  // ---- ノードの解放（モード切替を繰り返しても積み上がらない） ----
  {
    OA.autoHrtf = false;
    for (let i = 0; i < 10; i++) {
      await DAW.audio.play();
      OA.setMode(i % 2 ? OA.MODE_EQUALPOWER : OA.MODE_HRTF);
      DAW.audio.stop();
    }
    okf('A.42 モード切替を繰り返してもライブのノードが積み上がらない', OA.live.size <= 1, `live=${OA.live.size}`);
    DAW.audio.resetNodes();
    okf('A.43 resetNodes でライブのノードを切り離して捨てる', OA.live.size === 0);
    OA.setModeQuiet(OA.MODE_EQUALPOWER);
    O.setPosition(obj.id, 0, 0, 1);
    const m = await renderMix();
    okf('A.44 切替を繰り返したあとも書き出しは正常', Math.abs(rmsCh(m, 0) - 0.25) < 0.02, rmsCh(m, 0).toFixed(4));
    OA.autoHrtf = true;
  }

  okf('A.32 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
