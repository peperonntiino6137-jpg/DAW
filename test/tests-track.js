'use strict';
// =====================================================================
// トラックの並び替えのテスト（他ファイルのヘルパには依存しない）。
// =====================================================================

function trackSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.clipboard = null;
    DAW.addTrack('A'); DAW.addTrack('B'); DAW.addTrack('C');
    DAW.ui.selectedClipId = null;
    DAW.ui.renderTracks();
    DAW.history.reset();
    try { await body(okf); } finally { try { DAW.audio.stop(); } catch (e) {} }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

trackSuite('[21] トラックの並び替え', async (okf) => {
  const ui = DAW.ui;
  const names = () => DAW.project.tracks.map(t => t.name).join(',');
  const [a, b, c] = DAW.project.tracks;

  okf('K.1 初期の並び', names() === 'A,B,C', names());
  okf('K.2 下へ移動', DAW.moveTrack(a.id, 1) && names() === 'B,A,C', names());
  okf('K.3 上へ移動で元に戻る', DAW.moveTrack(a.id, -1) && names() === 'A,B,C', names());
  okf('K.4 先頭より上へは動かせない', DAW.moveTrack(a.id, -1) === false && names() === 'A,B,C', names());
  okf('K.5 末尾より下へは動かせない', DAW.moveTrack(c.id, 1) === false && names() === 'A,B,C', names());
  okf('K.6 存在しないトラックは false', DAW.moveTrack('no-such', 1) === false);

  // UI ボタン
  const headBtns = i => document.querySelectorAll('.track-head')[i].querySelectorAll('.t-move');
  okf('K.7 各トラックに▲▼ボタンがある', headBtns(0).length === 2 && headBtns(2).length === 2);
  headBtns(0)[1].click();   // A を下へ
  okf('K.8 ▼ボタンで下へ移動し、再描画される',
    names() === 'B,A,C' && document.querySelectorAll('.track-head .t-name')[0].value === 'B', names());
  headBtns(1)[0].click();   // A を上へ
  okf('K.9 ▲ボタンで上へ移動', names() === 'A,B,C', names());

  // 履歴
  DAW.history.reset();
  headBtns(0)[1].click();
  okf('K.10 並び替えが履歴に積まれる', DAW.history.canUndo() && names() === 'B,A,C', names());
  await DAW.history.undo();
  okf('K.11 undo で並びが戻る', names() === 'A,B,C', names());
  await DAW.history.redo();
  okf('K.12 redo で並びが再現', names() === 'B,A,C', names());

  // クリップと再生への影響
  {
    const ctx0 = DAW.audio.ensureCtx();
    const buf = ctx0.createBuffer(2, ctx0.sampleRate, ctx0.sampleRate);
    for (let ch = 0; ch < 2; ch++) buf.getChannelData(ch).fill(0.3);
    const bid = DAW.registerBuffer(buf);
    DAW.project.tracks[0].clips.push({ id: DAW.uid(), bufferId: bid, startTime: 0, offset: 0, duration: 1, name: 'x' });
    DAW.project.tracks[2].volume = 0.5;
    ui.renderTracks();
    const order = DAW.project.tracks.map(t => t.id).join(',');
    DAW.moveTrack(DAW.project.tracks[2].id, -1);
    ui.renderTracks();
    okf('K.13 並び替えてもクリップは元のトラックに付いたまま',
      DAW.findClip(DAW.project.tracks.find(t => t.clips.length).clips[0].id) !== null
      && DAW.project.tracks.map(t => t.id).join(',') !== order);
    okf('K.14 音量などトラック設定も一緒に動く',
      DAW.project.tracks[1].volume === 0.5, 'volume=' + DAW.project.tracks[1].volume);
    await DAW.audio.play();
    okf('K.15 並び替え後も再生できる', DAW.audio.playing === true);
    DAW.audio.stop();
  }
  okf('K.16 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
