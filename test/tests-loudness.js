'use strict';
// =====================================================================
// ラウドネス計測（ITU-R BS.1770-4 / js/loudness.js）のテスト。
//   - K特性係数が仕様書の 48kHz 表と一致すること
//   - 997Hz 正弦波の既知 LUFS 値（根拠は各テストのコメント）
//   - ゲーティング（無音混在で Integrated が変わらない）
//   - True Peak のインターサンプル検出
//   - METERING タブ（表示・リセット）とライブ計測（AudioWorklet）
//   - exportMix の書き出しレポート
// 他ファイルのヘルパには依存しない（tests.js の T / H / delay のみ使う）。
// =====================================================================

function loudSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    const savedLim = JSON.parse(JSON.stringify(DAW.limiter.params));
    const savedLimEnabled = DAW.limiter.enabled;
    const savedView = DAW.objui ? DAW.objui.view : null;
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.objects.clear();
    DAW.project.masterVolume = 1;
    DAW.loop.enabled = false;
    DAW.metronome.enabled = false;
    DAW.addTrack('src');
    DAW.ui.renderTracks();
    DAW.history.reset();
    try { await body(okf); } finally {
      Object.assign(DAW.limiter.params, savedLim);
      DAW.limiter.enabled = savedLimEnabled;
      if (DAW.objui && savedView) DAW.objui.setView(savedView);
      try { DAW.audio.stop(); } catch (e) {}
    }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

