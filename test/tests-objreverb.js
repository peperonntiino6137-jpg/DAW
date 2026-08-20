'use strict';
// =====================================================================
// オブジェクトベースのルームリバーブのテスト。
//   - revSend のデータモデル（保存/読込・undo・lock・欠落補完）
//   - 実効センド量の距離式 revSend × (0.25 + 0.75 × dist)
//   - センド0/リターン0 で既存出力とサンプル一致（回帰の要・バイナリ比較）
//   - センド>0 でクリップ終了後に残響尾が付く
//   - 経路で dist が動く書き出しでセンドが追従（bakePath）
//   - 5.1 書き出しでチャンネル数維持 + 左右スピーカー群への分配
//   - RENDERER のノブ / ストリップの Rev ノブ（undo 1回・lock）
// 他ファイルのヘルパには依存しない。
// =====================================================================

function objRevSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    const OA = DAW.objaudio;
    const savedRev = Object.assign({}, OA.revParams);
    const savedMode = OA.mode;
    const savedLayout = OA.layoutName;
    const savedAuto = OA.autoHrtf;
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.project.masterVolume = 1;
    DAW.objects.clear();
    OA.mode = OA.MODE_EQUALPOWER;
    OA.loadRevParams(null);   // 既定値（level=0）から始める
    DAW.loop.enabled = false; DAW.loop.start = 0; DAW.loop.end = 0;
    DAW.metronome.enabled = false;
    DAW.addTrack('src');
    DAW.ui.renderTracks();
    DAW.history.reset();
    try { await body(okf); } finally {
      DAW.objects.clear();
      OA.loadRevParams(savedRev);
      OA.mode = savedMode;
      OA.layoutName = savedLayout;
      OA.autoHrtf = savedAuto;
      if (DAW.objui && DAW.objui._inited) {
        DAW.objui.setView('panner');
        DAW.objui.els.stripScroll.scrollLeft = 0;
        DAW.objui.render();
      }
      DAW.audio.resetNodes();
      try { DAW.audio.stop(); } catch (e) {}
    }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

