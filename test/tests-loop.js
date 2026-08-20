'use strict';
// =====================================================================
// ループ再生区間のテスト（他ファイルのヘルパには依存しない）。
// =====================================================================

function loopSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.loop.enabled = false; DAW.loop.start = 0; DAW.loop.end = 0;
    DAW.metronome.enabled = false;
    DAW.grid.enabled = false;
    DAW.addTrack();
    DAW.ui.els.btnLoop.classList.remove('on');
    DAW.ui.renderTracks();
    DAW.history.reset();
    try { await body(okf); } finally {
      DAW.loop.enabled = false; DAW.loop.start = 0; DAW.loop.end = 0;
      DAW.ui.els.btnLoop.classList.remove('on');
      try { DAW.audio.stop(); } catch (e) {}
    }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

loopSuite('[23] ループ再生', async (okf) => {
  const ui = DAW.ui;
  const SRT = DAW.audio.ensureCtx().sampleRate;

  okf('L.1 既定ではループ無効', DAW.activeLoop() === null);
  DAW.setLoop(2, 1);
  okf('L.2 start > end を渡しても入れ替えて保持', DAW.loop.start === 1 && DAW.loop.end === 2,
    `${DAW.loop.start}-${DAW.loop.end}`);
  DAW.setLoop(-5, 3);
  okf('L.3 負の開始位置は 0 に丸める', DAW.loop.start === 0 && DAW.loop.end === 3, `${DAW.loop.start}-${DAW.loop.end}`);
  DAW.loop.enabled = true;
  okf('L.4 有効化すると activeLoop が返る', DAW.activeLoop() !== null);
  DAW.setLoop(1, 1.01);
  okf('L.5 短すぎる区間は無効扱い', DAW.activeLoop() === null, '長さ=0.01秒');

  // 音の検証: 1秒ごとに値が変わる素材をループさせ、折り返して同じ音が繰り返されるか見る
  {
    const buf = DAW.audio.ctx.createBuffer(1, SRT * 4, SRT);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = 0.2 * (Math.floor(i / SRT) + 1);   // 0-1秒:0.2, 1-2秒:0.4, ...
    const bid = DAW.registerBuffer(buf);
    const clip = { id: DAW.uid(), bufferId: bid, startTime: 0, offset: 0, duration: 4, name: 'steps', fadeIn: 0, fadeOut: 0 };
    DAW.project.tracks[0].clips.push(clip);

    // ループ区間 1.0〜2.0秒（値 0.4 の区間）を 3回ぶん予約したときの出力を確認する
    const off = new OfflineAudioContext(1, Math.round(SRT * 3), SRT);
    const g = off.createGain();
    g.connect(off.destination);
    let when = 0, from = 1.0;
    for (let i = 0; i < 3; i++) {
      DAW.audio.scheduleClip(off, g, clip, from, when, 2.0);
      when += 2.0 - from;
      from = 1.0;
    }
    const out = (await off.startRendering()).getChannelData(0);
    const at = t => out[Math.round(t * SRT)];
    okf('L.6 ループ区間の音が繰り返される',
      Math.abs(at(0.5) - 0.4) < 0.01 && Math.abs(at(1.5) - 0.4) < 0.01 && Math.abs(at(2.5) - 0.4) < 0.01,
      `${at(0.5).toFixed(3)} / ${at(1.5).toFixed(3)} / ${at(2.5).toFixed(3)}（すべて 0.4 = 1〜2秒の音）`);
    // 継ぎ目（1.0秒/2.0秒）の前後10msはデクリックのランプ中なので除外して調べる
    {
      const bad = [];
      for (let t = 0.02; t < 2.98; t += 0.01) {
        if (Math.abs(t - 1) < 0.01 || Math.abs(t - 2) < 0.01) continue;
        if (Math.abs(at(t) - 0.4) > 0.05) bad.push(`${t.toFixed(2)}s=${at(t).toFixed(3)}`);
      }
      okf('L.7 区間外の音（0.2 や 0.6）が混ざらない', bad.length === 0,
        bad.length ? bad.slice(0, 5).join(' ') : '全区間で 0.4（＝ループ区間の音）のみ');
    }
    // 継ぎ目でプチノイズが出ない（打ち切り時のデクリック）
    let maxJump = 0;
    for (let i = 1; i < out.length; i++) maxJump = Math.max(maxJump, Math.abs(out[i] - out[i - 1]));
    okf('L.8 折り返しの継ぎ目に段差が無い', maxJump < 0.01, '最大サンプル間差=' + maxJump.toFixed(5));
    // 継ぎ目に無音の穴が空いていないこと（デクリックは 5ms 以内）
    let holeLen = 0, cur = 0;
    for (let i = 0; i < out.length; i++) {
      if (Math.abs(out[i]) < 0.05) { cur++; holeLen = Math.max(holeLen, cur); } else cur = 0;
    }
    okf('L.9 継ぎ目の無音は 5ms 以内（音が途切れない）', holeLen < SRT * 0.005,
      '最長の無音=' + (holeLen / SRT * 1000).toFixed(2) + 'ms');
  }

  // 再生位置がループ内で折り返す
  {
    DAW.setLoop(1, 2);
    DAW.loop.enabled = true;
    DAW.audio.playing = true;
    DAW.audio.playStartPos = 1;
    DAW.audio.playStartCtxTime = DAW.audio.ctx.currentTime - 2.5;   // 2.5秒経過した状態を作る
    const pos = DAW.audio.getPos();
    DAW.audio.playing = false;
    okf('L.10 再生位置がループ区間内へ折り返す', pos >= 1 && pos < 2 && Math.abs(pos - 1.5) < 0.05,
      `経過2.5秒 → 位置 ${pos.toFixed(3)}秒（期待 1.5秒付近）`);
  }

  // 実再生
  {
    DAW.setLoop(1, 2);
    DAW.loop.enabled = true;
    DAW.audio.playheadPos = 3.5;      // ループ区間の外から再生
    await DAW.audio.play();
    okf('L.11 区間外から再生すると区間の先頭へ移動する',
      Math.abs(DAW.audio.playStartPos - 1) < 1e-9, 'playStartPos=' + DAW.audio.playStartPos);
    okf('L.12 繰り返しぶんが先まで予約されている', DAW.audio.sources.length >= 30,
      `sources=${DAW.audio.sources.length}（60秒先まで / 1周1秒）`);
    DAW.audio.stop();
  }

  // UI
  {
    DAW.loop.enabled = false;
    DAW.loop.start = 0; DAW.loop.end = 0;
    ui.els.btnLoop.click();
    okf('L.13 区間未設定でボタンを押すと全体がループ区間になる',
      DAW.loop.enabled && Math.abs(DAW.loop.end - DAW.projectDuration()) < 1e-9,
      `${DAW.loop.start}〜${DAW.loop.end}秒`);
    ui.els.btnLoop.click();
    okf('L.14 もう一度押すと無効化（区間は残る）',
      !DAW.loop.enabled && DAW.loop.end > 0 && !ui.els.btnLoop.classList.contains('on'));
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyL', bubbles: true, cancelable: true }));
    okf('L.15 L キーでも切り替わる', DAW.loop.enabled === true);
    ui.els.btnLoop.click();
  }

  // ルーラーの Shift+ドラッグ
  {
    DAW.loop.start = 0; DAW.loop.end = 0; DAW.loop.enabled = false;
    ui.els.scroller.scrollLeft = 0;
    DAW.setPPS(100);
    const ruler = ui.els.ruler;
    const ev = (type, x, opts) => {
      const e = new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 1 }, opts));
      Object.defineProperty(e, 'offsetX', { value: x });
      ruler.dispatchEvent(e);
    };
    ruler.setPointerCapture = () => {};
    ev('pointerdown', 100, { shiftKey: true });
    ev('pointermove', 350, { shiftKey: true });
    ev('pointerup', 350, { shiftKey: true });
    okf('L.16 ルーラーの Shift+ドラッグで区間を引ける',
      Math.abs(DAW.loop.start - 1) < 1e-9 && Math.abs(DAW.loop.end - 3.5) < 1e-9 && DAW.loop.enabled,
      `${DAW.loop.start}〜${DAW.loop.end}秒`);
    // Shift 無しは従来どおりシーク
    DAW.audio.playheadPos = 0;
    ev('pointerdown', 200, {});
    okf('L.17 Shift 無しのクリックは従来どおりシーク', Math.abs(DAW.audio.getPos() - 2) < 1e-9,
      'pos=' + DAW.audio.getPos());
  }

  // 保存 / 読み込み
  {
    DAW.setLoop(1.5, 3.25);
    DAW.loop.enabled = true;
    H.downloads.length = 0;
    DAW.wav.saveProject();
    const txt = await H.downloads[H.downloads.length - 1].blob.text();
    okf('L.18 ループ区間がプロジェクトに保存される',
      JSON.parse(txt).loop.start === 1.5 && JSON.parse(txt).loop.end === 3.25,
      JSON.stringify(JSON.parse(txt).loop));
    DAW.loop.enabled = false; DAW.loop.start = 0; DAW.loop.end = 0;
    await DAW.wav.loadProject(new File([txt], 'p.json'));
    okf('L.19 読み込みで復元される',
      DAW.loop.enabled && DAW.loop.start === 1.5 && DAW.loop.end === 3.25,
      `${DAW.loop.start}〜${DAW.loop.end} enabled=${DAW.loop.enabled}`);
    // ループを持たない旧ファイルでも壊れない
    const old = JSON.parse(txt); delete old.loop;
    await DAW.wav.loadProject(new File([JSON.stringify(old)], 'old.json'));
    okf('L.20 ループ情報を持たない旧ファイルは無効で開く',
      !DAW.loop.enabled && DAW.loop.start === 0 && DAW.loop.end === 0);
  }
  okf('L.21 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
