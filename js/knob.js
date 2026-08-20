'use strict';

// 共通ノブコンポーネント。
// js/objui.js のリミッターノブ（canvas・縦ドラッグ・ダブルクリックで既定値・pointer capture）を
// 汎用化して切り出したもの。リミッターと FX ラックの両方がこれに乗る。
//
// 使い方:
//   const el = DAW.knob.create({
//     label: 'MIX',                       // ラベル（下段表示とヒントバー）
//     unit: 'dB', digits: 1,              // format 省略時の表示組み立て
//     get: () => v,                       // 現在値
//     set: v => {},                       // 値の反映（音だけ。履歴には積まない）
//     commit: () => {},                   // 確定（pointerup / 入力確定 / ホイールで1回）
//     range: { min, max, step, curve },   // step 省略時は連続値。curve: 'lin' | 'log'
//     def: 0,                             // ダブルクリックで戻る既定値
//     format: v => '文字列',               // 表示文字列（ヒントバーと同一の文字列を使うこと）
//     menuItems: () => [...],             // 右クリックメニューへの追加項目（ui.showMenu の形式）
//     active: () => true,                 // false なら灰色で描く（リミッターのバイパス表示用）
//     size: 48,                           // canvas の CSS サイズ(px)
//   });
//   el.update() で get() から表示を描き直す（外部変更への追従用）。
//
// 挙動（undo 粒度は既存の input/change 分離と同じ: ドラッグ中 set / pointerup で commit 1回）:
//   縦ドラッグで変更 / Ctrl か Shift で微調整（0.2倍） / ホイールで1ステップ（Ctrl で微step）
//   ダブルクリックで既定値 / 右クリックで「値を入力…」等のメニュー
DAW.knob = {
  KNOB_PX: 170,   // フルレンジぶん動かすのに必要なドラッグ量(px)。objui.KNOB_PX と同じ値
  FINE: 0.2,      // Ctrl / Shift 微調整の倍率
  drag: null,     // ドラッグ中の状態 { k, y0, n0 }（同時に1つ）
  _inited: false,

  // move/up は window で受ける（canvas の外へ出ても追従。objui のノブと同じ流儀）
  _init() {
    if (this._inited) return;
    this._inited = true;
    window.addEventListener('pointermove', e => this._onMove(e));
    window.addEventListener('pointerup', () => this._onUp());
    window.addEventListener('pointercancel', () => this._onUp());
  },

  // ---- 値 ⇔ 0..1 の変換（wrapper.norm/denorm と同じ規則） ----

  _norm(k, v) {
    const r = k.range;
    const c = Math.max(r.min, Math.min(r.max, +v));
    if (r.curve === 'log' && r.min > 0) return Math.log(c / r.min) / Math.log(r.max / r.min);
    return (c - r.min) / (r.max - r.min);
  },

  _denorm(k, t) {
    const r = k.range;
    t = Math.max(0, Math.min(1, +t));
    let v = (r.curve === 'log' && r.min > 0)
      ? r.min * Math.pow(r.max / r.min, t)
      : r.min + (r.max - r.min) * t;
    if (r.step > 0) v = Math.round(v / r.step) * r.step;   // step があればグリッドへ量子化
    return Math.max(r.min, Math.min(r.max, v));
  },

  _clamp(k, v) {
    return Math.max(k.range.min, Math.min(k.range.max, +v));
  },

  _format(k, v) {
    if (k.format) return k.format(v);
    const digits = k.digits != null ? k.digits : 2;
    return (+v).toFixed(digits) + (k.unit || '');
  },

  // ヒントバーへ「ラベル: 現在値」を出す（hover / ドラッグ中）
  _hint(k) {
    if (DAW.ui && DAW.ui.setHint) DAW.ui.setHint(`${k.label}: ${this._format(k, k.get())}`);
  },

  _clearHint() {
    if (DAW.ui && DAW.ui.clearHint) DAW.ui.clearHint();
  },

  create(opts) {
    this._init();
    const k = Object.assign({ size: 48, label: '', menuItems: null, active: null }, opts);
    const el = document.createElement('div');
    el.className = 'knob';
    const dpr = window.devicePixelRatio || 1;
    const cv = document.createElement('canvas');
    cv.width = Math.round(k.size * dpr);
    cv.height = Math.round(k.size * dpr);
    cv.style.width = k.size + 'px';
    cv.style.height = k.size + 'px';
    const val = document.createElement('div');
    val.className = 'ok-val';
    const lab = document.createElement('div');
    lab.className = 'ok-lab';
    lab.textContent = k.label;
    el.append(cv, val, lab);
    k.el = el;
    k.canvas = cv;
    k.valEl = val;
    el._knob = k;
    el.update = () => this._draw(k);

    el.addEventListener('pointerdown', e => this._onDown(e, k));
    el.addEventListener('dblclick', () => {
      if (k.def === undefined) return;
      k.set(this._clamp(k, k.def));
      this._draw(k);
      k.commit();
      this._hint(k);
    });
    // ホイール1ステップ（Ctrl で微ステップ）。1操作 = commit 1回（undo 1エントリ）
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const step = k.range.step > 0 ? k.range.step : (k.range.max - k.range.min) / 100;
      const d = e.ctrlKey || e.metaKey ? step * this.FINE : step;
      k.set(this._clamp(k, k.get() + dir * d));
      this._draw(k);
      k.commit();
      this._hint(k);
    }, { passive: false });
    // hover 中はヒントバーへ「パラメータ名: 現在値」
    el.addEventListener('pointerenter', () => this._hint(k));
    el.addEventListener('pointerleave', () => { if (!this.drag || this.drag.k !== k) this._clearHint(); });
    // 右クリックメニュー（既存の ui.showMenu を流用）
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      this._openMenu(e, k);
    });

    this._draw(k);
    return el;
  },

  _onDown(e, k) {
    if (e.button !== 0) return;
    e.preventDefault();
    this.drag = { k, y0: e.clientY, n0: this._norm(k, k.get()) };
    k.el.classList.add('dragging');
    try { k.el.setPointerCapture(e.pointerId); } catch (err) { /* 合成イベントでは失敗する */ }
  },

  _onMove(e) {
    const d = this.drag;
    if (!d) return;
    const k = d.k;
    const fine = e.ctrlKey || e.metaKey || e.shiftKey ? this.FINE : 1;   // Ctrl 微調整（Shift も互換）
    // 上へドラッグ = 増加。正規化空間で動かすので log カーブも自然な効きになる
    const n = d.n0 + (d.y0 - e.clientY) / this.KNOB_PX * fine;
    k.set(this._denorm(k, n));
    this._draw(k);
    this._hint(k);
  },

  _onUp() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    d.k.el.classList.remove('dragging');
    d.k.commit();   // ドラッグ全体で undo 1エントリ
  },

  // 右クリックメニュー。「オートメーション化」「リンク…」はフェーズ2/3 の予告（disabled）
  _openMenu(e, k) {
    if (!DAW.ui || !DAW.ui.showMenu) return;
    const items = [
      { label: '値を入力…', run: () => this._openInput(k) },
      { label: 'デフォルトに戻す', disabled: k.def === undefined, run: () => {
        k.set(this._clamp(k, k.def));
        this._draw(k);
        k.commit();
      } },
      { label: 'オートメーション化', disabled: true, run: () => {} },
      { label: 'リンク…', disabled: true, run: () => {} },
    ];
    if (k.menuItems) items.push(...k.menuItems());
    DAW.ui.showMenu(e.clientX, e.clientY, items);
  },

  // インラインの値入力。body 直下に重ねて出す（ノブ内に <input> を残さない）
  _openInput(k) {
    const old = document.getElementById('knob-input');
    if (old) old.remove();
    const input = document.createElement('input');
    input.id = 'knob-input';
    input.type = 'text';
    input.value = String(k.get());
    const r = k.el.getBoundingClientRect();
    input.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 84)) + 'px';
    input.style.top = Math.max(4, r.top + r.height / 2 - 11) + 'px';
    let closed = false;   // blur と Enter/Escape の再入ガード（focusout で二重確定しない）
    const close = commit => {
      if (closed) return;
      closed = true;
      if (commit) {
        const v = parseFloat(input.value);
        if (isFinite(v)) {
          k.set(this._clamp(k, v));
          this._draw(k);
          k.commit();
        }
      }
      input.remove();
    };
    input.addEventListener('keydown', ev => {
      ev.stopPropagation();   // DAW 全体のショートカット（Space 再生など）に取られない
      if (ev.code === 'Enter' || ev.code === 'NumpadEnter') close(true);
      else if (ev.code === 'Escape') close(false);
    });
    input.addEventListener('blur', () => close(true));
    document.body.appendChild(input);
    input.focus();
    input.select();
  },

  // 円弧＋針の描画（objui.drawKnob と同じ見た目）
  _draw(k) {
    const v = k.get();
    const t = this._norm(k, v);
    const cv = k.canvas;
    const dpr = window.devicePixelRatio || 1;
    const want = Math.round(k.size * dpr);
    if (cv.width !== want) { cv.width = want; cv.height = want; }
    const g2 = cv.getContext('2d');
    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    g2.clearRect(0, 0, k.size, k.size);
    // 幾何はサイズ比で決める（48px でリミッターノブと同じ見た目、26px の MIX ノブも破綻しない）
    const c = k.size / 2;
    const R = c * 0.7;
    const A0 = Math.PI * 0.75;   // 左下から
    const A1 = Math.PI * 2.25;   // 右下まで（270°）
    const a = A0 + (A1 - A0) * Math.max(0, Math.min(1, t));
    const on = k.active ? !!k.active() : true;
    const arcW = Math.max(2, Math.round(k.size / 12));

    g2.lineWidth = arcW;
    g2.lineCap = 'round';
    g2.strokeStyle = '#2a2a34';
    g2.beginPath();
    g2.arc(c, c, R, A0, A1);
    g2.stroke();
    g2.strokeStyle = on ? '#4f8cff' : '#5a5a66';
    g2.beginPath();
    g2.arc(c, c, R, A0, a);
    g2.stroke();

    g2.fillStyle = '#191922';
    g2.beginPath();
    g2.arc(c, c, R * 0.76, 0, Math.PI * 2);
    g2.fill();
    g2.strokeStyle = on ? '#8fb6ff' : '#7a7a88';
    g2.lineWidth = Math.max(1.5, arcW / 2);
    g2.beginPath();
    g2.moveTo(c + Math.cos(a) * R * 0.42, c + Math.sin(a) * R * 0.42);
    g2.lineTo(c + Math.cos(a) * R * 0.83, c + Math.sin(a) * R * 0.83);
    g2.stroke();

    k.valEl.textContent = this._format(k, v);
  },
};
