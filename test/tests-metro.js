'use strict';
// =====================================================================
// メトロノーム（クリック）のテスト。
// build-verify.py は tests-*.js を名前順に読むため、他ファイルのヘルパには依存しない。
// =====================================================================

function metroSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.metronome.enabled = false;
    DAW.setBpm(120);
    DAW.addTrack();
    DAW.ui.renderTracks();
    DAW.history.reset();
    try {
      await body(okf);
    } finally {
      DAW.metronome.enabled = false;
      DAW.ui.els.btnMetro.classList.remove('on');
      try { DAW.audio.stop(); } catch (e) {}
    }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

metroSuite('[20] メトロノーム', async (okf) => {
  const ui = DAW.ui;
  const ctx0 = DAW.audio.ensureCtx();

  okf('N.1 既定は無効', DAW.metronome.enabled === false);
  okf('N.2 専用の出力ノードを持つ（マスター音量と独立）',
    !!DAW.audio.metroGain && DAW.audio.metroGain !== DAW.audio.masterGain);

  ui.els.btnMetro.click();
  okf('N.3 ボタンで有効化', DAW.metronome.enabled === true && ui.els.btnMetro.classList.contains('on'));
  ui.els.btnMetro.click();
  okf('N.4 もう一度押すと無効化', DAW.metronome.enabled === false && !ui.els.btnMetro.classList.contains('on'));

  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', bubbles: true, cancelable: true }));
  okf('N.5 M キーでも切り替わる', DAW.metronome.enabled === true);

  // クリップが無くてもクリックのために再生が始まる（録音時に必要）
  okf('N.6 クリップ0本でも再生できる（録音時のクリック用）', DAW.projectDuration() === 0);
  await DAW.audio.play();
  okf('N.7 クリック有効なら空プロジェクトでも play する', DAW.audio.playing === true);
  okf('N.8 クリック音源が予約されている', DAW.audio.sources.length > 100,
    'sources=' + DAW.audio.sources.length + '（5分先まで予約）');
  DAW.audio.stop();
  okf('N.9 停止で全て止まる', DAW.audio.sources.length === 0 && !DAW.audio.playing);

  DAW.metronome.enabled = false;
  await DAW.audio.play();
  okf('N.10 クリック無効かつクリップ0本なら再生しない（従来どおり）', DAW.audio.playing === false);

  // 予約タイミングの検証: BPM から拍位置を計算し、OfflineAudioContext で実波形を確認する
  {
    const SRT = 48000;
    const off = new OfflineAudioContext(1, SRT * 2, SRT);
    // 本体と同じ組み立てを再現する（scheduleMetronome は this.ctx を使うため差し替えて呼ぶ）
    const savedCtx = DAW.audio.ctx, savedGain = DAW.audio.metroGain, savedSrc = DAW.audio.sources;
    DAW.audio.ctx = off;
    DAW.audio.metroGain = off.createGain();
    DAW.audio.metroGain.connect(off.destination);
    DAW.audio.sources = [];
    DAW.metronome.enabled = true;
    DAW.setBpm(120);                       // 1拍 = 0.5秒
    DAW.audio.scheduleMetronome(0, 0, 2);
    const n = DAW.audio.sources.length;
    DAW.audio.ctx = savedCtx; DAW.audio.metroGain = savedGain; DAW.audio.sources = savedSrc;
    DAW.metronome.enabled = false;

    okf('N.11 2秒間に5回（0.0/0.5/1.0/1.5/2.0秒）予約される', n === 5, 'count=' + n);
    const d = (await off.startRendering()).getChannelData(0);
    const at = t => {
      let p = 0;
      for (let i = Math.round(t * SRT); i < Math.round((t + 0.04) * SRT); i++) p = Math.max(p, Math.abs(d[i]));
      return p;
    };
    okf('N.12 拍の位置に音が出ている', at(0) > 0.3 && at(0.5) > 0.3 && at(1.0) > 0.3 && at(1.5) > 0.3,
      [0, 0.5, 1.0, 1.5].map(t => at(t).toFixed(2)).join(' / '));
    okf('N.13 拍と拍の間は無音', at(0.25) < 0.01 && at(0.75) < 0.01,
      at(0.25).toFixed(4) + ' / ' + at(0.75).toFixed(4));
    // 小節頭(1600Hz)と裏拍(1000Hz)の高さの違い: ゼロ交差数で判定する
    const cross = (t0, t1) => {
      let c = 0;
      for (let i = Math.round(t0 * SRT) + 1; i < Math.round(t1 * SRT); i++) {
        if ((d[i - 1] < 0) !== (d[i] < 0)) c++;
      }
      return c;
    };
    okf('N.14 小節頭のクリックは他の拍より高い音', cross(0, 0.02) > cross(0.5, 0.52),
      '1拍目=' + cross(0, 0.02) + '交差 / 2拍目=' + cross(0.5, 0.52) + '交差');
  }

  // BPM を変えると間隔が変わる
  {
    const SRT = 48000;
    const off = new OfflineAudioContext(1, SRT * 2, SRT);
    const savedCtx = DAW.audio.ctx, savedGain = DAW.audio.metroGain, savedSrc = DAW.audio.sources;
    DAW.audio.ctx = off;
    DAW.audio.metroGain = off.createGain(); DAW.audio.metroGain.connect(off.destination);
    DAW.audio.sources = [];
    DAW.metronome.enabled = true;
    DAW.setBpm(240);                        // 1拍 = 0.25秒
    DAW.audio.scheduleMetronome(0, 0, 1);
    const n = DAW.audio.sources.length;
    DAW.audio.ctx = savedCtx; DAW.audio.metroGain = savedGain; DAW.audio.sources = savedSrc;
    DAW.metronome.enabled = false; DAW.setBpm(120);
    okf('N.15 BPM240 では1秒間に5回', n === 5, 'count=' + n);
  }

  // 途中から再生した場合、その位置以降の拍だけ予約される
  {
    const SRT = 48000;
    const off = new OfflineAudioContext(1, SRT, SRT);
    const savedCtx = DAW.audio.ctx, savedGain = DAW.audio.metroGain, savedSrc = DAW.audio.sources;
    DAW.audio.ctx = off;
    DAW.audio.metroGain = off.createGain(); DAW.audio.metroGain.connect(off.destination);
    DAW.audio.sources = [];
    DAW.metronome.enabled = true;
    DAW.audio.scheduleMetronome(1.1, 0, 2);   // 1.1秒地点から再生開始
    const n = DAW.audio.sources.length;
    DAW.audio.ctx = savedCtx; DAW.audio.metroGain = savedGain; DAW.audio.sources = savedSrc;
    DAW.metronome.enabled = false;
    okf('N.16 途中再生では以降の拍だけ予約（1.5/2.0秒の2回）', n === 2, 'count=' + n);
    const d = (await off.startRendering()).getChannelData(0);
    const peakIn = (t0, t1) => {
      let p = 0;
      for (let i = Math.round(t0 * SRT); i < Math.round(t1 * SRT); i++) p = Math.max(p, Math.abs(d[i]));
      return p;
    };
    // 1.1秒から再生 → 最初のクリックは 1.5秒の拍（再生開始から 0.4秒後）
    okf('N.17 再生開始直後に余計なクリックが出ない（次の拍まで無音）',
      peakIn(0, 0.39) < 0.01 && peakIn(0.4, 0.45) > 0.3,
      '開始直後=' + peakIn(0, 0.39).toFixed(4) + ' / 0.4秒後=' + peakIn(0.4, 0.45).toFixed(3));
  }

  // 書き出しには入らない
  {
    DAW.metronome.enabled = true;
    const buf = ctx0.createBuffer(2, ctx0.sampleRate, ctx0.sampleRate);
    const bid = DAW.registerBuffer(buf);      // 完全な無音素材
    DAW.project.tracks[0].clips.push({ id: DAW.uid(), bufferId: bid, startTime: 0, offset: 0, duration: 1, name: 'silent' });
    H.downloads.length = 0;
    await DAW.wav.exportMix();
    const dl = H.downloads[H.downloads.length - 1];
    const ab = await dl.blob.arrayBuffer();
    const dec = await new OfflineAudioContext(2, 128, new DataView(ab).getUint32(24, true)).decodeAudioData(ab.slice(0));
    let peak = 0;
    const ch = dec.getChannelData(0);
    for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
    okf('N.18 クリックは WAV 書き出しに混入しない', peak < 0.001, 'ピーク=' + peak.toFixed(5));
    DAW.metronome.enabled = false;
  }
  okf('N.19 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
