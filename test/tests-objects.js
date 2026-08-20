'use strict';
// =====================================================================
// オブジェクトベース音響のデータモデル（ADM BS.2076 準拠の極座標）。
// 他ファイルのヘルパには依存しない（tests-*.js は名前順に読まれるため）。
// =====================================================================

function objSuite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    const n0 = H.tests.length;
    try { DAW.audio.stop(); } catch (e) {}
    DAW.audio.resetNodes();
    DAW.project.tracks = [];
    DAW.objects.clear();
    DAW.addTrack('T1'); DAW.addTrack('T2');
    DAW.ui.renderTracks();
    DAW.history.reset();
    try { await body(okf); } finally {
      DAW.objects.clear();
      try { DAW.audio.stop(); } catch (e) {}
    }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

objSuite('[26] オブジェクトのデータモデル', async (okf) => {
  const O = DAW.objects;

  // ---- 生成・上限・選択 ----
  const a = O.create('ボーカル', DAW.project.tracks[0].id);
  okf('O.1 生成できる', !!a && O.count() === 1, `id=${a.id}`);
  okf('O.2 既定値が仕様どおり',
    a.az === 0 && a.el === 0 && a.dist === 1 && a.width === 0 && a.gainDb === 0
    && a.mute === false && a.solo === false && a.lock === 'none',
    JSON.stringify({ az: a.az, el: a.el, dist: a.dist, width: a.width, gainDb: a.gainDb, lock: a.lock }));
  okf('O.3 識別色が付く', /^#[0-9a-f]{6}$/i.test(a.color), a.color);
  okf('O.4 音源トラックに紐付く（音を出すための追加フィールド）', a.trackId === DAW.project.tracks[0].id);

  const b = O.create('ギター');
  O.select(b.id);
  okf('O.5 選択状態を単一 state で持つ', O.selectedId === b.id && O.selected() === b);
  O.remove(b.id);
  okf('O.6 削除すると選択が繰り上がる', O.count() === 1 && O.selectedId === a.id, `selected=${O.selectedId}`);

  while (!O.isFull()) O.create();
  okf('O.7 上限は128個', O.count() === 128 && O.create() === null, `count=${O.count()}`);
  O.clear();
  okf('O.8 clear で空になる', O.count() === 0 && O.selectedId === null);

  // ---- 正規化（受け入れ条件3） ----
  {
    const n1 = O.normalize(0, 140);
    okf('O.9 [受入3] (az=0, el=140) → (az=180, el=40)', n1.az === 180 && n1.el === 40, JSON.stringify(n1));
    const n2 = O.normalize(0, -140);
    okf('O.10 下側も同様に折り返す (0,-140) → (180,-40)', n2.az === 180 && n2.el === -40, JSON.stringify(n2));
    const n3 = O.normalize(90, 170);
    okf('O.11 折り返し後に方位も回る (90,170) → (-90,10)', n3.az === -90 && n3.el === 10, JSON.stringify(n3));
    okf('O.12 方位は (-180,180] に畳む',
      O.normalize(190, 0).az === -170 && O.normalize(-190, 0).az === 170
      && O.normalize(360, 0).az === 0 && O.normalize(180, 0).az === 180,
      `190→${O.normalize(190, 0).az} / -190→${O.normalize(-190, 0).az} / 360→${O.normalize(360, 0).az} / 180→${O.normalize(180, 0).az}`);
    okf('O.13 範囲内の値はそのまま', O.normalize(-45, 30).az === -45 && O.normalize(-45, 30).el === 30);
    okf('O.14 真上・真下は折り返さない',
      O.normalize(0, 90).el === 90 && O.normalize(0, 90).az === 0
      && O.normalize(0, -90).el === -90, JSON.stringify(O.normalize(0, 90)));
    okf('O.15 一周ぶん回しても同じ位置', O.normalize(0, 400).el === 40 && O.normalize(0, 400).az === 0,
      JSON.stringify(O.normalize(0, 400)));
  }

  // ---- クランプ ----
  {
    const o = O.create('c');
    O.set(o.id, 'dist', 5);
    okf('O.16 距離は 0〜1', o.dist === 1, o.dist);
    O.set(o.id, 'dist', -3);
    okf('O.17 距離の下限', o.dist === 0, o.dist);
    O.set(o.id, 'width', 999);
    okf('O.18 width は -200〜200', o.width === 200, o.width);
    O.set(o.id, 'width', -999);
    okf('O.19 width の負値も保持（LR反転は後段で実装）', o.width === -200, o.width);
    O.set(o.id, 'gainDb', 20);
    okf('O.20 gainDb は +6 まで', o.gainDb === 6, o.gainDb);
    O.set(o.id, 'gainDb', -200);
    okf('O.21 gainDb は -72 まで', o.gainDb === -72, o.gainDb);
    O.set(o.id, 'el', 140);
    okf('O.22 set 経由でも正規化される', o.az === 180 && o.el === 40, `az=${o.az} el=${o.el}`);
    O.set(o.id, 'gainDb', NaN);
    okf('O.23 数値でない入力は既定値に落とす', o.gainDb === 0, o.gainDb);
    O.clear();
  }

  // ---- lock ----
  {
    const o = O.create('lock試験');
    O.set(o.id, 'az', 45); O.set(o.id, 'gainDb', -6);
    O.set(o.id, 'lock', 'pos');
    okf('O.24 lock=pos なら位置は変えられない',
      O.setPosition(o.id, 90, 30) === false && o.az === 45, `az=${o.az}`);
    okf('O.25 lock=pos でもゲインは変えられる', O.set(o.id, 'gainDb', -12) === true && o.gainDb === -12);
    okf('O.26 lock=pos では width も固定', O.set(o.id, 'width', 50) === false && o.width === 0);
    O.set(o.id, 'lock', 'all');
    okf('O.27 lock=all なら何も変えられない',
      O.set(o.id, 'gainDb', 0) === false && O.setPosition(o.id, 0, 0) === false && o.gainDb === -12);
    okf('O.28 lock 自体は解除できる', O.set(o.id, 'lock', 'none') === true && o.lock === 'none');
    okf('O.29 不正な lock 値は none に丸める', O.set(o.id, 'lock', 'xxx') && o.lock === 'none');
    O.clear();
  }

  // ---- ミュート / ソロ / 実効ゲイン ----
  {
    const x = O.create('x'), y = O.create('y');
    okf('O.30 gainDb 0 の実効ゲインは 1.0', Math.abs(O.effectiveGain(x) - 1) < 1e-9);
    O.set(x.id, 'gainDb', -6);
    okf('O.31 -6dB は約0.501', Math.abs(O.effectiveGain(x) - 0.5012) < 0.001, O.effectiveGain(x).toFixed(4));
    O.set(x.id, 'mute', true);
    okf('O.32 ミュートで 0', O.effectiveGain(x) === 0);
    O.set(x.id, 'mute', false);
    O.set(y.id, 'solo', true);
    okf('O.33 他がソロなら 0（ソロ排他）', O.effectiveGain(x) === 0 && O.effectiveGain(y) === 1);
    O.clear();
  }

  // ---- 保存 → 復元（受け入れ条件1） ----
  {
    const o1 = O.create('SE', DAW.project.tracks[1].id);
    O.setPosition(o1.id, -37.5, 22.25, 0.42);
    O.set(o1.id, 'width', -150);
    O.set(o1.id, 'gainDb', -13.5);
    O.set(o1.id, 'mute', true);
    O.set(o1.id, 'lock', 'pos');
    const o2 = O.create('アンビ');
    O.setPosition(o2.id, 180, -90, 0);
    const before = JSON.parse(JSON.stringify(O.toJSON()));

    H.downloads.length = 0;
    DAW.wav.saveProject();
    const txt = await H.downloads[H.downloads.length - 1].blob.text();
    okf('O.34 プロジェクトに objects が入る', Array.isArray(JSON.parse(txt).objects) && JSON.parse(txt).objects.length === 2,
      `objects=${JSON.parse(txt).objects.length}`);
    O.clear();
    await DAW.wav.loadProject(new File([txt], 'p.json'));
    const after = O.toJSON();
    okf('O.35 [受入1] 保存→復元で全パラメータが一致',
      JSON.stringify(after) === JSON.stringify(before),
      `復元=${JSON.stringify(after[0])}`);

    // 旧プロジェクト（objects を持たない）
    const old = JSON.parse(txt); delete old.objects;
    await DAW.wav.loadProject(new File([JSON.stringify(old)], 'old.json'));
    okf('O.36 [受入1] objects を持たない旧プロジェクトは空配列で開く', O.count() === 0 && O.selectedId === null);

    // 壊れた objects でも落ちない
    const broken = JSON.parse(txt);
    broken.objects = [null, { az: 'abc', el: 999, dist: 'x', lock: 'zzz' }, 42];
    await DAW.wav.loadProject(new File([JSON.stringify(broken)], 'broken.json'));
    okf('O.37 壊れた objects は既定値で補って読み込む',
      O.count() === 3 && O.list.every(o => isFinite(o.az) && isFinite(o.el) && o.el >= -90 && o.el <= 90
        && ['none', 'pos', 'all'].includes(o.lock)),
      JSON.stringify(O.list[1]));
    O.clear();
  }

  // ---- 履歴 ----
  {
    const o = O.create('履歴試験');
    DAW.history.reset();
    O.setPosition(o.id, 60, 30, 0.5);
    DAW.history.commit();
    okf('O.38 オブジェクトの変更が履歴に積まれる', DAW.history.canUndo());
    await DAW.history.undo();
    okf('O.39 undo で位置が戻る',
      O.list[0].az === 0 && O.list[0].el === 0 && O.list[0].dist === 1,
      `az=${O.list[0].az} el=${O.list[0].el} dist=${O.list[0].dist}`);
    await DAW.history.redo();
    okf('O.40 redo で戻る', O.list[0].az === 60 && O.list[0].el === 30 && O.list[0].dist === 0.5);
    // 追加・削除も履歴に乗る
    DAW.history.reset();
    O.create('追加');
    DAW.history.commit();
    await DAW.history.undo();
    okf('O.41 追加も undo できる', O.count() === 1, `count=${O.count()}`);
  }
  okf('O.42 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
