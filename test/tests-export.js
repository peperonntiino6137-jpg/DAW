'use strict';
// =====================================================================
// ループ区間の書き出しのテスト（他ファイルのヘルパには依存しない）。
// =====================================================================

function exportSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.project.masterVolume = 1;
    DAW.loop.enabled = false; DAW.loop.start = 0; DAW.loop.end = 0;
    DAW.metronome.enabled = false;
    DAW.addTrack();
    DAW.ui.renderTracks();
    DAW.ui.updateExportLabel();
    DAW.history.reset();
    try { await body(okf); } finally {
      DAW.loop.enabled = false; DAW.loop.start = 0; DAW.loop.end = 0;
      DAW.ui.updateExportLabel();
      try { DAW.audio.stop(); } catch (e) {}
    }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

exportSuite('[24] ループ区間の書き出し', async (okf) => {
  const ctx0 = DAW.audio.ensureCtx();
  const SRT = ctx0.sampleRate;
  // 1秒ごとに振幅が変わる素材（どの区間が書き出されたか値で判別できる）
  const buf = ctx0.createBuffer(1, SRT * 4, SRT);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = 0.2 * (Math.floor(i / SRT) + 1);   // 0.2 / 0.4 / 0.6 / 0.8
  const bid = DAW.registerBuffer(buf);
  DAW.project.tracks[0].clips.push({
    id: DAW.uid(), bufferId: bid, startTime: 0, offset: 0, duration: 4, name: 'steps', fadeIn: 0, fadeOut: 0,
  });

  const decodeLast = async () => {
    const dl = H.downloads[H.downloads.length - 1];
    const ab = await dl.blob.arrayBuffer();
    const dec = await new OfflineAudioContext(2, 128, new DataView(ab).getUint32(24, true)).decodeAudioData(ab.slice(0));
    return { name: dl.filename, buf: dec };
  };
  // モノラル素材は StereoPanner の等パワー則で各チャンネル 1/√2 になる（pan=0 でも -3dB）。
  // これは Web Audio の仕様どおりなので、期待値側で織り込む。
  const PAN0 = Math.SQRT1_2;
  const at = (b, t) => b.getChannelData(0)[Math.round(t * b.sampleRate)] / PAN0;

  // ループ無効: 従来どおり全体を mix.wav へ
  H.downloads.length = 0;
  await DAW.wav.exportMix();
  {
    const r = await decodeLast();
    okf('X.1 ループ無効なら全体を mix.wav に書き出す',
      r.name === 'mix.wav' && Math.abs(r.buf.duration - 4) < 0.01,
      `${r.name} / ${r.buf.duration.toFixed(3)}秒`);
    okf('X.2 全体書き出しの中身が正しい',
      Math.abs(at(r.buf, 0.5) - 0.2) < 0.02 && Math.abs(at(r.buf, 3.5) - 0.8) < 0.02,
      `0.5s=${at(r.buf, 0.5).toFixed(2)} 3.5s=${at(r.buf, 3.5).toFixed(2)}`);
  }

  // ループ有効: 区間だけを loop.wav へ
  DAW.setLoop(1, 3);
  DAW.loop.enabled = true;
  DAW.ui.updateExportLabel();
  H.downloads.length = 0;
  await DAW.wav.exportMix();
  {
    const r = await decodeLast();
    okf('X.3 ループ有効なら区間だけを loop.wav に書き出す',
      r.name === 'loop.wav' && Math.abs(r.buf.duration - 2) < 0.01,
      `${r.name} / ${r.buf.duration.toFixed(3)}秒（区間 1〜3秒）`);
    okf('X.4 書き出しの先頭が区間の先頭に一致する',
      Math.abs(at(r.buf, 0.1) - 0.4) < 0.02 && Math.abs(at(r.buf, 1.5) - 0.6) < 0.02,
      `0.1s=${at(r.buf, 0.1).toFixed(2)}（=元の1.1秒） 1.5s=${at(r.buf, 1.5).toFixed(2)}（=元の2.5秒）`);
    okf('X.5 区間外（0.2 や 0.8）が混ざらない',
      Math.abs(at(r.buf, 0.5) - 0.2) > 0.1 && Math.abs(at(r.buf, 1.9) - 0.8) > 0.1);
  }

  okf('X.6 ボタン表示でループ区間の書き出しだと分かる',
    DAW.ui.els.btnExport.textContent.indexOf('ループ区間') >= 0, DAW.ui.els.btnExport.textContent);
  DAW.ui.els.btnLoop.click();   // ループ解除
  okf('X.7 ループを解除するとボタン表示も戻る',
    DAW.ui.els.btnExport.textContent === 'WAV書き出し', DAW.ui.els.btnExport.textContent);

  // クリップがループ末尾をまたぐ場合、末尾で切られる
  DAW.setLoop(0.5, 1.5);
  DAW.loop.enabled = true;
  H.downloads.length = 0;
  await DAW.wav.exportMix();
  {
    const r = await decodeLast();
    okf('X.8 ループ末尾をまたぐクリップは末尾で切られる',
      Math.abs(r.buf.duration - 1) < 0.01 && Math.abs(at(r.buf, 0.2) - 0.2) < 0.02
      && Math.abs(at(r.buf, 0.8) - 0.4) < 0.02,
      `${r.buf.duration.toFixed(3)}秒 / 0.2s=${at(r.buf, 0.2).toFixed(2)} 0.8s=${at(r.buf, 0.8).toFixed(2)}`);
    // 末尾はデクリックで 0 に落ちている
    const tail = at(r.buf, 0.9995);
    okf('X.9 書き出しの末尾はデクリックされている（プチノイズ防止）', Math.abs(tail) < 0.1,
      `末尾=${(tail * PAN0).toFixed(4)}`);
  }
  DAW.loop.enabled = false;
  DAW.ui.updateExportLabel();
  okf('X.10 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
