'use strict';
// =====================================================================
// FL 流エフェクトホスト フェーズ1
//   js/wrapper.js: ラッパー層（enable / wet の線形クロスフェード / latency 読み取り /
//                  norm・denorm・formatValue）
//   js/knob.js:    共通ノブ（縦ドラッグ / Ctrl・Shift 微調整 / ホイール / ダブルクリック /
//                  右クリックメニュー / インライン値入力）
//   js/ui.js:      FXラック UI（10行 / LED / MIX）とヒントバー
//
// 他ファイルのヘルパには依存しない（tests-*.js は名前順に読まれるため）。
// rAF は headless で発火しないので、更新関数・イベントを直接呼んで検証する。
// =====================================================================

function wrapperSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    const savedLimiter = DAW.limiter.enabled;
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project = { masterVolume: 1, tracks: [] };
    DAW.buffers = new Map();
    DAW.peaks = new Map();
    if (DAW.audio.masterGain) DAW.audio.masterGain.gain.value = 1;
    DAW.loop.enabled = false;
    DAW.objects.clear();
    DAW.limiter.setEnabled(false);   // 書き出しの線形性をサンプル単位で検証するため切る
    DAW.ui.selectedClipId = null;
    DAW.ui.renderTracks();
    DAW.history.reset();
    H.downloads.length = 0;
    try {
      await body(okf);
    } finally {
      DAW.limiter.setEnabled(savedLimiter);
      DAW.plugins.defs.delete('wrapgain');   // テスト専用プラグインを後続へ漏らさない
      DAW.plugins.defs.delete('wraplat');
      DAW.ui.closeFxRack();
      DAW.ui.closeMenu();
      DAW.ui.clearHint();
      const ki = document.getElementById('knob-input');
      if (ki) ki.remove();
      try { DAW.audio.stop(); } catch (e) {}
      DAW.audio.resetNodes();
      DAW.project.tracks = [];
      DAW.ui.renderTracks();
      DAW.history.reset();
      H.downloads.length = 0;
    }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

