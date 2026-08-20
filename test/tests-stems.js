'use strict';
// =====================================================================
// [38] AI ステム分離（js/stems.js + UI 統合）。
//
// 実モデル（172MB）は重すぎて既定スイートでは走らせない。ここでは
//   - DSP（STFT/iSTFT・Demucs 前後処理）の数値検証
//   - セグメント分割 + 窓合成の恒等性（推論を恒等写像でモックし入力が復元されること）
//   - トラック配置・命名・undo 粒度 / キャンセル / メニューの有効無効
// を推論なしで検証する。実モデルのスモークは --bench 時のみ末尾で1本走る
// （bench.js が差し込まれているかを実行時に見て判定する）。
//
// 注意:
// - DAW.stems.separate は running ガードを持つので、モックやキャンセルの後始末を
//   怠ると後続テストが 'busy' で全滅する。finally で必ず元へ戻すこと。
// - AudioBuffer はコンテキスト非依存のコンストラクタで 44.1kHz を明示して作る
//   （テスト環境の AudioContext が 48kHz だとリサンプリングが挟まり恒等でなくなる）。
// 他ファイルのヘルパには依存しない。
// =====================================================================

function stemsSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.ui.selectedClipId = null;
    DAW.ui.renderTracks();
    DAW.collectBuffers();
    DAW.history.reset();
    const saved = {
      separate: DAW.stems.separate,
      base: DAW.stems.BASE,
      override: DAW.stems.backends.onnx.modelOverride,
    };
    try { await body(okf); } finally {
      DAW.stems.separate = saved.separate;
      DAW.stems.BASE = saved.base;
      DAW.stems.backends.onnx.modelOverride = saved.override;
      DAW.stems.running = null;
      DAW.ui.closeStemsDialog();
      DAW.ui.closeMenu();
      DAW.project.tracks.forEach(t => { t.clips = []; });
      DAW.history.reset();
      DAW.collectBuffers();
    }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

