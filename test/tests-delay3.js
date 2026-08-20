'use strict';
// =====================================================================
// テンポ同期ディレイ（delay3）のテスト。
// 他ファイルのヘルパには依存しない（tests-*.js は名前順に読まれるため）。
// =====================================================================

function delay3Suite(group, body) {
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

delay3Suite('[40] テンポ同期ディレイ', async (okf) => {
  const SR = 48000;   // レンダリングレートは固定（実デバイスのレートに依存しない）
  const def = DAW.plugins.get('delay3');
  okf('D.1 delay3 が登録されている', !!def);
  if (!def) return;
  const BPM0 = DAW.project.bpm;
  DAW.setBpm(120);

  const rms = (a, from, to) => {
    from = Math.max(0, Math.round(from)); to = Math.min(a.length, Math.round(to));
    let s = 0;
    for (let i = from; i < to; i++) s += a[i] * a[i];
    return Math.sqrt(s / Math.max(1, to - from));
  };
  const peakIdx = (a, from, to) => {
    from = Math.max(0, Math.round(from || 0)); to = Math.min(a.length, Math.round(to || a.length));
    let p = 0, pi = from;
    for (let i = from; i < to; i++) { const v = Math.abs(a[i]); if (v > p) { p = v; pi = i; } }
    return pi;
  };

  // プラグイン単体を通したステレオレンダリング。
  // change を渡すと OfflineAudioContext.suspend でレンダリング途中に set() を呼ぶ
  // （タイム変更モードの検証はこれで「再生中の変更」を再現する）。
  const render = async (params, fill, seconds, change) => {
    const len = Math.round(SR * seconds);
    const off = new OfflineAudioContext(2, len, SR);
    const buf = off.createBuffer(2, len, SR);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = fill(i / SR, c);
    }
    const p = Object.assign(DAW.plugins.defaultParams(def), params || {});
    const inst = def.create(off, p);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(inst.input);
    inst.output.connect(off.destination);
    src.start(0);
    if (change) {
      const at = Math.round(change.at * SR / 128) * 128 / SR;   // 量子境界へ丸める
      off.suspend(at).then(() => { change.fn(inst); off.resume(); });
    }
    return await off.startRendering();
  };
  const impAt = at => t => (Math.round(t * SR) === Math.round(at * SR) ? 1 : 0);
  const burst = (f, a, dur) => t => (t < dur ? a * Math.sin(2 * Math.PI * f * t) : 0);
  // 帰還の色付けを無効化する共通指定（フィルタ全開・サチュレーションなし）
  const plain = { freq: 18000, sat: 0 };

  // ---- 音価 → 秒の換算（出力はウェットのみなので最初のエコー位置で測る） ----
  {
    const tol = 0.005 * SR;
    const q = await render(Object.assign({ sync: 1, note: 3, feedback: 0 }, plain), impAt(0), 1);
    const iq = peakIdx(q.getChannelData(0));
    okf('D.2 1/4 @120BPM は 0.5秒', Math.abs(iq - 0.5 * SR) < tol, `${(iq / SR).toFixed(4)}s`);
    const d8 = await render(Object.assign({ sync: 1, note: 2, feedback: 0 }, plain), impAt(0), 1);
    const id8 = peakIdx(d8.getChannelData(0));
    okf('D.3 付点1/8 @120BPM は 0.375秒', Math.abs(id8 - 0.375 * SR) < tol, `${(id8 / SR).toFixed(4)}s`);
    const ms = await render(Object.assign({ sync: 0, timeMs: 250, feedback: 0 }, plain), impAt(0), 1);
    const ims = peakIdx(ms.getChannelData(0));
    okf('D.4 同期OFFは ms 指定どおり (250ms)', Math.abs(ims - 0.25 * SR) < tol, `${(ims / SR).toFixed(4)}s`);
    DAW.setBpm(90);
    const q90 = await render(Object.assign({ sync: 1, note: 3, feedback: 0 }, plain), impAt(0), 1);
    const iq90 = peakIdx(q90.getChannelData(0));
    okf('D.5 BPM を変えると換算も変わる (1/4 @90BPM ≈ 0.667秒)',
      Math.abs(iq90 - (60 / 90) * SR) < tol, `${(iq90 / SR).toFixed(4)}s`);
    DAW.setBpm(120);
  }

  // ---- BPM 変更へのライブ追従（DAW.setBpm フック） ----
  {
    const ctx = DAW.audio.ensureCtx();
    const inst = def.create(ctx, Object.assign(DAW.plugins.defaultParams(def), { sync: 1, note: 3 }));
    okf('D.6 ライブ生成直後のタイムは現在 BPM を反映', Math.abs(inst.currentDelaySec() - 0.5) < 1e-6,
      `${inst.currentDelaySec()}s`);
    DAW.setBpm(100);
    okf('D.7 setBpm でライブインスタンスが追従する (1/4 @100BPM = 0.6秒)',
      Math.abs(inst.currentDelaySec() - 0.6) < 1e-6, `${inst.currentDelaySec()}s`);
    DAW.setBpm(120);
    try { inst.input.disconnect(); inst.output.disconnect(); } catch (e) {}
  }

  // ---- フィードバック減衰（各エコーがほぼ帰還量倍で減る） ----
  {
    const out = await render(Object.assign({ sync: 0, timeMs: 200, feedback: 0.5 }, plain),
      burst(440, 0.4, 0.05), 1);
    const a = out.getChannelData(0);
    const e = k => rms(a, (0.2 * k - 0.005) * SR, (0.2 * k + 0.055) * SR);
    const r21 = e(2) / e(1);
    const r32 = e(3) / e(2);
    okf('D.8 2回目/1回目のエコー比 ≈ 帰還量 0.5', r21 > 0.4 && r21 < 0.6, `比=${r21.toFixed(3)}`);
    okf('D.9 3回目/2回目のエコー比 ≈ 帰還量 0.5', r32 > 0.4 && r32 < 0.6, `比=${r32.toFixed(3)}`);
  }

  // ---- クロスフェードモード: 再生中のタイム変更でクリックしない ----
  {
    const out = await render(Object.assign({ sync: 0, timeMs: 300, feedback: 0.3, mode: 0 }, plain),
      t => 0.5 * Math.sin(2 * Math.PI * 440 * t), 3,
      { at: 1.5, fn: inst => inst.set('timeMs', 470) });
    let maxDiff = 0;
    for (let c = 0; c < 2; c++) {
      const a = out.getChannelData(c);
      for (let i = Math.round(0.1 * SR) + 1; i < a.length; i++) {
        const d = Math.abs(a[i] - a[i - 1]);
        if (d > maxDiff) maxDiff = d;
      }
    }
    // 440Hz 正弦（振幅の総和 ≤ 0.5/(1-0.3)）の自然な隣接差の上限は約 0.041。
    // タイムをハードに切り替えると位相跳びで 0.1〜1 級の段差が出る。
    okf('D.10 クロスフェードのタイム変更で不連続（クリック）が出ない', maxDiff < 0.06,
      `隣接サンプル差の最大=${maxDiff.toFixed(4)}`);
    const imp = await render(Object.assign({ sync: 0, timeMs: 300, feedback: 0, mode: 0 }, plain),
      impAt(2.0), 3, { at: 1.5, fn: inst => inst.set('timeMs', 470) });
    const ip = peakIdx(imp.getChannelData(0), 2.1 * SR, 3 * SR);
    okf('D.11 変更後は新しいタイムで鳴る (470ms)', Math.abs(ip - 2.47 * SR) < 0.005 * SR,
      `${(ip / SR - 2).toFixed(4)}s`);
  }

  // ---- テープ風モード: 遅延時間が滑らかに（連続的に）変わる ----
  {
    // 入力に直線ランプ x(t)=t を流すと、出力 y から実効遅延 d(t)=t-y(t) を逐次読める
    const out = await render(Object.assign({ sync: 0, timeMs: 200, feedback: 0, mode: 1 }, plain),
      t => t, 2.5, { at: 1.0, fn: inst => inst.set('timeMs', 400) });
    const y = out.getChannelData(0);
    const del = i => i / SR - y[i];
    okf('D.12 変更前の実効遅延は 200ms', Math.abs(del(Math.round(0.9 * SR)) - 0.2) < 0.004,
      `${(del(Math.round(0.9 * SR)) * 1000).toFixed(1)}ms`);
    okf('D.13 変更後の実効遅延は 400ms', Math.abs(del(Math.round(2.4 * SR)) - 0.4) < 0.004,
      `${(del(Math.round(2.4 * SR)) * 1000).toFixed(1)}ms`);
    let maxStep = 0;
    for (let i = Math.round(0.5 * SR); i < Math.round(2.0 * SR); i++) {
      const d = Math.abs(del(i + 1) - del(i));
      if (d > maxStep) maxStep = d;
    }
    // 直線ランプ（0.25秒で200ms移動）なら1サンプルあたり約17µs。跳びがあれば数十ms級になる
    okf('D.14 遅延時間がジャンプせず滑らかにスライドする', maxStep < 0.001,
      `1サンプルあたりの変化の最大=${(maxStep * 1e6).toFixed(1)}µs`);
  }

  // ---- ピンポン: エコーが L → R → L と交互に跳ねる ----
  {
    const params = Object.assign({ sync: 0, timeMs: 250, feedback: 0.6, pingpong: 1 }, plain);
    const out = await render(params, burst(440, 0.5, 0.03), 1.2);
    const L = out.getChannelData(0), R = out.getChannelData(1);
    const win = (a, k) => rms(a, (0.25 * k - 0.005) * SR, (0.25 * k + 0.04) * SR);
    okf('D.15 1回目のエコーは L', win(L, 1) > 5 * win(R, 1),
      `L=${win(L, 1).toFixed(4)} R=${win(R, 1).toFixed(4)}`);
    okf('D.16 2回目のエコーは R', win(R, 2) > 5 * win(L, 2),
      `L=${win(L, 2).toFixed(4)} R=${win(R, 2).toFixed(4)}`);
    okf('D.17 3回目のエコーは再び L', win(L, 3) > 5 * win(R, 3),
      `L=${win(L, 3).toFixed(4)} R=${win(R, 3).toFixed(4)}`);
    const st = await render(Object.assign({}, params, { pingpong: 0 }), burst(440, 0.5, 0.03), 1.2);
    const ratio = win(st.getChannelData(0), 1) / win(st.getChannelData(1), 1);
    okf('D.18 ピンポン OFF ならエコーは左右同等', ratio > 0.83 && ratio < 1.2, `L/R=${ratio.toFixed(3)}`);
  }

  // ---- 決定性（再生と書き出しの一致の根拠）と書き出し経路 ----
  {
    const p = { sync: 0, timeMs: 180, feedback: 0.5, freq: 2500, sat: 0.6, mode: 1, pingpong: 1 };
    const a = await render(p, burst(330, 0.5, 0.1), 1.5);
    const b = await render(p, burst(330, 0.5, 0.1), 1.5);
    let same = true;
    let finite = true;
    for (let c = 0; c < 2 && same; c++) {
      const x = a.getChannelData(c), z = b.getChannelData(c);
      for (let i = 0; i < x.length; i++) {
        if (x[i] !== z[i]) { same = false; break; }
        if (!isFinite(x[i])) { finite = false; break; }
      }
    }
    okf('D.19 同じ設定なら毎回まったく同じ出力（オフライン書き出し一致）', same);
    okf('D.20 フィルタ+サチュレーション込みでも非有限値が出ない', finite);

    // 実際のトラックに載せて書き出せること
    const ctx0 = DAW.audio.ensureCtx();
    const buf = ctx0.createBuffer(2, ctx0.sampleRate, ctx0.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = 0.4 * Math.sin(2 * Math.PI * 330 * i / ctx0.sampleRate);
    }
    const bid = DAW.registerBuffer(buf);
    const track = DAW.project.tracks[0];
    track.clips.push({ id: DAW.uid(), bufferId: bid, startTime: 0, offset: 0, duration: 1, name: 'c' });
    track.effects = [{ pluginId: 'delay3', params: DAW.plugins.defaultParams(def) }];
    H.downloads.length = 0;
    await DAW.wav.exportMix();
    okf('D.21 delay3 を挿したトラックが書き出しに通る',
      H.downloads.length === 1 && H.downloads[0].filename === 'mix.wav');
    // ライブ変更経路（スロット経由の set）が例外を出さない
    DAW.audio.ensureCtx();
    DAW.audio.getTrackNodes(track);
    DAW.audio.setEffectParam(track, 0, 'note', 1);
    DAW.audio.setEffectParam(track, 0, 'mode', 1);
    DAW.audio.setEffectParam(track, 0, 'timeMs', 120);
    DAW.audio.setEffectParam(track, 0, 'pingpong', 1);
    DAW.audio.setEffectParam(track, 0, 'sat', 0.8);
    okf('D.22 パラメータのライブ変更が例外なく通る', true);
    track.effects = [];
  }

  DAW.setBpm(BPM0);
  okf('D.23 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
