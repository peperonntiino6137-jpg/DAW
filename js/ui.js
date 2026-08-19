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
    };

    this.els.scroller.addEventListener('scroll', () => this.drawRuler());
    window.addEventListener('resize', () => this.renderTracks());

    this.els.ruler.addEventListener('pointerdown', e => {
      const t = DAW.pxToTime(this.els.scroller.scrollLeft + e.offsetX);
      DAW.audio.seek(t);
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

  fmtTime(t) {
    t = Math.max(0, t);
    const m = Math.floor(t / 60);
    return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
  },

  timelineWidth() {
    return Math.max(
      DAW.timeToPx(DAW.projectDuration() + 30),
      this.els.scroller.clientWidth - this.HEAD_W
    );
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
    lane.addEventListener('pointerdown', e => {
      if (e.target !== lane) return;
      DAW.audio.seek(DAW.pxToTime(e.offsetX));
      this.selectClip(null);
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
    const del = document.createElement('button');
    del.className = 't-del';
    del.textContent = '×';
    del.title = 'トラックを削除';
    del.addEventListener('click', () => {
      DAW.removeTrack(track.id);
      this.renderTracks();
      DAW.audio.reschedule();
    });
    top.append(name, del);

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
    });
    const solo = document.createElement('button');
    solo.className = 't-solo' + (track.solo ? ' on' : '');
    solo.textContent = 'S';
    solo.title = 'ソロ';
    solo.addEventListener('click', () => {
      track.solo = !track.solo;
      solo.classList.toggle('on', track.solo);
      DAW.audio.updateGains();
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
    });
    el.appendChild(x);

    el.addEventListener('pointerdown', e => this.startClipDrag(e, el, clip, track));
    return el;
  },

  drawClipWave(canvas, clip, cssW, cssH) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.min(Math.round(cssW * dpr), 8000));
    const h = Math.max(1, Math.round(cssH * dpr));
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    const peaks = DAW.peaks.get(clip.bufferId);
    const buf = DAW.buffers.get(clip.bufferId);
    if (!peaks || !buf) return;
    const B = DAW.PEAK_BUCKET;
    const sr = buf.sampleRate;
    const startS = clip.offset * sr;
    const spanS = clip.duration * sr;
    g.fillStyle = 'rgba(255,255,255,0.75)';
    const nBuckets = peaks.length / 2;
    for (let x = 0; x < w; x++) {
      const b0 = Math.floor((startS + spanS * x / w) / B);
      const b1 = Math.max(b0 + 1, Math.ceil((startS + spanS * (x + 1) / w) / B));
      let mn = Infinity, mx = -Infinity;
      for (let b = Math.max(0, b0); b < b1 && b < nBuckets; b++) {
        if (peaks[b * 2] < mn) mn = peaks[b * 2];
        if (peaks[b * 2 + 1] > mx) mx = peaks[b * 2 + 1];
      }
      if (mn === Infinity) continue;
      const y0 = (1 - mx) * h / 2;
      const y1 = (1 - mn) * h / 2;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  },

  selectClip(id) {
    this.selectedClipId = id;
    document.querySelectorAll('.clip.selected').forEach(el => el.classList.remove('selected'));
    if (id) {
      const el = document.querySelector(`.clip[data-id="${id}"]`);
      if (el) el.classList.add('selected');
    }
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

    const zone = e.target.classList.contains('h-l') ? 'l'
      : e.target.classList.contains('h-r') ? 'r' : 'move';
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = { start: clip.startTime, offset: clip.offset, dur: clip.duration };
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
      if (zone === 'move') {
        curStart = Math.max(0, orig.start + dt);
        clipEl.style.left = DAW.timeToPx(curStart) + 'px';
        const lane = this.laneAtY(ev.clientY);
        if (lane) {
          targetTrackId = lane.dataset.trackId;
          setHighlight(lane.dataset.trackId !== track.id ? lane : null);
        }
      } else if (zone === 'l') {
        const d = Math.min(orig.dur - 0.05, Math.max(-orig.offset, -orig.start, dt));
        clip.startTime = orig.start + d;
        clip.offset = orig.offset + d;
        clip.duration = orig.dur - d;
        clipEl.style.left = DAW.timeToPx(clip.startTime) + 'px';
        clipEl.style.width = Math.max(4, DAW.timeToPx(clip.duration)) + 'px';
      } else {
        const maxDur = buf ? buf.duration - orig.offset : orig.dur;
        clip.duration = Math.min(maxDur, Math.max(0.05, orig.dur + dt));
        clipEl.style.width = Math.max(4, DAW.timeToPx(clip.duration)) + 'px';
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
  },

  isAudioFile(f) {
    return f.type.startsWith('audio/') || /\.(wav|mp3|ogg|m4a|aac|flac|webm)$/i.test(f.name);
  },

  async onDrop(e) {
    e.preventDefault();
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

  updatePlayButton() {
    this.els.btnPlay.textContent = DAW.audio.playing ? '⏸' : '▶';
  },

  tick() {
    const pos = DAW.audio.getPos();
    this.els.playhead.style.transform = `translateX(${this.HEAD_W + DAW.timeToPx(pos)}px)`;
    this.els.time.textContent = this.fmtTime(pos);
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
    const t0 = Math.floor(sl / DAW.PPS);
    const t1 = Math.ceil((sl + cssW) / DAW.PPS);
    g.fillStyle = '#8b8b99';
    g.font = '10px Consolas, monospace';
    g.textBaseline = 'top';
    for (let t = Math.max(0, t0); t <= t1; t++) {
      const x = t * DAW.PPS - sl;
      const major = t % 5 === 0;
      g.fillRect(x, major ? 12 : 20, 1, major ? 15 : 7);
      if (major) {
        const m = Math.floor(t / 60);
        const s = t % 60;
        g.fillText(`${m}:${String(s).padStart(2, '0')}`, x + 3, 2);
      }
    }
  },
};
