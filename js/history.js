'use strict';

// Undo / Redo。
//
// プロジェクト状態（masterVolume + tracks）を JSON スナップショットで積む方式。
// 音声バッファ本体はコピーせず id 参照だけを持つので、履歴を深くしてもメモリは増えない。
// ただし「クリップを消す → 元に戻す」を成立させるには、履歴が参照しているバッファを
// 解放してはいけない。そのため DAW.collectBuffers() は referencedBuffers() も見て判断する。
//
// 使い方: 状態を変える操作の *あと* に DAW.history.commit() を呼ぶだけ。
// 変化が無ければ何も積まれないので、呼びすぎても害はない。
DAW.history = {
  LIMIT: 100,   // 保持する履歴の段数
  past: [],
  future: [],
  cur: null,

  snapshot() {
    const bufs = new Set();
    for (const track of DAW.project.tracks)
      for (const clip of track.clips)
        bufs.add(clip.bufferId);
    return {
      json: JSON.stringify({
        masterVolume: DAW.project.masterVolume,
        bpm: DAW.project.bpm,
        tracks: DAW.project.tracks,
        objects: DAW.objects.toJSON(),
        // マスターセクション（RENDERER のノブ）。プロジェクト保存の対象なので履歴にも入れる。
        // 出力形式やメトロノーム/グリッドは表示・再生側の設定なので入れない（ループと同じ扱い）。
        limiter: DAW.limiter.toJSON(),
        roomReverb: Object.assign({}, DAW.objaudio.revParams),
      }),
      bufs,
    };
  },

  // 現在の状態を起点として履歴を作り直す（起動時・プロジェクト読み込み時）
  reset() {
    this.past = [];
    this.future = [];
    this.cur = this.snapshot();
    this.changed();
  },

  commit() {
    const s = this.snapshot();
    if (this.cur && s.json === this.cur.json) return false;  // 実質変化なし
    if (this.cur) this.past.push(this.cur);
    if (this.past.length > this.LIMIT) this.past.shift();
    this.cur = s;
    this.future = [];
    this.changed();
    return true;
  },

  canUndo() { return this.past.length > 0; },
  canRedo() { return this.future.length > 0; },

  async undo() {
    if (!this.canUndo()) return false;
    this.future.push(this.cur);
    this.cur = this.past.pop();
    await this.apply(this.cur);
    return true;
  },

  async redo() {
    if (!this.canRedo()) return false;
    this.past.push(this.cur);
    this.cur = this.future.pop();
    await this.apply(this.cur);
    return true;
  },

  // スナップショットを現在の状態として復元する。
  // トラック構成が変わるので音声ノードは作り直し、再生中ならその位置から組み直す。
  async apply(snap) {
    const data = JSON.parse(snap.json);
    DAW.project.masterVolume = data.masterVolume;
    DAW.project.bpm = data.bpm != null ? data.bpm : 120;
    DAW.project.tracks = data.tracks;
    DAW.objects.load(data.objects);
    DAW.limiter.load(data.limiter);               // 欠落は既定値（load が補完する）
    DAW.objaudio.loadRevParams(data.roomReverb);  // 同上（level=0 = 従来の音）
    DAW.audio.resetNodes();
    if (DAW.audio.ctx) {
      DAW.audio.setMasterVolume(data.masterVolume);
      await DAW.plugins.prepareAll(DAW.audio.ctx, DAW.project.tracks);
    }
    DAW.collectBuffers();
    if (DAW.ui.els.masterVol) DAW.ui.els.masterVol.value = data.masterVolume;
    if (DAW.ui.els.bpm) DAW.ui.els.bpm.value = DAW.project.bpm;
    if (DAW.ui.selectedClipId && !DAW.findClip(DAW.ui.selectedClipId)) DAW.ui.selectedClipId = null;
    DAW.ui.renderTracks();
    DAW.audio.reschedule();
    this.changed();
  },

  // 履歴（過去・現在・未来）から参照されている音声バッファID
  referencedBuffers() {
    const set = new Set();
    const add = s => { if (s) for (const id of s.bufs) set.add(id); };
    add(this.cur);
    this.past.forEach(add);
    this.future.forEach(add);
    return set;
  },

  changed() {
    if (DAW.ui && DAW.ui.updateHistoryButtons) DAW.ui.updateHistoryButtons();
  },
};
