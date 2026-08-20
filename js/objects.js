'use strict';

// オブジェクトベース音響のデータモデル。
//
// 座標規約は ADM (ITU-R BS.2076) 準拠:
//   azimuth   0° = 正面、正 = 左回り（反時計回り）、範囲 -180〜180
//   elevation 正 = 上、範囲 -90〜90
//   distance  0〜1
// この規約のまま保持・保存する。直交座標への変換はレンダラー層だけで行う
// （将来 ADM で書き出すときに変換が要らないようにするため）。
//
// 極座標の正規化: elevation が 90 を超えたら「頭の裏側へ回り込んだ」と解釈し、
//   el' = 180 - el, az' = az + 180 に折り返す（-90 未満も同様）。
//
// width は -200〜+200%。今はデータモデルとして保持するだけで DSP は点音源。
// 後段で MDAP / 2ソース化する際に負値（L/R 反転）も含めて実装する。
DAW.objects = {
  MAX: 128,
  list: [],            // オブジェクトの配列（単一の state。全ビューがこれを参照する）
  selectedId: null,    // 選択中のオブジェクトID
  onChange: null,      // 変更通知（レンダラーが購読して音へ反映する）

  // 識別色。トラック色とは別に持つ（オブジェクトはトラックと1対1とは限らないため）
  COLORS: [
    '#4f8cff', '#3fbf7f', '#e0a63f', '#d96a6a', '#9b6fd9', '#3fbfbf', '#d96ab8', '#8fbf3f',
    '#5fa8d3', '#7fcf9f', '#e8c34a', '#e08a6a', '#b48ae0', '#5fd0d0', '#e88ac8', '#a8cf5f',
  ],

  LIMITS: {
    az: [-180, 180],
    el: [-90, 90],
    dist: [0, 1],
    width: [-200, 200],
    gainDb: [-72, 6],
    revSend: [0, 1],   // ルームリバーブへのセンド量（実効量は距離と連動。式は objaudio）
  },

  // ---- 経路（位置オートメーション） ----
  // obj.path = { enabled, loop, points: [{ t, az, el, dist, ease }] }
  //   t    … プロジェクト絶対時間（秒）。昇順を維持し、同時刻は PATH_MIN_DT を強制する
  //   ease … 「その点から次の点へ向かう」セグメントの緩急
  //   loop … 最後の点の後、最初の点へ戻って繰り返す（既定 false = 最後の点でホールド）
  PATH_MIN_DT: 0.05,                          // waypoint 同士の最小間隔（秒）
  EASES: ['linear', 'in', 'out', 'inout'],    // 等速 / 加速 / 減速 / S字

  clamp(key, v) {
    const r = this.LIMITS[key];
    const n = +v;
    if (!isFinite(n)) return this.defaults()[key];
    return Math.max(r[0], Math.min(r[1], n));
  },

  defaults() {
    return { az: 0, el: 0, dist: 1, width: 0, gainDb: 0, revSend: 0.25, mute: false, solo: false, lock: 'none' };
  },

  // 極座標の正規化。az は (-180, 180] に畳み、|el| > 90 は裏側へ折り返す。
  // 例: (az=0, el=140) -> (az=180, el=40)
  normalize(az, el) {
    let a = +az || 0;
    let e = +el || 0;
    // el を [-180, 180] に畳んでから折り返す
    e = ((e % 360) + 360) % 360;          // [0, 360)
    if (e > 180) e -= 360;                // (-180, 180]
    if (e > 90) { e = 180 - e; a += 180; }
    else if (e < -90) { e = -180 - e; a += 180; }
    a = ((a % 360) + 360) % 360;          // [0, 360)
    if (a > 180) a -= 360;                // (-180, 180]
    return { az: a, el: e };
  },

  count() { return this.list.length; },
  isFull() { return this.list.length >= this.MAX; },
  get(id) { return this.list.find(o => o.id === id) || null; },
  indexOf(id) { return this.list.findIndex(o => o.id === id); },

  // 新規オブジェクト。128 個を超えたら null。
  // trackId は「どのトラックの音を鳴らすか」の対応付け（仕様外の追加フィールド。
  // 音を出すために必要なので持たせている。未割り当ては null）。
  create(name, trackId) {
    if (this.isFull()) return null;
    const obj = Object.assign({
      id: DAW.uid(),
      name: name || `オブジェクト ${this.list.length + 1}`,
      color: this.COLORS[this.list.length % this.COLORS.length],
      trackId: trackId || null,
      path: { enabled: false, loop: false, points: [] },   // 経路（位置オートメーション）
    }, this.defaults());
    this.list.push(obj);
    return obj;
  },

  remove(id) {
    const i = this.indexOf(id);
    if (i < 0) return false;
    this.list.splice(i, 1);
    if (this.selectedId === id) this.selectedId = this.list.length ? this.list[Math.min(i, this.list.length - 1)].id : null;
    return true;
  },

  select(id) {
    this.selectedId = this.get(id) ? id : null;
    return this.selectedId;
  },

  selected() { return this.get(this.selectedId); },

  // lock の意味: 'none' = 自由、'pos' = 位置だけ固定、'all' = すべて固定
  canEditPosition(obj) { return !!obj && obj.lock === 'none'; },
  canEditParams(obj) { return !!obj && obj.lock !== 'all'; },

  // 位置の更新。正規化とクランプを必ず通す。lock されていれば false を返して何もしない。
  setPosition(id, az, el, dist) {
    const obj = this.get(id);
    if (!this.canEditPosition(obj)) return false;
    const n = this.normalize(az != null ? az : obj.az, el != null ? el : obj.el);
    obj.az = n.az;
    obj.el = n.el;
    if (dist != null) obj.dist = this.clamp('dist', dist);
    this.changed(obj);
    return true;
  },

  changed(obj) {
    if (this.onChange) this.onChange(obj);
  },

  // ---- 経路の補間 ----

  // 手で組んだ古いオブジェクトでも落ちないように、path が無ければここで補う
  ensurePath(obj) {
    if (!obj.path || typeof obj.path !== 'object' || !Array.isArray(obj.path.points)) {
      obj.path = { enabled: false, loop: false, points: [] };
    }
    if (obj.path.loop == null) obj.path.loop = false;   // loop 導入前のオブジェクト
    return obj.path;
  },

  // イージング。u は 0〜1、戻りも 0〜1。'in'=加速 / 'out'=減速 / 'inout'=S字
  easeVal(ease, u) {
    if (ease === 'in') return u * u;
    if (ease === 'out') return u * (2 - u);
    if (ease === 'inout') return u * u * (3 - 2 * u);
    return u;   // linear
  },

  // 方位の補間。±180 の折り畳みをまたいでも最短弧を通る（+170 → -170 は 180 経由の 20°）。
  // 補間はモデル層のここ一箇所（描画のサンプリングも書き出しの焼き込みもこれを使う）。
  azLerp(a, b, u) {
    let d = ((b - a) % 360 + 360) % 360;    // [0, 360)
    if (d > 180) d -= 360;                  // (-180, 180]
    let az = a + d * u;
    az = ((az % 360) + 360) % 360;
    if (az > 180) az -= 360;
    return az;
  },

  // セグメント内の位置（u は緩急適用後の 0〜1）。az は最短弧、el/dist は線形。
  pathSegPos(p0, p1, u) {
    return {
      az: this.azLerp(p0.az, p1.az, u),
      el: p0.el + (p1.el - p0.el) * u,
      dist: p0.dist + (p1.dist - p0.dist) * u,
    };
  },

  // 経路上の時刻 t（プロジェクト絶対時間）の位置。
  // 最初の点より前はホールド（最初の点に留まる）。最後の点より後は、
  //   loop 無効 … 最後の点でホールド（従来どおり）
  //   loop 有効 … t を経路スパン（最後の点 - 最初の点）で剰余して先頭へ巻き戻す。
  //               剰余は必ず [0, span) に落とす（負の剰余を出さない）。
  // 折り返しの瞬間（t = 最後の点 + k*span）は剰余 0 = 最初の点そのもの。空間の繋ぎは
  // 経路の閉じ方に従う: ジェネレータは終端に始点と同じ「閉じ点」を置くので途切れず、
  // 手で組んだ開いた経路は端から端へ瞬間移動する（ライブは setTargetAtTime の
  // 〜20ms グライド、書き出しは折り返し境界のイベントで同じく一瞬で追従する）。
  // セグメント内の az は常に azLerp の最短弧を通る。
  pathPosAt(obj, t) {
    const pts = obj.path ? obj.path.points : [];
    if (!pts.length) return { az: obj.az, el: obj.el, dist: obj.dist };
    if (t <= pts[0].t) return { az: pts[0].az, el: pts[0].el, dist: pts[0].dist };
    const last = pts[pts.length - 1];
    if (t >= last.t) {
      const span = last.t - pts[0].t;
      if (!(obj.path.loop && span > 0)) return { az: last.az, el: last.el, dist: last.dist };
      t = pts[0].t + (((t - pts[0].t) % span) + span) % span;
      if (t <= pts[0].t) return { az: pts[0].az, el: pts[0].el, dist: pts[0].dist };
    }
    let i = 0;
    while (i < pts.length - 2 && pts[i + 1].t <= t) i++;
    const a = pts[i];
    const b = pts[i + 1];
    const u = (t - a.t) / (b.t - a.t);
    return this.pathSegPos(a, b, this.easeVal(a.ease, u));
  },

  // 時刻 t の実効位置。経路が有効で点があれば経路、そうでなければ静的 az/el/dist。
  // 静的フィールドは消さない（旧プロジェクトの意味論を保つ）。
  posAt(obj, t) {
    if (obj.path && obj.path.enabled && obj.path.points.length) return this.pathPosAt(obj, t);
    return { az: obj.az, el: obj.el, dist: obj.dist };
  },

  // ---- 経路の編集（すべて normalize/clamp/changed を通し、lock は位置編集と同じ扱い）----

  // waypoint を追加して返す（lock などで追加できなければ null）。
  // 既存の点と近すぎる時刻は PATH_MIN_DT ぶん後ろへ押し出す（昇順で走査するので1パスで済む）。
  addPathPoint(id, pt) {
    const obj = this.get(id);
    if (!this.canEditPosition(obj)) return null;
    const pts = this.ensurePath(obj).points;
    const q = pt || {};
    const n = this.normalize(q.az != null ? q.az : obj.az, q.el != null ? q.el : obj.el);
    let t = Math.max(0, isFinite(+q.t) ? +q.t : 0);
    for (const p of pts) if (Math.abs(p.t - t) < this.PATH_MIN_DT - 1e-9) t = p.t + this.PATH_MIN_DT;
    const point = {
      t,
      az: n.az,
      el: n.el,
      dist: this.clamp('dist', q.dist != null ? q.dist : obj.dist),
      ease: this.EASES.includes(q.ease) ? q.ease : 'linear',
    };
    let i = 0;
    while (i < pts.length && pts[i].t <= point.t) i++;
    pts.splice(i, 0, point);
    this.changed(obj);
    return point;
  },

  // waypoint の位置を更新（null の引数は据え置き）。時刻は setPathPointTime の担当。
  movePathPoint(id, index, az, el, dist) {
    const obj = this.get(id);
    if (!this.canEditPosition(obj)) return false;
    const p = obj.path && obj.path.points[index];
    if (!p) return false;
    const n = this.normalize(az != null ? az : p.az, el != null ? el : p.el);
    p.az = n.az;
    p.el = n.el;
    if (dist != null) p.dist = this.clamp('dist', dist);
    this.changed(obj);
    return true;
  },

  // waypoint の時刻を変更。前後の点 ±PATH_MIN_DT でクランプする（順序は入れ替わらない）。
  setPathPointTime(id, index, t) {
    const obj = this.get(id);
    if (!this.canEditPosition(obj)) return false;
    const pts = obj.path && obj.path.points;
    const p = pts && pts[index];
    if (!p) return false;
    const v = isFinite(+t) ? +t : p.t;
    const lo = index > 0 ? pts[index - 1].t + this.PATH_MIN_DT : 0;
    const hi = index < pts.length - 1 ? pts[index + 1].t - this.PATH_MIN_DT : Infinity;
    p.t = Math.min(hi, Math.max(lo, v));
    this.changed(obj);
    return true;
  },

  removePathPoint(id, index) {
    const obj = this.get(id);
    if (!this.canEditPosition(obj)) return false;
    const pts = obj.path && obj.path.points;
    if (!pts || index < 0 || index >= pts.length) return false;
    pts.splice(index, 1);
    this.changed(obj);
    return true;
  },

  // セグメントの緩急を循環させる（linear → in → out → inout → linear）
  cyclePathEase(id, index) {
    const obj = this.get(id);
    if (!this.canEditPosition(obj)) return false;
    const p = obj.path && obj.path.points[index];
    if (!p) return false;
    p.ease = this.EASES[(this.EASES.indexOf(p.ease) + 1) % this.EASES.length];
    this.changed(obj);
    return true;
  },

  setPathEnabled(id, on) {
    const obj = this.get(id);
    if (!this.canEditPosition(obj)) return false;
    this.ensurePath(obj).enabled = !!on;
    this.changed(obj);
    return true;
  },

  // 経路ループの切替（lock の扱いは経路編集と同じ）
  setPathLoop(id, on) {
    const obj = this.get(id);
    if (!this.canEditPosition(obj)) return false;
    this.ensurePath(obj).loop = !!on;
    this.changed(obj);
    return true;
  },

  // ---- 軌道ジェネレータ ----
  //
  // 既存の waypoint 列を「生成して置き換える」だけの機能。出力は普通の経路なので、
  // 編集・undo・書き出しの焼き込み（bakePath）・保存は既存の仕組みが無改修で効く
  // （undo は呼び出し側の history.commit 1回で実行前の状態に戻る）。
  // 点は既定で 1/8 周期ごと + ease 'linear'。円滑さは既存のセグメント補間に任せる。
  // 終端には始点と同じ「閉じ点」を置くので、loop と組み合わせると途切れず周回する。
  // 生成した点は loadPath と同じ検証（normalize / clamp / 昇順 / PATH_MIN_DT）を通す。
  //
  // kind: 'circle'   一定 el のまま az を一周（dir で回転方向）
  //       'spiral'   az を回しながら el（と任意で dist）を始点→終点へ漸変
  //       'eight'    az が中心 ±radius で行き来しつつ el が上下（リサージュ 1:2 の8の字）
  //       'pingpong' az 中心-radius ←→ 中心+radius の2点間往復（点は折り返しにだけ置く）
  // opts: t0     開始時刻（秒。既定 0）
  //       period 1周期の秒数（既定 4）
  //       beats  1周期の拍数（指定があれば period より優先。拍長は現在の BPM から）
  //       cycles 周回数（既定 1。1〜32）
  //       div    1周期あたりの点数（既定 8。4〜96。pingpong は折り返し点のみで div 不使用）
  //       az/el/dist 中心・基準位置（既定はオブジェクトの現在位置）
  //       radius 振幅（度。既定 45、1〜90。eight / pingpong で使用）
  //       el1    spiral の終点 el（既定 60）
  //       dist1  spiral の終点 dist（省略時は dist 一定）
  //       dir    回転方向（1=左回り / -1=右回り。既定 1。circle / spiral で使用）
  generatePath(id, kind, opts) {
    const obj = this.get(id);
    if (!this.canEditPosition(obj)) return null;
    const q = opts || {};
    const num = (v, d) => (isFinite(+v) ? +v : d);
    const t0 = Math.max(0, num(q.t0, 0));
    const cycles = Math.max(1, Math.min(32, Math.round(num(q.cycles, 1))));
    const div = Math.max(4, Math.min(96, Math.round(num(q.div, 8))));
    // 周期。拍指定があれば優先。div 個の点が PATH_MIN_DT を割らない長さは確保する
    let period = num(q.beats, 0) > 0
      ? num(q.beats, 0) * (DAW.beatDuration ? DAW.beatDuration() : 0.5)
      : num(q.period, 4);
    period = Math.max(div * this.PATH_MIN_DT, period);
    const az0 = num(q.az, obj.az);
    const el0 = num(q.el, obj.el);
    const dist0 = this.clamp('dist', num(q.dist, obj.dist));
    // 振幅は 90° まで（pingpong の2点が 180° を超えて離れると azLerp の最短弧が裏へ回るため）
    const radius = Math.max(1, Math.min(90, num(q.radius, 45)));
    const dir = num(q.dir, 1) < 0 ? -1 : 1;
    const pts = [];
    const push = (t, az, el, dist) => pts.push({ t, az, el, dist, ease: 'linear' });
    if (kind === 'pingpong') {
      // 直線往復に中間点は要らない（補間が直線なので）。折り返しにだけ点を置く
      for (let k = 0; k < cycles; k++) {
        push(t0 + k * period, az0 - radius, el0, dist0);
        push(t0 + (k + 0.5) * period, az0 + radius, el0, dist0);
      }
      push(t0 + cycles * period, az0 - radius, el0, dist0);   // 閉じ点
    } else if (kind === 'circle' || kind === 'spiral' || kind === 'eight') {
      const el1 = kind === 'spiral' ? num(q.el1, 60) : el0;
      const d1 = kind === 'spiral' && q.dist1 != null ? this.clamp('dist', num(q.dist1, dist0)) : dist0;
      const N = cycles * div;
      for (let k = 0; k <= N; k++) {
        const w = k / div;    // 通し周回数（circle/spiral の回転量）
        const v = k / N;      // 全体の進行 0〜1（spiral の漸変）
        const u = (k % div) / div;   // 周回内の位相（eight。k=N は u=0 = 閉じ点）
        if (kind === 'eight') {
          push(t0 + w * period,
               az0 + radius * Math.sin(2 * Math.PI * u),
               el0 + (radius / 2) * Math.sin(4 * Math.PI * u), dist0);
        } else {
          push(t0 + w * period, az0 + dir * 360 * w,
               el0 + (el1 - el0) * v, dist0 + (d1 - dist0) * v);
        }
      }
    } else {
      return null;   // 未知の形状
    }
    // 検証は読み込みと同じ経路（normalize / clamp / 昇順 / PATH_MIN_DT）を通す。
    // enabled / loop は触らない（有効化やループはそれぞれの API の担当）。
    const path = this.ensurePath(obj);
    path.points = this.loadPath({ points: pts }).points;
    this.changed(obj);
    return path.points;
  },

  // az/el/dist/width/gainDb などの数値パラメータをまとめて更新する。
  // 位置系は lock='pos' でも拒否される。
  set(id, key, value) {
    const obj = this.get(id);
    if (!obj) return false;
    // lock 自体は常に変更できる。ここを lock 判定の対象にすると
    // lock='all' にした瞬間に解除できなくなり、オブジェクトが永久に凍る。
    if (key === 'lock') {
      obj.lock = ['none', 'pos', 'all'].includes(value) ? value : 'none';
      return true;
    }
    const positional = key === 'az' || key === 'el' || key === 'dist' || key === 'width';
    if (positional ? !this.canEditPosition(obj) : !this.canEditParams(obj)) return false;
    if (key === 'az' || key === 'el') {
      const n = this.normalize(key === 'az' ? value : obj.az, key === 'el' ? value : obj.el);
      obj.az = n.az;
      obj.el = n.el;
      this.changed(obj);
      return true;
    }
    if (key === 'mute' || key === 'solo') {
      obj[key] = !!value;
      // ソロは他のオブジェクトの実効ゲインも変えるので全体を更新する
      if (this.onChange) this.list.forEach(o => this.onChange(o));
      return true;
    }
    if (key === 'name') { obj.name = String(value); return true; }
    if (key === 'color') { obj.color = String(value); return true; }
    if (this.LIMITS[key]) {
      obj[key] = this.clamp(key, value);
      this.changed(obj);
      return true;
    }
    return false;
  },

  // トラックの割り当てを付け替える（trackId は null で未割り当て）。
  // 不変条件「1トラック = 最大1オブジェクト」をここで守る: 既に他のオブジェクトが
  // 使っているトラックを選んだら、そちらを未割り当てへ外す（奪い取り）。
  // レンダラー（audio.trackDest → objaudio.forTrack）は find で最初の1個しか見ないため、
  // 重複を許すと2個目以降が「割り当て済みに見えるのに鳴らない」死にオブジェクトになる。
  // lock は見ない（割り当てはルーティングであって位置/パラメータの編集ではない。
  // lock='all' から奪えないと、付け替えが永久にできなくなる）。
  assignTrack(id, trackId) {
    const obj = this.get(id);
    if (!obj) return false;
    const tid = trackId || null;
    if (obj.trackId === tid) return false;   // 変化なし
    if (tid) {
      for (const o of this.list) {
        if (o !== obj && o.trackId === tid) { o.trackId = null; this.changed(o); }
      }
    }
    obj.trackId = tid;
    this.changed(obj);
    return true;
  },

  anySolo() { return this.list.some(o => o.solo); },

  // ミュート/ソロを織り込んだ実効ゲイン（線形）
  effectiveGain(obj) {
    if (!obj || obj.mute || (this.anySolo() && !obj.solo)) return 0;
    return Math.pow(10, obj.gainDb / 20);
  },

  // 保存用。仕様どおり極座標のまま出す。
  toJSON() {
    return this.list.map(o => ({
      id: o.id, name: o.name, color: o.color, trackId: o.trackId || null,
      az: o.az, el: o.el, dist: o.dist, width: o.width,
      gainDb: o.gainDb, revSend: o.revSend, mute: !!o.mute, solo: !!o.solo, lock: o.lock,
      path: {
        enabled: !!(o.path && o.path.enabled),
        loop: !!(o.path && o.path.loop),
        points: (o.path ? o.path.points : []).map(p => ({ t: p.t, az: p.az, el: p.el, dist: p.dist, ease: p.ease })),
      },
    }));
  },

  // 経路の読み込み。欠落は { enabled:false, loop:false, points:[] }、不正な ease は 'linear'、
  // t は昇順に並べ直し、同時刻（PATH_MIN_DT 未満）は後の点を押し出して間隔を守る。
  loadPath(src) {
    const p = src && typeof src === 'object' ? src : {};
    const pts = (Array.isArray(p.points) ? p.points : [])
      .map(q => {
        const s = q && typeof q === 'object' ? q : {};
        const n = this.normalize(s.az != null ? s.az : 0, s.el != null ? s.el : 0);
        return {
          t: Math.max(0, isFinite(+s.t) ? +s.t : 0),
          az: n.az,
          el: n.el,
          dist: this.clamp('dist', s.dist != null ? s.dist : 1),
          ease: this.EASES.includes(s.ease) ? s.ease : 'linear',
        };
      })
      .sort((a, b) => a.t - b.t);
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].t < pts[i - 1].t + this.PATH_MIN_DT) pts[i].t = pts[i - 1].t + this.PATH_MIN_DT;
    }
    return { enabled: !!p.enabled, loop: !!p.loop, points: pts };
  },

  // 読み込み。旧プロジェクト（objects を持たない）は空配列で開く。
  // 欠けたフィールドは既定値で補い、範囲外は丸める（壊れたファイルで落ちないように）。
  load(arr) {
    const d = this.defaults();
    this.list = (Array.isArray(arr) ? arr : []).slice(0, this.MAX).map((o, i) => {
      const src = o && typeof o === 'object' ? o : {};
      const n = this.normalize(src.az != null ? src.az : d.az, src.el != null ? src.el : d.el);
      return {
        id: src.id || DAW.uid(),
        name: src.name != null ? String(src.name) : `オブジェクト ${i + 1}`,
        color: src.color || this.COLORS[i % this.COLORS.length],
        trackId: src.trackId || null,
        az: n.az,
        el: n.el,
        dist: this.clamp('dist', src.dist != null ? src.dist : d.dist),
        width: this.clamp('width', src.width != null ? src.width : d.width),
        gainDb: this.clamp('gainDb', src.gainDb != null ? src.gainDb : d.gainDb),
        revSend: this.clamp('revSend', src.revSend != null ? src.revSend : d.revSend),   // 旧プロジェクトは既定で補完
        mute: !!src.mute,
        solo: !!src.solo,
        lock: ['none', 'pos', 'all'].includes(src.lock) ? src.lock : 'none',
        path: this.loadPath(src.path),   // 旧プロジェクトは path を持たないので空で開く
      };
    });
    // 同じトラックを指す重複割り当ては先勝ちで解消する（手で編集されたファイル対策）。
    // レンダラーは「1トラック = 最大1オブジェクト」前提で最初の1個しか見ないので、
    // 残しても2個目以降は鳴らない。読み込み時点で不変条件へ揃えておく。
    const usedTracks = new Set();
    for (const o of this.list) {
      if (!o.trackId) continue;
      if (usedTracks.has(o.trackId)) o.trackId = null;
      else usedTracks.add(o.trackId);
    }
    if (!this.get(this.selectedId)) this.selectedId = this.list.length ? this.list[0].id : null;
    return this.list;
  },

  clear() {
    this.list = [];
    this.selectedId = null;
  },
};
