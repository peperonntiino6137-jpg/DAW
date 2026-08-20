'use strict';
// =====================================================================
// 7バンド パラメトリックEQ（paraeq）のテスト。
// 他ファイルのヘルパには依存しない（tests-*.js は名前順に読まれるため）。
// =====================================================================

function paraeqSuite(group, body) {
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

paraeqSuite('[41] パラメトリックEQ', async (okf) => {
  const SRT = DAW.audio.ensureCtx().sampleRate;
  const rmsOf = (a, from, to) => {
    from = from || 0; to = to === undefined ? a.length : to;
    let s = 0;
    for (let i = from; i < to; i++) s += a[i] * a[i];
    return Math.sqrt(s / (to - from));
  };
  const sine = (f, a) => t => a * Math.sin(2 * Math.PI * f * t);
  const def = DAW.plugins.get('paraeq');

  // paraeq を通した2秒レンダリング。sets を渡すと create 後に set() を適用する。
  // withPlugin=false なら素通し（比較基準用）。
  const render = async (params, fill, opts) => {
    opts = opts || {};
    const seconds = opts.seconds || 2;
    const off = new OfflineAudioContext(1, Math.round(SRT * seconds), SRT);
    const buf = off.createBuffer(1, Math.round(SRT * seconds), SRT);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = fill(i / SRT);
    const src = off.createBufferSource();
    src.buffer = buf;
    if (opts.withPlugin === false) {
      src.connect(off.destination);
    } else {
      const p = Object.assign(DAW.plugins.defaultParams(def), params || {});
      const inst = def.create(off, p);
      for (const [k, v] of opts.sets || []) inst.set(k, v);
      src.connect(inst.input);
      inst.output.connect(off.destination);
    }
    src.start(0);
    return (await off.startRendering()).getChannelData(0);
  };

  okf('Q.1 パラメトリックEQが登録されている', !!def);
  okf('Q.2 パラメータが 7バンド×5 = 35 個ある', def.params.length === 35, `個数=${def.params.length}`);

  // --- 既定値で素通し ---
  {
    const bare = await render(null, sine(440, 0.5), { withPlugin: false });
    const thru = await render(null, sine(440, 0.5));
    let maxDiff = 0;
    for (let i = 0; i < bare.length; i++) {
      const dd = Math.abs(bare[i] - thru[i]);
      if (dd > maxDiff) maxDiff = dd;
    }
    okf('Q.3 全バンド既定値で入出力がほぼ一致（素通し）', maxDiff < 1e-4, `最大差=${maxDiff.toExponential(2)}`);
  }

  // --- bell +12dB で該当周波数が増幅・隣接帯域は微小 ---
  {
    const boost = { on4: 1, ty4: 0, fq4: 1000, gn4: 12, q4: 2 };
    const inRms = 0.1 / Math.SQRT2;
    const at1k = rmsOf(await render(boost, sine(1000, 0.1)), Math.round(0.5 * SRT), Math.round(1.5 * SRT));
    const at100 = rmsOf(await render(boost, sine(100, 0.1)), Math.round(0.5 * SRT), Math.round(1.5 * SRT));
    okf('Q.4 bell +12dB で該当周波数の正弦波が増幅される', at1k / inRms > 3,
      `1kHz 倍率=${(at1k / inRms).toFixed(2)}（理論値≈3.98）`);
    okf('Q.5 隣接帯域（100Hz）はほぼ変化しない', Math.abs(at100 / inRms - 1) < 0.15,
      `100Hz 倍率=${(at100 / inRms).toFixed(3)}`);
  }

  // --- highpass で低域が減衰 ---
  {
    const hp = { on1: 1, ty1: 4, fq1: 400, q1: 0.7 };
    const inRms = 0.5 / Math.SQRT2;
    const low = rmsOf(await render(hp, sine(50, 0.5)), Math.round(0.5 * SRT), Math.round(1.5 * SRT));
    const high = rmsOf(await render(hp, sine(4000, 0.5)), Math.round(0.5 * SRT), Math.round(1.5 * SRT));
    okf('Q.6 highpass 400Hz で 50Hz の正弦波が大きく減衰する', low / inRms < 0.1,
      `減衰後倍率=${(low / inRms).toFixed(4)}`);
    okf('Q.7 highpass でも通過帯域（4kHz）はほぼ素通し', Math.abs(high / inRms - 1) < 0.15,
      `4kHz 倍率=${(high / inRms).toFixed(3)}`);
  }

  // --- getFrequencyResponse: 合成値が単体フィルタの積と一致 ---
  {
    const off = new OfflineAudioContext(1, 8, SRT);
    const freqs = Float32Array.from([50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000]);

    // 既定値では全周波数で振幅 ≈ 1
    const flat = def.create(off, DAW.plugins.defaultParams(def)).getFrequencyResponse(freqs);
    let flatOk = true, flatWorst = 0;
    for (const m of flat) {
      const e = Math.abs(m - 1);
      if (e > flatWorst) flatWorst = e;
      if (e > 1e-4) flatOk = false;
    }
    okf('Q.8 既定値の周波数レスポンスは全帯域で 1', flatOk, `最大誤差=${flatWorst.toExponential(2)}`);

    // B2=bell +6dB@200 / B6=highshelf -9dB@5k を有効にして、
    // 同設定の BiquadFilter 2 本の振幅の積と比較する
    const p = Object.assign(DAW.plugins.defaultParams(def), {
      on2: 1, ty2: 0, fq2: 200, gn2: 6, q2: 1.5,
      on6: 1, ty6: 2, fq6: 5000, gn6: -9, q6: 1,
    });
    const combined = def.create(off, p).getFrequencyResponse(freqs);
    const mk = (type, f, g, q) => {
      const b = off.createBiquadFilter();
      b.type = type; b.frequency.value = f; b.gain.value = g; b.Q.value = q;
      return b;
    };
    const mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
    const expected = new Float32Array(freqs.length).fill(1);
    for (const b of [mk('peaking', 200, 6, 1.5), mk('highshelf', 5000, -9, 1)]) {
      b.getFrequencyResponse(freqs, mag, ph);
      for (let i = 0; i < expected.length; i++) expected[i] *= mag[i];
    }
    let worst = 0;
    for (let i = 0; i < freqs.length; i++) {
      const e = Math.abs(combined[i] / expected[i] - 1);
      if (e > worst) worst = e;
    }
    okf('Q.9 getFrequencyResponse の合成値が単体フィルタの積と一致', worst < 1e-3,
      `最大相対誤差=${worst.toExponential(2)}`);
    okf('Q.10 ブースト設定のレスポンスが実際に 1 から離れている（テスト自体の健全性）',
      Math.abs(combined[2] - 1) > 0.2, `mag@200Hz=${combined[2].toFixed(3)}`);
  }

  // --- set() での型切替・on/off 後も出力が有限 ---
  {
    const out = await render(null, sine(440, 0.5), {
      sets: [
        ['on4', 1], ['ty4', 4], ['fq4', 300],      // bell → highpass
        ['ty4', 3], ['fq4', 6000],                 // highpass → lowpass
        ['on1', 1], ['on1', 0],                    // ローカットの on/off
        ['ty7', 5], ['on7', 1], ['fq7', 2000],     // notch を有効化
        ['gn2', 12], ['q2', 8],
        ['zz9', 1],                                // 不正キーは黙って無視
      ],
    });
    let finite = true;
    for (let i = 0; i < out.length; i++) if (!isFinite(out[i])) { finite = false; break; }
    okf('Q.11 set() での型切替・on/off 後も出力が有限', finite);
  }

  // --- オフライン書き出し一致（決定性） ---
  {
    const p = { on1: 1, fq1: 100, on4: 1, gn4: 9, q4: 3, on7: 1, fq7: 8000 };
    const a = await render(p, sine(440, 0.5));
    const b = await render(p, sine(440, 0.5));
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
    okf('Q.12 同じ設定なら毎回同一サンプル（再生と書き出しが一致する）', same);
  }

  // --- 実際のトラックに載せて書き出し・ライブ変更 ---
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
    track.effects = [{ pluginId: 'paraeq', params: DAW.plugins.defaultParams(def) }];
    H.downloads.length = 0;
    await DAW.wav.exportMix();
    okf('Q.13 paraeq を挿したトラックが書き出しに通る',
      H.downloads.length === 1 && H.downloads[0].filename === 'mix.wav');
    // パラメータのライブ変更（型切替を含む）が例外を出さない
    DAW.audio.ensureCtx();
    DAW.audio.getTrackNodes(track);
    DAW.audio.setEffectParam(track, 0, 'gn4', 6);
    DAW.audio.setEffectParam(track, 0, 'ty4', 1);
    DAW.audio.setEffectParam(track, 0, 'on1', 1);
    okf('Q.14 ライブ変更（ゲイン・型切替・on/off）が例外なく通る', true);
    track.effects = [];
  }
  okf('Q.15 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
