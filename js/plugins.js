'use strict';

// プラグインレジストリ。
//
// プラグインの追加方法:
//   1. js/plugins/ に JS ファイルを置き、DAW.plugins.register({...}) を呼ぶ
//   2. index.html の末尾に <script src="js/plugins/xxx.js"></script> を1行追加
//
// プラグイン定義:
//   {
//     id: 'lowpass',                 // 一意なID（プロジェクト保存に使われる）
//     name: 'ローパスフィルタ',        // UI表示名
//     params: [                      // パラメータ記述子（スライダーが自動生成される）
//       { key: 'freq', label: '周波数', min: 100, max: 18000, step: 1, default: 8000 },
//     ],
//     create(ctx, params) {          // ctx は AudioContext / OfflineAudioContext の両方が渡りうる
//       return {
//         input:  <AudioNode>,       // チェーンの入口
//         output: <AudioNode>,       // チェーンの出口
//         set(key, value) { ... },   // パラメータのライブ変更
//       };
//     },
//   }
DAW.plugins = {
  defs: new Map(),

  register(def) {
    this.defs.set(def.id, def);
  },

  get(id) {
    return this.defs.get(id);
  },

  list() {
    return [...this.defs.values()];
  },

  defaultParams(def) {
    const p = {};
    for (const d of def.params) p[d.key] = d.default;
    return p;
  },

  // 使用中プラグインの prepare(ctx) を全て await する。
  // AudioWorklet 等の非同期初期化が必要なプラグインは prepare を実装し、
  // create(ctx, params) は prepare 完了後に呼ばれる前提でよい
  // （core が play / 書き出し / 読み込み / FX追加 の前に呼ぶ）。
  async prepareAll(ctx, tracks) {
    const seen = new Set();
    for (const track of tracks) {
      for (const fx of track.effects) {
        const def = this.get(fx.pluginId);
        if (def && def.prepare && !seen.has(def)) {
          seen.add(def);
          await def.prepare(ctx);
        }
      }
    }
  },
};
