'use strict';
// =====================================================================
// オブジェクトのグループ化（改善ロードマップ⑧・第1段）。
// モデル（groupId / レジストリ / グループ回転）と UI（色帯 / メニュー / Shift+ドラッグ）。
// 他ファイルのヘルパには依存しない（tests-*.js は名前順に読まれるため）。
// =====================================================================

function objgroupSuite(group, body) {
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
    DAW.ui.selectedClipId = null;
    DAW.ui.renderTracks();
    DAW.objui.init();
    DAW.objui.setView('panner');
    DAW.objui.render();
    DAW.history.reset();
    try { await body(okf); } finally {
      DAW.ui.closeMenu();
      DAW.objects.clear();
      DAW.objui.setView('panner');
      DAW.objui.els.stripScroll.scrollLeft = 0;
      DAW.objui.render();
      try { DAW.audio.stop(); } catch (e) {}
    }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

// 2方向の球面距離（度）。回転の「球面相対保持」の検証に使う
function objgroupAngle(a, b) {
  const u = DAW.objaudio.toCartesian(a.az, a.el, 1);
  const v = DAW.objaudio.toCartesian(b.az, b.el, 1);
  const dot = Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y + u.z * v.z));
  return Math.acos(dot) * 180 / Math.PI;
}

objgroupSuite('[47] オブジェクトのグループ化（モデル）', async (okf) => {
  const O = DAW.objects;
  const EPS = 1e-6;

  // ---- レジストリと所属 ----
  const a = O.create('A');
  const b = O.create('B');
  const c = O.create('C');
  {
    const g = O.createGroup('ペア');
    okf('G.1 グループを作れる（id / 名前 / 色）',
      !!g.id && g.name === 'ペア' && /^#[0-9a-f]{6}$/i.test(g.color), JSON.stringify(g));
    okf('G.2 名前省略時は「グループ N」', O.createGroup().name === 'グループ 2', O.groups[1] && O.groups[1].name);
    O.groups.pop();   // 空グループの試験はここまで（以後は「ペア」だけ使う）

    okf('G.3 setGroup で所属できる', O.setGroup(a.id, g.id) === true && a.groupId === g.id);
    O.setGroup(b.id, g.id);
    okf('G.4 groupMembers がメンバーを返す',
      O.groupMembers(g.id).length === 2 && O.groupMembers(g.id).every(o => o === a || o === b));
    okf('G.5 存在しないグループへは入れない', O.setGroup(c.id, 'idnotexist') === false && c.groupId === null);
    okf('G.6 同じ所属への再指定は変化なし（false）', O.setGroup(a.id, g.id) === false);

    okf('G.7 null で外せる', O.setGroup(a.id, null) === true && a.groupId === null);
    okf('G.8 最後のメンバーを外すと空グループが畳まれる',
      O.setGroup(b.id, null) === true && O.groups.length === 0, `groups=${O.groups.length}`);

    const g2 = O.createGroup('削除試験');
    O.setGroup(c.id, g2.id);
    O.remove(c.id);
    okf('G.9 最後のメンバーの削除でも空グループが畳まれる', O.groups.length === 0, `groups=${O.groups.length}`);
  }

  // ---- グループ回転（ヨー: rotateGroupAz）----
  {
    const g = O.createGroup('回転');
    O.setPosition(a.id, 0, 10, 1);
    O.setPosition(b.id, 90, -20, 0.5);
    const d = O.create('D');
    O.setPosition(d.id, -170, 0, 0.8);
    O.setGroup(a.id, g.id); O.setGroup(b.id, g.id); O.setGroup(d.id, g.id);

    okf('G.10 ヨー回転: 全メンバーの az が同じ差分で回る（既知座標）',
      O.rotateGroupAz(a.id, 30) === true
      && Math.abs(a.az - 30) < EPS && Math.abs(b.az - 120) < EPS && Math.abs(d.az - (-140)) < EPS,
      `a=${a.az} b=${b.az} d=${d.az}`);
    okf('G.11 ヨー回転で el は変わらない',
      Math.abs(a.el - 10) < EPS && Math.abs(b.el - (-20)) < EPS && Math.abs(d.el) < EPS,
      `el: a=${a.el} b=${b.el} d=${d.el}`);
    okf('G.12 dist は各自維持',
      Math.abs(a.dist - 1) < EPS && Math.abs(b.dist - 0.5) < EPS && Math.abs(d.dist - 0.8) < EPS,
      `dist: a=${a.dist} b=${b.dist} d=${d.dist}`);
    okf('G.13 ±180 の折り畳みをまたいでも正しく畳まれる',
      O.rotateGroupAz(a.id, 100) === true && Math.abs(d.az - (-70)) < EPS && Math.abs(b.az - (-170)) < EPS,
      `b=${b.az} d=${d.az}`);
    O.rotateGroupAz(a.id, 0);   // 元の位相へ戻す（a=0）
    O.remove(d.id);
  }

  // ---- グループ回転（最小回転: rotateGroupTo）----
  {
    const g = O.groups[0];
    O.setPosition(a.id, 0, 0, 1);
    O.setPosition(b.id, 90, 0, 0.5);

    // (0,0)→(0,30) の最小回転軸は +x。B(90,0)=(-1,0,0) は軸上なので不動（既知座標）
    okf('G.14 仰角へ倒す回転: 掴んだ点は目標へ、軸上のメンバーは不動',
      O.rotateGroupTo(a.id, 0, 30) === true
      && Math.abs(a.az) < EPS && Math.abs(a.el - 30) < EPS
      && Math.abs(b.az - 90) < EPS && Math.abs(b.el) < EPS,
      `a=(${a.az},${a.el}) b=(${b.az},${b.el})`);
    okf('G.15 回転後も球面距離 90° を保持',
      Math.abs(objgroupAngle(a, b) - 90) < 1e-4, objgroupAngle(a, b).toFixed(6));

    // 赤道上のヨー相当: (0,30)→(0,0) で戻し、(0,0)→(90,0) で B は 180 へ
    O.rotateGroupTo(a.id, 0, 0);
    okf('G.16 赤道上の最小回転はヨーと一致（B は 90→180）',
      O.rotateGroupTo(a.id, 90, 0) === true
      && Math.abs(a.az - 90) < EPS && Math.abs(b.az - 180) < 1e-4 && Math.abs(b.el) < 1e-4,
      `a=${a.az} b=${b.az},${b.el}`);
    okf('G.17 dist は各自維持（最小回転でも）',
      Math.abs(a.dist - 1) < EPS && Math.abs(b.dist - 0.5) < EPS, `a=${a.dist} b=${b.dist}`);

    // 一般の回転でも相対保持（既知座標で数値固定）
    O.setPosition(a.id, 20, 10, 1);
    O.setPosition(b.id, -50, 40, 0.5);
    const before = objgroupAngle(a, b);
    O.rotateGroupTo(a.id, -130, -25);
    okf('G.18 一般の回転でも球面相対を保持',
      Math.abs(a.az - (-130)) < 1e-4 && Math.abs(a.el - (-25)) < 1e-4
      && Math.abs(objgroupAngle(a, b) - before) < 1e-4,
      `∠=${before.toFixed(4)}→${objgroupAngle(a, b).toFixed(4)}`);

    // 正反対へ一気に跨ぐ（軸が定まらない縮退）でも壊れない
    O.setPosition(a.id, 0, 0, 1);
    O.setPosition(b.id, 90, 0, 0.5);
    okf('G.19 正反対への回転でも掴んだ点は目標へ・相対 90° を保持',
      O.rotateGroupTo(a.id, 180, 0) === true
      && Math.abs(Math.abs(a.az) - 180) < 1e-4 && Math.abs(objgroupAngle(a, b) - 90) < 1e-4,
      `a=(${a.az},${a.el}) ∠=${objgroupAngle(a, b).toFixed(4)}`);
  }

  // ---- lock / 経路 / 無所属の扱い ----
  {
    O.setPosition(a.id, 0, 0, 1);
    O.setPosition(b.id, 90, 0, 0.5);
    O.set(b.id, 'lock', 'pos');
    O.rotateGroupAz(a.id, 40);
    okf('G.20 lock 中のメンバーは回転しない', Math.abs(a.az - 40) < EPS && Math.abs(b.az - 90) < EPS,
      `a=${a.az} b=${b.az}`);
    O.set(b.id, 'lock', 'none');

    O.addPathPoint(b.id, { t: 0, az: 10, el: 0, dist: 1 });
    O.setPathEnabled(b.id, true);
    O.rotateGroupTo(a.id, -40, 20);
    okf('G.21 経路有効のメンバーは回転の対象外（静的位置も動かない）',
      Math.abs(a.az - (-40)) < 1e-4 && Math.abs(b.az - 90) < EPS, `a=${a.az} b=${b.az}`);
    O.setPathEnabled(b.id, false);
    O.removePathPoint(b.id, 0);

    O.set(a.id, 'lock', 'pos');
    okf('G.22 掴んだメンバー自身が lock なら回転そのものが不成立',
      O.rotateGroupAz(a.id, 120) === false && Math.abs(b.az - 90) < EPS, `b=${b.az}`);
    O.set(a.id, 'lock', 'none');

    O.setGroup(a.id, null);
    okf('G.23 無所属では回転できない', O.rotateGroupAz(a.id, 120) === false && O.rotateGroupTo(a.id, 0, 10) === false);
    okf('G.24 a が抜けてもグループは b が残るので存続', O.groups.length === 1 && b.groupId === O.groups[0].id);
    O.setGroup(a.id, O.groups[0].id);
  }

  // ---- グループ中心（平均方向）----
  {
    O.setPosition(a.id, 0, 0, 1);
    O.setPosition(b.id, 90, 0, 0.5);
    const ctr = O.groupCenter(a.groupId);
    okf('G.25 中心 = toCartesian 平均→正規化（(0,0)+(90,0) → az=45）',
      !!ctr && Math.abs(ctr.az - 45) < 1e-6 && Math.abs(ctr.el) < 1e-6, JSON.stringify(ctr));
    O.setPosition(b.id, 180, 0, 0.5);
    okf('G.26 正反対の2点は中心が定まらないので null', O.groupCenter(a.groupId) === null);
    okf('G.27 存在しないグループの中心は null', O.groupCenter('idnotexist') === null);
  }

  // ---- 保存 → 復元 / 欠落補完 ----
  {
    O.setPosition(a.id, 12, 34, 0.5);
    O.setPosition(b.id, -56, -7, 0.9);
    const gid = a.groupId;
    const gname = O.getGroup(gid).name;
    const gcolor = O.getGroup(gid).color;

    H.downloads.length = 0;
    DAW.wav.saveProject();
    const txt = await H.downloads[H.downloads.length - 1].blob.text();
    const data = JSON.parse(txt);
    okf('G.28 保存: objects は配列のまま（旧実装互換）+ groupId が入る',
      Array.isArray(data.objects) && data.objects.every(o => o.groupId === gid),
      JSON.stringify(data.objects.map(o => o.groupId)));
    okf('G.29 保存: objectGroups にレジストリが入る',
      Array.isArray(data.objectGroups) && data.objectGroups.length === 1
      && data.objectGroups[0].id === gid && data.objectGroups[0].name === gname,
      JSON.stringify(data.objectGroups));

    O.clear();
    await DAW.wav.loadProject(new File([txt], 'p.json'));
    okf('G.30 復元: 所属とレジストリ（名前・色）が往復する',
      O.list.every(o => o.groupId === gid) && O.groups.length === 1
      && O.groups[0].id === gid && O.groups[0].name === gname && O.groups[0].color === gcolor,
      JSON.stringify(O.groups));

    // 旧プロジェクト（objectGroups も groupId も無い）
    const old = JSON.parse(txt);
    delete old.objectGroups;
    for (const o of old.objects) delete o.groupId;
    await DAW.wav.loadProject(new File([JSON.stringify(old)], 'old.json'));
    okf('G.31 旧プロジェクトは無所属・レジストリ空で開く',
      O.groups.length === 0 && O.list.every(o => o.groupId === null), `groups=${O.groups.length}`);

    // 欠落補完: groupId はあるのにレジストリが無い（手で編集されたファイル）
    const broken = JSON.parse(txt);
    delete broken.objectGroups;
    await DAW.wav.loadProject(new File([JSON.stringify(broken)], 'broken.json'));
    okf('G.32 レジストリ欠落は既定の名前・色で補完される',
      O.groups.length === 1 && O.groups[0].id === gid
      && /^グループ /.test(O.groups[0].name) && /^#[0-9a-f]{6}$/i.test(O.groups[0].color)
      && O.list.every(o => o.groupId === gid),
      JSON.stringify(O.groups));

    // レジストリはあるがメンバーがいないグループは畳む
    const stray = JSON.parse(txt);
    stray.objectGroups.push({ id: 'idstray', name: '空', color: '#123456' });
    await DAW.wav.loadProject(new File([JSON.stringify(stray)], 'stray.json'));
    okf('G.33 メンバーのいないグループは読み込みで畳まれる',
      O.groups.length === 1 && O.groups[0].id === gid, JSON.stringify(O.groups.map(g => g.id)));
  }

  // ---- undo ----
  {
    O.clear();
    const x = O.create('X');
    const y = O.create('Y');
    DAW.history.reset();
    const g = O.createGroup('undo試験');
    O.setGroup(x.id, g.id);
    O.setGroup(y.id, g.id);
    DAW.history.commit();
    okf('G.34 グループ化は履歴に積まれる', DAW.history.canUndo());
    await DAW.history.undo();
    okf('G.35 undo で所属とレジストリが戻る',
      O.groups.length === 0 && O.list.every(o => o.groupId === null), `groups=${O.groups.length}`);
    await DAW.history.redo();
    okf('G.36 redo で復活する',
      O.groups.length === 1 && O.groups[0].name === 'undo試験' && O.list.every(o => o.groupId === O.groups[0].id),
      JSON.stringify(O.groups));
  }
  okf('G.37 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});

objgroupSuite('[47] オブジェクトのグループ化（UI）', async (okf) => {
  const O = DAW.objects;
  const U = DAW.objui;
  const AZ_EPS = 1.5;   // クリック座標を整数に丸めるぶんの誤差
  const EPS = 1e-6;

  const stripOf = id => document.querySelector(`#obj-strips .obj-strip[data-obj-id="${id}"]`);
  const menuItems = () => [...document.querySelectorAll('#ctx-menu .ctx-item')];
  const menuItem = label => menuItems().find(el => el.textContent.includes(label)) || null;
  const rclick = (el, x, y) => el.dispatchEvent(new MouseEvent('contextmenu',
    { bubbles: true, cancelable: true, clientX: Math.round(x || 0), clientY: Math.round(y || 0) }));

  const a = O.create('A');
  const b = O.create('B');
  O.select(a.id);
  U.render();
  DAW.history.reset();

  // ---- ストリップ右クリック → グループメニュー ----
  {
    rclick(stripOf(a.id), 100, 100);
    okf('UG.1 右クリックでメニューが開く', !!document.getElementById('ctx-menu'));
    okf('UG.2 まだグループが無いので「新規作成」と「外す（無効）」だけ',
      !!menuItem('新しいグループを作って追加') && menuItem('グループから外す').disabled === true
      && menuItems().length === 2, menuItems().map(el => el.textContent).join('/'));

    menuItem('新しいグループを作って追加').click();
    okf('UG.3 新規作成 → 所属とレジストリができる',
      O.groups.length === 1 && O.get(a.id).groupId === O.groups[0].id, JSON.stringify(O.groups));
    okf('UG.4 作成 + 追加で履歴は1エントリ', DAW.history.past.length === 1, DAW.history.past.length);

    rclick(stripOf(b.id), 100, 100);
    okf('UG.5 右クリックで対象のストリップが選択される', O.selectedId === b.id);
    const add = menuItem('へ追加');
    okf('UG.6 既存グループがメニューに載る（メンバー数付き）',
      !!add && add.textContent.includes('1個') && !add.disabled, add && add.textContent);
    add.click();
    okf('UG.7 既存グループへ追加できる', O.get(b.id).groupId === O.groups[0].id
      && O.groupMembers(O.groups[0].id).length === 2);

    rclick(stripOf(b.id), 100, 100);
    okf('UG.8 所属中のグループは ✓ 付きで無効表示',
      menuItem('へ追加').disabled === true && menuItem('✓') === menuItem('へ追加'),
      menuItem('へ追加') && menuItem('へ追加').textContent);
    DAW.ui.closeMenu();
  }

  // ---- 色帯 ----
  {
    U.render();
    const band = stripOf(a.id).querySelector('.os-group');
    okf('UG.9 グループ色帯がストリップに出る',
      !!band && band.style.display !== 'none' && band.dataset.c === O.groups[0].color,
      band && band.dataset.c);
    const g0 = O.groups[0].id;
    O.setGroup(a.id, null);
    U.render();
    okf('UG.10 外すと色帯が消える', stripOf(a.id).querySelector('.os-group').style.display === 'none');
    O.setGroup(a.id, g0);
    U.render();
  }

  // ---- Shift+ドラッグ = グループ回転（トップビュー）----
  const canvas = document.getElementById('obj-top');
  const pev = (type, x, y, opts) => {
    canvas.dispatchEvent(new PointerEvent(type, Object.assign({
      bubbles: true, cancelable: true, pointerId: 1, button: 0,
      clientX: Math.round(x), clientY: Math.round(y),
    }, opts)));
  };
  {
    O.setPosition(a.id, 0, 0, 1);
    O.setPosition(b.id, 90, 0, 0.5);
    O.select(a.id);
    U.render();
    DAW.history.reset();
    const g = U.topGeom();
    const p0 = U.posToXY(0, 1, g);
    const p1 = U.posToXY(30, 1, g);
    pev('pointerdown', p0.x, p0.y, { shiftKey: true });
    pev('pointermove', p1.x, p1.y);
    okf('UG.11 ドラッグ中は履歴を積まない', !DAW.history.canUndo(), `past=${DAW.history.past.length}`);
    pev('pointerup', p1.x, p1.y);
    const oa = O.get(a.id);
    const ob = O.get(b.id);
    okf('UG.12 Shift+ドラッグでグループごと回る（既知座標）',
      Math.abs(oa.az - 30) < AZ_EPS && Math.abs(ob.az - (90 + oa.az)) < 1e-4,
      `a=${oa.az.toFixed(2)} b=${ob.az.toFixed(2)}`);
    okf('UG.13 dist は各自維持（ポインタの距離成分を使わない）',
      Math.abs(oa.dist - 1) < EPS && Math.abs(ob.dist - 0.5) < EPS, `a=${oa.dist} b=${ob.dist}`);
    okf('UG.14 ドラッグ全体で履歴は1エントリ', DAW.history.past.length === 1, DAW.history.past.length);
    await DAW.history.undo();
    okf('UG.15 undo 1回で全メンバーが戻る',
      Math.abs(O.get(a.id).az) < EPS && Math.abs(O.get(b.id).az - 90) < EPS,
      `a=${O.get(a.id).az} b=${O.get(b.id).az}`);
  }

  // ---- Shift 無しは従来どおり単独移動 ----
  {
    O.setPosition(a.id, 0, 0, 1);
    O.setPosition(b.id, 90, 0, 0.5);
    O.select(a.id);
    U.render();
    const g = U.topGeom();
    const p0 = U.posToXY(0, 1, g);
    const p1 = U.posToXY(-45, 1, g);
    pev('pointerdown', p0.x, p0.y);
    pev('pointermove', p1.x, p1.y);
    pev('pointerup', p1.x, p1.y);
    okf('UG.16 通常ドラッグは単独移動のまま（他メンバーは不動）',
      Math.abs(O.get(a.id).az - (-45)) < AZ_EPS && Math.abs(O.get(b.id).az - 90) < EPS,
      `a=${O.get(a.id).az.toFixed(2)} b=${O.get(b.id).az}`);
  }

  // ---- Shift+ドラッグ（正面ビュー: 最小回転）----
  {
    O.setPosition(a.id, 0, 0, 1);
    O.setPosition(b.id, 90, 0, 0.5);
    O.select(a.id);
    U.render();
    const front = document.getElementById('obj-front');
    const fev = (type, x, y, opts) => front.dispatchEvent(new PointerEvent(type, Object.assign({
      bubbles: true, cancelable: true, pointerId: 2, button: 0,
      clientX: Math.round(x), clientY: Math.round(y),
    }, opts)));
    const g = U.frontGeom();
    fev('pointerdown', g.cx, g.cy, { shiftKey: true });          // a は (0,0) = 中央
    fev('pointermove', g.cx, g.cy - g.R * 0.5);                  // 上へ = el 30°
    fev('pointerup', g.cx, g.cy - g.R * 0.5);
    const oa = O.get(a.id);
    const ob = O.get(b.id);
    // ポインタ座標は整数に丸まるので回転軸がわずかに傾き、B もサブ度単位で動く。
    // 位置はピクセル誤差の許容で見て、「球面相対 90° の厳密保持」の方を固く検証する。
    okf('UG.17 正面ビューの Shift+ドラッグは最小回転（B はほぼ不動・相対 90° は厳密保持）',
      Math.abs(oa.az) < AZ_EPS && Math.abs(oa.el - 30) < AZ_EPS
      && Math.abs(ob.az - 90) < AZ_EPS && Math.abs(ob.el) < AZ_EPS
      && Math.abs(objgroupAngle(oa, ob) - 90) < 1e-4,
      `a=(${oa.az.toFixed(2)},${oa.el.toFixed(2)}) b=(${ob.az.toFixed(2)},${ob.el.toFixed(2)}) ∠=${objgroupAngle(oa, ob).toFixed(5)}`);
  }

  // ---- lock メンバーと署名 ----
  {
    O.setPosition(a.id, 0, 0, 1);
    O.setPosition(b.id, 90, 0, 0.5);
    O.set(b.id, 'lock', 'pos');
    O.select(a.id);
    U.render();
    const g = U.topGeom();
    const p0 = U.posToXY(0, 1, g);
    const p1 = U.posToXY(60, 1, g);
    pev('pointerdown', p0.x, p0.y, { shiftKey: true });
    pev('pointermove', p1.x, p1.y);
    pev('pointerup', p1.x, p1.y);
    okf('UG.18 lock 中のメンバーは Shift+ドラッグでも動かない',
      Math.abs(O.get(a.id).az - 60) < AZ_EPS && Math.abs(O.get(b.id).az - 90) < EPS,
      `a=${O.get(a.id).az.toFixed(2)} b=${O.get(b.id).az}`);
    O.set(b.id, 'lock', 'none');

    const s0 = U.stateSig();
    O.setGroup(b.id, null);
    okf('UG.19 所属の変更で stateSig が変わる（rAF 同期で追従できる）', U.stateSig() !== s0);
    const s1 = U.stateSig();
    O.setGroup(b.id, O.groups[0].id);
    O.groups[0].name = '改名';
    okf('UG.20 レジストリの変更でも stateSig が変わる', U.stateSig() !== s1);
  }

  okf('UG.21 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