// ---------------------------------------------------------------------
// データモデル（revSend）と距離式
// ---------------------------------------------------------------------
objRevSuite('[42] ルームリバーブ（データモデル）', async (okf) => {
  const O = DAW.objects;
  const OA = DAW.objaudio;
  const near = (a, b, t) => Math.abs(a - b) <= (t == null ? 1e-9 : t);

  okf('R.1 既定の revSend は 0.25', O.defaults().revSend === 0.25, O.defaults().revSend);
  okf('R.2 LIMITS に revSend がある（0〜1）',
    Array.isArray(O.LIMITS.revSend) && O.LIMITS.revSend[0] === 0 && O.LIMITS.revSend[1] === 1);

  const o = O.create('残響試験', DAW.project.tracks[0].id);
  okf('R.3 新規オブジェクトは revSend=0.25', o.revSend === 0.25, o.revSend);

  // set のクランプ
  O.set(o.id, 'revSend', 2);
  okf('R.4 範囲外は 1 へクランプ', o.revSend === 1, o.revSend);
  O.set(o.id, 'revSend', -0.5);
  okf('R.5 負値は 0 へクランプ', o.revSend === 0, o.revSend);
  O.set(o.id, 'revSend', 0.6);

  // lock: 'pos' は位置だけ固定なので revSend は編集できる。'all' は不可（canEditParams 準拠）
  O.set(o.id, 'lock', 'pos');
  okf('R.6 lock=pos では revSend を編集できる', O.set(o.id, 'revSend', 0.4) === true && o.revSend === 0.4);
  O.set(o.id, 'lock', 'all');
  okf('R.7 lock=all では revSend を編集できない', O.set(o.id, 'revSend', 0.9) === false && o.revSend === 0.4);
  O.set(o.id, 'lock', 'none');

  // toJSON → load の往復
  {
    const json = JSON.parse(JSON.stringify(O.toJSON()));
    okf('R.8 toJSON に revSend が入る', json[0].revSend === 0.4, JSON.stringify(json[0].revSend));
    O.load(json);
    okf('R.9 load で revSend が復元される', O.list[0].revSend === 0.4, O.list[0].revSend);
    // 旧プロジェクト（revSend 欠落）は既定値 0.25 で補完
    delete json[0].revSend;
    O.load(json);
    okf('R.10 revSend が欠けた旧データは 0.25 で補完', O.list[0].revSend === 0.25, O.list[0].revSend);
    // 壊れた値はクランプ
    json[0].revSend = 'abc';
    O.load(json);
    okf('R.11 壊れた revSend でも落ちず既定値へ', O.list[0].revSend === 0.25, O.list[0].revSend);
  }

  // undo（履歴のスナップショットに revSend が入る）
  {
    O.clear();
    const u = O.create('undo試験');
    DAW.history.reset();
    O.set(u.id, 'revSend', 0.8);
    DAW.history.commit();
    okf('R.12 revSend の変更が履歴に積まれる', DAW.history.canUndo());
    await DAW.history.undo();
    okf('R.13 undo で revSend が戻る', O.list[0].revSend === 0.25, O.list[0].revSend);
    await DAW.history.redo();
    okf('R.14 redo でやり直せる', O.list[0].revSend === 0.8, O.list[0].revSend);
  }

  // 実効センド量の距離式（objaudio に1箇所）: revSend × (0.25 + 0.75 × dist)
  {
    const t = { revSend: 0.8, dist: 1 };
    okf('R.15 dist=1 で revSend そのまま', near(OA.revSendLevel(t, 1), 0.8), OA.revSendLevel(t, 1));
    okf('R.16 dist=0 で 0.25 倍（近くでも少し湿る）', near(OA.revSendLevel(t, 0), 0.2), OA.revSendLevel(t, 0));
    okf('R.17 dist=0.5 は中間（0.25+0.375 倍）', near(OA.revSendLevel(t, 0.5), 0.8 * 0.625), OA.revSendLevel(t, 0.5));
    okf('R.18 dist 省略時は obj.dist を使う', near(OA.revSendLevel({ revSend: 0.5, dist: 1 }), 0.5));
    okf('R.19 revSend=0 なら距離によらず 0',
      OA.revSendLevel({ revSend: 0, dist: 1 }, 1) === 0 && OA.revSendLevel({ revSend: 0, dist: 0 }, 0) === 0);
  }

  // マスターパラメータのクランプと欠落補完
  {
    okf('R.20 setRevParam がクランプする', OA.setRevParam('decay', 99) === true && OA.revParams.decay === OA.REV_LIMITS.decay[1],
      OA.revParams.decay);
    okf('R.21 不明キーは拒否', OA.setRevParam('nope', 1) === false);
    OA.loadRevParams({ decay: 2.5 });
    okf('R.22 loadRevParams は欠落を既定値で補完',
      OA.revParams.decay === 2.5 && OA.revParams.damp === OA.REV_DEFAULTS.damp && OA.revParams.level === OA.REV_DEFAULTS.level,
      JSON.stringify(OA.revParams));
    OA.loadRevParams(null);
    okf('R.23 引数なしで全て既定値', JSON.stringify(OA.revParams) === JSON.stringify(OA.REV_DEFAULTS));
  }

  okf('R.24 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});

// ---------------------------------------------------------------------
// 書き出し（音響）: 回帰・残響尾・距離連動・経路追従・5.1
// ---------------------------------------------------------------------
objRevSuite('[42] ルームリバーブ（書き出し）', async (okf) => {
  const O = DAW.objects;
  const OA = DAW.objaudio;
  const ctx0 = DAW.audio.ensureCtx();
  const SRT = ctx0.sampleRate;

  const mkSine = (dur, amp) => {
    const b = ctx0.createBuffer(1, Math.round(SRT * dur), SRT);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = amp * Math.sin(2 * Math.PI * 440 * i / SRT);
    return b;
  };
  const mkClip = (bid, start, dur) => (
    { id: DAW.uid(), bufferId: bid, startTime: start, offset: 0, duration: dur, name: 'c', fadeIn: 0, fadeOut: 0 });

  // 書き出して 16bit PCM を直接読む（多チャンネル対応。tests-objpath.js と同じ流儀）
  const render = async () => {
    H.downloads.length = 0;
    await DAW.wav.exportMix();
    const ab = await H.downloads[H.downloads.length - 1].blob.arrayBuffer();
    return { ch: new DataView(ab).getUint16(22, true), bytes: ab };
  };
  // 全長に対する割合 [f0, f1) の区間の ch の RMS
  const rmsWin = (ab, ch, nch, f0, f1) => {
    const dv = new DataView(ab);
    const frames = (ab.byteLength - 44) / (nch * 2);
    const i0 = Math.round(frames * f0);
    const i1 = Math.round(frames * f1);
    let s = 0;
    for (let i = i0; i < i1; i++) {
      const v = dv.getInt16(44 + (i * nch + ch) * 2, true) / 32768;
      s += v * v;
    }
    return Math.sqrt(s / Math.max(1, i1 - i0));
  };
  const bytesEq = (a, b) => {
    if (a.byteLength !== b.byteLength) return false;
    const ua = new Uint8Array(a);
    const ub = new Uint8Array(b);
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
    return true;
  };

  // 1秒の正弦（オブジェクト行き）+ 2秒の無音（プロジェクト長の確保 = 残響尾の観測区間）
  const sineBid = DAW.registerBuffer(mkSine(1, 0.5));
  const silBid = DAW.registerBuffer(ctx0.createBuffer(1, SRT * 2, SRT));
  const track = DAW.project.tracks[0];
  track.clips = [mkClip(sineBid, 0, 1)];
  DAW.addTrack('sil');
  DAW.project.tracks[1].clips = [mkClip(silBid, 0, 2)];
  const obj = O.create('残響音源', track.id);

  // ---- 回帰: センド0 / リターン0 のとき既存出力とサンプル一致（バイナリ比較）----
  {
    O.set(obj.id, 'revSend', 0.25);
    OA.setRevParam('level', 0);
    const a = await render();               // センドあり・リターン0
    O.set(obj.id, 'revSend', 0);
    OA.setRevParam('level', 0.6);
    const b = await render();               // センド0・リターンあり
    OA.setRevParam('level', 0);
    const c = await render();               // 両方 0
    okf('E.1 [回帰] level=0 はセンドがあっても両方0と完全一致（バイナリ）', bytesEq(a.bytes, c.bytes),
      `${a.bytes.byteLength}B vs ${c.bytes.byteLength}B`);
    okf('E.2 [回帰] 全オブジェクト revSend=0 も完全一致（バイナリ）', bytesEq(b.bytes, c.bytes),
      `${b.bytes.byteLength}B vs ${c.bytes.byteLength}B`);
    okf('E.3 [回帰] リバーブ無しならクリップ終了後は無音',
      rmsWin(c.bytes, 0, 2, 0.55, 0.95) < 1e-4 && rmsWin(c.bytes, 1, 2, 0.55, 0.95) < 1e-4,
      `L=${rmsWin(c.bytes, 0, 2, 0.55, 0.95).toExponential(2)}`);
  }

  // ---- センド>0 & リターン>0 で残響尾が付く ----
  {
    O.set(obj.id, 'revSend', 0.7);
    OA.setRevParam('level', 0.6);
    OA.setRevParam('decay', 1.8);
    const r = await render();
    const tailL = rmsWin(r.bytes, 0, 2, 0.55, 0.95);   // クリップは 0〜1s（全長2s の前半）
    const tailR = rmsWin(r.bytes, 1, 2, 0.55, 0.95);
    okf('E.4 クリップ終了後に残響尾が残る（L/R とも非無音）', tailL > 0.003 && tailR > 0.003,
      `L=${tailL.toFixed(4)} R=${tailR.toFixed(4)}`);
    okf('E.5 直接音は変わらず鳴っている', rmsWin(r.bytes, 0, 2, 0.1, 0.4) > 0.2,
      rmsWin(r.bytes, 0, 2, 0.1, 0.4).toFixed(4));
  }

  // ---- 距離連動（静的）: az=+90 で直接音は L のみ → R はリバーブだけが乗る ----
  {
    O.set(obj.id, 'revSend', 0.5);
    OA.setRevParam('level', 0.6);
    O.setPosition(obj.id, 90, 0, 1);
    const far = await render();
    O.setPosition(obj.id, 90, 0, 0);
    const nearR = await render();
    const wetFar = rmsWin(far.bytes, 1, 2, 0.1, 0.45);     // R = リバーブ成分のみ
    const wetNear = rmsWin(nearR.bytes, 1, 2, 0.1, 0.45);
    okf('E.6 [距離式] 遠い（dist=1）ほど湿りが多い（dist=0 の約4倍）',
      wetFar > wetNear * 2 && wetNear > 0,
      `far=${wetFar.toFixed(4)} near=${wetNear.toFixed(4)} 比=${(wetFar / Math.max(wetNear, 1e-9)).toFixed(2)}`);
    O.setPosition(obj.id, 0, 0, 1);
  }

  // ---- 経路で dist が動く書き出し: センドがランプで追従する（bakePath）----
  {
    track.clips = [mkClip(DAW.registerBuffer(mkSine(2, 0.5)), 0, 2)];
    OA.setRevParam('decay', 0.3);   // 応答を速くして送り量の変化を観測しやすくする
    O.setPosition(obj.id, 90, 0, 1);
    const setPath = pts => {
      obj.path.points = pts.map(p => Object.assign({ az: 90, el: 0, ease: 'linear' }, p));
      obj.path.enabled = true;
    };
    setPath([{ t: 0, dist: 1 }, { t: 2, dist: 0 }]);   // 遠 → 近
    const away = await render();
    setPath([{ t: 0, dist: 0 }, { t: 2, dist: 1 }]);   // 近 → 遠
    const toward = await render();
    obj.path.enabled = false;
    const wet = (r, f0, f1) => rmsWin(r.bytes, 1, 2, f0, f1);   // R = リバーブのみ（直接音は L）
    okf('E.7 [経路] 遠→近 では湿りが減っていく', wet(away, 0.2, 0.4) > wet(away, 0.75, 0.95) * 1.5,
      `前=${wet(away, 0.2, 0.4).toFixed(4)} 後=${wet(away, 0.75, 0.95).toFixed(4)}`);
    okf('E.8 [経路] 近→遠 では湿りが増えていく', wet(toward, 0.75, 0.95) > wet(toward, 0.2, 0.4) * 1.5,
      `前=${wet(toward, 0.2, 0.4).toFixed(4)} 後=${wet(toward, 0.75, 0.95).toFixed(4)}`);
    okf('E.9 書き出し後に exportRange が戻っている', OA.exportRange === null, String(OA.exportRange));
  }

  // ---- 5.1（VBAP）: チャンネル数維持 + 左右スピーカー群への分配 ----
  {
    track.clips = [mkClip(sineBid, 0, 1)];
    OA.setModeQuiet(OA.MODE_SPEAKERS);
    OA.layoutName = '5.1';
    OA.setRevParam('decay', 1.0);
    OA.setRevParam('level', 0.6);
    O.set(obj.id, 'revSend', 0.6);
    O.setPosition(obj.id, 0, 0, 1);   // 正面 = 直接音は C のみ
    const r = await render();
    okf('E.10 [5.1] 6ch のまま書き出される', r.ch === 6, `${r.ch}ch`);
    const w = ch => rmsWin(r.bytes, ch, 6, 0.1, 0.45);
    okf('E.11 [5.1] 直接音は C が優勢', w(2) > 0.2, `C=${w(2).toFixed(4)}`);
    okf('E.12 [5.1] リバーブがフロント L/R とサラウンドへ分配される',
      w(0) > 0.003 && w(1) > 0.003 && w(4) > 0.003 && w(5) > 0.003,
      `L=${w(0).toFixed(4)} R=${w(1).toFixed(4)} Ls=${w(4).toFixed(4)} Rs=${w(5).toFixed(4)}`);
    okf('E.13 [5.1] LFE には送らない', w(3) < 1e-4, w(3).toExponential(2));
    OA.setRevParam('level', 0);
    const dry = await render();
    okf('E.14 [5.1] level=0 なら L は無音（回帰）',
      rmsWin(dry.bytes, 0, 6, 0.1, 0.45) < 1e-4 && dry.ch === 6,
      rmsWin(dry.bytes, 0, 6, 0.1, 0.45).toExponential(2));
    OA.setModeQuiet(OA.MODE_EQUALPOWER);
  }

  // ---- ライブ再生: センドノード / 共有バスの生成と追従・解放 ----
  {
    OA.autoHrtf = false;
    OA.setModeQuiet(OA.MODE_EQUALPOWER);
    OA.setRevParam('level', 0.5);
    O.set(obj.id, 'revSend', 0.8);
    O.setPosition(obj.id, 0, 0, 1);
    await DAW.audio.play();
    const n = OA.live.get(obj.id);
    okf('L.1 再生でセンドノードと共有バスが作られる',
      !!n && !!n.rev && !!OA._revBuses.get(DAW.audio.ctx),
      `rev=${!!(n && n.rev)}`);
    okf('L.2 センド量の初期値は距離式どおり', Math.abs(n.rev.gain.value - 0.8) < 1e-6, n.rev.gain.value);
    O.set(obj.id, 'revSend', 0);   // onChange → update → applyObjPosition で追従
    await delay(150);
    okf('L.3 revSend の変更がライブへ伝わる', n.rev.gain.value < 0.4, n.rev.gain.value.toFixed(3));
    DAW.audio.stop();
    DAW.audio.resetNodes();
    okf('L.4 resetNodes で共有バスも解放される', !OA._revBuses.get(DAW.audio.ctx));
    OA.autoHrtf = true;
  }

  okf('E.15 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});

// ---------------------------------------------------------------------
// UI: RENDERER のノブ / ストリップの Rev ノブ / 保存
// ---------------------------------------------------------------------
objRevSuite('[42] ルームリバーブ（UI）', async (okf) => {
  const O = DAW.objects;
  const OA = DAW.objaudio;
  const U = DAW.objui;
  okf('U.1 objui が読み込まれている', !!U && U._inited === true);

  // ---- RENDERER のノブ（リミッターのノブ群と同じ流儀）----
  U.setView('renderer');
  const knobs = document.querySelectorAll('#obj-rev-knobs .obj-knob');
  okf('U.2 ルームリバーブのノブが3つある（Decay / Bright / Return）',
    knobs.length === 3
    && Array.from(knobs).map(k => k.dataset.key).join(',') === 'decay,damp,level',
    Array.from(knobs).map(k => k.dataset.key).join(','));
  okf('U.3 ノブは共通ノブ（canvas。<input> ではない）',
    Array.from(knobs).every(k => k.querySelector('canvas') && !k.querySelector('input')));

  const knob = key => document.querySelector(`#obj-rev-knobs .obj-knob[data-key="${key}"]`);
  const kev = (el, type, y, opts) => {
    const target = type === 'pointerdown' ? el : window;
    target.dispatchEvent(new PointerEvent(type, Object.assign({
      bubbles: true, cancelable: true, pointerId: 9, button: 0, clientX: 0, clientY: y,
    }, opts)));
  };
  const drag = (el, dy, opts) => {
    kev(el, 'pointerdown', 300);
    kev(el, 'pointermove', 300 - dy, opts);
    kev(el, 'pointerup', 300 - dy);
  };

  {
    OA.setRevParam('level', 0);
    U.renderRenderer();
    const range = OA.REV_LIMITS.level;
    const expect = (range[1] - range[0]) * (34 / U.KNOB_PX);
    drag(knob('level'), 34);
    okf('U.4 Return ノブのドラッグが revParams.level に反映される',
      Math.abs(OA.revParams.level - expect) < 1e-6,
      `level=${OA.revParams.level.toFixed(3)} 期待=${expect.toFixed(3)}`);
    okf('U.5 ノブの数値表示が一致する',
      knob('level').querySelector('.ok-val').textContent === OA.revParams.level.toFixed(2),
      knob('level').querySelector('.ok-val').textContent);
    // stateSig に revParams が入っている（外部変更にノブが追従できる）
    const sig0 = U.stateSig();
    OA.setRevParam('decay', 3.3);
    okf('U.6 revParams の変更で stateSig が変わる', U.stateSig() !== sig0);
    U.renderRenderer();
    okf('U.7 Decay ノブの表示が追従する',
      knob('decay').querySelector('.ok-val').textContent === '3.3s',
      knob('decay').querySelector('.ok-val').textContent);
    knob('decay').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    okf('U.8 ダブルクリックで既定値へ戻る', OA.revParams.decay === 1.8, OA.revParams.decay);
  }

  // ---- 保存 → 読み込み（roomReverb はプロジェクト保存の対象）----
  {
    OA.setRevParam('decay', 3.2);
    OA.setRevParam('damp', 0.8);
    OA.setRevParam('level', 0.4);
    H.downloads.length = 0;
    DAW.wav.saveProject();
    const txt = await H.downloads[H.downloads.length - 1].blob.text();
    const json = JSON.parse(txt);
    okf('U.9 プロジェクトに roomReverb が入る（version は 1 のまま）',
      json.version === 1 && json.roomReverb && json.roomReverb.decay === 3.2
      && json.roomReverb.damp === 0.8 && json.roomReverb.level === 0.4,
      JSON.stringify(json.roomReverb));
    OA.loadRevParams(null);   // 一旦既定値へ
    await DAW.wav.loadProject(new File([txt], 'p.json'));
    okf('U.10 読み込みで roomReverb が復元される',
      OA.revParams.decay === 3.2 && OA.revParams.damp === 0.8 && OA.revParams.level === 0.4,
      JSON.stringify(OA.revParams));
    // 旧プロジェクト（roomReverb 欠落）は既定値 = level 0（従来の音）で開く
    const old = JSON.parse(txt);
    delete old.roomReverb;
    await DAW.wav.loadProject(new File([JSON.stringify(old)], 'old.json'));
    okf('U.11 roomReverb を持たない旧プロジェクトは既定値（level=0）で開く',
      JSON.stringify(OA.revParams) === JSON.stringify(OA.REV_DEFAULTS), JSON.stringify(OA.revParams));
  }

  // ---- ストリップの Rev ノブ ----
  {
    // loadProject でトラックが空になっているので作り直す
    if (!DAW.project.tracks.length) DAW.addTrack('src');
    DAW.ui.renderTracks();
    const obj = O.create('ストリップ試験', DAW.project.tracks[0].id);
    U.setView('panner');
    U.render();
    const strip = document.querySelector(`#obj-strips .obj-strip[data-obj-id="${obj.id}"]`);
    okf('U.12 ストリップに Rev センドノブがある',
      !!strip && !!strip.querySelector('.os-rev .knob canvas'), String(!!strip));
    const rk = strip.querySelector('.os-rev .knob');

    // undo の粒度: ドラッグ全体で commit 1回（stateSig に revSend が入っているので表示も追従）
    DAW.history.reset();
    const sigBefore = U.stateSig();
    drag(rk, 51);   // 51px / 170px × (1 - 0) = +0.3
    okf('U.13 ドラッグで revSend が増える（0.25 → 0.55）',
      Math.abs(O.list[0].revSend - 0.55) < 1e-6, O.list[0].revSend);
    okf('U.14 ドラッグ全体で undo 1エントリ', DAW.history.past.length === 1, DAW.history.past.length);
    okf('U.15 stateSig が revSend に反応する', U.stateSig() !== sigBefore);
    await DAW.history.undo();
    U.sync();
    okf('U.16 undo で revSend が戻り、ノブ表示も追従する',
      O.list[0].revSend === 0.25 && rk.querySelector('.ok-val').textContent === '25%',
      `revSend=${O.list[0].revSend} 表示=${rk.querySelector('.ok-val').textContent}`);

    // lock='all' ではモデル側が拒否する（ドラッグしても値が変わらない）
    O.set(obj.id, 'lock', 'all');
    U.render();
    drag(rk, 51);
    okf('U.17 lock=all では Rev センドを変更できない', O.list[0].revSend === 0.25, O.list[0].revSend);
    O.set(obj.id, 'lock', 'none');
  }

  okf('U.18 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