stemsSuite('[38] ステム分離', async (okf) => {
  const S = DAW.stems;
  const dsp = S.dsp;
  const C = dsp.CONSTANTS;
  const tick = () => new Promise(r => setTimeout(r, 0));
  const realSeparate = S.separate;   // モックを使うブロックの後は必ずこれへ戻す

  // 44.1kHz 固定の AudioBuffer を作る（コンテキスト非依存）
  const makeBuf = (seconds, fill) => {
    const len = Math.round(seconds * 44100);
    const buf = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: 44100 });
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = fill(i, ch);
    }
    return buf;
  };
  const testFill = (i, ch) => 0.5 * Math.sin(2 * Math.PI * 220 * i / 44100)
    + 0.3 * Math.sin(2 * Math.PI * (ch ? 1330 : 880) * i / 44100);
  const maxDiff = (a, b, from, to) => {
    let m = 0;
    for (let i = from; i < to; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; }
    return m;
  };

  // ---- API とワーカーソース ----
  okf('S.1 API が揃っている',
    typeof S.separate === 'function' && typeof S.cancel === 'function'
    && typeof S.setModelData === 'function' && S.backends.onnx
    && Array.isArray(S.TRACKS) && S.TRACKS.length === 4 && dsp && C.TRAINING_SAMPLES === 343980);
  okf('S.2 アセットの場所をスクリプト位置から解決している',
    /\/$/.test(S.BASE) && !/test\/$/.test(S.BASE), 'BASE=' + S.BASE);
  {
    // Blob Worker へ埋め込むソースが構文的に正しいこと（dspFactory.toString() 注入の検証）
    let compiled = true, detail = '';
    try { new Function(DAW.stems.backends.onnx.workerSource()); } catch (e) { compiled = false; detail = e.message; }
    okf('S.3 Worker ソースがコンパイル可能', compiled, detail);
  }

  // ---- DSP: STFT / iSTFT 往復 ----
  {
    const n = 4096 * 8;
    const sig = new Float32Array(n);
    for (let i = 0; i < n; i++) sig[i] = testFill(i, 0);
    const spec = dsp.stft(sig, C.FFT_SIZE, C.HOP_SIZE);
    const rec = dsp.istft(spec.real, spec.imag, spec.numFrames, spec.numBins, C.FFT_SIZE, C.HOP_SIZE, n);
    const err = maxDiff(sig, rec, C.FFT_SIZE, n - C.FFT_SIZE);   // 窓が揃わない両端は除く
    okf('S.4 STFT→iSTFT 往復誤差が小さい', err < 1e-3, 'maxDiff=' + err.toExponential(2));
  }

  // ---- DSP: Demucs 前後処理の往復（pad / offset 3584 / Nyquist 落としの検証）----
  {
    const seg = new Float32Array(C.TRAINING_SAMPLES);
    for (let i = 0; i < seg.length; i++) seg[i] = testFill(i, 0);
    const input = dsp.prepareModelInput(seg, seg);
    okf('S.5 モデル入力の形（waveform 2×343980 / magSpec 4×2048×336）',
      input.waveform.length === 2 * C.TRAINING_SAMPLES
      && input.magSpec.length === 4 * C.MODEL_SPEC_BINS * C.MODEL_SPEC_FRAMES);
    // magSpec のレイアウトは standaloneIspec の入力（b*frames+f）と同一なので、
    // そのまま「周波数出力 = 入力スペクトログラム」の恒等マスクとして戻せる
    const BF = C.MODEL_SPEC_BINS * C.MODEL_SPEC_FRAMES;
    const spec = {
      leftReal: input.magSpec.subarray(0, BF), leftImag: input.magSpec.subarray(BF, 2 * BF),
      rightReal: input.magSpec.subarray(2 * BF, 3 * BF), rightImag: input.magSpec.subarray(3 * BF, 4 * BF),
    };
    const out = dsp.standaloneIspec(spec, C.TRAINING_SAMPLES);
    const err = maxDiff(seg, out.left, C.FFT_SIZE, seg.length - C.FFT_SIZE);
    okf('S.6 spec→ispec 往復で入力が復元される（offset 3584 が正しい）',
      err < 1e-2, 'maxDiff=' + err.toExponential(2));
  }

  // ---- セグメント分割 ----
  {
    const stride = Math.floor(C.TRAINING_SAMPLES * (1 - C.SEGMENT_OVERLAP));
    okf('S.7 ストライドは 257,985（オーバーラップ25%）', stride === 257985, 'stride=' + stride);
    const a = S.segmentStarts(44100 * 12);   // 529,200 サンプル
    okf('S.8 12秒 → 3セグメント', a.starts.length === 3 && a.starts[2] === 2 * stride,
      JSON.stringify(a.starts));
    const b = S.segmentStarts(1000);
    okf('S.9 短い入力でも必ず1セグメント', b.starts.length === 1 && b.starts[0] === 0);
  }

  // ---- 恒等モック推論で「分割 + 窓合成 + 正規化」の恒等性 ----
  {
    const src = makeBuf(12, testFill);
    const events = [];
    const stems = await S.separate(src, {
      infer: (l, r) => S.TRACKS.map(() => ({ left: l, right: r })),   // 恒等写像
      onProgress: p => events.push(p),
    });
    const len = Math.round(12 * 44100);
    okf('S.10 4ステムとも 44.1kHz/2ch/入力と同じ長さ',
      S.TRACKS.every(k => stems[k] instanceof AudioBuffer && stems[k].sampleRate === 44100
        && stems[k].numberOfChannels === 2 && stems[k].length === len));
    const errs = S.TRACKS.map(k =>
      Math.max(maxDiff(src.getChannelData(0), stems[k].getChannelData(0), 1, len),
               maxDiff(src.getChannelData(1), stems[k].getChannelData(1), 1, len)));
    okf('S.11 窓合成後に入力が復元される（クロスフェード + 重み正規化の恒等性）',
      errs.every(e => e < 1e-4), 'maxDiff=' + Math.max(...errs).toExponential(2));
    okf('S.12 進捗はセグメント完了ごとに単調増加し最後に done=total',
      events.length === 4 && events.every(p => p.phase === 'separate' && p.total === 3)
      && events.map(p => p.done).join(',') === '0,1,2,3',
      JSON.stringify(events.map(p => p.done)));
    okf('S.13 完了後は running が解除される', S.running === null);
  }

  // ---- offset / duration（クリップの範囲だけを分離する）----
  {
    const src = makeBuf(12, testFill);
    const stems = await S.separate(src, {
      offset: 1, duration: 5,
      infer: (l, r) => S.TRACKS.map(() => ({ left: l, right: r })),
    });
    const len = Math.round(5 * 44100);
    const off = 44100;
    let err = 0;
    const d = stems.drums.getChannelData(0), orig = src.getChannelData(0);
    for (let i = 1; i < len; i++) { const e = Math.abs(d[i] - orig[off + i]); if (e > err) err = e; }
    okf('S.14 offset/duration 指定でその範囲だけが分離される',
      stems.drums.length === len && err < 1e-4, `len=${stems.drums.length} maxDiff=${err.toExponential(2)}`);
  }

  // ---- トラック配置・命名・undo 粒度 ----
  {
    DAW.project.tracks = [];
    const t0 = DAW.addTrack('A'), t1 = DAW.addTrack('B');
    const srcBuf = makeBuf(2, testFill);
    const clip = { id: DAW.uid(), bufferId: DAW.registerBuffer(srcBuf), startTime: 2.5, offset: 0, duration: 2, name: 'song' };
    t0.clips.push(clip);
    DAW.ui.renderTracks();
    DAW.history.reset();
    const stems = {};
    for (const k of S.TRACKS) stems[k] = makeBuf(2, testFill);
    const made = DAW.ui.placeStemTracks(t0.id, clip, stems);
    const names = DAW.project.tracks.map(t => t.name);
    okf('S.15 元トラックの直下に Drums/Bass/Other/Vocals の順で4トラック',
      names.join('|') === 'A|song Drums|song Bass|song Other|song Vocals|B', names.join('|'));
    okf('S.16 各トラックにクリップが1つ・同じ startTime・元クリップは残る',
      made.every(t => t.clips.length === 1 && Math.abs(t.clips[0].startTime - 2.5) < 1e-9)
      && DAW.project.tracks[0].clips.length === 1);
    okf('S.17 クリップ名もステム名（DAW.registerBuffer 済み）',
      made.every(t => t.clips[0].name === t.name && DAW.buffers.has(t.clips[0].bufferId)));
    okf('S.18 全体で undo 1回ぶん', DAW.history.past.length === 1, 'past=' + DAW.history.past.length);
    await DAW.history.undo();
    okf('S.19 undo 1発で4トラックまとめて消える',
      DAW.project.tracks.length === 2 && DAW.project.tracks.map(t => t.name).join('|') === 'A|B',
      DAW.project.tracks.map(t => t.name).join('|'));
    await DAW.history.redo();
    okf('S.20 redo で4トラックまとめて戻る', DAW.project.tracks.length === 6);
    await DAW.history.undo();
  }

  // ---- UI 経路（右クリック → ダイアログ → 完了）----
  {
    const t0 = DAW.project.tracks[0];
    const srcBuf = makeBuf(1, testFill);
    const clip = { id: DAW.uid(), bufferId: DAW.registerBuffer(srcBuf), startTime: 0.5, offset: 0, duration: 1, name: 'mix' };
    t0.clips.push(clip);
    DAW.ui.renderTracks();
    DAW.history.reset();

    // メニューの有効/無効
    const el = document.querySelector(`.clip[data-id="${clip.id}"]`);
    const item = () => {
      const m = document.getElementById('ctx-menu');
      return m && [...m.querySelectorAll('.ctx-item')].find(b => b.firstChild.textContent === 'ステム分離');
    };
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }));
    okf('S.21 メニューに「ステム分離」があり待機中は有効', !!item() && !item().disabled);
    DAW.ui.closeMenu();
    DAW.stems.running = {};   // 実行中を装う
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }));
    okf('S.22 実行中はメニュー項目が無効', !!item() && item().disabled);
    DAW.ui.closeMenu();
    DAW.stems.running = null;

    // separate をモックして UI の完了経路を通す（ダイアログ表示 → 4トラック → 閉じる）
    let sawDialog = false, gotOpts = null;
    DAW.stems.separate = async (buffer, opts) => {
      gotOpts = opts;
      sawDialog = !!document.getElementById('stems-modal');
      opts.onProgress({ phase: 'separate', done: 1, total: 2 });
      const stems = {};
      for (const k of S.TRACKS) stems[k] = makeBuf(1, testFill);
      return stems;
    };
    const ok1 = await DAW.ui.separateClipStems(clip.id);
    okf('S.23 実行中はダイアログが出て、完了で閉じる', ok1 === true && sawDialog && !document.getElementById('stems-modal'));
    okf('S.24 クリップの範囲（offset/duration）が渡る',
      gotOpts && gotOpts.offset === 0 && gotOpts.duration === 1 && typeof gotOpts.onProgress === 'function');
    okf('S.25 完了で4トラックが増え undo 1回ぶん',
      DAW.project.tracks.length === 6 && DAW.history.past.length === 1,
      `tracks=${DAW.project.tracks.length} past=${DAW.history.past.length}`);
    await DAW.history.undo();
    DAW.stems.separate = async () => { throw DAW.stems.error('inference', 'テスト用のエラー'); };
    const ok2 = await DAW.ui.separateClipStems(clip.id);
    const modal = document.getElementById('stems-modal');
    okf('S.26 エラーはダイアログに表示され「閉じる」になる',
      ok2 === false && modal && modal.querySelector('.stems-msg.stems-err')
      && modal.querySelector('.stems-cancel').textContent === '閉じる',
      modal ? modal.querySelector('.stems-msg').textContent : 'モーダルなし');
    modal.querySelector('.stems-cancel').click();
    okf('S.27 「閉じる」でダイアログが消え状態が残らない',
      !document.getElementById('stems-modal') && DAW.stems.running === null
      && DAW.project.tracks.length === 2 && !DAW.history.canUndo());
    DAW.stems.separate = realSeparate;
  }

  // ---- キャンセル（実エンジン経由。推論は永遠に返らないモック）----
  {
    DAW.stems.separate = (buffer, opts) => realSeparate.call(DAW.stems, buffer,
      Object.assign({}, opts, { infer: () => new Promise(() => {}) }));
    const clip = DAW.project.tracks[0].clips[0];
    const nTracks = DAW.project.tracks.length;
    const p = DAW.ui.separateClipStems(clip.id);
    await tick();
    okf('S.28 実行中は running が立ちダイアログが出る',
      !!DAW.stems.running && !!document.getElementById('stems-modal'));
    document.querySelector('#stems-modal .stems-cancel').click();   // = DAW.stems.cancel()
    const r = await p;
    okf('S.29 キャンセルで即座に戻りダイアログも閉じる', r === false && !document.getElementById('stems-modal'));
    okf('S.30 キャンセル後に状態が残らない（running / トラック / 履歴）',
      DAW.stems.running === null && DAW.project.tracks.length === nTracks && !DAW.history.canUndo());
    DAW.stems.separate = realSeparate;
    // エンジン単体でも: reject の code は 'cancelled'
    let code = null;
    const p2 = DAW.stems.separate(makeBuf(1, testFill), { infer: () => new Promise(() => {}) })
      .catch(e => { code = e.code; });
    await tick();
    DAW.stems.cancel();
    await p2;
    okf('S.31 エンジン単体のキャンセルは code=cancelled で reject', code === 'cancelled' && DAW.stems.running === null);
  }

  // ---- 二重起動の禁止 ----
  {
    let code = null;
    const p = DAW.stems.separate(makeBuf(1, testFill), { infer: () => new Promise(() => {}) });
    p.catch(() => {});
    await tick();
    await DAW.stems.separate(makeBuf(1, testFill), { infer: (l, r) => S.TRACKS.map(() => ({ left: l, right: r })) })
      .catch(e => { code = e.code; });
    okf('S.32 実行中の二重起動は busy で拒否', code === 'busy');
    DAW.stems.cancel();
    await p.catch(() => {});
  }

  // ---- モデル未配置の誘導とドロップ搬入 ----
  {
    DAW.stems.BASE = DAW.stems.BASE + 'no-such-dir/';   // アセットが見つからない状況を作る
    let err = null;
    // backend 明示: サイドカー検出に流れると（開発中に実サーバが居た場合）結果が変わるため
    await DAW.stems.separate(makeBuf(1, testFill), { backend: 'onnx' }).catch(e => { err = e; });
    okf('S.33 モデル未配置なら model-missing と「ドロップ」誘導を返す',
      err && err.code === 'model-missing' && /ドロップ/.test(err.message), err && err.message);
    okf('S.34 失敗後も running が解除される', DAW.stems.running === null);
    DAW.stems.BASE = DAW.stems.BASE.replace(/no-such-dir\/$/, '');
    // 存在しない script src の読み込み失敗はハーネスが [resource] として拾う。
    // これはこのテストが意図して起こしたものなので、S.36 の判定から除いておく
    for (let i = H.errors.length - 1; i >= 0; i--) {
      if (H.errors[i].includes('no-such-dir')) H.errors.splice(i, 1);
    }

    // .onnx のドロップでモデルを差し込める（onDrop はモデルを読み込みトラックは作らない）
    const nTracks = DAW.project.tracks.length;
    await DAW.ui.onDrop({
      preventDefault() {},
      dataTransfer: { files: [new File([new Uint8Array([8, 1, 2, 3])], 'htdemucs_embedded.onnx')] },
    });
    okf('S.35 .onnx ドロップでモデルが登録されアラートで知らせる',
      DAW.stems.backends.onnx.modelOverride instanceof Uint8Array
      && DAW.stems.backends.onnx.modelOverride.length === 4
      && H.alerts.some(a => /モデルを読み込みました/.test(a))
      && DAW.project.tracks.length === nTracks);
    DAW.stems.backends.onnx.modelOverride = null;
    H.alerts.length = 0;
  }

  okf('S.36 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});

// =====================================================================
// [38] Python サイドカーバックエンド（tools/stems-sidecar/ 連携）。
// 実サーバは既定スイートでは起動しない。fetch は DAW.stems.backends.python._fetch
// の1点に集約されているので、そこをモックして検出・フレーミング・キャンセル・
// エラー表示を検証する（window.fetch は触らない: ハーネスの結果送信が壊れるため）。
// =====================================================================
stemsSuite('[38] Python サイドカー', async (okf) => {
  const S = DAW.stems;
  const PY = S.backends.python;
  const wait = ms => new Promise(r => setTimeout(r, ms));

  const makeBuf = (seconds, fill) => {
    const len = Math.round(seconds * 44100);
    const buf = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: 44100 });
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = fill(i, ch);
    }
    return buf;
  };
  const constFill = v => () => v;

  const saved = { fetch: PY._fetch, poll: PY.POLL_INTERVAL, onnxSep: S.backends.onnx.separate };
  try {
    // ---- モック用ヘルパ ----
    const jsonRes = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj });
    const binRes = ab => ({ ok: true, status: 200, arrayBuffer: async () => ab });
    const route = routes => {
      PY._fetch = (url, init) => Promise.resolve().then(() => {
        const h = routes[url.replace(PY.URL, '').split('?')[0]];
        if (!h) throw new TypeError('Failed to fetch');
        return h(init, url);
      });
    };
    // サイドカーと同じ "DAWS" フレーミングの合成バイナリを作る（JSON + WAV 連結）
    const frame = pairs => {
      const wavs = pairs.map(([name, buf]) => [name, new Uint8Array(DAW.wav.encodeWav16(buf))]);
      let off = 0;
      const entries = wavs.map(([name, u8]) => { const e = { name, offset: off, length: u8.length }; off += u8.length; return e; });
      const hdr = new TextEncoder().encode(JSON.stringify({ stems: entries }));
      const out = new Uint8Array(8 + hdr.length + off);
      out.set([0x44, 0x41, 0x57, 0x53], 0);   // "DAWS"
      new DataView(out.buffer).setUint32(4, hdr.length, true);
      out.set(hdr, 8);
      let p = 8 + hdr.length;
      for (const [, u8] of wavs) { out.set(u8, p); p += u8.length; }
      return out.buffer;
    };

    // ---- DAWS フレーミングのパース（合成バイナリで往復） ----
    {
      const vals = { drums: 0.25, bass: -0.5, other: 0.1, vocals: 0.9 };
      const ab = frame(S.TRACKS.map(k => [k, makeBuf(0.1, constFill(vals[k]))]));
      const parsed = PY.parseFrame(ab);
      const len = Math.round(0.1 * 44100);
      okf('P.1 パース結果は4ステムとも 44.1kHz/2ch/正しい長さの AudioBuffer',
        S.TRACKS.every(k => parsed[k] instanceof AudioBuffer && parsed[k].sampleRate === 44100
          && parsed[k].numberOfChannels === 2 && parsed[k].length === len));
      const errs = S.TRACKS.map(k => Math.abs(parsed[k].getChannelData(0)[50] - vals[k]));
      okf('P.2 int16 WAV 往復の値が一致（±1/32768 程度）',
        errs.every(e => e < 1e-3), errs.map(e => e.toExponential(1)).join(','));
      let code = null;
      try { PY.parseFrame(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0]).buffer); } catch (e) { code = e.code; }
      okf('P.3 magic 不一致は sidecar エラーで拒否', code === 'sidecar');
    }

    // ---- 検出成功 → python バックエンドで一連の分離 ----
    {
      PY.POLL_INTERVAL = 10;   // テストでは高速にポーリングさせる
      const src = makeBuf(0.5, i => 0.3 * Math.sin(2 * Math.PI * 440 * i / 44100));
      const framed = frame(S.TRACKS.map(k => [k, makeBuf(0.5, constFill(0.5))]));
      let postedBody = null, backendUsed = null;
      const events = [];
      route({
        '/ping': () => jsonRes({ ok: true, version: '4.1.0', model: 'htdemucs', busy: false }),
        '/progress': () => jsonRes({ running: true, progress: 0.42, stage: 'separating', error: null }),
        '/separate': init => { postedBody = init.body; return wait(60).then(() => binRes(framed)); },
        '/cancel': () => jsonRes({ ok: true, cancelled: false }),
      });
      const stems = await S.separate(src, {
        onBackend: b => { backendUsed = b; },
        onProgress: p => events.push(p),
      });
      okf('P.4 /ping 検出成功で python バックエンドが選ばれる', backendUsed === 'python');
      const dv = postedBody && new DataView(postedBody);
      const lenIn = Math.round(0.5 * 44100);
      okf('P.5 POST body は 44.1kHz/16bit ステレオ WAV（既存エンコーダ再利用）',
        dv && dv.byteLength === 44 + lenIn * 4
        && String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) === 'RIFF'
        && dv.getUint32(24, true) === 44100 && dv.getUint16(22, true) === 2,
        'bytes=' + (dv && dv.byteLength));
      okf('P.6 4ステムの AudioBuffer が返る',
        S.TRACKS.every(k => stems[k] instanceof AudioBuffer && stems[k].length === lenIn));
      okf('P.7 進捗は /progress ポーリング由来の percent 形式（0 → 42 → 100）',
        events.length >= 2 && events[0].done === 0 && events[events.length - 1].done === 100
        && events.every(p => p.phase === 'separate' && p.unit === 'percent' && p.total === 100)
        && events.some(p => p.done === 42),
        JSON.stringify(events.map(p => p.done)));
      okf('P.8 完了後は running が解除される', S.running === null);
      PY.POLL_INTERVAL = saved.poll;
    }

    // ---- 検出失敗 → ブラウザ内処理（onnx）へフォールバック ----
    {
      PY._fetch = () => Promise.reject(new TypeError('Failed to fetch'));   // 接続拒否を模す
      const SENTINEL = { fallback: true };
      S.backends.onnx.separate = async () => SENTINEL;
      let backendUsed = null;
      const r = await S.separate(makeBuf(0.1, constFill(0)), { onBackend: b => { backendUsed = b; } });
      okf('P.9 検出失敗（接続拒否）で onnx へフォールバック', r === SENTINEL && backendUsed === 'onnx');
      S.backends.onnx.separate = saved.onnxSep;
    }

    // ---- キャンセル（fetch abort + POST /cancel の併用） ----
    {
      let cancelPosted = false, started;
      const startedP = new Promise(r => { started = r; });
      route({
        '/ping': () => jsonRes({ ok: true }),
        '/progress': () => jsonRes({ running: false, progress: 0, stage: 'idle', error: null }),
        '/cancel': () => { cancelPosted = true; return jsonRes({ ok: true, cancelled: true }); },
        '/separate': init => new Promise((resolve, reject) => {
          started();
          init.signal.addEventListener('abort',
            () => reject(new DOMException('The user aborted a request.', 'AbortError')));
        }),
      });
      let code = null;
      const p = S.separate(makeBuf(0.2, constFill(0.1)), {}).catch(e => { code = e.code; });
      await startedP;    // POST が始まるまで待ってからキャンセル
      S.cancel();
      await p;
      okf('P.10 キャンセルで abort され POST /cancel も飛ぶ（code=cancelled）',
        code === 'cancelled' && cancelPosted);
      okf('P.11 キャンセル後に running が解除される', S.running === null);
    }

    // ---- サーバ側ステータス（499 / 500）とネットワーク断 ----
    {
      const base = {
        '/ping': () => jsonRes({ ok: true }),
        '/progress': () => jsonRes({ running: false }),
        '/cancel': () => jsonRes({ ok: true }),
      };
      route(Object.assign({}, base, { '/separate': () => jsonRes({ error: 'cancelled' }, 499) }));
      let code = null;
      await S.separate(makeBuf(0.1, constFill(0)), {}).catch(e => { code = e.code; });
      okf('P.12 サーバ側 499 も cancelled として扱う', code === 'cancelled');

      route(Object.assign({}, base, { '/separate': () => jsonRes({ error: 'demucs exited with code 1' }, 500) }));
      let err = null;
      await S.separate(makeBuf(0.1, constFill(0)), {}).catch(e => { err = e; });
      okf('P.13 500 は sidecar エラーで本文の理由も表示に含む',
        err && err.code === 'sidecar' && /500/.test(err.message) && /demucs exited/.test(err.message),
        err && err.message);

      route(Object.assign({}, base, { '/separate': () => { throw new TypeError('Failed to fetch'); } }));
      err = null;
      await S.separate(makeBuf(0.1, constFill(0)), {}).catch(e => { err = e; });
      okf('P.14 分離中のネットワーク断は network エラー',
        err && err.code === 'network' && /通信できません/.test(err.message), err && err.message);
    }

    // ---- UI 経路: バックエンド表示 / 409 busy / 完了で4トラック配置 ----
    {
      DAW.project.tracks = [];
      const t0 = DAW.addTrack('A');
      const srcBuf = makeBuf(0.3, constFill(0.2));
      const clip = { id: DAW.uid(), bufferId: DAW.registerBuffer(srcBuf), startTime: 0, offset: 0, duration: 0.3, name: 'mix' };
      t0.clips.push(clip);
      DAW.ui.renderTracks();
      DAW.history.reset();

      // 409 busy: 実行中の様子（Python 高速処理の表示）も /separate 到達時に覗いて確かめる
      let msgDuring = '';
      route({
        '/ping': () => jsonRes({ ok: true, busy: true }),
        '/progress': () => jsonRes({ running: true, progress: 0.5 }),
        '/separate': () => {
          const el = document.querySelector('#stems-modal .stems-msg');
          msgDuring = el ? el.textContent : '';
          return jsonRes({ error: 'busy' }, 409);
        },
        '/cancel': () => jsonRes({ ok: true }),
      });
      const ok1 = await DAW.ui.separateClipStems(clip.id);
      const modal = document.getElementById('stems-modal');
      okf('P.15 実行中ダイアログに「Python 高速処理」と表示される', /Python 高速処理/.test(msgDuring), msgDuring);
      okf('P.16 409 busy はダイアログにエラー表示され「閉じる」になる',
        ok1 === false && modal && modal.querySelector('.stems-msg.stems-err')
        && /実行中/.test(modal.querySelector('.stems-msg').textContent)
        && modal.querySelector('.stems-cancel').textContent === '閉じる',
        modal ? modal.querySelector('.stems-msg').textContent : 'モーダルなし');
      if (modal) modal.querySelector('.stems-cancel').click();
      okf('P.17 「閉じる」で消えて状態が残らない',
        !document.getElementById('stems-modal') && S.running === null
        && DAW.project.tracks.length === 1 && !DAW.history.canUndo());

      // 完了経路: 分離結果の後段（4トラック配置・undo 1回）は既存経路がそのまま働く
      const framed = frame(S.TRACKS.map(k => [k, makeBuf(0.3, constFill(0.25))]));
      route({
        '/ping': () => jsonRes({ ok: true }),
        '/progress': () => jsonRes({ running: true, progress: 0.5 }),
        '/separate': () => binRes(framed),
        '/cancel': () => jsonRes({ ok: true }),
      });
      const ok2 = await DAW.ui.separateClipStems(clip.id);
      okf('P.18 完了で4トラック配置・undo 1回ぶん（既存経路の再利用）',
        ok2 === true && DAW.project.tracks.length === 5 && DAW.history.past.length === 1
        && DAW.project.tracks.map(t => t.name).join('|') === 'A|mix Drums|mix Bass|mix Other|mix Vocals',
        DAW.project.tracks.map(t => t.name).join('|'));
      await DAW.history.undo();
    }

    // ---- percent 進捗の表示ユニット ----
    {
      const dlg = DAW.ui.openStemsDialog('song');
      DAW.ui.setStemsBackend(dlg, 'python');
      DAW.ui.updateStemsDialog(dlg, { phase: 'separate', unit: 'percent', done: 42, total: 100 });
      okf('P.19 percent 進捗は「42%」表記でバーも 42%・バックエンド名も出る',
        dlg.count.textContent === '42%' && dlg.fill.style.width === '42%'
        && /Python 高速処理/.test(dlg.msg.textContent),
        dlg.msg.textContent + ' / ' + dlg.count.textContent);
      DAW.ui.closeStemsDialog();
    }

    okf('P.20 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
  } finally {
    PY._fetch = saved.fetch;
    PY.POLL_INTERVAL = saved.poll;
    S.backends.onnx.separate = saved.onnxSep;
  }
});

