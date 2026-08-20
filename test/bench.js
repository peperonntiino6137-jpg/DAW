'use strict';
// =====================================================================
// 性能ベンチマーク（通常のテストには含めない。`bash test/run.sh --bench` で実行）
//
//  重いプロジェクト（20トラック × 40クリップ = 800クリップ / 約3分）を組み立てて、
//  描画・スクロール追従・再生開始・書き出し・保存/読み込みの所要時間を測る。
//  数値は環境依存なので合否のしきい値はゆるく置き、値そのものを詳細欄に出す。
// =====================================================================

T('[BENCH] 性能計測', async () => {
  const B = (name, cond, detail) => {
    H.tests.push({ name: '[BENCH] ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
  };
  const n0 = H.tests.length;
  try { DAW.audio.stop(); } catch (e) {}
  DAW.audio.resetNodes();
  DAW.project.tracks = [];
  DAW.history.reset();

  const ui=DAW.ui;
  const ctx=DAW.audio.ensureCtx(), SR=ctx.sampleRate;
  const t=(f)=>{const s=performance.now(); f(); return performance.now()-s;};
  const ta=async(f)=>{const s=performance.now(); await f(); return performance.now()-s;};

  // 4秒の素材を1つ作り、全クリップで共有する（実際の使い方に近い）
  const buf=ctx.createBuffer(2,SR*4,SR);
  for(let c=0;c<2;c++){const d=buf.getChannelData(c);
    for(let i=0;i<d.length;i++)d[i]=0.5*Math.sin(2*Math.PI*220*i/SR)*Math.exp(-3*((i/SR)%0.5));}
  const tBuf=t(()=>DAW.registerBuffer(buf));
  const bid=[...DAW.buffers.keys()][0];
  B('B.1 4秒素材の登録（ピーク計算込み）',true,tBuf.toFixed(1)+'ms');

  DAW.project.tracks=[];
  const TRACKS=20, CLIPS=40;
  for(let i=0;i<TRACKS;i++){
    const tr=DAW.addTrack('T'+i);
    for(let j=0;j<CLIPS;j++) tr.clips.push({id:DAW.uid(),bufferId:bid,startTime:j*4.5,offset:0,duration:4,name:'c'+j,fadeIn:0.1,fadeOut:0.2});
  }
  B('B.2 規模',true,TRACKS+'トラック × '+CLIPS+'クリップ = '+(TRACKS*CLIPS)+'クリップ / 全長'+DAW.projectDuration()+'秒');

  ui.setZoom(100);
  const tRender=t(()=>ui.renderTracks());
  B('B.3 全描画 renderTracks',tRender<2000,tRender.toFixed(1)+'ms');
  const tRender2=t(()=>ui.renderTracks());
  B('B.4 2回目の全描画',true,tRender2.toFixed(1)+'ms');
  const tWaves=t(()=>ui.refreshVisibleWaves());
  B('B.5 スクロール1回ぶんの波形再描画',tWaves<200,tWaves.toFixed(1)+'ms');
  const tRuler=t(()=>ui.drawRuler());
  B('B.6 ルーラー描画',true,tRuler.toFixed(1)+'ms');

  ui.setZoom(1600);
  const tWavesZoom=t(()=>ui.refreshVisibleWaves());
  B('B.7 最大倍率での波形再描画（可視範囲方式の効果）',tWavesZoom<200,tWavesZoom.toFixed(1)+'ms');
  ui.setZoom(4);
  const tWavesOut=t(()=>ui.refreshVisibleWaves());
  B('B.8 最小倍率での波形再描画',tWavesOut<400,tWavesOut.toFixed(1)+'ms');
  ui.setZoom(100);

  const tSnap=t(()=>{for(let i=0;i<50;i++) DAW.history.commit(), DAW.project.tracks[0].volume=Math.random();});
  B('B.9 履歴スナップショット50回',true,tSnap.toFixed(1)+'ms（1回あたり '+(tSnap/50).toFixed(2)+'ms）');
  B('B.10 履歴のメモリ目安',true,'スナップショット1件 = '+(DAW.history.cur.json.length/1024).toFixed(0)+'KB');

  const tPlay=await ta(async()=>{await DAW.audio.play();});
  B('B.11 再生開始（800クリップのスケジューリング）',tPlay<3000,tPlay.toFixed(1)+'ms sources='+DAW.audio.sources.length);
  DAW.audio.stop();

  // 書き出し（実時間の何倍速で書き出せるか）
  window.confirm=()=>true; DAW.wav.download=()=>{};
  const tExport=await ta(async()=>{await DAW.wav.exportMix();});
  const dur=DAW.projectDuration();
  B('B.12 WAV書き出し',true,tExport.toFixed(0)+'ms で '+dur.toFixed(0)+'秒ぶん = 実時間の '+(dur*1000/tExport).toFixed(0)+'倍速');

  // 保存/読み込み（音声はbase64埋め込み）
  let cap=null; DAW.wav.download=(b,f)=>{cap={b,f};};
  const tSave=t(()=>DAW.wav.saveProject());
  const txt=await cap.b.text();
  B('B.13 プロジェクト保存',true,tSave.toFixed(0)+'ms / '+(txt.length/1024/1024).toFixed(2)+'MB');
  const tLoad=await ta(async()=>{await DAW.wav.loadProject(new File([txt],'p.json'));});
  B('B.14 プロジェクト読み込み',true,tLoad.toFixed(0)+'ms');
  // スクロール追従の実測（画面外クリップが大半のケース）
  {
    const sc=ui.els.scroller;
    const times=[];
    for(let i=0;i<20;i++){ sc.scrollLeft=i*137; times.push(t(()=>ui.refreshVisibleWaves())); }
    const avg=times.reduce((a,b)=>a+b,0)/times.length;
    B('B.16 スクロール追従の平均（60fps = 16.7ms 以内が目標）',avg<16.7,avg.toFixed(1)+'ms/フレーム');
  }
  B('B.15 未捕捉エラーなし',H.errors.length===0,H.errors.join('|'));
  const added = H.tests.slice(n0);
  const failed = added.filter(x => !x.pass).length;
  if (failed) throw new Error(`${failed}/${added.length} 件が目標値を超過`);
  return `${added.length} 項目を計測`;
});

// =====================================================================
// オブジェクトベース音響の負荷計測（受け入れ条件6）。
// 128オブジェクト時の描画・音声の負荷を測る。
// =====================================================================
T('[BENCH] 128オブジェクトの負荷', async () => {
  const B = (name, cond, detail) => {
    H.tests.push({ name: '[BENCH] ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
  };
  const t = f => { const s = performance.now(); f(); return performance.now() - s; };
  const ta = async f => { const s = performance.now(); await f(); return performance.now() - s; };
  const n0 = H.tests.length;

  try { DAW.audio.stop(); } catch (e) {}
  DAW.audio.resetNodes();
  DAW.project.tracks = [];
  DAW.objects.clear();
  const ctx0 = DAW.audio.ensureCtx();
  const SR = ctx0.sampleRate;
  const buf = ctx0.createBuffer(1, SR, SR);
  {
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = 0.2 * Math.sin(2 * Math.PI * 220 * i / SR);
  }
  const bid = DAW.registerBuffer(buf);

  // 128トラック × 1クリップ、それぞれにオブジェクトを割り当てる
  const tCreate = t(() => {
    for (let i = 0; i < DAW.objects.MAX; i++) {
      const tr = DAW.addTrack('T' + i);
      tr.clips.push({ id: DAW.uid(), bufferId: bid, startTime: 0, offset: 0, duration: 1, name: 'c', fadeIn: 0, fadeOut: 0 });
      const o = DAW.objects.create('O' + i, tr.id);
      DAW.objects.setPosition(o.id, (i * 360 / 128) - 180, ((i % 19) - 9) * 10, 0.3 + (i % 7) / 10);
    }
  });
  B('OB.1 128オブジェクトの生成（トラック込み）', DAW.objects.count() === 128, tCreate.toFixed(1) + 'ms');

  const tTracks = t(() => DAW.ui.renderTracks());
  B('OB.2 タイムラインの全描画（128トラック）', tTracks < 3000, tTracks.toFixed(1) + 'ms');

  if (DAW.objui && DAW.objui.render) {
    const tView = t(() => DAW.objui.render());
    B('OB.3 パンナー画面の描画（トップビュー＋ストリップ）', tView < 500, tView.toFixed(1) + 'ms');
    const tView2 = t(() => DAW.objui.render());
    B('OB.4 2回目の描画', true, tView2.toFixed(1) + 'ms');
    const strips = document.querySelectorAll('#obj-strips .obj-strip, .obj-strip').length;
    B('OB.5 ストリップは可視ぶんだけ生成される', strips > 0 && strips <= 40, `DOM上のストリップ=${strips}本 / 128個`);
  }

  // 位置更新（ドラッグ相当）を128回
  const ids = DAW.objects.list.map(o => o.id);
  const tMove = t(() => { for (let i = 0; i < ids.length; i++) DAW.objects.setPosition(ids[i], i - 64, 0, 0.5); });
  B('OB.6 128オブジェクトの位置更新', tMove < 200, tMove.toFixed(1) + 'ms（1個あたり ' + (tMove / 128).toFixed(3) + 'ms）');

  // 等パワーでの再生開始（オブジェクトのノード生成を含む）
  DAW.objaudio.autoHrtf = false;
  DAW.objaudio.setModeQuiet(DAW.objaudio.MODE_EQUALPOWER);
  const tPlayEq = await ta(async () => { await DAW.audio.play(); });
  B('OB.7 再生開始（等パワー・128オブジェクト）', tPlayEq < 5000,
    tPlayEq.toFixed(0) + 'ms / ノード=' + DAW.objaudio.live.size);
  DAW.audio.stop();
  DAW.audio.resetNodes();

  // HRTF での再生開始（PannerNode 128個）
  DAW.objaudio.setModeQuiet(DAW.objaudio.MODE_HRTF);
  const tPlayHrtf = await ta(async () => { await DAW.audio.play(); });
  B('OB.8 再生開始（HRTF・128オブジェクト）', tPlayHrtf < 8000,
    tPlayHrtf.toFixed(0) + 'ms / ノード=' + DAW.objaudio.live.size);
  DAW.audio.stop();
  DAW.audio.resetNodes();
  DAW.objaudio.setModeQuiet(DAW.objaudio.MODE_EQUALPOWER);
  DAW.objaudio.autoHrtf = true;

  // 書き出し（128オブジェクト＋リミッター）
  DAW.wav.download = () => {};
  window.confirm = () => true;
  const tExport = await ta(async () => { await DAW.wav.exportMix(); });
  B('OB.9 書き出し（128オブジェクト・等パワー＋リミッター）', true,
    tExport.toFixed(0) + 'ms で ' + DAW.projectDuration().toFixed(1) + '秒ぶん = 実時間の '
    + (DAW.projectDuration() * 1000 / tExport).toFixed(1) + '倍速');

  // 保存/読み込み（128オブジェクトぶんのメタデータ）
  const json = JSON.stringify(DAW.objects.toJSON());
  B('OB.10 オブジェクトのメタデータ量', true, (json.length / 1024).toFixed(1) + 'KB / 128個');

  // 経路の補間（followPaths の中身）。128個 × 8waypoint を 60fps × 5秒ぶん = 300フレーム。
  // rAF 1フレームに収まるかの目安（1フレームあたり 128 回の pathPosAt）。
  for (const o of DAW.objects.list) {
    o.path.enabled = true;
    o.path.points = [];
    for (let k = 0; k < 8; k++) {
      o.path.points.push({ t: k * 2, az: (k * 45) % 360 - 180, el: (k % 3) * 30 - 30, dist: 0.5 + (k % 2) * 0.5,
        ease: DAW.objects.EASES[k % 4] });
    }
  }
  const tPath = t(() => {
    for (let f = 0; f < 300; f++) {
      const pos = f * 14 / 300;
      for (const o of DAW.objects.list) DAW.objects.pathPosAt(o, pos);
    }
  });
  B('OB.11 経路の補間 128個 × 300フレーム', tPath < 500,
    tPath.toFixed(1) + 'ms（1フレームあたり ' + (tPath / 300).toFixed(3) + 'ms）');

  DAW.objects.clear();
  DAW.project.tracks = [];
  DAW.ui.renderTracks();

  const added = H.tests.slice(n0);
  const failed = added.filter(x => !x.pass).length;
  if (failed) throw new Error(`${failed}/${added.length} 件が目標値を超過`);
  return `${added.length} 項目を計測`;
});
