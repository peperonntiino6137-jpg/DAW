'use strict';
// =====================================================================
// マスターリミッター（先読み型）のテスト。
// 受け入れ条件4「シーリング超過サンプルが書き出しに無い。遅延補正後の波形整列」を含む。
// 他ファイルのヘルパには依存しない。
// =====================================================================

function limSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    const saved = JSON.parse(JSON.stringify(DAW.limiter.params));
    const savedEnabled = DAW.limiter.enabled;
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
      Object.assign(DAW.limiter.params, saved);
      DAW.limiter.enabled = savedEnabled;
      try { DAW.audio.stop(); } catch (e) {}
    }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

limSuite('[29] マスターリミッター', async (okf) => {
  const L = DAW.limiter;
  const SRT = DAW.audio.ensureCtx().sampleRate;
  const peakOf = a => { let p = 0; for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i])); return p; };

  // ---- パラメータ ----
  okf('C.1 既定値', L.params.ceilingDb === -1 && L.params.lookaheadMs === 5 && L.params.releaseMs === 100
    && L.params.gainDb === 0, JSON.stringify(L.params));
  L.set('ceilingDb', 5);
  okf('C.2 シーリングは 0dB を超えない', L.params.ceilingDb === 0, L.params.ceilingDb);
  L.set('lookaheadMs', 999);
  okf('C.3 先読みは 20ms まで', L.params.lookaheadMs === 20, L.params.lookaheadMs);
  L.set('releaseMs', 0);
  okf('C.4 リリースの下限', L.params.releaseMs === 1, L.params.releaseMs);
  L.set('gainDb', 'abc');
  okf('C.5 数値でない入力は無視', L.params.gainDb === 0, L.params.gainDb);
  okf('C.6 未知のキーは受け付けない', L.set('zzz', 1) === false);
  L.set('ceilingDb', -1); L.set('lookaheadMs', 5); L.set('releaseMs', 100); L.set('gainDb', 0);
  okf('C.7 遅延は先読みと一致', Math.abs(L.latencySec() - 0.005) < 1e-9, L.latencySec());
  L.enabled = false;
  okf('C.8 無効時は遅延ゼロ', L.latencySec() === 0);
  L.enabled = true;

  // ---- DSP 本体（Worklet と共有している実装） ----
  okf('C.9 Worklet のソースが DSP 本体を含む（実装が二重化していない）',
    L.moduleSource().indexOf(L.coreSource()) === 0, 'moduleSource は coreSource で始まる');

  const runCore = (sig, params) => {
    const p = Object.assign({}, L.params, params || {});
    const core = new (L.Core())(SRT, p);
    const out = new Float32Array(sig.length);
    core.process([sig], [out], sig.length);
    return out;
  };

  {
    // インパルスで遅延を測る
    const look = Math.round(0.005 * SRT);
    const sig = new Float32Array(SRT / 10);
    sig[100] = 0.5;
    const out = runCore(sig, { lookaheadMs: 5 });
    let at = -1;
    for (let i = 0; i < out.length; i++) if (Math.abs(out[i]) > 1e-6) { at = i; break; }
    okf('C.10 出力は先読みぶん遅れる', at === 100 + look, `入力=100 出力=${at}（先読み=${look}サンプル）`);
    okf('C.11 シーリング以下の信号は素通り', Math.abs(out[at] - 0.5) < 1e-6, out[at]);
  }
  {
    // シーリングを超える信号は必ず抑えられる
    const sig = new Float32Array(SRT);
    for (let i = 0; i < sig.length; i++) sig[i] = 0.95 * Math.sin(2 * Math.PI * 220 * i / SRT);
    const out = runCore(sig, { ceilingDb: -6 });
    const ceil = Math.pow(10, -6 / 20);
    okf('C.12 シーリングを1サンプルも超えない', peakOf(out) <= ceil + 1e-6,
      `peak=${peakOf(out).toFixed(6)} ceiling=${ceil.toFixed(6)}`);
    okf('C.13 抑えても無音にはしない', peakOf(out) > ceil * 0.9, peakOf(out).toFixed(4));
  }
  {
    // 入力ゲインが効く
    const sig = new Float32Array(1000);
    for (let i = 0; i < sig.length; i++) sig[i] = 0.1;
    const out = runCore(sig, { gainDb: 6, lookaheadMs: 0 });
    okf('C.14 入力ゲインが掛かる', Math.abs(out[500] - 0.1 * Math.pow(10, 6 / 20)) < 1e-4, out[500].toFixed(4));
  }
  {
    // 先読み 0 でも動く（遅延なし）
    const sig = new Float32Array(100);
    sig[10] = 0.2;
    const out = runCore(sig, { lookaheadMs: 0 });
    okf('C.15 先読み0でも動作し遅延しない', Math.abs(out[10] - 0.2) < 1e-6, out[10]);
  }
  {
    // リリース: 大きな音のあと、ゲインが徐々に戻る
    const sig = new Float32Array(SRT);
    for (let i = 0; i < sig.length; i++) sig[i] = (i < SRT / 10 ? 2.0 : 0.5) * Math.sin(2 * Math.PI * 200 * i / SRT);
    const out = runCore(sig, { ceilingDb: -6, releaseMs: 200 });
    const seg = (a, b) => {
      let p = 0;
      for (let i = Math.round(a * SRT); i < Math.round(b * SRT); i++) p = Math.max(p, Math.abs(out[i]));
      return p;
    };
    okf('C.16 リリース中はゲインが徐々に戻る', seg(0.11, 0.13) < seg(0.3, 0.32) && seg(0.3, 0.32) <= 0.5 + 1e-6,
      `直後=${seg(0.11, 0.13).toFixed(4)} 0.3秒後=${seg(0.3, 0.32).toFixed(4)}`);
  }

  // ---- 書き出し（受け入れ条件4） ----
  const ctx0 = DAW.audio.ctx;
  const mkClip = (fill, sec) => {
    const b = ctx0.createBuffer(1, Math.round(SRT * sec), SRT);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = fill(i / SRT);
    const id = DAW.registerBuffer(b);
    DAW.project.tracks[0].clips = [{ id: DAW.uid(), bufferId: id, startTime: 0, offset: 0, duration: sec, name: 'c', fadeIn: 0, fadeOut: 0 }];
  };
  const renderMix = async () => {
    H.downloads.length = 0;
    await DAW.wav.exportMix();
    const ab = await H.downloads[H.downloads.length - 1].blob.arrayBuffer();
    return new OfflineAudioContext(2, 128, new DataView(ab).getUint32(24, true)).decodeAudioData(ab.slice(0));
  };

  {
    // わざと 0dBFS を大きく超える素材
    mkClip(t => 1.6 * Math.sin(2 * Math.PI * 300 * t), 1);
    L.enabled = true;
    L.set('ceilingDb', -1);
    const m = await renderMix();
    const ceil = L.ceilingLinear();
    let over = 0;
    for (let ch = 0; ch < 2; ch++) {
      const a = m.getChannelData(ch);
      for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > ceil + 0.002) over++;
    }
    okf('C.17 [受入4] シーリング超過サンプルが書き出しに1つも無い', over === 0,
      `超過=${over}サンプル / peak=${peakOf(m.getChannelData(0)).toFixed(4)} ceiling=${ceil.toFixed(4)}`);
    okf('C.18 抑えたうえで音は残っている', peakOf(m.getChannelData(0)) > ceil * 0.8,
      peakOf(m.getChannelData(0)).toFixed(4));
  }
  {
    // 遅延補正後の整列: 0.5秒からバーストする素材
    mkClip(t => (t < 0.5 ? 0 : 0.8 * Math.sin(2 * Math.PI * 300 * t)), 1);
    const m = await renderMix();
    const a = m.getChannelData(0);
    let onset = -1;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > 0.05) { onset = i / m.sampleRate; break; }
    okf('C.19 [受入4] 遅延補正後に波形が元の位置へ整列', Math.abs(onset - 0.5) < 0.002,
      `立ち上がり=${onset.toFixed(4)}秒（期待 0.5秒、先読み ${L.params.lookaheadMs}ms は補正済み）`);
    okf('C.20 [受入4] 長さも元のまま', Math.abs(m.duration - 1) < 0.002, `${m.duration.toFixed(4)}秒`);
  }
  {
    // 先読みを変えても整列する
    L.set('lookaheadMs', 20);
    const m = await renderMix();
    const a = m.getChannelData(0);
    let onset = -1;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > 0.05) { onset = i / m.sampleRate; break; }
    okf('C.21 先読み20msでも整列する', Math.abs(onset - 0.5) < 0.003, `立ち上がり=${onset.toFixed(4)}秒`);
    L.set('lookaheadMs', 5);
  }
  {
    // バイパス時は従来どおり（クリップ警告の経路）
    L.enabled = false;
    mkClip(t => 1.6 * Math.sin(2 * Math.PI * 300 * t), 0.5);
    H.confirmResult = true;
    const m = await renderMix();
    // モノラル素材は StereoPanner の等パワー則で各ch 1/√2 になるため、1.6 → 1.13 相当
    okf('C.22 バイパス時は従来どおり ±1.0 で頭打ち（警告経路が残る）',
      peakOf(m.getChannelData(0)) > 0.99 && DAW.wav.lastExportPeak > 1.1,
      `peak=${peakOf(m.getChannelData(0)).toFixed(4)} 元のピーク=${DAW.wav.lastExportPeak.toFixed(2)}`);
    okf('C.23 バイパス時は長さも変わらない', Math.abs(m.duration - 0.5) < 0.002, m.duration.toFixed(4));
    L.enabled = true;
  }
  {
    // リミッター前のピークは記録される（どれだけ突っ込んでいるかの目安）
    mkClip(t => 1.6 * Math.sin(2 * Math.PI * 300 * t), 0.3);
    await renderMix();
    okf('C.24 リミッター前のピークを記録している（0dBFS 超過が見える）', DAW.wav.lastExportPeak > 1.1,
      `lastExportPeak=${DAW.wav.lastExportPeak.toFixed(3)}`);
  }

  // ---- ライブ経路 ----
  {
    mkClip(t => 0.5 * Math.sin(2 * Math.PI * 300 * t), 0.5);
    await DAW.audio.ensureLimiter();
    okf('C.25 ライブ経路にリミッターが挿入される', !!DAW.audio.limiterNode && DAW.limiter.node === DAW.audio.limiterNode);
    okf('C.26 表示位置が先読みぶん補正される',
      Math.abs((DAW.audio.getPos() - DAW.audio.displayPos()) - (DAW.audio.isPlaying() ? L.latencySec() : 0)) < 1e-9,
      `getPos=${DAW.audio.getPos().toFixed(4)} displayPos=${DAW.audio.displayPos().toFixed(4)}`);
    await DAW.audio.play();
    await delay(100);
    okf('C.27 再生中は表示位置が先読みぶん手前になる',
      DAW.audio.displayPos() < DAW.audio.getPos() && DAW.audio.getPos() - DAW.audio.displayPos() <= L.latencySec() + 1e-9,
      `差=${((DAW.audio.getPos() - DAW.audio.displayPos()) * 1000).toFixed(1)}ms`);
    DAW.audio.stop();
  }
  okf('C.28 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