// =====================================================================
// 実モデルのスモーク（--bench 時のみ）。
// アセット搬入 → Blob Worker 内で ort セッション生成 → 1セグメント実推論まで通す。
// 既定スイートでは bench.js が差し込まれていないのでスキップされる。
// =====================================================================
T('[38] 実モデルスモーク（--bench 時のみ）', async () => {
  if (!document.querySelector('script[src="bench.js"]')) return 'スキップ（--bench 時のみ実行）';
  const S = DAW.stems;
  const len = Math.round(2 * 44100);
  const buf = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: 44100 });
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = 0.4 * Math.sin(2 * Math.PI * 220 * i / 44100)
        + 0.2 * Math.sin(2 * Math.PI * 55 * i / 44100)
        + (i % 22050 < 800 ? 0.4 * Math.sin(2 * Math.PI * 60 * i / 44100) : 0);
    }
  }
  const t0 = performance.now();
  const stems = await S.separate(buf, { workers: 1 });
  const ms = Math.round(performance.now() - t0);
  const stats = {};
  for (const k of S.TRACKS) {
    const d = stems[k].getChannelData(0);
    let sum2 = 0, bad = 0;
    for (let i = 0; i < d.length; i++) { const v = d[i]; if (!Number.isFinite(v)) bad++; else sum2 += v * v; }
    stats[k] = { rms: Math.sqrt(sum2 / d.length), bad };
    if (bad > 0) throw new Error(`${k} に非有限サンプル ${bad} 個`);
    if (!(stats[k].rms > 1e-6)) throw new Error(`${k} が無音 (rms=${stats[k].rms})`);
  }
  return `${ms}ms / rms: ` + S.TRACKS.map(k => `${k}=${stats[k].rms.toFixed(4)}`).join(' ');
});
