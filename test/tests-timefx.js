'use strict';
// =====================================================================
// タイムFX（Gross Beat 風グリッチ / スタッター）のテスト。
// 他ファイルのヘルパには依存しない（tests-*.js は名前順に読まれるため）。
// =====================================================================

function timefxSuite(group, body) {
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

timefxSuite('[TFX] タイムFX', async (okf) => {
  const SRT = DAW.audio.ensureCtx().sampleRate;
  const bpm0 = DAW.project.bpm;
  DAW.setBpm(120);   // 1拍 = 0.5秒 / 1小節 = 2秒 に固定してから測る

  const rmsIn = (a, fromSec, toSec) => {
    const i0 = Math.round(fromSec * SRT), i1 = Math.min(a.length, Math.round(toSec * SRT));
    let s = 0;
    for (let i = i0; i < i1; i++) s += a[i] * a[i];
    return Math.sqrt(s / Math.max(1, i1 - i0));
  };
  const maxDiff = (a, b) => {
    let m = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const d = Math.abs(a[i] - b[i]);
      if (d > m) m = d;
    }
    return m;
  };
  // ゼロ交差数（周波数の概算検証用）
  const zc = (a, fromSec, toSec) => {
    const i0 = Math.round(fromSec * SRT), i1 = Math.min(a.length, Math.round(toSec * SRT));
    let n = 0;
    for (let i = i0 + 1; i < i1; i++) {
      if ((a[i - 1] < 0 && a[i] >= 0) || (a[i - 1] > 0 && a[i] <= 0)) n++;
    }
    return n;
  };
  // 最大サンプル間段差（クリック検出用）
  const maxStep = (a, fromSec, toSec) => {
    const i0 = Math.max(1, Math.round(fromSec * SRT)), i1 = Math.min(a.length, Math.round(toSec * SRT));
    let m = 0;
    for (let i = i0; i < i1; i++) {
      const d = Math.abs(a[i] - a[i - 1]);
      if (d > m) m = d;
    }
    return m;
  };

  // タイムFX を1つ通したレンダリング。
  //   exportFrom: 書き出し開始のタイムライン位置（exportMix と同じく
  //               DAW.objaudio.exportRange 経由で位相基準に渡る）
  //   tweak: { at, fn } … at 秒でレンダリングを一時停止して fn(inst) を実行（切替テスト用）
  const render = async (params, fill, seconds, exportFrom, tweak) => {
    seconds = seconds || 2;
    const len = Math.round(SRT * seconds);
    const off = new OfflineAudioContext(1, len, SRT);
    const buf = off.createBuffer(1, len, SRT);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = fill(i / SRT);
    const def = DAW.plugins.get('timefx');
    const p = Object.assign(DAW.plugins.defaultParams(def), params || {});
    await def.prepare(off);
    DAW.objaudio.exportRange = exportFrom ? { from: exportFrom, until: exportFrom + seconds } : null;
    let inst;
    try { inst = def.create(off, p); } finally { DAW.objaudio.exportRange = null; }
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(inst.input);
    inst.output.connect(off.destination);
    src.start(0);
    let pending = null;
    if (tweak) {
      pending = off.suspend(tweak.at).then(async () => {
        tweak.fn(inst);
        // postMessage がレンダリングスレッドへ届くのを1マクロタスク待ってから再開する
        await new Promise(r => setTimeout(r, 30));
        return off.resume();
      });
    }
    const out = (await off.startRendering()).getChannelData(0);
    if (pending) await pending;
    return out;
  };
  const sine = (f, a) => t => a * Math.sin(2 * Math.PI * f * t);

  okf('X.1 タイムFXが登録されている', !!DAW.plugins.get('timefx'));

  // --- 素通し ---
  {
    const len = Math.round(SRT * 2);
    const input = new Float32Array(len);
    for (let i = 0; i < len; i++) input[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / SRT);
    const out = await render({ timePattern: 0, volPattern: 0, mix: 1 }, sine(440, 0.5));
    okf('X.2 素通しパターンは入力とほぼ一致する', maxDiff(out, input) < 1e-6,
      `最大差=${maxDiff(out, input).toExponential(2)}`);
    const out0 = await render({ timePattern: 6, volPattern: 1, mix: 0 }, sine(440, 0.5));
    okf('X.3 深さ0ならどのパターンでも素通しになる', maxDiff(out0, input) < 1e-6,
      `最大差=${maxDiff(out0, input).toExponential(2)}`);
  }

  // --- ハーフスピード: 周波数が半分になる（ゼロ交差数で概算） ---
  {
    const inp = new Float32Array(Math.round(SRT * 2));
    for (let i = 0; i < inp.length; i++) inp[i] = 0.6 * Math.sin(2 * Math.PI * 440 * i / SRT);
    const out = await render({ timePattern: 1 }, sine(440, 0.6));
    const zIn = zc(inp, 0.2, 1.8);   // 1小節=2秒: 窓は小節内に収める
    const zOut = zc(out, 0.2, 1.8);
    okf('X.4 ハーフスピードで周波数が約半分になる', Math.abs(zOut / zIn - 0.5) < 0.08,
      `入力=${zIn}交差 出力=${zOut}交差 比=${(zOut / zIn).toFixed(3)}`);

    // 逆再生風: 速度は等倍なので周波数は変わらない。
    // 1拍目は「直前の拍」がまだ録音されておらず無音なので、窓は2拍目以降にする。
    const rev = await render({ timePattern: 5 }, sine(440, 0.6));
    const r = zc(rev, 0.55, 1.8) / zc(inp, 0.55, 1.8);
    okf('X.5 逆再生風は周波数を保つ（等倍逆走）', Math.abs(r - 1) < 0.15, `比=${r.toFixed(3)}`);
  }

  // --- テープストップ: 小節の終わりへ向けて周波数が下がる ---
  {
    const out = await render({ timePattern: 6 }, sine(440, 0.6));
    const early = zc(out, 0.1, 0.4);
    const late = zc(out, 1.6, 1.9);
    okf('X.6 テープストップは小節末で周波数が大きく下がる', late < early * 0.5,
      `前半=${early}交差 後半=${late}交差`);
  }

  // --- 1拍リピート: 1拍目の内容が繰り返される ---
  {
    // 拍ごとに振幅を変えた入力（拍0=0.2, 拍1=0.4, 拍2=0.6, 拍3=0.8）
    const fill = t => {
      const k = Math.min(3, Math.floor(t / 0.5));
      return (k + 1) * 0.2 * Math.sin(2 * Math.PI * 440 * t);
    };
    const out = await render({ timePattern: 2 }, fill);
    const r3 = rmsIn(out, 1.55, 1.95);        // 4拍目の窓
    const beat0 = 0.2 / Math.SQRT2;           // 1拍目の rms ≈ 0.141
    okf('X.7 1拍リピートは4拍目でも1拍目の内容を鳴らす', r3 > 0.06 && r3 < 0.25,
      `4拍目rms=${r3.toFixed(3)}（1拍目=${beat0.toFixed(3)} / 入力4拍目=${(0.8 / Math.SQRT2).toFixed(3)}）`);
  }

  // --- ゲートパターンの無音区間 ---
  {
    const out = await render({ timePattern: 0, volPattern: 1 }, sine(440, 0.6));
    const on = rmsIn(out, 0.05, 0.20);        // 拍の前半 = 開く
    const offR = rmsIn(out, 0.30, 0.48);      // 拍の後半 = 閉じる（3msスルー後は完全無音）
    okf('X.8 4分ゲートの閉区間は無音になる', offR < 1e-4 && on > 0.2,
      `開区間rms=${on.toFixed(3)} 閉区間rms=${offR.toExponential(2)}`);
    const out8 = await render({ timePattern: 0, volPattern: 2 }, sine(440, 0.6));
    okf('X.9 8分ゲートは半拍周期で刻む',
      rmsIn(out8, 0.15, 0.23) < 1e-4 && rmsIn(out8, 0.02, 0.10) > 0.2,
      `開=${rmsIn(out8, 0.02, 0.10).toFixed(3)} 閉=${rmsIn(out8, 0.15, 0.23).toExponential(2)}`);
  }

  // --- 切替クロスフェード: セグメント境界とパターン切替でクリックしない ---
  {
    // 443Hz は1拍(0.5秒)遅れがちょうど逆相になる周波数 = クロスフェードが無ければ段差約1.2
    const out = await render({ timePattern: 2 }, sine(443, 0.6), 2, 0,
      { at: 0.9, fn: inst => inst.set('timePattern', 4) });   // 0.9秒でスタッターへ切替
    const step = maxStep(out, 0.01, 2);
    const natural = 0.6 * 2 * Math.PI * 443 / SRT;   // 連続な正弦波の最大サンプル差
    okf('X.10 セグメント境界とパターン切替でクリックが出ない', step < 0.1,
      `最大段差=${step.toFixed(4)}（連続波形なら${natural.toFixed(4)}・フェード無しなら約1.2）`);
  }

  // --- オフライン決定性: 同じ設定なら2回のレンダリングが完全一致 ---
  {
    const a = await render({ timePattern: 7, volPattern: 3, mix: 0.8 }, sine(440, 0.6));
    const b = await render({ timePattern: 7, volPattern: 3, mix: 0.8 }, sine(440, 0.6));
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
    okf('X.11 オフライン2回レンダリングが完全一致する（再生と書き出しが一致）', same);
  }

  // --- 再生開始位置が小節の途中でも位相が合う ---
  {
    // タイムライン 0.25 秒（半拍目）から書き出すと、ゲートは頭から「閉」で始まるはず
    const out = await render({ timePattern: 0, volPattern: 1 }, sine(440, 0.6), 2, 0.25);
    const head = rmsIn(out, 0.02, 0.23);      // タイムライン 0.27..0.48 = 拍後半 → 無音
    const open = rmsIn(out, 0.27, 0.48);      // タイムライン 0.52..0.73 = 拍前半 → 開く
    const next = rmsIn(out, 0.55, 0.73);      // タイムライン 0.80..0.98 = 拍後半 → 無音
    okf('X.12 書き出し開始が拍の途中でもゲート位相がタイムライン基準になる',
      head < 1e-3 && open > 0.2 && next < 1e-3,
      `頭=${head.toExponential(2)} 開=${open.toFixed(3)} 次閉=${next.toExponential(2)}`);
  }

  // --- 非有限値が出ない ---
  {
    const out = await render({ timePattern: 5, volPattern: 3, mix: 1 }, sine(440, 0.9));
    let finite = true;
    for (let i = 0; i < out.length; i++) if (!isFinite(out[i])) { finite = false; break; }
    okf('X.13 非有限値が出ない', finite);
  }

  // --- 実際のトラックに載せて書き出し・ライブ再生できること ---
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
      { pluginId: 'timefx', params: Object.assign(DAW.plugins.defaultParams(DAW.plugins.get('timefx')), { timePattern: 4, volPattern: 1 }) },
    ];
    H.downloads.length = 0;
    await DAW.wav.exportMix();
    okf('X.14 タイムFXを載せたトラックが書き出しに通る',
      H.downloads.length === 1 && H.downloads[0].filename === 'mix.wav');
    // ライブ再生: 途中位置から開始してトランスポート同期フックを通し、ライブ変更も試す
    DAW.audio.playheadPos = 0.3;
    await DAW.audio.play();
    await new Promise(r => setTimeout(r, 150));
    DAW.audio.setEffectParam(track, 0, 'timePattern', 2);
    DAW.audio.setEffectParam(track, 0, 'mix', 0.5);
    await new Promise(r => setTimeout(r, 100));
    const playing = DAW.audio.playing;
    DAW.audio.stop();
    okf('X.15 途中位置からのライブ再生とパラメータのライブ変更が例外なく通る', playing);
    track.effects = [];
  }

  DAW.setBpm(bpm0);
  okf('X.16 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