wrapperSuite('[39] ラッパー層/共通ノブ/FXラック', async (okf) => {
  const ctx0 = DAW.audio.ensureCtx();
  const SRW = ctx0.sampleRate;

  // ---- テスト専用プラグイン（決定的な純ゲイン ×2。線形合成をサンプル単位で検証できる）----
  DAW.plugins.register({
    id: 'wrapgain',
    name: 'テストゲイン',
    params: [],
    create(ctx) {
      const g = ctx.createGain();
      g.gain.value = 2;
      return { input: g, output: g, set() {} };
    },
  });
  // latencySamples 申告つきのパススルー（chainLatency の読み取り検証用）
  DAW.plugins.register({
    id: 'wraplat',
    name: 'テストレイテンシ',
    params: [],
    create(ctx) {
      const g = ctx.createGain();
      return { input: g, output: g, set() {}, latencySamples: 128 };
    },
  });

  const makeBuf = (amp, dur) => {
    const buf = ctx0.createBuffer(1, Math.round(SRW * dur), SRW);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = amp * Math.sin(2 * Math.PI * 440 * i / SRW);
    return buf;
  };
  // exportMix の実経路でレンダリングして bytes と Float32 を返す
  const render = async () => {
    H.downloads.length = 0;
    await DAW.wav.exportMix();
    const dl = H.downloads.pop();
    if (!dl) return null;
    const bytes = new Uint8Array(await dl.blob.arrayBuffer());
    const buffer = await ctx0.decodeAudioData(bytes.buffer.slice(0));
    return { bytes, buffer, ch0: buffer.getChannelData(0) };
  };
  const bytesEq = (a, b) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  const rmsW = a => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * a[i];
    return Math.sqrt(s / a.length);
  };

  const bid = DAW.registerBuffer(makeBuf(0.3, 0.25));
  const track = DAW.addTrack('W1');
  track.clips.push({ id: DAW.uid(), bufferId: bid, startTime: 0, offset: 0, duration: 0.25, name: 'c' });

  // ---------------------------------------------------------------
  // A. ラッパー層の音（enable / wet が書き出しへ正しく反映される）
  // ---------------------------------------------------------------
  track.effects = [];
  const dry = await render();
  okf('F.1 前提: FX 無しの書き出しが取れる', !!dry && dry.ch0.length > 0);

  {
    // enable=false は完全 dry とサンプル一致（WAV のバイト列ごと一致）
    track.effects = [{ pluginId: 'lowpass', params: DAW.plugins.defaultParams(DAW.plugins.get('lowpass')), enabled: false, wet: 0.7 }];
    const off = await render();
    okf('F.2 enable=false の出力は完全 dry とサンプル一致', bytesEq(off.bytes, dry.bytes),
      `bytes=${off.bytes.length}`);
  }

  {
    // wet=0 も dry とサンプル一致（線形クロスフェードの境界）
    track.effects = [{ pluginId: 'wrapgain', params: {}, enabled: true, wet: 0 }];
    const w0 = await render();
    okf('F.3 wet=0 の出力は dry とサンプル一致', bytesEq(w0.bytes, dry.bytes));

    // wet=1 は wet 枝のみ（×2 ゲインなのでちょうど2倍）
    track.effects[0].wet = 1;
    const w1 = await render();
    let maxErr = 0;
    for (let i = 0; i < dry.ch0.length; i++) {
      const e = Math.abs(w1.ch0[i] - 2 * dry.ch0[i]);
      if (e > maxErr) maxErr = e;
    }
    okf('F.4 wet=1 の出力は wet 枝そのもの（×2）', maxErr < 3e-4, `最大誤差=${maxErr.toExponential(2)}`);

    // wet=0.5 は線形合成: 0.5*dry + 0.5*(2*dry) = 1.5*dry
    track.effects[0].wet = 0.5;
    const w5 = await render();
    maxErr = 0;
    for (let i = 0; i < dry.ch0.length; i++) {
      const e = Math.abs(w5.ch0[i] - 1.5 * dry.ch0[i]);
      if (e > maxErr) maxErr = e;
    }
    okf('F.5 wet=0.5 は線形合成（dry*(1-w) + wet*w）', maxErr < 3e-4, `最大誤差=${maxErr.toExponential(2)}`);
  }

  {
    // 旧形式（enabled/wet フィールド欠落）は enabled=true / wet=1 と同一出力
    track.effects = [{ pluginId: 'wrapgain', params: {} }];
    const legacy = await render();
    track.effects = [{ pluginId: 'wrapgain', params: {}, enabled: true, wet: 1 }];
    const explicit = await render();
    okf('F.6 旧形式 effects（フィールド欠落）は従来出力とサンプル一致', bytesEq(legacy.bytes, explicit.bytes));
  }

  {
    // exportMix 経由での enable 切替が音に出る（rms が約2倍差）
    track.effects = [{ pluginId: 'wrapgain', params: {}, enabled: true, wet: 1 }];
    const on = await render();
    track.effects[0].enabled = false;
    const off = await render();
    const ratio = rmsW(on.ch0) / rmsW(off.ch0);
    okf('F.7 exportMix に enable/wet が反映される', Math.abs(ratio - 2) < 0.01, `rms比=${ratio.toFixed(4)}`);
  }

  // ---------------------------------------------------------------
  // B. スロットの契約（旧インスタンス互換 / latency 読み取り）
  // ---------------------------------------------------------------
  {
    track.effects = [{ pluginId: 'wraplat', params: {} }];
    const n = DAW.audio.getTrackNodes(track);
    okf('F.8 スロットは旧インスタンスと同じ input/output/set を持つ',
      n.fx.length === 1 && !!n.fx[0].input && !!n.fx[0].output && typeof n.fx[0].set === 'function');
    okf('F.9 latencySamples（任意契約）を createSlot が読み取る', n.fx[0].latencySamples === 128,
      'latency=' + n.fx[0].latencySamples);
    okf('F.10 chainLatency は enable 中のスロットを合算する', DAW.wrapper.chainLatency(track) === 128,
      DAW.wrapper.chainLatency(track));
    DAW.audio.setEffectEnabled(track, 0, false);
    okf('F.11 disable 中のスロットは chainLatency に入らない', DAW.wrapper.chainLatency(track) === 0,
      DAW.wrapper.chainLatency(track));
    DAW.audio.setEffectEnabled(track, 0, true);
    okf('F.12 再 enable してもインスタンスは同じ（破棄しない）',
      DAW.wrapper.chainLatency(track) === 128 && n.fx[0]._connected === true);
    DAW.audio.removeTrackNodes(track.id);
    track.effects = [];
  }

  // ---------------------------------------------------------------
  // C. undo / 10スロット上限
  // ---------------------------------------------------------------
  {
    track.effects = [{ pluginId: 'wrapgain', params: {}, enabled: true, wet: 1 }];
    DAW.history.reset();
    DAW.audio.setEffectEnabled(track, 0, false);
    DAW.history.commit();
    DAW.audio.setEffectWet(track, 0, 0.25);
    DAW.history.commit();
    const cur = () => DAW.project.tracks[0].effects[0];
    okf('F.13 enable/wet の変更が state に入る', cur().enabled === false && cur().wet === 0.25,
      JSON.stringify({ enabled: cur().enabled, wet: cur().wet }));
    await DAW.history.undo();
    okf('F.14 undo 1回で wet が戻る', cur().enabled === false && cur().wet === 1,
      JSON.stringify({ enabled: cur().enabled, wet: cur().wet }));
    await DAW.history.undo();
    okf('F.15 undo 2回で enable が戻る', cur().enabled === true && cur().wet === 1);
    await DAW.history.redo();
    okf('F.16 redo で enable=false に進む', cur().enabled === false);
    DAW.project.tracks[0].effects = [];
    DAW.history.reset();
  }

  {
    const tr = DAW.project.tracks[0];
    const def = DAW.plugins.get('wrapgain');
    for (let i = 0; i < DAW.wrapper.MAX_SLOTS; i++) {
      tr.effects.push({ pluginId: 'wrapgain', params: {}, enabled: true, wet: 1 });
    }
    await DAW.ui.addFxSlot(tr, def);
    okf('F.17 スロットは10個が上限（addFxSlot が拒否する）', tr.effects.length === DAW.wrapper.MAX_SLOTS,
      'effects=' + tr.effects.length);
    tr.effects = [];
    DAW.ui.renderTracks();
    DAW.history.reset();
  }

  // ---------------------------------------------------------------
  // D. norm / denorm / formatValue
  // ---------------------------------------------------------------
  {
    const W = DAW.wrapper;
    const def = {
      params: [
        { key: 'freq', label: '周波数', min: 100, max: 18000, step: 1, default: 8000, unit: 'Hz', digits: 0, curve: 'log' },
        { key: 'gain', label: 'ゲイン', min: -12, max: 12, step: 0.5, default: 0, unit: 'dB' },
        { key: 'q', label: 'Q', min: 0.1, max: 15, step: 0.1, default: 0.8, format: v => 'Q=' + v.toFixed(2) },
      ],
    };
    okf('F.18 norm は端点で 0 / 1（log 含む）',
      W.norm(def, 'freq', 100) === 0 && W.norm(def, 'freq', 18000) === 1
      && W.norm(def, 'gain', -12) === 0 && W.norm(def, 'gain', 12) === 1);
    okf('F.19 denorm は端点で min / max',
      W.denorm(def, 'freq', 0) === 100 && W.denorm(def, 'freq', 1) === 18000
      && W.denorm(def, 'gain', 0) === -12 && W.denorm(def, 'gain', 1) === 12);
    const rt1 = W.denorm(def, 'freq', W.norm(def, 'freq', 8000));
    const rt2 = W.denorm(def, 'gain', W.norm(def, 'gain', -6.5));
    okf('F.20 norm→denorm が往復する（log は step へ量子化して一致）', rt1 === 8000 && rt2 === -6.5,
      `freq=${rt1} gain=${rt2}`);
    const mid = W.denorm(def, 'freq', 0.5);
    okf('F.21 log カーブの中央は幾何平均（≈1342Hz。線形の 9050Hz ではない）',
      Math.abs(mid - Math.sqrt(100 * 18000)) <= 1, 'mid=' + mid);
    okf('F.22 範囲外の値はクランプされる',
      W.norm(def, 'gain', 99) === 1 && W.norm(def, 'gain', -99) === 0
      && W.denorm(def, 'gain', 2) === 12 && W.denorm(def, 'gain', -1) === -12);
    okf('F.23 formatValue は桁区切り+単位（"8,000 Hz"）', W.formatValue(def, 'freq', 8000) === '8,000 Hz',
      `"${W.formatValue(def, 'freq', 8000)}"`);
    okf('F.24 digits 省略時は step から桁数を推定（step=0.5 → 1桁）',
      W.formatValue(def, 'gain', -6.5) === '-6.5 dB', `"${W.formatValue(def, 'gain', -6.5)}"`);
    okf('F.25 format 指定はそれを優先する', W.formatValue(def, 'q', 0.8) === 'Q=0.80',
      `"${W.formatValue(def, 'q', 0.8)}"`);
  }

  // ---------------------------------------------------------------
  // E. 共通ノブ（DAW.knob）
  // ---------------------------------------------------------------
  {
    let v = 0.5;
    let commits = 0;
    const el = DAW.knob.create({
      label: 'テスト',
      range: { min: 0, max: 1, step: 0.01 },
      def: 0.25,
      get: () => v,
      set: x => { v = x; },
      commit: () => { commits++; },
      format: x => x.toFixed(2) + 'u',
    });
    document.body.appendChild(el);
    const pev = (target, type, y, opts) => {
      target.dispatchEvent(new PointerEvent(type, Object.assign({
        bubbles: true, cancelable: true, pointerId: 9, button: 0, clientX: 100, clientY: y,
      }, opts)));
    };
    okf('F.26 ノブは canvas 描画（<input> を含まない）',
      !!el.querySelector('canvas') && !el.querySelector('input')
      && el.querySelector('.ok-val').textContent === '0.50u',
      el.querySelector('.ok-val').textContent);

    // 縦ドラッグ 17px = 正規化 0.1（KNOB_PX=170）。ドラッグ中は commit しない
    pev(el, 'pointerdown', 300);
    pev(window, 'pointermove', 283);
    okf('F.27 縦ドラッグで値が動く（17px = レンジの1割）', Math.abs(v - 0.6) < 1e-9, 'v=' + v);
    okf('F.28 ドラッグ中は commit しない', commits === 0, 'commits=' + commits);
    pev(window, 'pointerup', 283);
    okf('F.29 pointerup で commit 1回（undo 粒度）', commits === 1, 'commits=' + commits);

    // Ctrl で微調整（0.2倍）。Shift も互換で同じ
    v = 0.5;
    pev(el, 'pointerdown', 300);
    pev(window, 'pointermove', 283, { ctrlKey: true });
    pev(window, 'pointerup', 283, { ctrlKey: true });
    okf('F.30 Ctrl ドラッグは微調整（0.2倍）', Math.abs(v - 0.52) < 1e-9, 'v=' + v);
    v = 0.5;
    pev(el, 'pointerdown', 300);
    pev(window, 'pointermove', 283, { shiftKey: true });
    pev(window, 'pointerup', 283, { shiftKey: true });
    okf('F.31 Shift ドラッグも互換で微調整', Math.abs(v - 0.52) < 1e-9, 'v=' + v);

    // ホイールは1ステップ（Ctrl で微ステップ）
    v = 0.5;
    commits = 0;
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }));
    okf('F.32 ホイール上で +1 ステップ', Math.abs(v - 0.51) < 1e-9 && commits === 1, `v=${v} commits=${commits}`);
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }));
    okf('F.33 ホイール下で -1 ステップ', Math.abs(v - 0.5) < 1e-9, 'v=' + v);
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, cancelable: true }));
    okf('F.34 Ctrl ホイールは微ステップ（0.2ステップ）', Math.abs(v - 0.502) < 1e-9, 'v=' + v);

    // ダブルクリックで既定値
    v = 0.9;
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    okf('F.35 ダブルクリックで既定値に戻る', v === 0.25, 'v=' + v);

    // 右クリックメニュー（項目とdisabled状態）
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
    const menu = document.getElementById('ctx-menu');
    const items = menu ? [...menu.querySelectorAll('.ctx-item')] : [];
    const labels = items.map(b => b.firstChild.textContent);
    okf('F.36 右クリックメニューが開く（値入力/デフォルト/オートメーション/リンク）',
      labels.join(',') === '値を入力…,デフォルトに戻す,オートメーション化,リンク…', labels.join(','));
    okf('F.37 オートメーション化とリンクは disabled（フェーズ2/3 の予告）',
      items.length === 4 && items[2].disabled && items[3].disabled && !items[0].disabled && !items[1].disabled);

    // 「値を入力…」→ インライン input → blur で確定（テストは blur() を使う規約）
    v = 0.5;
    commits = 0;
    items[0].click();
    const input = document.getElementById('knob-input');
    okf('F.38 値入力のインライン input が開く', !!input && document.getElementById('ctx-menu') === null);
    input.value = '0.815';
    input.blur();
    okf('F.39 blur で値が確定して commit される',
      Math.abs(v - 0.815) < 1e-9 && commits === 1 && !document.getElementById('knob-input'),
      `v=${v} commits=${commits}`);

    // 範囲外の入力はクランプ
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
    document.querySelector('#ctx-menu .ctx-item').click();
    const input2 = document.getElementById('knob-input');
    input2.value = '99';
    input2.blur();
    okf('F.40 範囲外の入力はクランプされる', v === 1, 'v=' + v);

    // ヒントバー（hover 中「ラベル: 現在値」/ 離れたら消える）
    el.dispatchEvent(new PointerEvent('pointerenter', { pointerId: 9 }));
    okf('F.41 hover でヒントバーに「ラベル: 現在値」', document.getElementById('hint-bar').textContent === 'テスト: 1.00u',
      `"${document.getElementById('hint-bar').textContent}"`);
    el.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 9 }));
    okf('F.42 hover が外れたらヒントは消える', document.getElementById('hint-bar').textContent === '');

    // 外部変更への追従（update）
    v = 0.33;
    el.update();
    okf('F.43 update() で外部変更に追従する', el.querySelector('.ok-val').textContent === '0.33u',
      el.querySelector('.ok-val').textContent);

    el.remove();
  }

  // ---------------------------------------------------------------
  // F. FXラック UI（10行 / LED / MIX / エディタ / バッジ）
  // ---------------------------------------------------------------
  {
    const tr = DAW.project.tracks[0];
    tr.effects = [{ pluginId: 'lowpass', params: DAW.plugins.defaultParams(DAW.plugins.get('lowpass')), enabled: true, wet: 1 }];
    DAW.ui.renderTracks();
    DAW.history.reset();

    const btn = document.querySelector('#tracks .track-row .fx-rack-btn');
    okf('F.44 トラックヘッドはラックボタン+バッジ（fx-chip 列は廃止）',
      !!btn && !document.querySelector('.fx-chip') && !document.querySelector('.fx-add')
      && btn.querySelector('.fx-badge').textContent === '1/10',
      btn ? btn.querySelector('.fx-badge').textContent : 'ボタンなし');

    btn.click();
    const panel = document.getElementById('fx-panel');
    const slots = panel ? panel.querySelectorAll('.fx-slot') : [];
    okf('F.45 ラックは常に10行', !!panel && slots.length === 10, 'rows=' + slots.length);
    okf('F.46 行の構成は [LED] [名前] [MIX ノブ]',
      slots[0].querySelector('.fx-led').classList.contains('on')
      && slots[0].querySelector('.fx-slot-name').textContent === 'ローパス'
      && !!slots[0].querySelector('.fx-mix canvas'));
    okf('F.47 空行は LED が押せず MIX が無い',
      slots[1].classList.contains('empty') && slots[1].querySelector('.fx-led').disabled
      && !slots[1].querySelector('.fx-mix') && slots[1].querySelector('.fx-slot-name').textContent === '---');

    // LED で enable 切替（undo 1エントリ）
    slots[0].querySelector('.fx-led').click();
    okf('F.48 LED クリックで enable が切れる', tr.effects[0].enabled === false
      && !slots[0].querySelector('.fx-led').classList.contains('on'));
    await DAW.history.undo();
    okf('F.49 undo で enable が戻り、開いているラックも追従する',
      DAW.project.tracks[0].effects[0].enabled === true
      && document.querySelector('#fx-panel .fx-slot .fx-led').classList.contains('on'));

    // 行クリックでエディタ展開（共通ノブが param ぶん生成される）
    document.querySelector('#fx-panel .fx-slot .fx-slot-name').click();
    const editor = document.querySelector('#fx-panel .fx-editor');
    okf('F.50 行クリックでエディタが展開する（ノブ自動生成）',
      !!editor && editor.querySelectorAll('.fx-knobs .knob').length === 2
      && !editor.querySelector('input[type="range"]'),
      editor ? editor.querySelectorAll('.knob').length + 'ノブ' : 'エディタなし');

    // MIX ノブのダブルクリック = 100% に戻る
    DAW.audio.setEffectWet(DAW.project.tracks[0], 0, 0.3);
    document.querySelector('#fx-panel .fx-mix').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    okf('F.51 MIX のダブルクリックで 100% に戻る', DAW.project.tracks[0].effects[0].wet === 1,
      'wet=' + DAW.project.tracks[0].effects[0].wet);

    // 空行クリックでプラグイン選択メニュー
    document.querySelectorAll('#fx-panel .fx-slot')[3].querySelector('.fx-slot-name')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 80, clientY: 80 }));
    const addMenu = document.getElementById('ctx-menu');
    okf('F.52 空行クリックでプラグイン選択メニューが開く',
      !!addMenu && addMenu.querySelectorAll('.ctx-item').length === DAW.plugins.list().length,
      addMenu ? addMenu.querySelectorAll('.ctx-item').length + '項目' : 'メニューなし');
    DAW.ui.closeMenu();

    DAW.ui.closeFxRack();
    okf('F.53 ラックを閉じられる', !document.getElementById('fx-panel'));
    DAW.project.tracks[0].effects = [];
    DAW.ui.renderTracks();
    DAW.history.reset();
  }

  // ---------------------------------------------------------------
  // G. ヒントバー API
  // ---------------------------------------------------------------
  {
    okf('F.54 #hint-bar が存在する', !!document.getElementById('hint-bar'));
    DAW.ui.setHint('周波数: 8,000 Hz');
    okf('F.55 setHint で表示される', document.getElementById('hint-bar').textContent === '周波数: 8,000 Hz');
    DAW.ui.clearHint();
    okf('F.56 clearHint で消える', document.getElementById('hint-bar').textContent === '');
  }

  okf('F.57 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
