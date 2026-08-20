'use strict';
// =====================================================================
// 追加プラグイン（コンプレッサー / リバーブ）のテスト。
// 他ファイルのヘルパには依存しない（tests-*.js は名前順に読まれるため）。
// =====================================================================

function plugin2Suite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.addTrack();
    DAW.ui.renderTracks();
    DAW.history.reset();
    try { await body(okf); } finally { try { DAW.audio.stop(); } catch (e) {} }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

plugin2Suite('[22] コンプレッサー / リバーブ', async (okf) => {
  const SRT = DAW.audio.ensureCtx().sampleRate;
  const rmsOf2 = (a, from, to) => {
    from = from || 0; to = to === undefined ? a.length : to;
    let s = 0;
    for (let i = from; i < to; i++) s += a[i] * a[i];
    return Math.sqrt(s / (to - from));
  };
  // プラグイン1つを通した2秒ぶんのレンダリング
  const render = async (id, params, fill, seconds) => {
    seconds = seconds || 2;
    const off = new OfflineAudioContext(1, Math.round(SRT * seconds), SRT);
    const buf = off.createBuffer(1, Math.round(SRT * seconds), SRT);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = fill(i / SRT);
    const def = DAW.plugins.get(id);
    const p = Object.assign(DAW.plugins.defaultParams(def), params || {});
    if (def.prepare) await def.prepare(off);
    const inst = def.create(off, p);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(inst.input);
    inst.output.connect(off.destination);
    src.start(0);
    return (await off.startRendering()).getChannelData(0);
  };
  const sine = (f, a) => t => a * Math.sin(2 * Math.PI * f * t);

  okf('P.1 コンプレッサーが登録されている', !!DAW.plugins.get('comp'));
  okf('P.2 リバーブが登録されている', !!DAW.plugins.get('reverb'));

  // --- コンプレッサー ---
  {
    const loud = await render('comp', { threshold: -24, ratio: 8, makeup: 1 }, sine(440, 0.9));
    const quiet = await render('comp', { threshold: -24, ratio: 8, makeup: 1 }, sine(440, 0.02));
    const rLoud = rmsOf2(loud, SRT, 2 * SRT);      // アタック後の定常部
    const rQuiet = rmsOf2(quiet, SRT, 2 * SRT);
    okf('P.3 しきい値を超える大音量は圧縮される', rLoud < 0.9 / Math.SQRT2 * 0.8,
      `入力rms=${(0.9 / Math.SQRT2).toFixed(3)} → 出力rms=${rLoud.toFixed(3)}`);
    // 注意: Chrome の DynamicsCompressorNode は内部でしきい値に応じたメイクアップゲインを
    // 掛けるため、「小音量が素通り」にはならない。圧縮器として正しいのは
    // 「大小の音量差（ダイナミックレンジ）が縮まること」なので、そちらで判定する。
    const inRatio = 0.9 / 0.02;
    const outRatio = rLoud / rQuiet;
    okf('P.4 大小の音量差が縮まる（ダイナミックレンジの圧縮）', outRatio < inRatio * 0.6,
      `入力比=${inRatio.toFixed(1)}倍 → 出力比=${outRatio.toFixed(1)}倍`);
    const withMakeup = await render('comp', { threshold: -24, ratio: 8, makeup: 2 }, sine(440, 0.9));
    okf('P.5 メイクアップゲインが効く',
      Math.abs(rmsOf2(withMakeup, SRT, 2 * SRT) / rLoud - 2) < 0.05,
      `倍率=${(rmsOf2(withMakeup, SRT, 2 * SRT) / rLoud).toFixed(3)}`);
    const hard = await render('comp', { threshold: -40, ratio: 20, makeup: 1 }, sine(440, 0.9));
    okf('P.6 レシオを上げるほど強く圧縮される', rmsOf2(hard, SRT, 2 * SRT) < rLoud,
      `ratio8=${rLoud.toFixed(3)} ratio20=${rmsOf2(hard, SRT, 2 * SRT).toFixed(3)}`);
    let finite = true;
    for (let i = 0; i < loud.length; i++) if (!isFinite(loud[i])) { finite = false; break; }
    okf('P.7 非有限値が出ない', finite);
  }

  // --- リバーブ ---
  {
    // 0.2秒だけ鳴らして、その後に残響が残るか
    const burst = t => (t < 0.2 ? Math.sin(2 * Math.PI * 440 * t) * 0.6 : 0);
    const wet = await render('reverb', { mix: 1, decay: 1.5 }, burst);
    const dryOnly = await render('reverb', { mix: 0, decay: 1.5 }, burst);
    const tail = rmsOf2(wet, Math.round(0.4 * SRT), Math.round(1.2 * SRT));
    okf('P.8 音が止まったあとに残響が残る', tail > 0.001, `残響部 rms=${tail.toFixed(5)}`);
    okf('P.9 ミックス0なら原音のみ（残響なし）',
      rmsOf2(dryOnly, Math.round(0.4 * SRT), Math.round(1.2 * SRT)) < 1e-6,
      `rms=${rmsOf2(dryOnly, Math.round(0.4 * SRT), Math.round(1.2 * SRT)).toExponential(2)}`);
    const short = await render('reverb', { mix: 1, decay: 0.4 }, burst);
    okf('P.10 残響長を短くすると尾が短くなる',
      rmsOf2(short, Math.round(0.8 * SRT), Math.round(1.2 * SRT)) < tail,
      `decay1.5=${tail.toFixed(5)} decay0.4=${rmsOf2(short, Math.round(0.8 * SRT), Math.round(1.2 * SRT)).toFixed(5)}`);

    // 決定性: 再生と書き出しで残響が変わらないこと（Math.random を使っていない）
    const a = await render('reverb', { mix: 1 }, burst);
    const b = await render('reverb', { mix: 1 }, burst);
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
    okf('P.11 同じ設定なら毎回まったく同じ残響（再生と書き出しが一致する）', same);

    let finite = true;
    for (let i = 0; i < wet.length; i++) if (!isFinite(wet[i])) { finite = false; break; }
    okf('P.12 非有限値が出ない', finite);
  }

  // --- 実際のトラックに載せて書き出せること ---
  {
    const ctx0 = DAW.audio.ensureCtx();
    const buf = ctx0.createBuffer(2, ctx0.sampleRate, ctx0.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = 0.4 * Math.sin(2 * Math.PI * 330 * i / ctx0.sampleRate);
    }
    const bid = DAW.registerBuffer(buf);
    const track = DAW.project.tracks[0];
    track.clips.push({ id: DAW.uid(), bufferId: bid, startTime: 0, offset: 0, duration: 1, name: 'c' });
    track.effects = [
      { pluginId: 'comp', params: DAW.plugins.defaultParams(DAW.plugins.get('comp')) },
      { pluginId: 'reverb', params: DAW.plugins.defaultParams(DAW.plugins.get('reverb')) },
    ];
    H.downloads.length = 0;
    await DAW.wav.exportMix();
    okf('P.13 コンプ→リバーブの直列チェーンが書き出しに通る',
      H.downloads.length === 1 && H.downloads[0].filename === 'mix.wav');
    // パラメータのライブ変更が例外を出さない
    DAW.audio.ensureCtx();
    DAW.audio.getTrackNodes(track);
    DAW.audio.setEffectParam(track, 0, 'makeup', 1.5);
    DAW.audio.setEffectParam(track, 1, 'mix', 0.6);
    DAW.audio.setEffectParam(track, 1, 'decay', 2.5);
    okf('P.14 パラメータのライブ変更が例外なく通る（IR 作り直しを含む）', true);
    track.effects = [];
  }
  okf('P.15 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
