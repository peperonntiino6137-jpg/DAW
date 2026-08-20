'use strict';
// =====================================================================
// キーボードでの微調整（矢印キー）とシークのスナップ。
// 他ファイルのヘルパには依存しない。
// =====================================================================

function nudgeSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.grid.enabled = false; DAW.grid.division = 1;
    DAW.loop.enabled = false; DAW.loop.start = 0; DAW.loop.end = 0;
    DAW.setBpm(120);
    DAW.addTrack('A'); DAW.addTrack('B');
    DAW.ui.selectedClipId = null;
    DAW.setPPS(DAW.DEFAULT_PPS);
    DAW.ui.renderTracks();
    DAW.history.reset();
    try { await body(okf); } finally { try { DAW.audio.stop(); } catch (e) {} }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

nudgeSuite('[25] キーボードでの微調整', async (okf) => {
  const key = (code, opts) => document.dispatchEvent(
    new KeyboardEvent('keydown', Object.assign({ code, bubbles: true, cancelable: true }, opts)));
  const ctx0 = DAW.audio.ensureCtx();
  const buf = ctx0.createBuffer(1, ctx0.sampleRate, ctx0.sampleRate);
  const bid = DAW.registerBuffer(buf);
  const clip = { id: DAW.uid(), bufferId: bid, startTime: 2, offset: 0, duration: 1, name: 'c', fadeIn: 0, fadeOut: 0 };
  DAW.project.tracks[0].clips.push(clip);
  DAW.ui.renderTracks();

  // 再生ヘッドの移動
  DAW.audio.playheadPos = 0;
  okf('U.1 グリッド無効なら1歩=1秒', DAW.nudgeStep() === 1);
  key('ArrowRight');
  okf('U.2 →で1秒進む', Math.abs(DAW.audio.getPos() - 1) < 1e-9, DAW.audio.getPos());
  key('ArrowRight', { shiftKey: true });
  okf('U.3 Shift+→で5歩進む', Math.abs(DAW.audio.getPos() - 6) < 1e-9, DAW.audio.getPos());
  key('ArrowLeft');
  okf('U.4 ←で戻る', Math.abs(DAW.audio.getPos() - 5) < 1e-9, DAW.audio.getPos());
  DAW.audio.playheadPos = 0.5;
  key('ArrowLeft');
  okf('U.5 0 より前へは行かない', DAW.audio.getPos() === 0, DAW.audio.getPos());

  // グリッドに連動した歩幅
  DAW.grid.enabled = true; DAW.grid.division = 1;   // 120BPM → 1拍 = 0.5秒
  okf('U.6 グリッド有効なら1歩=1マス（0.5秒）', DAW.nudgeStep() === 0.5, DAW.nudgeStep());
  DAW.audio.playheadPos = 0;
  key('ArrowRight');
  okf('U.7 →が1拍ぶんになる', Math.abs(DAW.audio.getPos() - 0.5) < 1e-9, DAW.audio.getPos());
  DAW.grid.division = 4;
  okf('U.8 細かさを変えると歩幅も変わる（1小節=2秒）', DAW.nudgeStep() === 2, DAW.nudgeStep());
  DAW.grid.division = 1;

  // クリップの微調整
  DAW.ui.selectClip(clip.id);
  DAW.history.reset();
  key('ArrowRight', { altKey: true });
  okf('U.9 Alt+→で選択クリップがずれる', Math.abs(clip.startTime - 2.5) < 1e-9, clip.startTime);
  key('ArrowLeft', { altKey: true });
  okf('U.10 Alt+←で戻る', Math.abs(clip.startTime - 2) < 1e-9, clip.startTime);
  okf('U.11 クリップの移動は履歴に積まれる', DAW.history.canUndo());
  await DAW.history.undo();
  await DAW.history.undo();
  okf('U.12 undo で元の位置へ', Math.abs(DAW.findClip(clip.id).clip.startTime - 2) < 1e-9,
    DAW.findClip(clip.id).clip.startTime);

  // クリップのトラック移動
  {
    const c = DAW.findClip(clip.id).clip;
    DAW.ui.selectClip(c.id);
    key('ArrowDown', { altKey: true });
    okf('U.13 Alt+↓で下のトラックへ移る',
      DAW.project.tracks[1].clips.length === 1 && DAW.project.tracks[0].clips.length === 0,
      `A=${DAW.project.tracks[0].clips.length} B=${DAW.project.tracks[1].clips.length}`);
    key('ArrowUp', { altKey: true });
    okf('U.14 Alt+↑で戻る', DAW.project.tracks[0].clips.length === 1);
    key('ArrowUp', { altKey: true });
    okf('U.15 一番上より先へは動かない', DAW.project.tracks[0].clips.length === 1);
  }

  // 選択が無ければ再生ヘッドの移動になる
  DAW.ui.selectClip(null);
  DAW.audio.playheadPos = 0;
  key('ArrowRight', { altKey: true });
  okf('U.16 クリップ未選択の Alt+→は再生ヘッドの移動', DAW.audio.getPos() > 0, DAW.audio.getPos());

  // テキスト入力中は奪わない
  {
    const input = document.querySelector('.t-name');
    input.focus();
    DAW.audio.playheadPos = 0;
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true, cancelable: true }));
    okf('U.17 トラック名の編集中は矢印キーを奪わない', DAW.audio.getPos() === 0, DAW.audio.getPos());
    input.blur();
  }

  // シークのスナップ
  {
    DAW.grid.enabled = true; DAW.grid.division = 1;
    DAW.setPPS(100);
    DAW.ui.els.scroller.scrollLeft = 0;
    const ruler = DAW.ui.els.ruler;
    ruler.setPointerCapture = () => {};
    const ev = (x, opts) => {
      const e = new PointerEvent('pointerdown', Object.assign({ bubbles: true, cancelable: true, pointerId: 1 }, opts));
      Object.defineProperty(e, 'offsetX', { value: x });
      ruler.dispatchEvent(e);
    };
    ev(137);   // 1.37秒 → 最寄りの拍 1.5秒
    okf('U.18 グリッド有効ならシークも拍に吸着', Math.abs(DAW.audio.getPos() - 1.5) < 1e-9, DAW.audio.getPos());
    ev(137, { altKey: true });
    okf('U.19 Alt 押下では吸着しない', Math.abs(DAW.audio.getPos() - 1.37) < 1e-9, DAW.audio.getPos());
    DAW.grid.enabled = false;
    ev(137);
    okf('U.20 グリッド無効なら吸着しない', Math.abs(DAW.audio.getPos() - 1.37) < 1e-9, DAW.audio.getPos());
  }
  okf('U.21 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
