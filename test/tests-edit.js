'use strict';
// =====================================================================
// クリップ編集（コピー / カット / 貼り付け / 複製）のテスト。
//
// 注意: build-verify.py は tests-*.js を **名前順** に差し込む。
// このファイルは tests-features.js より先に読まれるため、あちらの suite() は
// まだ定義されていない。依存を作らないよう、同等のヘルパをここに持つ。
// （tests.js の T / H / delay は先に読まれているので使える）
// =====================================================================

function editSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    // 起動直後の状態に戻す（tests.js / tests-features.js の状態を引きずらない）
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.project.masterVolume = 1;
    DAW.clipboard = null;
    DAW.addTrack();
    DAW.addTrack();
    DAW.ui.selectedClipId = null;
    DAW.setPPS(DAW.DEFAULT_PPS);
    DAW.ui.renderTracks();
    DAW.collectBuffers();
    DAW.history.reset();
    try {
      await body(okf);
    } finally {
      try { DAW.audio.stop(); } catch (e) {}
      DAW.clipboard = null;
    }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

editSuite('[19] クリップのコピー/貼り付け', async (okf) => {
  const ui = DAW.ui;
  const ctx0 = DAW.audio.ensureCtx();
  const buf = ctx0.createBuffer(2, ctx0.sampleRate * 3, ctx0.sampleRate);
  for (let c = 0; c < 2; c++) buf.getChannelData(c).fill(0.4);
  const bid = DAW.registerBuffer(buf);
  const [t0, t1] = DAW.project.tracks;
  const src = { id: DAW.uid(), bufferId: bid, startTime: 1, offset: 0.5, duration: 2,
                name: '元クリップ', fadeIn: 0.2, fadeOut: 0.3 };
  t0.clips.push(src);
  ui.renderTracks();
  DAW.clipboard = null;

  okf('E.1 コピー前の貼り付けは何も起きない', DAW.pasteClip(0) === null);
  okf('E.2 存在しないクリップのコピーは null', DAW.copyClip('no-such-id') === null);

  const cb = DAW.copyClip(src.id);
  okf('E.3 コピーで内容（offset/長さ/フェード/名前）を保持',
    cb.bufferId === bid && cb.offset === 0.5 && cb.duration === 2 && cb.fadeIn === 0.2 && cb.fadeOut === 0.3
    && cb.name === '元クリップ' && cb.trackId === t0.id,
    JSON.stringify(cb));

  const pasted = DAW.pasteClip(5);
  okf('E.4 貼り付け位置は指定した時刻', pasted.startTime === 5);
  okf('E.5 貼り付け先は既定でコピー元のトラック', t0.clips.includes(pasted) && t0.clips.length === 2);
  okf('E.6 貼り付けたクリップは別IDで、内容は同一',
    pasted.id !== src.id && pasted.bufferId === src.bufferId && pasted.offset === src.offset
    && pasted.duration === src.duration && pasted.fadeIn === 0.2 && pasted.fadeOut === 0.3);
  okf('E.7 音声データは複製されない（bufferId 共有）', DAW.buffers.size === 1, 'buffers=' + DAW.buffers.size);

  const pasted2 = DAW.pasteClip(9, t1.id);
  okf('E.8 トラックを指定して貼り付けできる', t1.clips.includes(pasted2) && pasted2.startTime === 9);
  okf('E.9 負の位置は 0 に丸める', DAW.pasteClip(-5).startTime === 0);
  t0.clips = t0.clips.filter(c => c.startTime !== 0);

  // 複製
  const dup = DAW.duplicateClip(src.id);
  okf('E.10 複製は元の直後に置かれる', dup.startTime === src.startTime + src.duration, 'startTime=' + dup.startTime);
  okf('E.11 複製は元クリップの隣に挿入される', t0.clips.indexOf(dup) === t0.clips.indexOf(src) + 1);
  okf('E.12 複製の内容が一致（IDのみ別）',
    dup.id !== src.id && dup.bufferId === src.bufferId && dup.offset === src.offset
    && dup.duration === src.duration && dup.fadeIn === src.fadeIn && dup.fadeOut === src.fadeOut);
  okf('E.13 複製を繰り返すと連続して並ぶ（ループ素材の並べ置き）',
    DAW.duplicateClip(dup.id).startTime === dup.startTime + dup.duration);

  // クリップボードが参照するバッファは解放されない
  {
    DAW.project.tracks.forEach(t => t.clips = []);
    DAW.history.reset();               // 履歴からも参照を切る
    DAW.collectBuffers();
    okf('E.14 クリップボードが参照するバッファは解放されない',
      DAW.buffers.has(bid), 'buffers=' + DAW.buffers.size);
    const revived = DAW.pasteClip(0);
    okf('E.15 全クリップ削除後でも貼り付けで復活できる',
      !!revived && !!DAW.buffers.get(revived.bufferId), revived ? 'OK' : '失敗');
    DAW.clipboard = null;
    DAW.project.tracks.forEach(t => t.clips = []);
    DAW.history.reset();
    DAW.collectBuffers();
    okf('E.16 クリップボードを空にすれば従来どおり解放される', !DAW.buffers.has(bid), 'buffers=' + DAW.buffers.size);
  }

  // ショートカット経由（Ctrl+C / Ctrl+V / Ctrl+D / Ctrl+X）
  {
    const bid2 = DAW.registerBuffer(buf);
    const c = { id: DAW.uid(), bufferId: bid2, startTime: 0, offset: 0, duration: 1, name: 'k', fadeIn: 0, fadeOut: 0 };
    DAW.project.tracks[0].clips = [c];
    ui.renderTracks();
    ui.selectClip(c.id);
    DAW.audio.playheadPos = 4;
    const key = (code, opts) => document.dispatchEvent(
      new KeyboardEvent('keydown', Object.assign({ code, bubbles: true, cancelable: true }, opts)));

    key('KeyC', { ctrlKey: true });
    okf('E.17 Ctrl+C でコピーされる', !!DAW.clipboard && DAW.clipboard.bufferId === bid2);
    key('KeyV', { ctrlKey: true });
    await delay(10);
    okf('E.18 Ctrl+V で再生ヘッド位置に貼り付く',
      DAW.project.tracks[0].clips.length === 2 && DAW.project.tracks[0].clips[1].startTime === 4,
      'clips=' + DAW.project.tracks[0].clips.length);
    okf('E.19 貼り付けたクリップが選択される', ui.selectedClipId === DAW.project.tracks[0].clips[1].id);

    ui.selectClip(c.id);
    key('KeyD', { ctrlKey: true });
    await delay(10);
    okf('E.20 Ctrl+D で複製される', DAW.project.tracks[0].clips.length === 3);

    const before = DAW.project.tracks[0].clips.length;
    ui.selectClip(c.id);
    key('KeyX', { ctrlKey: true });
    await delay(10);
    okf('E.21 Ctrl+X で切り取られる（数が減り、選択も外れる）',
      DAW.project.tracks[0].clips.length === before - 1 && ui.selectedClipId === null,
      'clips=' + DAW.project.tracks[0].clips.length);
    okf('E.22 切り取った内容は貼り付けで復元できる', !!DAW.pasteClip(0));

    // 履歴に載っているか
    DAW.history.reset();
    ui.selectClip(DAW.project.tracks[0].clips[0].id);
    const n = DAW.project.tracks[0].clips.length;
    key('KeyD', { ctrlKey: true });
    await delay(10);
    okf('E.23 複製が undo できる', DAW.history.canUndo(), 'past=' + DAW.history.past.length);
    await DAW.history.undo();
    okf('E.24 undo でクリップ数が戻る', DAW.project.tracks[0].clips.length === n,
      'clips=' + DAW.project.tracks[0].clips.length + ' 期待=' + n);
  }

  // テキスト入力中はショートカットを奪わない
  {
    const input = document.querySelector('.t-name');
    input.focus();
    const n = DAW.project.tracks[0].clips.length;
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', ctrlKey: true, bubbles: true, cancelable: true }));
    await delay(10);
    okf('E.25 トラック名の編集中はクリップ操作にならない',
      DAW.project.tracks[0].clips.length === n, 'clips=' + DAW.project.tracks[0].clips.length);
    input.blur();
  }
  okf('E.26 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