loudSuite('[43] ラウドネス (BS.1770-4)', async (okf) => {
  const LD = DAW.loudness;
  const A18 = Math.pow(10, -18 / 20);   // -18dBFS の振幅

  const sine = (sr, sec, amp, freq) => {
    const a = new Float32Array(Math.round(sr * sec));
    const f = freq || 997;
    for (let i = 0; i < a.length; i++) a[i] = amp * Math.sin(2 * Math.PI * f * i / sr);
    return a;
  };
  const concat = (a, b) => {
    const out = new Float32Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  };

  // ---- K特性フィルタの係数 ----
  {
    // BS.1770-4 の 48kHz 用係数表（Table 1: 高域シェルフ / Table 2: RLB ハイパス）。
    // 実装はプリワープしたアナログ原型からレートごとに計算するので、48kHz で
    // この表と一致すれば任意レートへの一般化が正しい根拠になる。
    const k = LD.kCoeffs(48000);
    const spec1 = { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 };
    const spec2 = { b0: 1.0, b1: -2.0, b2: 1.0, a1: -1.99004745483398, a2: 0.99007225036621 };
    let err = 0;
    for (const key of Object.keys(spec1)) err = Math.max(err, Math.abs(k.hs[key] - spec1[key]));
    for (const key of Object.keys(spec2)) err = Math.max(err, Math.abs(k.hp[key] - spec2[key]));
    okf('L.1 K係数が仕様書の 48kHz 表と一致', err < 1e-9, `最大誤差=${err.toExponential(2)}`);
  }

  // ---- Integrated（既知の値）----
  {
    // 期待値の根拠: 振幅 a = 10^(-18/20) の正弦波は各chの平均自乗が a²/2。
    // ステレオ（重み 1+1）の合計は a² = 10^(-1.8) -> 10*log10 = -18.00 dB。
    // K特性の 997Hz ゲインは +0.691dB で定数 -0.691 と相殺する（BS.1770 の較正点。
    // 「1kHz 0dBFS 正弦波を1chに入れると -3.01 LKFS」と同じ関係）。
    // よって Integrated = -18.00 LUFS（EBU tech 3341 テストケース1の -18dBFS 版）。
    const l = sine(48000, 3, A18);
    const v = LD.integrated([l, l.slice(0)], 48000);
    okf('L.2 997Hz -18dBFS ステレオ = -18.0 LUFS (±0.1)', Math.abs(v - (-18.0)) <= 0.1, `${v.toFixed(3)} LUFS`);
  }
  {
    // 係数がレートごとに計算されることの検証（44.1kHz でも同じ値になる）
    const l = sine(44100, 2, A18);
    const v = LD.integrated([l, l.slice(0)], 44100);
    okf('L.3 44.1kHz でも -18.0 LUFS (±0.1)', Math.abs(v - (-18.0)) <= 0.1, `${v.toFixed(3)} LUFS`);
  }

  // ---- 逐次計算器（Momentary / Short Term）----
  {
    const sr = 48000;
    const meter = LD.createMeter(sr, 2);
    const l = sine(sr, 4, A18);
    const CH = 128;   // Worklet と同じ 128 サンプル刻みで流し込む
    // 400ms（= 4ホップ）に満たないうちは -∞
    let fed = 0;
    while (fed < Math.round(0.3 * sr)) {
      const n = Math.min(CH, Math.round(0.3 * sr) - fed);
      meter.process([l.subarray(fed, fed + n), l.subarray(fed, fed + n)], n);
      fed += n;
    }
    okf('L.4 400ms 未満の Momentary は -∞', meter.momentary() === -Infinity, String(meter.momentary()));
    while (fed < l.length) {
      const n = Math.min(CH, l.length - fed);
      meter.process([l.subarray(fed, fed + n), l.subarray(fed, fed + n)], n);
      fed += n;
    }
    const m = meter.momentary();
    const s = meter.shortTerm();
    const i = meter.integrated();
    okf('L.5 Momentary = -18.0 LUFS (±0.1)', Math.abs(m - (-18.0)) <= 0.1, `${m.toFixed(3)} LUFS`);
    okf('L.6 Short Term = -18.0 LUFS (±0.1)', Math.abs(s - (-18.0)) <= 0.1, `${s.toFixed(3)} LUFS`);
    okf('L.7 逐次計算でも Integrated が一致', Math.abs(i - (-18.0)) <= 0.1, `${i.toFixed(3)} LUFS`);
    meter.reset();
    okf('L.8 reset() で全計測が -∞ に戻る',
      meter.momentary() === -Infinity && meter.integrated() === -Infinity && meter.tpMax === 0,
      `M=${meter.momentary()} I=${meter.integrated()} TP=${meter.tpMax}`);
  }

  // ---- ゲーティング ----
  {
    // 無音を混ぜても Integrated が変わらない（絶対 -70 LUFS ゲートが無音ブロックを、
    // 相対 -10 LU ゲートが境界の弱いブロックを弾く）。境界をまたぐブロックの端数の
    // 影響を薄めるため長めの信号で見る。計算量を抑えるためレートは 16kHz
    // （係数はレート別計算なので結果は同じ。L.3 で確認済み）。
    const sr = 16000;
    const s20 = sine(sr, 20, A18);
    const silence = new Float32Array(20 * sr);
    const a = LD.integrated([s20, s20.slice(0)], sr);
    const b = LD.integrated([concat(s20, silence), concat(s20, silence)], sr);
    okf('L.9 無音を混ぜても Integrated が変わらない (±0.05)', Math.abs(a - b) <= 0.05,
      `正弦波のみ=${a.toFixed(3)} 無音混在=${b.toFixed(3)} 差=${Math.abs(a - b).toFixed(4)} LU`);
    okf('L.10 完全な無音は -∞（絶対ゲート）', LD.integrated([silence, silence.slice(0)], sr) === -Infinity);
  }

  // ---- True Peak ----
  {
    // インターサンプルピーク: fs/4 の正弦波を 45° 位相で切ると、サンプル点は
    // ±A·cos(45°) = ±0.707A にしか乗らないが、本当のピークは A。
    // A=0.5 -> サンプルピーク 0.354 (-9.03dBFS)、True Peak 0.5 (-6.02dBTP)。
    const sr = 48000;
    const a = new Float32Array(Math.round(sr * 0.5));
    for (let i = 0; i < a.length; i++) a[i] = 0.5 * Math.sin(2 * Math.PI * (sr / 4) * i / sr + Math.PI / 4);
    let sp = 0;
    for (let i = 0; i < a.length; i++) sp = Math.max(sp, Math.abs(a[i]));
    const tp = LD.truePeak([a], sr);
    const tpDb = 20 * Math.log10(tp);
    okf('L.11 サンプル点は 0.354 に留まる', Math.abs(sp - Math.SQRT1_2 * 0.5) < 1e-3, sp.toFixed(4));
    okf('L.12 インターサンプルピーク 0.5 を検出 (-6.02dBTP ±0.5dB)', Math.abs(tpDb - (-6.02)) <= 0.5,
      `TP=${tp.toFixed(4)} (${tpDb.toFixed(2)} dBTP)、サンプルピークより +${(tpDb - 20 * Math.log10(sp)).toFixed(2)} dB`);
  }
  {
    // 997Hz -18dBFS はサンプル点がほぼピークに乗るので True Peak ≈ -18dBTP
    const a = sine(48000, 1, A18);
    const tpDb = 20 * Math.log10(LD.truePeak([a], 48000));
    okf('L.13 997Hz -18dBFS の True Peak = -18dBTP (±0.3)', Math.abs(tpDb - (-18.0)) <= 0.3, `${tpDb.toFixed(2)} dBTP`);
  }

  // ---- 書き出しレポート（exportMix）----
  const ctx0 = DAW.audio.ensureCtx();
  const SRT = ctx0.sampleRate;
  const mkClip = (fill, sec, nch) => {
    const b = ctx0.createBuffer(nch || 2, Math.round(SRT * sec), SRT);
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = fill(i / SRT, c);
    }
    const id = DAW.registerBuffer(b);
    DAW.project.tracks[0].clips = [{ id: DAW.uid(), bufferId: id, startTime: 0, offset: 0, duration: sec, name: 'c', fadeIn: 0, fadeOut: 0 }];
  };
  const renderMixLocal = async () => {
    H.downloads.length = 0;
    await DAW.wav.exportMix();
    return H.downloads[H.downloads.length - 1] || null;
  };
  {
    // ステレオ 997Hz -18dBFS を実経路で書き出す。パン 0 の StereoPanner はステレオ素材を
    // 素通しし、-18dBFS はシーリング -1dB のリミッターに触れないので L.2 と同じ -18.0 LUFS。
    DAW.limiter.enabled = true;
    DAW.limiter.set('ceilingDb', -1);
    H.alerts.length = 0;   // ここまでの他スイートの alert は見ない（この書き出しで出ないことを確かめる）
    mkClip(t => A18 * Math.sin(2 * Math.PI * 997 * t), 1.0);
    const d = await renderMixLocal();
    const rep = DAW.wav.lastExportLoudness;
    okf('L.14 書き出しでレポートが記録される', !!d && !!rep && rep.file === 'mix.wav',
      rep ? JSON.stringify({ file: rep.file }) : 'レポートなし');
    okf('L.15 レポートの Integrated = -18.0 LUFS (±0.2)', rep && Math.abs(rep.integrated - (-18.0)) <= 0.2,
      rep ? `${rep.integrated.toFixed(3)} LUFS` : '-');
    okf('L.16 レポートの True Peak = -18dBTP (±0.5)', rep && Math.abs(rep.truePeakDb - (-18.0)) <= 0.5,
      rep ? `${rep.truePeakDb.toFixed(2)} dBTP` : '-');
    okf('L.17 書き出しで alert は出さない（既存の規約のまま）', H.alerts.length === 0,
      H.alerts.join('|'));
    const hint = document.getElementById('hint-bar');
    okf('L.18 レポートはヒントバーに出る', !!hint && /LUFS/.test(hint.textContent) && /dBTP/.test(hint.textContent),
      hint ? hint.textContent : 'ヒントバーなし');
  }

  // ---- METERING タブ ----
  const U = DAW.objui;
  {
    okf('M.1 タブが有効化されている', U.els.tabMetering && !U.els.tabMetering.disabled);
    U.setView('metering');
    okf('M.2 タブでビューが切り替わる', U.view === 'metering'
      && !U.els.metering.classList.contains('hidden')
      && U.els.panner.classList.contains('hidden')
      && U.els.tabMetering.classList.contains('on'));
    okf('M.3 M/S/I/TP の表示要素がある', !!(U.els.loud && U.els.loud.m && U.els.loud.s && U.els.loud.i && U.els.loud.tp));

    // 表示: live の値がそのまま流れる（計算は Worklet 側なのでここは表示だけ確かめる）
    DAW.loudness.live = { momentary: -23.4, shortTerm: -22.1, integrated: -23.0, truePeak: 0.5, truePeakDb: -6.0 };
    U.updateLoudness();
    okf('M.4 値が表示される', U.els.loud.i.val.textContent === '-23.0 LUFS'
      && U.els.loud.tp.val.textContent === '-6.0 dBTP',
      `I="${U.els.loud.i.val.textContent}" TP="${U.els.loud.tp.val.textContent}"`);
    okf('M.5 書き出しレポートがタブにも出る', /Integrated/.test(U.els.loud.report.textContent),
      U.els.loud.report.textContent);

    // リセットボタン
    U.els.loud.reset.click();
    okf('M.6 リセットで蓄積が -∞ に戻る', DAW.loudness.live.integrated === -Infinity
      && DAW.loudness.live.truePeak === 0
      && U.els.loud.i.val.textContent === '-∞ LUFS',
      `I="${U.els.loud.i.val.textContent}"`);
  }

  // ---- ライブ計測（AudioWorklet 経路）----
  {
    // METERING を開くとタップが付く。再生して 1 秒待てば Momentary（400ms 窓）が立つ。
    // モノラル 0.5 正弦波はパン 0 で各ch 0.354 -> 合計平均自乗 0.125 -> 約 -9.7 LUFS 相当。
    const node = await DAW.audio.ensureLoudness();
    okf('V.1 タップノードが作られる', !!node && DAW.loudness.node === node);
    mkClip(t => 0.5 * Math.sin(2 * Math.PI * 997 * t), 1.6, 1);
    DAW.loudness.reset();
    await DAW.audio.play();
    await delay(1100);
    const lv = DAW.loudness.live;
    DAW.audio.stop();
    okf('V.2 ライブの Momentary が立つ', isFinite(lv.momentary) && lv.momentary > -40 && lv.momentary < 0,
      `M=${LD.fmt(lv.momentary)} LUFS`);
    okf('V.3 ライブの Integrated / True Peak も動く', isFinite(lv.integrated) && lv.truePeakDb > -20 && lv.truePeakDb < 0,
      `I=${LD.fmt(lv.integrated)} LUFS TP=${LD.fmt(lv.truePeakDb)} dBTP`);
    DAW.loudness.reset();
    okf('V.4 リセット後は蓄積が消える', DAW.loudness.live.integrated === -Infinity, String(DAW.loudness.live.integrated));
    U.setView('panner');
    okf('V.5 タブを戻してもエラーなし', U.view === 'panner' && U.els.metering.classList.contains('hidden'));
  }

  okf('Z.1 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
