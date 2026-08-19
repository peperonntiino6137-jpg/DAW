'use strict';
// =====================================================================
// 過去に実際に混入したバグの再発防止テスト。
//
// いずれも「既存テストを全部パスしたまま」入り込んだ不具合なので、
// 直した内容そのものを固定する。各項目の見出しに症状を書いてある。
// 他ファイルのヘルパには依存しない（tests-*.js は名前順に読まれるため）。
// =====================================================================

function regressSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.clipboard = null;
    DAW.metronome.enabled = false;
    DAW.grid.enabled = false;
    DAW.setBpm(120);
    DAW.addTrack(); DAW.addTrack();
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

// ---------------------------------------------------------------------
// 【1】クリップ先頭 5ms 以内へシークすると、クリップ全体が減衰したまま鳴り、
//      終端で不連続に飛んでいた（自動化イベントの時刻が逆転していた）。
// ---------------------------------------------------------------------
regressSuite('[R1] シーク位置によるゲイン異常', async (okf) => {
  const SRT = DAW.audio.ensureCtx().sampleRate;
  // 直流 1.0 の素材 → 出力サンプル値がそのままゲインになる
  const buf = DAW.audio.ctx.createBuffer(1, SRT * 2, SRT);
  buf.getChannelData(0).fill(1);
  const bid = DAW.registerBuffer(buf);
  const clip = { id: DAW.uid(), bufferId: bid, startTime: 0, offset: 0, duration: 2, name: 'dc', fadeIn: 0, fadeOut: 0 };

  const renderFrom = async skip => {
    const playDur = clip.duration - skip;
    const off = new OfflineAudioContext(1, Math.max(128, Math.ceil(playDur * SRT)), SRT);
    const g = off.createGain();
    g.connect(off.destination);
    DAW.audio.scheduleClip(off, g, clip, skip, 0);
    return (await off.startRendering()).getChannelData(0);
  };
  const at = (d, t) => d[Math.min(d.length - 1, Math.round(t * SRT))];
  const maxJump = d => { let m = 0; for (let i = 1; i < d.length; i++) m = Math.max(m, Math.abs(d[i] - d[i - 1])); return m; };

  {
    const d = await renderFrom(0);
    okf('R1.1 [対照] 先頭から再生すると本体は等倍', Math.abs(at(d, 0.5) - 1) < 0.001, at(d, 0.5).toFixed(4));
  }
  {
    const d = await renderFrom(0.001);   // ← かつてここで 0.2 倍のまま鳴っていた
    okf('R1.2 先頭 1ms へシークしても本体は等倍',
      Math.abs(at(d, 0.3) - 1) < 0.001 && Math.abs(at(d, 1.0) - 1) < 0.001,
      `0.3s=${at(d, 0.3).toFixed(4)} 1.0s=${at(d, 1.0).toFixed(4)}`);
    okf('R1.3 ゲインが段差ジャンプしない', maxJump(d) < 0.01, '最大サンプル間差=' + maxJump(d).toFixed(4));
  }
  {
    // 危険域（0 < skip < DECLICK）を含めて走査する
    const bad = [];
    for (const skip of [0, 0.0005, 0.001, 0.002, 0.004, 0.0049, 0.005, 0.006, 0.02, 0.5]) {
      const d = await renderFrom(skip);
      const body = at(d, Math.min(0.3, (clip.duration - skip) / 2));
      if (Math.abs(body - 1) > 0.02) bad.push(`${skip}s→${body.toFixed(3)}`);
    }
    okf('R1.4 skip を 0〜0.5秒まで走査しても本体は常に等倍', bad.length === 0, bad.length ? bad.join(' ') : '全て 1.000');
  }
  {
    // 立ち上がりはデクリックぶんだけ（音を削らない）
    const d = await renderFrom(0.001);
    okf('R1.5 シーク直後は 0 から立ち上がる（プチノイズ防止）',
      Math.abs(d[0]) < 0.01 && at(d, 0.006) > 0.99, `d[0]=${d[0].toFixed(4)} 6ms=${at(d, 0.006).toFixed(4)}`);
  }
  {
    // フェード設定ありでシークした場合も、その時点のエンベロープ値から連続する
    clip.fadeIn = 0.5;
    const d = await renderFrom(0.2);
    okf('R1.6 フェードイン途中へシークしても連続',
      at(d, 0.006) > 0.35 && at(d, 0.006) < 0.5 && Math.abs(at(d, 0.4) - 1) < 0.01 && maxJump(d) < 0.01,
      `直後=${at(d, 0.006).toFixed(3)} 0.4s=${at(d, 0.4).toFixed(3)} 最大段差=${maxJump(d).toFixed(4)}`);
    clip.fadeIn = 0;
  }
  {
    clip.fadeOut = 0.5;
    const d = await renderFrom(1.8);   // フェードアウトの途中から再生
    okf('R1.7 フェードアウト途中へシークしても連続',
      at(d, 0.006) > 0.3 && at(d, 0.006) < 0.45 && maxJump(d) < 0.01,
      `直後=${at(d, 0.006).toFixed(3)} 最大段差=${maxJump(d).toFixed(4)}`);
    clip.fadeOut = 0;
  }
});

