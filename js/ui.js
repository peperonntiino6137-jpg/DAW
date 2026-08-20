'use strict';

// タイムラインUI。state を直接変更し、明示的に render する方式。
DAW.ui = {
  HEAD_W: 200,
  selectedClipId: null,
  els: {},

  init() {
    this.els = {
      scroller: document.getElementById('scroller'),
      content: document.getElementById('content'),
      tracks: document.getElementById('tracks'),
      rulerRow: document.getElementById('ruler-row'),
      ruler: document.getElementById('ruler'),
      playhead: document.getElementById('playhead'),
      time: document.getElementById('time-display'),
      btnPlay: document.getElementById('btn-play'),
      dropHint: document.getElementById('drop-hint'),
      zoomLabel: document.getElementById('zoom-label'),
      bpm: document.getElementById('bpm'),
      btnSnap: document.getElementById('btn-snap'),
      btnMetro: document.getElementById('btn-metro'),
      gridDiv: document.getElementById('grid-div'),
      masterVol: document.getElementById('master-vol'),
      btnRecord: document.getElementById('btn-record'),
      btnLoop: document.getElementById('btn-loop'),
      btnExport: document.getElementById('btn-export'),
      btnUndo: document.getElementById('btn-undo'),
      btnRedo: document.getElementById('btn-redo'),
      btnCut: document.getElementById('btn-cut'),
      btnSplit: document.getElementById('btn-split'),
      btnClipDel: document.getElementById('btn-clip-del'),
      meter: document.getElementById('meter'),
      meterL: document.getElementById('meter-l'),
      meterR: document.getElementById('meter-r'),
      meterDb: document.getElementById('meter-db'),
      meterClip: document.getElementById('meter-clip'),
    };

    this.els.scroller.addEventListener('scroll', () => {
      this.drawRuler();
      this.refreshVisibleWaves();
      this.closeMenu();   // メニューは開いた位置の時刻と結びついているので、ずれたら閉じる
    });
    window.addEventListener('resize', () => this.renderTracks());

    // ズーム: ボタン / Ctrl+ホイール（ポインタ位置の時刻を固定して拡大縮小）
    document.getElementById('btn-zoom-in').addEventListener('click', () => this.zoomBy(1.5));
    document.getElementById('btn-zoom-out').addEventListener('click', () => this.zoomBy(1 / 1.5));
    document.getElementById('btn-zoom-fit').addEventListener('click', () => this.zoomToFit());
    this.els.scroller.addEventListener('wheel', e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this.zoomBy(Math.pow(1.0015, -e.deltaY), e.clientX);
    }, { passive: false });
    this.updateZoomLabel();

    // グリッド（BPM / スナップ）
    this.els.bpm.addEventListener('input', () => {
      DAW.setBpm(+this.els.bpm.value);
      this.applyGrid();
    });
    this.els.bpm.addEventListener('change', () => {
      this.els.bpm.value = DAW.project.bpm;
      DAW.history.commit();
    });
    this.els.btnMetro.addEventListener('click', () => this.toggleMetronome());
    this.els.btnSnap.addEventListener('click', () => {
      DAW.grid.enabled = !DAW.grid.enabled;
      this.els.btnSnap.classList.toggle('on', DAW.grid.enabled);
      this.applyGrid();
    });
    this.els.gridDiv.addEventListener('change', () => {
      DAW.grid.division = +this.els.gridDiv.value;
      this.applyGrid();
    });

    // メーターのクリックでクリップ表示をリセット
    this.els.meter.addEventListener('click', () => this.resetClip());

    this.els.btnUndo.addEventListener('click', () => DAW.history.undo());
    this.els.btnRedo.addEventListener('click', () => DAW.history.redo());
    this.updateHistoryButtons();

    // クリップ編集ボタン。キーボードショートカットと同じ経路（下の ***SelectedClip）を呼ぶだけ
    this.els.btnCut.addEventListener('click', () => this.cutSelectedClip());
    this.els.btnSplit.addEventListener('click', () => this.splitSelectedClip());
    this.els.btnClipDel.addEventListener('click', () => this.deleteSelectedClip());
    this.updateEditButtons();

    // 右クリックメニューを閉じる仕掛け。クリップ/レーンのハンドラは stopPropagation するので、
    // ここへ届く contextmenu は「メニュー対象外の場所での右クリック」だけ。
    document.addEventListener('pointerdown', e => {
      const m = document.getElementById('ctx-menu');
      if (m && !m.contains(e.target)) this.closeMenu();
    });
    document.addEventListener('keydown', e => {
      if (e.code === 'Escape') this.closeMenu();
    });
    document.addEventListener('contextmenu', () => this.closeMenu());

    this.els.ruler.addEventListener('pointerdown', e => {
      const t = DAW.pxToTime(this.els.scroller.scrollLeft + e.offsetX);
      if (e.shiftKey) {          // Shift+ドラッグでループ区間を引く
        this.startLoopDrag(e, t);
        return;
      }
      DAW.audio.seek(DAW.snapTime(t, e.altKey));
    });

    // ドラッグ&ドロップ読み込み
    this.els.scroller.addEventListener('dragover', e => e.preventDefault());
    this.els.scroller.addEventListener('drop', e => this.onDrop(e));

    // FXパネルの外側クリックで閉じる
    document.addEventListener('pointerdown', e => {
      const panel = document.getElementById('fx-panel');
      if (panel && !panel.contains(e.target) && !e.target.closest('.fx-chip')) panel.remove();
    });

    requestAnimationFrame(() => this.tick());
  },

  // トラックを上下に動かす。色はトラック位置で決まるのでクリップも描き直す。
  moveTrack(trackId, delta) {
    if (!DAW.moveTrack(trackId, delta)) return;
    this.renderTracks();
    DAW.history.commit();
  },

  updateHistoryButtons() {
    if (!this.els.btnUndo) return;
    this.els.btnUndo.disabled = !DAW.history.canUndo();
    this.els.btnRedo.disabled = !DAW.history.canRedo();
  },

  fmtTime(t) {
    t = Math.max(0, t);
    const m = Math.floor(t / 60);
    return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
  },

  // レーン領域は content 内で HEAD_W だけ右にずれている
  laneViewLeft() {
    return this.els.scroller.getBoundingClientRect().left + this.HEAD_W;
  },

  timeAtClientX(clientX) {
    return DAW.pxToTime(this.els.scroller.scrollLeft + clientX - this.laneViewLeft());
  },

  // 画面上の anchorClientX（既定はビュー中央）にある時刻を固定したままズームする
  setZoom(pps, anchorClientX) {
    const sc = this.els.scroller;
    const viewW = sc.clientWidth - this.HEAD_W;
    const ax = anchorClientX == null ? this.laneViewLeft() + viewW / 2 : anchorClientX;
    const anchorT = this.timeAtClientX(ax);
    if (!DAW.setPPS(pps)) return;
    this.renderTracks();
    const offsetInView = ax - this.laneViewLeft();
    sc.scrollLeft = Math.max(0, DAW.timeToPx(anchorT) - offsetInView);
    this.drawRuler();
    this.updateZoomLabel();
  },

  zoomBy(factor, anchorClientX) {
    this.setZoom(DAW.PPS * factor, anchorClientX);
  },

  // プロジェクト全体が1画面に収まる倍率へ
  zoomToFit() {
    const viewW = this.els.scroller.clientWidth - this.HEAD_W;
    const dur = DAW.projectDuration();
    const pps = dur > 0 ? (viewW - 24) / dur : DAW.DEFAULT_PPS;
    DAW.setPPS(pps);
    this.renderTracks();
    this.els.scroller.scrollLeft = 0;
    this.updateZoomLabel();

  },

  // レーン背景に拍/小節の格子を描く。細かすぎる場合は間引く。
  styleGrid(lane) {
    if (!DAW.grid.enabled) {
      lane.style.backgroundImage = '';
      return;
    }
    const stepPx = DAW.timeToPx(DAW.gridStep());
    const barPx = DAW.timeToPx(DAW.barDuration());
    const layers = [`repeating-linear-gradient(90deg, rgba(255,255,255,0.13) 0 1px, transparent 1px ${barPx}px)`];
    if (stepPx >= 6 && stepPx < barPx - 0.5) {
      layers.push(`repeating-linear-gradient(90deg, rgba(255,255,255,0.05) 0 1px, transparent 1px ${stepPx}px)`);
    }
    lane.style.backgroundImage = layers.join(', ');
  },

  applyGrid() {
    for (const lane of document.querySelectorAll('.lane')) this.styleGrid(lane);
  },

  updateZoomLabel() {
    if (!this.els.zoomLabel) return;
    const r = DAW.PPS / DAW.DEFAULT_PPS;
    this.els.zoomLabel.textContent = (r >= 10 ? r.toFixed(0) : r.toFixed(r >= 1 ? 1 : 2)) + '×';
    this.els.zoomLabel.title = `${Math.round(DAW.PPS)} px/秒`;
  },

  timelineWidth() {
    // ズーム倍率によらず、末尾に必ず1画面分の余白を残す（クリップを終端より後ろへ置けるように）
    const viewW = Math.max(200, this.els.scroller.clientWidth - this.HEAD_W);
    return Math.max(DAW.timeToPx(DAW.projectDuration()) + viewW, viewW);
  },

  // ---- rendering ----

  renderTracks() {
    const tracksEl = this.els.tracks;
    tracksEl.innerHTML = '';
    const width = this.timelineWidth();
    if (this.selectedClipId && !DAW.findClip(this.selectedClipId)) this.selectedClipId = null;
    DAW.project.tracks.forEach((track, i) => {
      tracksEl.appendChild(this.buildTrackRow(track, i, width));
    });
    this.updateDropHint();
    this.updateEditButtons();   // 選択が消えていたらボタンも無効に戻す
    this.drawRuler();
  },

  updateDropHint() {
    const hasClips = DAW.project.tracks.some(t => t.clips.length > 0);
    this.els.dropHint.classList.toggle('hidden', hasClips);
  },

  buildTrackRow(track, index, width) {
    const row = document.createElement('div');
    row.className = 'track-row';
    row.appendChild(this.buildTrackHead(track));

    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.dataset.trackId = track.id;
    lane.style.width = width + 'px';
    this.styleGrid(lane);
    lane.addEventListener('pointerdown', e => {
      if (e.target !== lane || e.button !== 0) return;   // 右クリックはメニュー側（シークしない）
      DAW.audio.seek(DAW.snapTime(DAW.pxToTime(e.offsetX), e.altKey));
      this.selectClip(null);
    });
    // レーン空白部の右クリック: 貼り付けメニュー（貼り付け位置は右クリックした時刻）
    lane.addEventListener('contextmenu', e => {
      if (e.target !== lane) return;   // クリップ上はクリップ側のメニューが受ける
      e.preventDefault();
      e.stopPropagation();
      this.openLaneMenu(e, track, DAW.snapTime(DAW.pxToTime(e.offsetX), e.altKey));
    });
    for (const clip of track.clips) {
      lane.appendChild(this.buildClip(clip, track, index));
    }
    row.appendChild(lane);
    return row;
  },

  buildTrackHead(track) {
    const head = document.createElement('div');
    head.className = 'track-head';

    // 名前 + 削除
    const top = document.createElement('div');
    top.className = 'th-top';
    const name = document.createElement('input');
    name.className = 't-name';
    name.value = track.name;
    name.addEventListener('input', () => { track.name = name.value; });
    name.addEventListener('change', () => DAW.history.commit());
    const up = document.createElement('button');
    up.className = 't-move';
    up.textContent = '▲';
    up.title = 'トラックを上へ';
    up.addEventListener('click', () => this.moveTrack(track.id, -1));
    const down = document.createElement('button');
    down.className = 't-move';
    down.textContent = '▼';
    down.title = 'トラックを下へ';
    down.addEventListener('click', () => this.moveTrack(track.id, 1));

    const del = document.createElement('button');
    del.className = 't-del';
    del.textContent = '×';
    del.title = 'トラックを削除';
    del.addEventListener('click', () => {
      DAW.removeTrack(track.id);
      this.renderTracks();
      DAW.audio.reschedule();
      DAW.history.commit();
    });
    top.append(name, up, down, del);

    // 音量・パン
    const vol = this.buildSlider('音量', 0, 1.5, 0.01, track.volume, v => {
      track.volume = v;
      DAW.audio.updateGains();
    });
    const pan = this.buildSlider('パン', -1, 1, 0.01, track.pan, v => {
      track.pan = v;
      DAW.audio.updateGains();
    });

    // ミュート・ソロ
    const btns = document.createElement('div');
    btns.className = 'th-btns';
    const mute = document.createElement('button');
    mute.className = 't-mute' + (track.muted ? ' on' : '');
    mute.textContent = 'M';
    mute.title = 'ミュート';
    mute.addEventListener('click', () => {
      track.muted = !track.muted;
      mute.classList.toggle('on', track.muted);
      DAW.audio.updateGains();
      DAW.history.commit();
    });
    const solo = document.createElement('button');
    solo.className = 't-solo' + (track.solo ? ' on' : '');
    solo.textContent = 'S';
    solo.title = 'ソロ';
    solo.addEventListener('click', () => {
      track.solo = !track.solo;
      solo.classList.toggle('on', track.solo);
      DAW.audio.updateGains();
      DAW.history.commit();
    });
    btns.append(mute, solo);

    head.append(top, vol, pan, btns, this.buildFxRow(track));
    return head;
  },

  buildSlider(label, min, max, step, value, onInput) {
    const wrap = document.createElement('label');
    wrap.className = 'th-slider';
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step; input.value = value;
    input.addEventListener('input', () => onInput(+input.value));
    input.addEventListener('change', () => DAW.history.commit());
    wrap.append(span, input);
    return wrap;
  },

  // ---- FX ----

  buildFxRow(track) {
    const row = document.createElement('div');
    row.className = 'fx-row';

    const sel = document.createElement('select');
    sel.className = 'fx-add';
    sel.title = 'エフェクトを追加';
    const ph = document.createElement('option');
    ph.textContent = '＋FX';
    ph.value = '';
    sel.appendChild(ph);
    for (const def of DAW.plugins.list()) {
      const opt = document.createElement('option');
      opt.value = def.id;
      opt.textContent = def.name;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', async () => {
      const def = DAW.plugins.get(sel.value);
      if (!def) return;
      track.effects.push({ pluginId: def.id, params: DAW.plugins.defaultParams(def) });
      if (DAW.audio.ctx) {
        if (def.prepare) await def.prepare(DAW.audio.ctx);
        DAW.audio.rebuildTrackChain(track);
      }
      this.renderTracks();
      DAW.history.commit();
    });
    row.appendChild(sel);

    track.effects.forEach((fx, i) => {
      const def = DAW.plugins.get(fx.pluginId);
      if (!def) return;
      const chip = document.createElement('span');
      chip.className = 'fx-chip';
      chip.textContent = def.name;
      chip.title = def.name;
      chip.addEventListener('click', () => this.openFxPanel(track, i, chip));
      row.appendChild(chip);
    });
    return row;
  },

  openFxPanel(track, fxIndex, anchor) {
    const old = document.getElementById('fx-panel');
    if (old) old.remove();
    const fx = track.effects[fxIndex];
    const def = DAW.plugins.get(fx.pluginId);
    if (!def) return;

    const panel = document.createElement('div');
    panel.id = 'fx-panel';
    const h = document.createElement('h3');
    h.textContent = def.name;
    panel.appendChild(h);

    for (const p of def.params) {
      const rowEl = document.createElement('div');
      rowEl.className = 'fx-param';
      const label = document.createElement('span');
      label.textContent = p.label;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = p.min; input.max = p.max; input.step = p.step;
      input.value = fx.params[p.key];
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = (+fx.params[p.key]).toFixed(2);
      input.addEventListener('input', () => {
        const v = +input.value;
        val.textContent = v.toFixed(2);
        DAW.audio.setEffectParam(track, fxIndex, p.key, v);
      });
      input.addEventListener('change', () => DAW.history.commit());
      rowEl.append(label, input, val);
      panel.appendChild(rowEl);
    }

    const remove = document.createElement('button');
    remove.className = 'fx-remove';
    remove.textContent = 'このFXを削除';
    remove.addEventListener('click', () => {
      track.effects.splice(fxIndex, 1);
      if (DAW.audio.ctx) DAW.audio.rebuildTrackChain(track);
      panel.remove();
      this.renderTracks();
      DAW.history.commit();
    });
    panel.appendChild(remove);

    document.body.appendChild(panel);
    const r = anchor.getBoundingClientRect();
    const x = Math.min(r.left, window.innerWidth - 260);
    const y = Math.min(r.bottom + 6, window.innerHeight - panel.offsetHeight - 10);
    panel.style.left = Math.max(4, x) + 'px';
    panel.style.top = Math.max(4, y) + 'px';
  },

  // ---- clips ----

  buildClip(clip, track, trackIndex) {
    const el = document.createElement('div');
    el.className = 'clip' + (clip.id === this.selectedClipId ? ' selected' : '');
    el.dataset.id = clip.id;
    el.style.left = DAW.timeToPx(clip.startTime) + 'px';
    el.style.width = Math.max(4, DAW.timeToPx(clip.duration)) + 'px';
    el.style.setProperty('--clip-color', DAW.trackColor(trackIndex));

    const canvas = document.createElement('canvas');
    el.appendChild(canvas);
    this.drawClipWave(canvas, clip, DAW.timeToPx(clip.duration), 104);

    const name = document.createElement('span');
    name.className = 'clip-name';
    name.textContent = clip.name;
    el.appendChild(name);

    const hl = document.createElement('div');
    hl.className = 'h-l';
    const hr = document.createElement('div');
    hr.className = 'h-r';
    el.append(hl, hr);

    // フェードハンドル（クリップ上辺の左右）。ドラッグでフェード長を決める
    const fl = document.createElement('div');
    fl.className = 'f-l';
    fl.title = 'フェードイン';
    const fr = document.createElement('div');
    fr.className = 'f-r';
    fr.title = 'フェードアウト';
    el.append(fl, fr);
    this.positionFadeHandles(el, clip);

    const x = document.createElement('div');
    x.className = 'clip-x';
    x.textContent = '×';
    x.title = 'クリップを削除';
    x.addEventListener('pointerdown', e => e.stopPropagation());
    x.addEventListener('click', e => {
      e.stopPropagation();
      DAW.removeClip(clip.id);
      if (this.selectedClipId === clip.id) this.selectedClipId = null;
      this.renderTracks();
      DAW.audio.reschedule();
      DAW.history.commit();
    });
    el.appendChild(x);

    el._clip = clip;   // 再描画時の逆引き用（findClip の線形探索を避ける）
    el.addEventListener('pointerdown', e => this.startClipDrag(e, el, clip, track));
    el.addEventListener('contextmenu', e => {
      e.preventDefault();      // 既定メニューは出さない
      e.stopPropagation();     // document 側の「他所での右クリックで閉じる」に届かせない
      this.openClipMenu(e, clip);
    });
    return el;
  },

  positionFadeHandles(clipEl, clip) {
    const fl = clipEl.querySelector('.f-l');
    const fr = clipEl.querySelector('.f-r');
    const { fi, fo } = DAW.audio.fadeLengths(clip, false);   // 音と同じクランプ規則を使う
    if (fl) fl.style.left = DAW.timeToPx(fi) + 'px';
    if (fr) fr.style.right = DAW.timeToPx(fo) + 'px';
  },

  // クリップの見た目を作り直さずに更新する（ドラッグ中に呼ぶ）
  refreshClipEl(clipEl, clip) {
    clipEl.style.left = DAW.timeToPx(clip.startTime) + 'px';
    clipEl.style.width = Math.max(4, DAW.timeToPx(clip.duration)) + 'px';
    this.positionFadeHandles(clipEl, clip);
    const canvas = clipEl.querySelector('canvas');
    if (canvas) this.drawClipWave(canvas, clip, DAW.timeToPx(clip.duration), 104);
  },

  // クリップの波形を描く。
  //
  // 画面に見えている範囲だけを実サイズで描く方式にしている。クリップ全体を1枚の canvas に
  // 収めようとすると、高倍率では横幅が数万pxに達して上限で潰れ、波形がぼやける（拡大編集の役に立たない）。
  // 可視部だけなら常に等倍で描けるうえ、長いクリップでも描画量が一定に収まる。
  // 1枚のcanvasに収める上限（クリップ内 px）。これ以下ならクリップ全体を一度に描き、
  // スクロールしても描き直さない。これを超える長大クリップだけ可視範囲＋余白を描く。
  WAVE_FULL_PX: 4000,

  drawClipWave(canvas, clip, cssW, cssH) {
    const sc = this.els.scroller;
    const viewW = Math.max(1, sc.clientWidth - this.HEAD_W);
    const clipLeft = DAW.timeToPx(clip.startTime);
    // 画面外のクリップは描かない（クリップ数が多いプロジェクトでの描画量を抑える）
    if (clipLeft + cssW < sc.scrollLeft || clipLeft > sc.scrollLeft + viewW) {
      canvas.style.display = 'none';
      canvas.width = 0;
      canvas._pps = null;
      return;
    }
    let x0, x1;
    if (cssW <= this.WAVE_FULL_PX) {
      x0 = 0;
      x1 = cssW;
    } else {
      // 可視範囲の左右に半画面ぶんの余白を持たせ、少し動いた程度では描き直さないようにする
      const margin = viewW / 2;
      x0 = Math.max(0, Math.floor(sc.scrollLeft - clipLeft - margin));
      x1 = Math.min(cssW, Math.ceil(sc.scrollLeft + viewW - clipLeft + margin));
    }
    if (x1 <= x0) {           // 画面外のクリップは描かない
      canvas.style.display = 'none';
      canvas.width = 0;
      canvas._pps = null;
      return;
    }
    // 既に「いま見えている範囲」を含めて描いてあるなら描き直さない。
    // 余白ぶん先まで描いてあるので、少し動いた程度では再描画が発生しない。
    if (canvas.width > 0 && canvas._pps === DAW.PPS && canvas._dur === clip.duration
        && canvas._fi === (clip.fadeIn || 0) && canvas._fo === (clip.fadeOut || 0)
        && canvas._off === clip.offset) {
      const needFrom = Math.max(0, sc.scrollLeft - clipLeft);
      const needTo = Math.min(cssW, sc.scrollLeft + viewW - clipLeft);
      if (canvas._x0 <= needFrom && canvas._x1 >= needTo) return;
    }
    canvas.style.display = '';
    canvas.style.left = x0 + 'px';
    canvas.style.width = (x1 - x0) + 'px';

    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.min(Math.round((x1 - x0) * dpr), 8000));
    const h = Math.max(1, Math.round(cssH * dpr));
    canvas.width = w;
    canvas.height = h;
    canvas._pps = DAW.PPS;
    canvas._x0 = x0;
    canvas._x1 = x1;
    canvas._dur = clip.duration;
    canvas._off = clip.offset;
    canvas._fi = clip.fadeIn || 0;
    canvas._fo = clip.fadeOut || 0;
    const g = canvas.getContext('2d');
    const peaks = DAW.peaks.get(clip.bufferId);
    const buf = DAW.buffers.get(clip.bufferId);
    if (!peaks || !buf) return;

    const B = DAW.PEAK_BUCKET;
    const sr = buf.sampleRate;
    const nBuckets = peaks.length / 2;
    const data = buf.getChannelData(0);
    // クリップ内 px → 音声サンプル位置
    const pxToSample = px => (clip.offset + (px / cssW) * clip.duration) * sr;

    g.fillStyle = 'rgba(255,255,255,0.75)';
    for (let x = 0; x < w; x++) {
      const s0 = pxToSample(x0 + (x / w) * (x1 - x0));
      const s1 = pxToSample(x0 + ((x + 1) / w) * (x1 - x0));
      let mn = Infinity, mx = -Infinity;
      if (s1 - s0 < B) {
        // 1px が1バケット未満まで拡大されていれば、実サンプルを直接見る（ピークより正確）
        const i0 = Math.max(0, Math.floor(s0));
        const i1 = Math.min(data.length, Math.max(i0 + 1, Math.ceil(s1)));
        for (let i = i0; i < i1; i++) {
          const v = data[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      } else {
        const b0 = Math.max(0, Math.floor(s0 / B));
        const b1 = Math.min(nBuckets, Math.max(b0 + 1, Math.ceil(s1 / B)));
        for (let b = b0; b < b1; b++) {
          if (peaks[b * 2] < mn) mn = peaks[b * 2];
          if (peaks[b * 2 + 1] > mx) mx = peaks[b * 2 + 1];
        }
      }
      if (mn === Infinity) continue;
      const y0 = (1 - mx) * h / 2;
      const y1 = (1 - mn) * h / 2;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
    this.drawFadeShape(g, clip, w, h, cssW, x0, x1);
  },

  // フェード区間を斜めに暗くして、境界に線を引く。
  // canvas はクリップの可視部（クリップ内 px の x0..x1）だけを覆うので、その座標系に変換する。
  drawFadeShape(g, clip, w, h, cssW, x0, x1) {
    const scale = w / Math.max(1e-6, x1 - x0);           // クリップ内px → canvas px
    const toX = px => (px - x0) * scale;
    const lengths = DAW.audio.fadeLengths(clip, false);  // 音と同じクランプ規則を使う
    const fiPx = lengths.fi / clip.duration * cssW;
    const foPx = lengths.fo / clip.duration * cssW;
    const fi = toX(fiPx);
    const fo = foPx * scale;                            // canvas 上でのフェードアウト幅
    const left = toX(0);
    const right = toX(cssW);
    g.fillStyle = 'rgba(0, 0, 0, 0.45)';
    g.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    g.lineWidth = Math.max(1, Math.round(h / 100));
    if (fiPx > 1) {
      g.beginPath(); g.moveTo(left, 0); g.lineTo(fi, 0); g.lineTo(left, h); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(left, h); g.lineTo(fi, 0); g.stroke();
    }
    if (foPx > 1) {
      g.beginPath(); g.moveTo(right, 0); g.lineTo(right - fo, 0); g.lineTo(right, h); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(right - fo, 0); g.lineTo(right, h); g.stroke();
    }
  },

  // スクロール・ズームで見える範囲が変わったら、可視部の波形を描き直す。
  // スクロール中は毎フレーム呼ばれるので、クリップ数に対して線形に収まるようにする
  // （要素からクリップを引くのに findClip を使うと O(クリップ数^2) になる）。
  refreshVisibleWaves() {
    const sc = this.els.scroller;
    const from = sc.scrollLeft;
    const to = from + (sc.clientWidth - this.HEAD_W);
    for (const el of document.querySelectorAll('.clip')) {
      const clip = el._clip;
      if (!clip) continue;
      const left = DAW.timeToPx(clip.startTime);
      const right = left + DAW.timeToPx(clip.duration);
      const canvas = el.firstElementChild;
      if (right < from || left > to) {
        // 画面外。既に隠してあるなら何もしない
        if (canvas && canvas.width !== 0) { canvas.style.display = 'none'; canvas.width = 0; canvas._pps = null; }
        continue;
      }
      if (canvas) this.drawClipWave(canvas, clip, DAW.timeToPx(clip.duration), 104);
    }
  },

  selectClip(id) {
    this.selectedClipId = id;
    document.querySelectorAll('.clip.selected').forEach(el => el.classList.remove('selected'));
    if (id) {
      const el = document.querySelector(`.clip[data-id="${id}"]`);
      if (el) el.classList.add('selected');
    }
    this.updateEditButtons();
  },

  // ---- クリップ編集操作 ----
  // キーボード（main.js）・右クリックメニュー・ツールバーの三者が全て同じ経路を通る。
  // 状態を変える操作は最後に commit() を1回呼ぶので、どの入口でも undo 粒度は同じ。

  // コピーは状態を変えないので履歴には積まれない
  copySelectedClip() {
    return this.selectedClipId ? DAW.copyClip(this.selectedClipId) : null;
  },

  // カット = コピーしてから削除（undo 1回で丸ごと戻る）
  cutSelectedClip() {
    if (!this.selectedClipId || !DAW.copyClip(this.selectedClipId)) return false;
    return this.deleteSelectedClip();
  },

  deleteSelectedClip() {
    if (!this.selectedClipId || !DAW.findClip(this.selectedClipId)) return false;
    DAW.removeClip(this.selectedClipId);
    this.selectedClipId = null;
    this.renderTracks();
    DAW.audio.reschedule();
    DAW.history.commit();
    return true;
  },

  // 分割は常に再生ヘッド位置（S キー・分割ボタン・右クリックメニューで共通）
  splitSelectedClip() {
    if (!this.selectedClipId || !DAW.splitClip(this.selectedClipId, DAW.audio.getPos())) return false;
    this.renderTracks();
    DAW.audio.reschedule();
    DAW.history.commit();
    return true;
  },

  // 再生ヘッドがこのクリップを分割できる位置にあるか（splitClip と同じ端の判定）
  canSplitAtPlayhead(clip) {
    const pos = DAW.audio.getPos();
    return pos > clip.startTime + DAW.SPLIT_MIN && pos < clip.startTime + clip.duration - DAW.SPLIT_MIN;
  },

  pasteClipAt(time, trackId) {
    const clip = DAW.pasteClip(time, trackId);
    if (!clip) return null;
    this.renderTracks();
    this.selectClip(clip.id);
    DAW.audio.reschedule();
    DAW.history.commit();
    return clip;
  },

  duplicateSelectedClip() {
    const copy = this.selectedClipId && DAW.duplicateClip(this.selectedClipId);
    if (!copy) return null;
    this.renderTracks();
    this.selectClip(copy.id);
    DAW.audio.reschedule();
    DAW.history.commit();
    return copy;
  },

  // ツールバーの編集ボタンはクリップ選択中だけ押せる
  updateEditButtons() {
    if (!this.els.btnCut) return;
    const on = !!(this.selectedClipId && DAW.findClip(this.selectedClipId));
    this.els.btnCut.disabled = !on;
    this.els.btnSplit.disabled = !on;
    this.els.btnClipDel.disabled = !on;
  },

  // ---- 右クリックメニュー ----

  closeMenu() {
    const m = document.getElementById('ctx-menu');
    if (m) m.remove();
  },

  // items: { label, key, disabled, run } の配列。メニューは常に1個だけ（開き直しで前を閉じる）。
  // 閉じる仕掛け（外側クリック / Escape / スクロール / 他所での右クリック）は init で張ってある。
  showMenu(x, y, items) {
    this.closeMenu();
    const menu = document.createElement('div');
    menu.id = 'ctx-menu';
    menu.addEventListener('contextmenu', e => e.preventDefault());   // メニュー上の右クリックは無視
    for (const it of items) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ctx-item';
      row.disabled = !!it.disabled;
      const lab = document.createElement('span');
      lab.textContent = it.label;
      const key = document.createElement('span');
      key.className = 'ctx-key';
      key.textContent = it.key || '';
      row.append(lab, key);
      row.addEventListener('click', () => {
        this.closeMenu();
        it.run();
      });
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    // 画面端では内側に補正する（fx-panel と同じ流儀）
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
    return menu;
  },

  // クリップの右クリック。分割は再生ヘッド位置（S キーと同じ）。ヘッドがクリップ外なら無効表示。
  openClipMenu(e, clip) {
    this.selectClip(clip.id);
    this.showMenu(e.clientX, e.clientY, [
      { label: 'カット', key: 'Ctrl+X', run: () => this.cutSelectedClip() },
      { label: 'コピー', key: 'Ctrl+C', run: () => this.copySelectedClip() },
      { label: '複製', key: 'Ctrl+D', run: () => this.duplicateSelectedClip() },
      { label: '再生ヘッド位置で分割', key: 'S', disabled: !this.canSplitAtPlayhead(clip),
        run: () => this.splitSelectedClip() },
      // ステム分離は1件ずつ（Worker がメモリを大量に使うため）。実行中は無効表示
      { label: 'ステム分離', disabled: !!DAW.stems.running,
        run: () => this.separateClipStems(clip.id) },
      { label: '削除', key: 'Delete', run: () => this.deleteSelectedClip() },
    ]);
  },

  // ---- ステム分離（AI で drums / bass / other / vocals の4トラックに分ける）----

  // 進捗ダイアログ（モーダル）。実行中はこれ以外の操作をブロックする。
  openStemsDialog(title) {
    this.closeStemsDialog();
    const overlay = document.createElement('div');
    overlay.id = 'stems-modal';
    const box = document.createElement('div');
    box.className = 'stems-box';
    const h = document.createElement('h3');
    h.textContent = 'ステム分離';
    const msg = document.createElement('div');
    msg.className = 'stems-msg';
    msg.textContent = `${title}: 準備中…`;
    const bar = document.createElement('div');
    bar.className = 'stems-bar';
    const fill = document.createElement('i');
    bar.appendChild(fill);
    const count = document.createElement('div');
    count.className = 'stems-count';
    count.textContent = '';
    const btn = document.createElement('button');
    btn.className = 'stems-cancel';
    btn.textContent = 'キャンセル';
    btn.addEventListener('click', () => {
      if (DAW.stems.running) {
        btn.disabled = true;   // 二度押し防止。後始末は separate の reject 側で行う
        DAW.stems.cancel();
      } else {
        this.closeStemsDialog();   // エラー表示状態では「閉じる」として働く
      }
    });
    box.append(h, msg, bar, count, btn);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    return { overlay, msg, fill, count, btn, title };
  },

  // バックエンド確定時の表示（Python サイドカーが居れば高速処理の旨を出す）
  setStemsBackend(dlg, backend) {
    if (!dlg) return;
    dlg.backendLabel = backend === 'python' ? 'Python 高速処理' : 'ブラウザ内処理';
    if (document.getElementById('stems-modal')) {
      dlg.msg.textContent = `${dlg.title}: 分離中…（${dlg.backendLabel}）`;
    }
  },

  updateStemsDialog(dlg, p) {
    if (!dlg || !document.getElementById('stems-modal')) return;
    if (p.phase === 'load') {
      dlg.msg.textContent = `${dlg.title}: モデル読み込み中…`;
      dlg.fill.style.width = '0%';
      dlg.count.textContent = `${p.done} / ${p.total} ファイル`;
    } else {
      const pct = p.total > 0 ? Math.round(p.done / p.total * 100) : 0;
      dlg.msg.textContent = `${dlg.title}: 分離中…` + (dlg.backendLabel ? `（${dlg.backendLabel}）` : '');
      dlg.fill.style.width = pct + '%';
      // python サイドカーはセグメント数を持たない（% のみ）ので表記を分ける
      dlg.count.textContent = p.unit === 'percent' ? `${pct}%` : `セグメント ${p.done} / ${p.total}（${pct}%）`;
    }
  },

  // エラーはダイアログ内に表示して「閉じる」で消してもらう（黙って閉じない）
  showStemsError(dlg, err) {
    if (!dlg || !document.getElementById('stems-modal')) return;
    dlg.msg.textContent = (err && err.message) || String(err);
    dlg.msg.classList.add('stems-err');
    dlg.count.textContent = '';
    dlg.btn.textContent = '閉じる';
    dlg.btn.disabled = false;
  },

  closeStemsDialog() {
    const m = document.getElementById('stems-modal');
    if (m) m.remove();
  },

  // クリップを4ステムに分離して、元トラックの直下へ4トラックとして並べる。
  // 元クリップはそのまま残す。実行は一度に1件だけ（DAW.stems.running が防ぐ）。
  async separateClipStems(clipId) {
    if (DAW.stems.running) return false;
    const found = DAW.findClip(clipId);
    if (!found) return false;
    const clip = found.clip;
    const buffer = DAW.buffers.get(clip.bufferId);
    if (!buffer) return false;
    // 実行中にクリップが動かされた場合に備えて必要な値を控えておく
    const snap = { trackId: found.track.id, name: clip.name, startTime: clip.startTime };
    const dlg = this.openStemsDialog(clip.name);
    try {
      const stems = await DAW.stems.separate(buffer, {
        offset: clip.offset,
        duration: clip.duration,
        onBackend: b => this.setStemsBackend(dlg, b),
        onProgress: p => this.updateStemsDialog(dlg, p),
      });
      const cur = DAW.findClip(clipId);   // 分離中の移動・削除に追従（消えていたら控えの値）
      const at = cur || { track: { id: snap.trackId }, clip: snap };
      this.placeStemTracks(at.track.id, at.clip.name != null ? at.clip : snap, stems);
      this.closeStemsDialog();
      return true;
    } catch (err) {
      if (err && err.code === 'cancelled') {
        this.closeStemsDialog();
      } else {
        this.showStemsError(dlg, err);
      }
      return false;
    }
  },

  // 4ステムを新規4トラックとして sourceTrackId の直下に挿し、クリップを同じ startTime に置く。
  // 履歴は最後に commit 1回だけ（undo 1発で4トラックまとめて消える）。
  placeStemTracks(sourceTrackId, clipInfo, stems) {
    let idx = DAW.project.tracks.findIndex(t => t.id === sourceTrackId);
    if (idx < 0) idx = DAW.project.tracks.length - 1;   // 元トラックが消されていたら末尾へ
    const made = [];
    DAW.stems.TRACKS.forEach((key, k) => {
      const buf = stems[key];
      const name = `${clipInfo.name} ${DAW.stems.STEM_LABELS[key]}`;
      const track = {
        id: DAW.uid(), name, volume: 1, pan: 0, muted: false, solo: false,
        effects: [], clips: [],
      };
      track.clips.push({
        id: DAW.uid(),
        bufferId: DAW.registerBuffer(buf),
        startTime: Math.max(0, clipInfo.startTime),
        offset: 0,
        duration: buf.duration,
        name,
      });
      DAW.project.tracks.splice(idx + 1 + k, 0, track);
      made.push(track);
    });
    this.renderTracks();
    DAW.audio.reschedule();
    DAW.history.commit();
    return made;
  },

  // レーン空白部の右クリック。貼り付け先は右クリックしたレーンのトラックと時刻。
  openLaneMenu(e, track, t) {
    this.showMenu(e.clientX, e.clientY, [
      { label: '貼り付け', key: 'Ctrl+V', disabled: !DAW.clipboard,
        run: () => this.pasteClipAt(t, track.id) },
    ]);
  },

  laneAtY(clientY) {
    for (const lane of document.querySelectorAll('.lane')) {
      const r = lane.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return lane;
    }
    return null;
  },

  startClipDrag(e, clipEl, clip, track) {
    if (e.button !== 0) return;
    e.stopPropagation();
    this.selectClip(clip.id);

    const cl = e.target.classList;
    const zone = cl.contains('f-l') ? 'fi'
      : cl.contains('f-r') ? 'fo'
      : cl.contains('h-l') ? 'l'
      : cl.contains('h-r') ? 'r' : 'move';
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = {
      start: clip.startTime, offset: clip.offset, dur: clip.duration,
      fadeIn: clip.fadeIn || 0, fadeOut: clip.fadeOut || 0,
    };
    const buf = DAW.buffers.get(clip.bufferId);
    let moved = false;
    let targetTrackId = track.id;
    let curStart = clip.startTime;
    let highlighted = null;

    const setHighlight = lane => {
      if (highlighted === lane) return;
      if (highlighted) highlighted.classList.remove('drop-target');
      highlighted = lane;
      if (lane) lane.classList.add('drop-target');
    };

    const onMove = ev => {
      if (!moved && Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - startY) < 3) return;
      moved = true;
      const dt = DAW.pxToTime(ev.clientX - startX);
      if (zone === 'fi' || zone === 'fo') {
        // フェードは最大でもクリップ長の半分まで（再生側の上限と揃える）
        const max = clip.duration / 2;
        const v = zone === 'fi' ? orig.fadeIn + dt : orig.fadeOut - dt;
        clip[zone === 'fi' ? 'fadeIn' : 'fadeOut'] = Math.max(0, Math.min(max, v));
        this.refreshClipEl(clipEl, clip);
      } else if (zone === 'move') {
        curStart = Math.max(0, DAW.snapTime(orig.start + dt, ev.altKey));
        clipEl.style.left = DAW.timeToPx(curStart) + 'px';
        const lane = this.laneAtY(ev.clientY);
        if (lane) {
          targetTrackId = lane.dataset.trackId;
          setHighlight(lane.dataset.trackId !== track.id ? lane : null);
        }
      } else if (zone === 'l') {
        const snapped = DAW.snapTime(orig.start + dt, ev.altKey) - orig.start;
        const d = Math.min(orig.dur - 0.05, Math.max(-orig.offset, -orig.start, snapped));
        clip.startTime = orig.start + d;
        clip.offset = orig.offset + d;
        clip.duration = orig.dur - d;
        DAW.clampFades(clip);
        this.refreshClipEl(clipEl, clip);
      } else {
        const maxDur = buf ? buf.duration - orig.offset : orig.dur;
        const end = DAW.snapTime(orig.start + orig.dur + dt, ev.altKey);
        clip.duration = Math.min(maxDur, Math.max(0.05, end - orig.start));
        DAW.clampFades(clip);
        this.refreshClipEl(clipEl, clip);
      }
    };

    const onUp = () => {
      clipEl.removeEventListener('pointermove', onMove);
      clipEl.removeEventListener('pointercancel', onUp);
      setHighlight(null);
      if (!moved) return;
      if (zone === 'move') {
        clip.startTime = curStart;
        if (targetTrackId !== track.id) {
          const dest = DAW.project.tracks.find(t => t.id === targetTrackId);
          if (dest) {
            track.clips.splice(track.clips.indexOf(clip), 1);
            dest.clips.push(clip);
          }
        }
      }
      this.renderTracks();
      DAW.audio.reschedule();
      DAW.history.commit();
    };

    clipEl.setPointerCapture(e.pointerId);
    clipEl.addEventListener('pointermove', onMove);
    clipEl.addEventListener('pointerup', onUp, { once: true });
    clipEl.addEventListener('pointercancel', onUp, { once: true });
  },

  // ---- import ----

  async importFiles(files, track, startTime) {
    DAW.audio.ensureCtx();
    let t = Math.max(0, startTime);
    for (const file of files) {
      try {
        const buf = await DAW.audio.ctx.decodeAudioData(await file.arrayBuffer());
        const bufferId = DAW.registerBuffer(buf);
        track.clips.push({
          id: DAW.uid(),
          bufferId,
          startTime: t,
          offset: 0,
          duration: buf.duration,
          name: file.name.replace(/\.[^.]+$/, ''),
        });
        t += buf.duration;
      } catch (err) {
        alert(`読み込めませんでした: ${file.name}`);
      }
    }
    this.renderTracks();
    DAW.audio.reschedule();
    DAW.history.commit();
  },

  isAudioFile(f) {
    return f.type.startsWith('audio/') || /\.(wav|mp3|ogg|m4a|aac|flac|webm)$/i.test(f.name);
  },

  async onDrop(e) {
    e.preventDefault();
    // ステム分離モデル（htdemucs_embedded.onnx）のドロップ。models/ 未配置環境向けの搬入経路
    const onnx = [...e.dataTransfer.files].find(f => /\.onnx$/i.test(f.name));
    if (onnx) {
      DAW.stems.setModelData(await onnx.arrayBuffer());
      alert(`ステム分離モデルを読み込みました: ${onnx.name}`);
      return;
    }
    const files = [...e.dataTransfer.files].filter(f => this.isAudioFile(f));
    if (!files.length) return;
    const laneEl = e.target.closest('.lane');
    let track, startTime;
    if (laneEl) {
      track = DAW.project.tracks.find(t => t.id === laneEl.dataset.trackId);
      startTime = DAW.pxToTime(e.clientX - laneEl.getBoundingClientRect().left);
    }
    if (!track) {
      track = DAW.addTrack();
      startTime = 0;
    }
    await this.importFiles(files, track, startTime);
  },

  // ---- transport / playhead ----

  // ---- レベルメーター ----

  METER_FLOOR: -60,   // メーター左端の dBFS
  METER_DECAY: 0.94,  // 1フレームあたりの減衰係数
  meterPeak: [0, 0],  // 表示用（立ち上がり即時・減衰はゆっくり）
  clipped: false,

  resetClip() {
    this.clipped = false;
    this.els.meterClip.classList.remove('on');
  },

  meterPct(peak) {
    if (peak <= 0) return 0;
    const db = 20 * Math.log10(peak);
    return Math.max(0, Math.min(100, (1 - db / this.METER_FLOOR) * 100));
  },

  updateMeter() {
    const lv = DAW.audio.getLevels();
    // ピークメーターの標準的な挙動: 立ち上がり即時・戻りは緩やか（約 -32dB/秒）
    for (let i = 0; i < 2; i++) this.meterPeak[i] = Math.max(lv[i], this.meterPeak[i] * this.METER_DECAY);
    this.els.meterL.style.width = this.meterPct(this.meterPeak[0]) + '%';
    this.els.meterR.style.width = this.meterPct(this.meterPeak[1]) + '%';
    const p = Math.max(this.meterPeak[0], this.meterPeak[1]);
    this.els.meterDb.textContent = p > 0 ? (20 * Math.log10(p)).toFixed(1) : '-∞';
    if (lv[0] >= 1 || lv[1] >= 1) {
      this.clipped = true;
      this.els.meterClip.classList.add('on');
    }
  },

  // ループ再生の切り替え。区間が未設定ならプロジェクト全体をループ区間にする。
  toggleLoop() {
    DAW.loop.enabled = !DAW.loop.enabled;
    if (DAW.loop.enabled && DAW.loop.end - DAW.loop.start <= 0.05) {
      DAW.setLoop(0, DAW.projectDuration());
    }
    this.els.btnLoop.classList.toggle('on', DAW.loop.enabled);
    this.updateExportLabel();
    this.drawRuler();
    DAW.audio.reschedule();
  },

  // ループ有効時は書き出し対象が区間だけになるので、ボタンにそれを出す（黙って変わらないように）
  updateExportLabel() {
    if (this.els.btnExport) {
      this.els.btnExport.textContent = DAW.activeLoop() ? 'WAV書き出し（ループ区間）' : 'WAV書き出し';
    }
  },

  // ルーラーの Shift+ドラッグでループ区間を決める
  startLoopDrag(e, from) {
    const ruler = this.els.ruler;
    const at = ev => DAW.pxToTime(this.els.scroller.scrollLeft + ev.offsetX);
    const move = ev => {
      DAW.setLoop(DAW.snapTime(from, ev.altKey), DAW.snapTime(at(ev), ev.altKey));
      this.drawRuler();
    };
    const up = () => {
      ruler.removeEventListener('pointermove', move);
      if (DAW.loop.end - DAW.loop.start > 0.05) {
        DAW.loop.enabled = true;
        this.els.btnLoop.classList.add('on');
        this.updateExportLabel();
        DAW.audio.reschedule();
      }
      this.drawRuler();
    };
    ruler.setPointerCapture(e.pointerId);
    ruler.addEventListener('pointermove', move);
    ruler.addEventListener('pointerup', up, { once: true });
    ruler.addEventListener('pointercancel', up, { once: true });
  },

  // メトロノームの切り替え。再生中なら即座に反映されるよう組み直す。
  toggleMetronome() {
    DAW.metronome.enabled = !DAW.metronome.enabled;
    this.els.btnMetro.classList.toggle('on', DAW.metronome.enabled);
    DAW.audio.reschedule();
  },

  // 録音の開始/停止。停止時に録れたトラックへスクロールして選択状態にする。
  async toggleRecord() {
    if (DAW.record.active) {
      const track = await DAW.record.stop();
      this.els.btnRecord.classList.remove('on');
      DAW.audio.pause();
      this.renderTracks();
      this.updatePlayButton();
      if (track) {
        const clip = track.clips[0];
        this.selectClip(clip.id);
        DAW.history.commit();
      } else {
        alert('録音データがありませんでした');
      }
      return;
    }
    this.els.btnRecord.classList.add('on');
    const started = await DAW.record.start();
    if (!started) {
      this.els.btnRecord.classList.remove('on');
      return;
    }
    this.updatePlayButton();
  },

  updatePlayButton() {
    this.els.btnPlay.textContent = DAW.audio.playing ? '⏸' : '▶';
  },

  tick() {
    this.updateMeter();
    const pos = DAW.audio.getPos();
    // 表示はリミッターの先読みぶん戻した位置にする（聞こえている音と画面を合わせる）
    const shown = DAW.audio.displayPos();
    this.els.playhead.style.transform = `translateX(${this.HEAD_W + DAW.timeToPx(shown)}px)`;
    this.els.time.textContent = this.fmtTime(shown);
    if (DAW.audio.playing) {
      const dur = DAW.projectDuration();
      if (dur > 0 && pos >= dur) {
        DAW.audio.pause();
        this.updatePlayButton();
      }
      // 再生ヘッドが右端を越えたら追従スクロール
      const sc = this.els.scroller;
      const viewX = this.HEAD_W + DAW.timeToPx(pos) - sc.scrollLeft;
      if (viewX > sc.clientWidth - 40) {
        sc.scrollLeft = DAW.timeToPx(pos) - (sc.clientWidth - this.HEAD_W) * 0.15;
      }
    }
    requestAnimationFrame(() => this.tick());
  },

  drawRuler() {
    const sc = this.els.scroller;
    const c = this.els.ruler;
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(1, sc.clientWidth - this.HEAD_W);
    const cssH = 27;
    this.els.rulerRow.style.width = sc.clientWidth + 'px';
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    c.style.width = cssW + 'px';
    c.style.height = cssH + 'px';
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, cssW, cssH);
    const sl = sc.scrollLeft;

    // ループ区間を帯で示す（無効時は灰色で「設定はあるが効いていない」ことを示す）
    if (DAW.loop.end - DAW.loop.start > 0) {
      const lx = DAW.timeToPx(DAW.loop.start) - sl;
      const lw = DAW.timeToPx(DAW.loop.end - DAW.loop.start);
      g.fillStyle = DAW.loop.enabled ? 'rgba(79, 140, 255, 0.28)' : 'rgba(139, 139, 153, 0.16)';
      g.fillRect(lx, 0, lw, cssH);
      g.fillStyle = DAW.loop.enabled ? '#4f8cff' : '#8b8b99';
      g.fillRect(lx, 0, 2, cssH);
      g.fillRect(lx + lw - 2, 0, 2, cssH);
    }

    g.fillStyle = '#8b8b99';
    g.font = '10px Consolas, monospace';
    g.textBaseline = 'top';

    // ズーム倍率に応じてラベル間隔（最低64px）と補助目盛り（最低7px）を選ぶ
    const major = this.RULER_STEPS.find(s2 => DAW.timeToPx(s2) >= 64) || this.RULER_STEPS[this.RULER_STEPS.length - 1];
    const minor = this.RULER_STEPS.find(s2 => s2 <= major / 2 && DAW.timeToPx(s2) >= 7 && (major / s2) % 1 === 0);

    const tEnd = DAW.pxToTime(sl + cssW);
    if (minor) {
      for (let i = Math.max(0, Math.floor(DAW.pxToTime(sl) / minor)); i * minor <= tEnd; i++) {
        const t = i * minor;
        if (Math.abs(t / major - Math.round(t / major)) < 1e-9) continue;
        g.fillRect(Math.round(DAW.timeToPx(t) - sl), 20, 1, 7);
      }
    }
    for (let i = Math.max(0, Math.floor(DAW.pxToTime(sl) / major)); i * major <= tEnd; i++) {
      const t = i * major;
      const x = Math.round(DAW.timeToPx(t) - sl);
      g.fillRect(x, 12, 1, 15);
      g.fillText(this.fmtRuler(t, major), x + 3, 2);
    }
  },

  // ラベル間隔の候補（秒）。1分未満は 60 を割り切れる値だけを使う
  RULER_STEPS: [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800],

  fmtRuler(t, step) {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    const dec = step >= 1 ? 0 : (step >= 0.1 ? 1 : 2);
    return `${m}:${s.toFixed(dec).padStart(dec ? 3 + dec : 2, '0')}`;
  },
};
