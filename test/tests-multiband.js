'use strict';
// =====================================================================
// マルチバンドコンプレッサー / グッダイザーのテスト。
// 他ファイルのヘルパには依存しない（tests-*.js は名前順に読まれるため）。
// =====================================================================

function multibandSuite(group, body) {
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

multibandSuite('[40] マルチバンド/グッダイザー', async (okf) => {
  const SRT = DAW.audio.ensureCtx().sampleRate;
  const rmsOf = (a, from, to) => {
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
  // 定常部（後半 1.5 秒）の rms
  const steady = a => rmsOf(a, Math.round(0.5 * SRT));

  okf('M.1 マルチバンドコンプが登録されている', !!DAW.plugins.get('multiband'));
  okf('M.2 グッダイザーが登録されている', !!DAW.plugins.get('goodizer'));

  // 全バンド圧縮なし（thr 0 / ratio 1）のパラメータ雛形
  const flat = () => ({
    lthr: 0, lratio: 1, mthr: 0, mratio: 1, hthr: 0, hratio: 1,
    lgain: 0, mgain: 0, hgain: 0, master: 0, xlow: 200, xhigh: 2500,
  });
  // 指定バンドだけ残し、他バンドのゲインを -24dB に下げる（バンドソロ）
  const solo = (keep) => {
    const p = flat();
    for (const b of ['l', 'm', 'h']) if (b !== keep) p[b + 'gain'] = -24;
    return p;
  };

  // --- クロスオーバーの帯域分割 ---
  {
    const lo100 = steady(await render('multiband', solo('l'), sine(100, 0.4)));
    const hi100 = steady(await render('multiband', solo('h'), sine(100, 0.4)));
    okf('M.3 100Hz は低バンドに入る', lo100 > 5 * hi100,
      `低ソロ=${lo100.toFixed(4)} 高ソロ=${hi100.toFixed(4)}`);
    const hi5k = steady(await render('multiband', solo('h'), sine(5000, 0.4)));
    const lo5k = steady(await render('multiband', solo('l'), sine(5000, 0.4)));
    okf('M.4 5kHz は高バンドに入る', hi5k > 5 * lo5k,
      `高ソロ=${hi5k.toFixed(4)} 低ソロ=${lo5k.toFixed(4)}`);
    const mid700 = steady(await render('multiband', solo('m'), sine(700, 0.4)));
    const lo700 = steady(await render('multiband', solo('l'), sine(700, 0.4)));
    const hi700 = steady(await render('multiband', solo('h'), sine(700, 0.4)));
    okf('M.5 700Hz は中バンドに入る', mid700 > 5 * Math.max(lo700, hi700),
      `中ソロ=${mid700.toFixed(4)} 低ソロ=${lo700.toFixed(4)} 高ソロ=${hi700.toFixed(4)}`);
    // クロスオーバー周波数の変更が分割に反映されること
    // （xlow を 60Hz へ下げると 100Hz は低バンドから外れる）
    const lo100b = steady(await render('multiband', Object.assign(solo('l'), { xlow: 60 }), sine(100, 0.4)));
    okf('M.6 交差周波数の変更が分割に反映される', lo100b < 0.5 * lo100,
      `xlow200=${lo100.toFixed(4)} → xlow60=${lo100b.toFixed(4)}`);
  }

  // --- 再合算のフラットさ（LR4 + 位相合わせ AP の検証） ---
  {
    const inRms = 0.4 / Math.SQRT2;
    const details = [];
    let allFlat = true;
    for (const f of [60, 200, 700, 2500, 6000]) { // 交差周波数ちょうど（200/2500）も含む
      const out = steady(await render('multiband', flat(), sine(f, 0.4)));
      const ratio = out / inRms;
      details.push(`${f}Hz=${ratio.toFixed(3)}`);
      if (ratio < 0.85 || ratio > 1.15) allFlat = false;
    }
    okf('M.7 圧縮なしなら再合算がほぼフラット', allFlat, details.join(' '));
  }

  // --- 圧縮の挙動 ---
  {
    const inRms = 0.9 / Math.SQRT2;
    const comp8 = steady(await render('multiband', Object.assign(flat(), { mthr: -24, mratio: 8 }), sine(700, 0.9)));
    okf('M.8 しきい値を超える帯域は圧縮される', comp8 < inRms * 0.75,
      `入力rms=${inRms.toFixed(3)} → 出力rms=${comp8.toFixed(3)}`);
    const comp20 = steady(await render('multiband', Object.assign(flat(), { mthr: -24, mratio: 20 }), sine(700, 0.9)));
    okf('M.9 レシオを上げるほど強く圧縮される', comp20 < comp8,
      `ratio8=${comp8.toFixed(3)} ratio20=${comp20.toFixed(3)}`);
    // 大小の音量差（ダイナミックレンジ）が縮まること（comp.js の P.4 と同じ判定方法。
    // DynamicsCompressorNode は内部メイクアップを持つため「小音量が素通り」にはならない）
    const quiet = steady(await render('multiband', Object.assign(flat(), { mthr: -24, mratio: 8 }), sine(700, 0.02)));
    const inRatio = 0.9 / 0.02;
    const outRatio = comp8 / quiet;
    okf('M.10 大小の音量差が縮まる', outRatio < inRatio * 0.6,
      `入力比=${inRatio.toFixed(1)}倍 → 出力比=${outRatio.toFixed(1)}倍`);
    // 帯域ごとに独立に効くこと: 中バンドだけ強圧縮しても低域の正弦波は影響を受けない
    const lowThrough = steady(await render('multiband', Object.assign(flat(), { mthr: -60, mratio: 20 }), sine(100, 0.4)));
    okf('M.11 圧縮は帯域ごとに独立', Math.abs(lowThrough / (0.4 / Math.SQRT2) - 1) < 0.15,
      `倍率=${(lowThrough / (0.4 / Math.SQRT2)).toFixed(3)}`);
  }

  // --- バンドゲインとマスターゲイン ---
  {
    const base = steady(await render('multiband', flat(), sine(700, 0.3)));
    const master6 = steady(await render('multiband', Object.assign(flat(), { master: 6 }), sine(700, 0.3)));
    okf('M.12 マスターゲイン +6dB でほぼ2倍', Math.abs(master6 / base - Math.pow(10, 6 / 20)) < 0.1,
      `倍率=${(master6 / base).toFixed(3)}`);
    const mgain6 = steady(await render('multiband', Object.assign(flat(), { mgain: 6 }), sine(700, 0.3)));
    okf('M.13 バンドゲインが効く', Math.abs(mgain6 / base - Math.pow(10, 6 / 20)) < 0.1,
      `倍率=${(mgain6 / base).toFixed(3)}`);
  }

  // --- 決定性（再生と書き出しの一致 = 同一設定なら毎回同一挙動） ---
  // 注意: Chrome の DynamicsCompressorNode はヒープの配置によって SIMD / スカラの
  // 処理経路が変わり、float 1ULP 程度（実測 ~1e-7 ≈ -138dBFS）のビット差が出ることがある。
  // 挙動としては同一なので、ビット一致ではなく -100dBFS（1e-5）未満で判定する。
  const maxAbsDiff = (a, b) => {
    if (a.length !== b.length) return Infinity;
    let m = 0;
    for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; }
    return m;
  };
  {
    const p = Object.assign(flat(), { lthr: -30, lratio: 4, mthr: -24, mratio: 8, hthr: -20, hratio: 3, master: 3 });
    const a = await render('multiband', p, sine(300, 0.8));
    const b = await render('multiband', p, sine(300, 0.8));
    const diff = maxAbsDiff(a, b);
    okf('M.14 オフライン書き出しが決定的（2回レンダリングの差が -100dBFS 未満）', diff < 1e-5,
      `最大差=${diff.toExponential(2)}`);
    let finite = true;
    for (let i = 0; i < a.length; i++) if (!isFinite(a[i])) { finite = false; break; }
    okf('M.15 非有限値が出ない', finite);
  }

  // --- グッダイザー ---
  {
    // 3帯域を含む合成波（低/中/高が全バンドを通る）
    const mix3 = t => 0.25 * (Math.sin(2 * Math.PI * 100 * t) + Math.sin(2 * Math.PI * 700 * t) + Math.sin(2 * Math.PI * 5000 * t));
    // 入力側の定常部 rms は数値積分で直接求める（レンダリング不要）
    let inSq = 0;
    const N = Math.round(1.5 * SRT);
    for (let i = 0; i < N; i++) { const v = mix3((i + Math.round(0.5 * SRT)) / SRT); inSq += v * v; }
    const inRms = Math.sqrt(inSq / N);

    const a0 = await render('goodizer', { amount: 0 }, mix3);
    okf('M.16 amount 0 はほぼ素通し（振幅フラット）', Math.abs(steady(a0) / inRms - 1) < 0.1,
      `倍率=${(steady(a0) / inRms).toFixed(3)}`);
    const a8 = await render('goodizer', { amount: 0.8 }, mix3);
    okf('M.17 amount を上げると音圧が上がる', steady(a8) > steady(a0) * 1.1,
      `amount0=${steady(a0).toFixed(3)} amount0.8=${steady(a8).toFixed(3)}`);
    const a8b = await render('goodizer', { amount: 0.8 }, mix3);
    const diff = maxAbsDiff(a8, a8b);
    okf('M.18 グッダイザーも決定的（2回レンダリングの差が -100dBFS 未満）', diff < 1e-5,
      `最大差=${diff.toExponential(2)}`);
    let finite = true;
    for (let i = 0; i < a8.length; i++) if (!isFinite(a8[i])) { finite = false; break; }
    okf('M.19 非有限値が出ない', finite);
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
      { pluginId: 'multiband', params: DAW.plugins.defaultParams(DAW.plugins.get('multiband')) },
      { pluginId: 'goodizer', params: DAW.plugins.defaultParams(DAW.plugins.get('goodizer')) },
    ];
    H.downloads.length = 0;
    await DAW.wav.exportMix();
    okf('M.20 マルチバンド→グッダイザーの直列チェーンが書き出しに通る',
      H.downloads.length === 1 && H.downloads[0].filename === 'mix.wav');
    // パラメータのライブ変更が例外を出さない
    DAW.audio.ensureCtx();
    DAW.audio.getTrackNodes(track);
    DAW.audio.setEffectParam(track, 0, 'mthr', -30);
    DAW.audio.setEffectParam(track, 0, 'xlow', 150);
    DAW.audio.setEffectParam(track, 0, 'master', 3);
    DAW.audio.setEffectParam(track, 1, 'amount', 0.9);
    okf('M.21 パラメータのライブ変更が例外なく通る（1ノブ→17パラメータ展開を含む）', true);
    track.effects = [];
  }
  okf('M.22 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