// ---------------------------------------------------------------------
// 【2】setZoom / zoomToFit がリスナ登録ブロックを毎回追加していた。
//      ズームするたびにトグルボタンが効かなくなり、Undo が多重実行された。
// ---------------------------------------------------------------------
regressSuite('[R2] ズームでイベントリスナが増殖しない', async (okf) => {
  const ui = DAW.ui;
  const zoomOps = () => { ui.setZoom(200); ui.setZoom(400); ui.zoomToFit(); ui.setZoom(100); };

  DAW.grid.enabled = false;
  ui.els.btnSnap.classList.remove('on');
  zoomOps();
  const states = [];
  for (let i = 0; i < 4; i++) { ui.els.btnSnap.click(); states.push(DAW.grid.enabled); zoomOps(); }
  okf('R2.1 ズームを挟んでもグリッドボタンは押すたびにトグルする',
    states.join(',') === 'true,false,true,false', states.join(' -> '));

  DAW.metronome.enabled = false;
  ui.els.btnMetro.classList.remove('on');
  const mStates = [];
  for (let i = 0; i < 3; i++) { ui.els.btnMetro.click(); mStates.push(DAW.metronome.enabled); zoomOps(); }
  okf('R2.2 メトロノームボタンも同様', mStates.join(',') === 'true,false,true', mStates.join(' -> '));
  DAW.metronome.enabled = false;

  // Undo ボタン1クリック = 1手戻る
  const ctx0 = DAW.audio.ensureCtx();
  const buf = ctx0.createBuffer(1, 128, ctx0.sampleRate);
  const bid = DAW.registerBuffer(buf);
  DAW.history.reset();
  for (let i = 0; i < 5; i++) {
    DAW.project.tracks[0].clips.push({ id: DAW.uid(), bufferId: bid, startTime: i, offset: 0, duration: 0.5, name: 'c' + i });
    DAW.history.commit();
  }
  zoomOps();
  const before = DAW.project.tracks[0].clips.length;
  ui.els.btnUndo.click();
  await delay(20);
  okf('R2.3 ズーム後でも Undo ボタン1クリックで1手だけ戻る',
    DAW.project.tracks[0].clips.length === before - 1,
    `${before} → ${DAW.project.tracks[0].clips.length}（期待 ${before - 1}）`);
  ui.els.btnRedo.click();
  await delay(20);
  okf('R2.4 Redo も1手だけ進む', DAW.project.tracks[0].clips.length === before,
    `clips=${DAW.project.tracks[0].clips.length}`);

  // BPM の change が多重に履歴を積まないこと
  DAW.history.reset();
  zoomOps();
  ui.els.bpm.value = '140';
  ui.els.bpm.dispatchEvent(new Event('input'));
  ui.els.bpm.dispatchEvent(new Event('change'));
  okf('R2.5 BPM 変更で履歴が1手だけ増える', DAW.history.past.length === 1, 'past=' + DAW.history.past.length);
  DAW.setBpm(120);
});

// ---------------------------------------------------------------------
// 【3】分割・トリムでクリップが短くなってもフェードが縮まず、
//      表示（斜線・ハンドル）と実際に鳴る音がずれていた。
// ---------------------------------------------------------------------
regressSuite('[R3] フェード長のクランプが表示と音で一致する', async (okf) => {
  const ctx0 = DAW.audio.ensureCtx();
  const buf = ctx0.createBuffer(1, ctx0.sampleRate * 4, ctx0.sampleRate);
  buf.getChannelData(0).fill(1);
  const bid = DAW.registerBuffer(buf);
  const track = DAW.project.tracks[0];
  const clip = { id: DAW.uid(), bufferId: bid, startTime: 0, offset: 0, duration: 4, name: 'c', fadeIn: 1.5, fadeOut: 1.2 };
  track.clips.push(clip);

  const right = DAW.splitClip(clip.id, 1.0);
  okf('R3.1 分割後の左クリップのフェードが長さの半分以内',
    clip.fadeIn <= clip.duration / 2 + 1e-9, `duration=${clip.duration} fadeIn=${clip.fadeIn}`);
  okf('R3.2 分割後の右クリップのフェードも長さの半分以内',
    right.fadeOut <= right.duration / 2 + 1e-9, `duration=${right.duration} fadeOut=${right.fadeOut}`);

  // 表示と音のクランプ規則が一致していること
  const lenAudio = DAW.audio.fadeLengths(clip, true);
  const lenView = DAW.audio.fadeLengths(clip, false);
  okf('R3.3 表示用と音用のフェード長がデクリック分を除いて一致',
    Math.abs(lenAudio.fi - Math.max(lenView.fi, DAW.audio.DECLICK)) < 1e-9,
    `音=${lenAudio.fi} 表示=${lenView.fi}`);

  // ハンドル位置が実際のフェード終端と一致する
  DAW.ui.renderTracks();
  const el = document.querySelector('.clip');
  okf('R3.4 フェードハンドルが実効フェード長の位置にある',
    parseFloat(el.querySelector('.f-l').style.left) === DAW.timeToPx(lenView.fi),
    `ハンドル=${el.querySelector('.f-l').style.left} 期待=${DAW.timeToPx(lenView.fi)}px`);

  // トリムでもクランプされる
  clip.fadeIn = 0.4; clip.fadeOut = 0.4;
  clip.duration = 0.5;
  DAW.clampFades(clip);
  okf('R3.5 トリムで短くしたらフェードも詰まる',
    clip.fadeIn === 0.25 && clip.fadeOut === 0.25, `in=${clip.fadeIn} out=${clip.fadeOut}`);
});

// ---------------------------------------------------------------------
// 【4】クリップ右端が画面外のとき、フェードアウトの陰影が canvas 外へずれて消えていた。
// ---------------------------------------------------------------------
regressSuite('[R4] 長大クリップのフェードアウト表示', async (okf) => {
  const ui = DAW.ui, sc = ui.els.scroller;
  const ctx0 = DAW.audio.ensureCtx();
  const buf = ctx0.createBuffer(1, ctx0.sampleRate * 8, ctx0.sampleRate);
  buf.getChannelData(0).fill(0.5);
  const bid = DAW.registerBuffer(buf);
  DAW.project.tracks[0].clips.push({
    id: DAW.uid(), bufferId: bid, startTime: 0, offset: 0, duration: 8, name: 'long', fadeIn: 0, fadeOut: 4,
  });
  ui.setZoom(1000);            // 8秒 = 8000px（描画上限 4000px 超）
  const alphaTop = () => {
    const cv = document.querySelector('.clip canvas');
    const g = cv.getContext('2d');
    const img = g.getImageData(0, 0, cv.width, 3);
    let n = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 0) n++;
    return { n, cv };
  };

  sc.scrollLeft = 8000 - (sc.clientWidth - ui.HEAD_W);   // 右端が見える位置
  ui.refreshVisibleWaves();
  const withEdge = alphaTop();
  okf('R4.1 [対照] クリップ右端が見えていれば陰影が描かれる', withEdge.n > 100,
    `非透明px=${withEdge.n} _x0=${withEdge.cv._x0} _x1=${withEdge.cv._x1}`);

  sc.scrollLeft = 3900;        // フェードアウト開始点(4000px)は見えるが右端は画面外
  ui.refreshVisibleWaves();
  const noEdge = alphaTop();
  okf('R4.2 右端が画面外でもフェードアウトの陰影が描かれる', noEdge.n > 100,
    `非透明px=${noEdge.n} _x0=${noEdge.cv._x0} _x1=${noEdge.cv._x1}`);
  ui.setZoom(100);
  sc.scrollLeft = 0;
});

// ---------------------------------------------------------------------
// 【5】録音開始が既存トラックの再生開始より約50ms早く、テイクが前へずれていた。
// ---------------------------------------------------------------------
regressSuite('[R5] 録音の頭出し', async (okf) => {
  const ctx0 = DAW.audio.ensureCtx();
  const buf = ctx0.createBuffer(1, ctx0.sampleRate * 4, ctx0.sampleRate);
  buf.getChannelData(0).fill(0.2);
  const bid = DAW.registerBuffer(buf);
  DAW.project.tracks[0].clips.push({ id: DAW.uid(), bufferId: bid, startTime: 0, offset: 0, duration: 4, name: 'backing' });
  DAW.ui.renderTracks();

  const started = await DAW.record.start();
  if (!started) {
    okf('R5.0 マイクを使えないためスキップ', true, '--use-fake-device-for-media-stream 付きで実行すると検証されます');
    return;
  }
  // 再生の時間基準（playStartCtxTime）より前に取り込みが始まっているぶん、startPos は前へずれる
  const lead = DAW.audio.playStartCtxTime - DAW.audio.playStartPos;   // ctx時刻 - タイムライン位置
  okf('R5.1 録音開始位置が再生の時間基準から逆算されている',
    DAW.record.startPos < 0.001, `startPos=${DAW.record.startPos.toFixed(4)}s（先読み分だけ手前になる）`);
  await delay(600);
  const track = await DAW.record.stop();
  DAW.audio.stop();

  const clip = track.clips[0];
  okf('R5.2 テイクは 0 より前に置かれない', clip.startTime >= 0, `startTime=${clip.startTime}`);
  okf('R5.3 再生開始前に録れた分は offset で読み飛ばす（頭ズレしない）',
    clip.offset > 0.02 && clip.offset < 0.3, `offset=${clip.offset.toFixed(4)}s`);
  okf('R5.4 長さは offset を除いた分になる',
    Math.abs(clip.duration - (DAW.buffers.get(clip.bufferId).duration - clip.offset)) < 1e-6,
    `duration=${clip.duration.toFixed(3)} buffer=${DAW.buffers.get(clip.bufferId).duration.toFixed(3)}`);
});
