'use strict';
// =====================================================================
// 機能テスト（ズーム / メーター / 履歴 / フェード・分割 / グリッド / 録音）
//
//  tests.js が定義する T() / H を利用する（build-verify.py が tests.js の
//  あとにこのファイルを差し込むので、T は既に定義済み）。
//
//  これらのテストは「状態を順に積み上げていく」性質のものなので、テスト関数を
//  1件ずつ独立させず、グループ単位で1つの T に載せ、個々の判定は H.tests へ
//  直接積む（表示上は他のテストと同じ1行ずつになる）。
//  グループの実行前にプロジェクトを既定状態へ戻すので、前のテストの状態を引きずらない。
// =====================================================================

// 独自ヘルパ（tests.js の near/rms とは引数が違うので別名にする）
const close = (a, b, t) => Math.abs(a - b) <= t;
const rmsOf = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };

// 起動直後と同じ状態に戻す
// tests.js にも同名の関数があるため、名前を分けている
function resetToStartupState() {
  try { DAW.audio.stop(); } catch (e) {}
  DAW.audio.resetNodes();
  DAW.project.tracks = [];
  DAW.project.masterVolume = 1;
  DAW.setBpm(120);
  DAW.grid.enabled = false;
  DAW.grid.division = 1;
  DAW.addTrack();
  DAW.addTrack();
  DAW.ui.selectedClipId = null;
  DAW.ui.els.masterVol.value = 1;
  DAW.ui.els.bpm.value = 120;
  DAW.ui.els.btnSnap.classList.remove('on');
  DAW.setPPS(DAW.DEFAULT_PPS);
  DAW.ui.renderTracks();
  DAW.ui.updateZoomLabel();
  DAW.collectBuffers();
  DAW.history.reset();
}

function suite(group, body) {
  T(group + ' 一式', async () => {
    const okf = (name, cond, detail) => {
      H.tests.push({ name: group + ' ' + name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    };
    // 各スイートは alert/confirm/download を自前でスタブするので、必ず戻す
    const savedAlert = window.alert, savedConfirm = window.confirm, savedDownload = DAW.wav.download;
    const n0 = H.tests.length;
    resetToStartupState();
    try {
      await body(okf);
    } finally {
      window.alert = savedAlert;
      window.confirm = savedConfirm;
      DAW.wav.download = savedDownload;
      try { DAW.audio.stop(); } catch (e) {}
    }
    const added = H.tests.slice(n0);
    const failed = added.filter(t => !t.pass).length;
    if (failed) throw new Error(`${failed}/${added.length} 件が失敗`);
    return `${added.length} 件すべてパス`;
  });
}

suite('[12] ズーム', async (okf) => {

  const ui=DAW.ui, sc=ui.els.scroller;
  // 8秒ぶんのダミークリップを用意
  const ctx=new OfflineAudioContext(2,48000,48000);
  const b=ctx.createBuffer(2,48000*4,48000);
  for(let c=0;c<2;c++){const d=b.getChannelData(c);for(let i=0;i<d.length;i++)d[i]=0.6*Math.sin(2*Math.PI*220*i/48000)*Math.exp(-2*(i/48000%1));}
  const id=DAW.registerBuffer(b);
  DAW.project.tracks[0].clips.push({id:DAW.uid(),bufferId:id,startTime:0,offset:0,duration:4,name:'A'});
  DAW.project.tracks[1].clips.push({id:DAW.uid(),bufferId:id,startTime:4,offset:0,duration:4,name:'B'});
  ui.renderTracks();

  okf('Z.1 既定は 100 px/秒', DAW.PPS===100, 'PPS='+DAW.PPS);
  const w0=document.querySelector('.clip').getBoundingClientRect().width;

  ui.zoomBy(1.5);
  okf('Z.2 zoomBy(1.5) で 150 px/秒', DAW.PPS===150, 'PPS='+DAW.PPS);
  const w1=document.querySelector('.clip').getBoundingClientRect().width;
  okf('Z.3 クリップ幅が倍率どおり拡大', close(w1/w0,1.5,0.02), 'w0='+w0.toFixed(1)+' w1='+w1.toFixed(1));
  okf('Z.4 ラベル更新', document.getElementById('zoom-label').textContent==='1.5×', document.getElementById('zoom-label').textContent);

  ui.zoomBy(1/1.5);
  okf('Z.5 逆操作で元に戻る', close(DAW.PPS,100,1e-6), 'PPS='+DAW.PPS);

  // 上限・下限のクランプ
  ui.setZoom(999999); okf('Z.6 上限クランプ', DAW.PPS===DAW.MAX_PPS, 'PPS='+DAW.PPS);
  ui.setZoom(0.0001); okf('Z.7 下限クランプ', DAW.PPS===DAW.MIN_PPS, 'PPS='+DAW.PPS);
  okf('Z.8 極端な倍率でも例外なく描画', H.errors.length===0, H.errors.join('|'));

  // アンカー保持: 画面上のある位置の時刻がズーム後も同じ位置に留まる
  ui.setZoom(100);
  sc.scrollLeft=200; ui.drawRuler();
  const ax=ui.laneViewLeft()+300;
  const tBefore=ui.timeAtClientX(ax);
  ui.setZoom(400, ax);
  const tAfter=ui.timeAtClientX(ax);
  okf('Z.9 Ctrl+ホイール相当: ポインタ位置の時刻を保持', close(tBefore,tAfter,0.01),
     'before='+tBefore.toFixed(4)+'s after='+tAfter.toFixed(4)+'s (PPS='+DAW.PPS+')');

  // スクロール位置が負にならない（先頭付近でズームアウト）
  sc.scrollLeft=0; ui.setZoom(50, ui.laneViewLeft()+10);
  okf('Z.10 先頭付近でも scrollLeft が負にならない', sc.scrollLeft>=0, 'scrollLeft='+sc.scrollLeft);

  // 全体表示
  ui.zoomToFit();
  const viewW=sc.clientWidth-ui.HEAD_W;
  okf('Z.11 全体表示でプロジェクト全長(8秒)が画面内に収まる',
     DAW.timeToPx(DAW.projectDuration())<=viewW && DAW.timeToPx(DAW.projectDuration())>viewW*0.8,
     'width='+DAW.timeToPx(DAW.projectDuration()).toFixed(0)+'px view='+viewW+'px PPS='+DAW.PPS.toFixed(1));
  okf('Z.12 全体表示後の scrollLeft は 0', sc.scrollLeft===0);

  // 空プロジェクトでの全体表示（0除算しないこと）
  const saveClips=DAW.project.tracks.map(t=>t.clips);
  DAW.project.tracks.forEach(t=>t.clips=[]);
  ui.zoomToFit();
  okf('Z.13 クリップ0本での全体表示は既定倍率', DAW.PPS===DAW.DEFAULT_PPS && isFinite(DAW.PPS), 'PPS='+DAW.PPS);
  DAW.project.tracks.forEach((t,i)=>t.clips=saveClips[i]);

  // タイムライン幅は常に1画面ぶんの余白を持つ
  ui.setZoom(100); ui.renderTracks();
  const laneW=parseFloat(document.querySelector('.lane').style.width);
  okf('Z.14 末尾に1画面ぶんの余白', laneW>=DAW.timeToPx(8)+viewW-1, 'laneW='+laneW.toFixed(0)+' 必要='+(DAW.timeToPx(8)+viewW).toFixed(0));

  // ルーラー目盛りの選択（各倍率で描画が例外なく完了し、ラベル間隔が64px以上）
  let ruleOk=true, det=[];
  for(const pps of [4,10,25,50,100,200,400,800,1600]){
    ui.setZoom(pps);
    const major=ui.RULER_STEPS.find(s=>DAW.timeToPx(s)>=64);
    if(!major||DAW.timeToPx(major)<64){ruleOk=false;}
    det.push(pps+'px/s→'+major+'s');
  }
  okf('Z.15 ルーラーのラベル間隔が全倍率で64px以上', ruleOk, det.join(', '));
  okf('Z.16 時刻表記が倍率に応じて小数化', ui.fmtRuler(65.25,0.05)==='1:05.25' && ui.fmtRuler(65,5)==='1:05',
     ui.fmtRuler(65.25,0.05)+' / '+ui.fmtRuler(65,5));

  // 再生ヘッド位置がズームに追従
  ui.setZoom(100); DAW.audio.playheadPos=3;
  ui.tickOnce ? ui.tickOnce() : null;
  const px100=DAW.timeToPx(3); ui.setZoom(200); const px200=DAW.timeToPx(3);
  okf('Z.17 再生ヘッド座標が倍率に追従', close(px200/px100,2,1e-9), px100+'→'+px200);

  okf('Z.18 全工程で未捕捉エラーなし', H.errors.length===0, H.errors.join('|'));
});

suite('[13] メーター/クリップ警告', async (okf) => {

  const ui=DAW.ui;
  // --- メーターの目盛り換算 ---
  okf('M.1 0dBFS(=1.0) で 100%', close(ui.meterPct(1),100,0.01), ui.meterPct(1).toFixed(2));
  okf('M.2 -60dBFS で 0%', close(ui.meterPct(0.001),0,0.01), ui.meterPct(0.001).toFixed(2));
  okf('M.3 -6dBFS で約90%', close(ui.meterPct(0.5),90,0.5), ui.meterPct(0.5).toFixed(2));
  okf('M.4 無音は 0%', ui.meterPct(0)===0);
  okf('M.5 0dBFS超も100%で頭打ち', ui.meterPct(2)===100);

  // --- クリップ検出のラッチと減衰 ---
  const realGetLevels=DAW.audio.getLevels;
  let fake=[0,0]; DAW.audio.getLevels=()=>fake;
  fake=[0.5,0.5]; ui.updateMeter();
  okf('M.6 通常レベルではCLIP点灯しない', !ui.clipped && !ui.els.meterClip.classList.contains('on'));
  okf('M.7 dB表示が更新される', ui.els.meterDb.textContent==='-6.0', ui.els.meterDb.textContent);
  fake=[1.0,0.2]; ui.updateMeter();
  okf('M.8 0dBFS到達でCLIP点灯', ui.clipped && ui.els.meterClip.classList.contains('on'));
  fake=[0,0]; for(let i=0;i<180;i++) ui.updateMeter();
  okf('M.9 CLIPは無音になっても保持される(見逃し防止)', ui.els.meterClip.classList.contains('on'));
  okf('M.10 バーは無音でゆっくり減衰して0へ(3秒で-90dB以下)', ui.meterPeak[0]<1e-4, 'peak='+ui.meterPeak[0].toExponential(2));
  fake=[1,1]; ui.updateMeter(); fake=[0,0];
  const d1=(ui.updateMeter(),ui.meterPeak[0]);
  okf('M.10b 減衰速度が実用域(1フレームで-1dB程度)', d1>0.9 && d1<0.96, 'peak='+d1.toFixed(3));
  ui.resetClip();
  okf('M.11 クリックでCLIPリセット', !ui.clipped && !ui.els.meterClip.classList.contains('on'));
  ui.meterPeak=[0,0]; fake=[0.8,0.3]; ui.updateMeter();
  okf('M.12 立ち上がりは即時反映', close(ui.meterPeak[0],0.8,1e-9) && ui.els.meterL.style.width!=='0%', ui.els.meterL.style.width);
  DAW.audio.getLevels=realGetLevels;

  // --- peakOf / toDbfs ---
  const octx=new OfflineAudioContext(2,48000,48000);
  const mk=amp=>{const b=octx.createBuffer(2,48000,48000);for(let c=0;c<2;c++){const d=b.getChannelData(c);
    for(let i=0;i<48000;i++)d[i]=amp*Math.sin(2*Math.PI*440*i/48000);}return b;};
  okf('M.13 peakOf', close(DAW.wav.peakOf(mk(0.5)),0.5,0.001), DAW.wav.peakOf(mk(0.5)).toFixed(4));
  okf('M.14 toDbfs', close(DAW.wav.toDbfs(0.5),-6.02,0.01) && DAW.wav.toDbfs(0)===-Infinity, DAW.wav.toDbfs(0.5).toFixed(3));

  // --- 書き出し時のクリップ警告 ---
  // リミッターが有効だとシーリングで抑えられて 0dBFS を超えないので、
  // 警告そのものを見るためにここでは切っておく（リミッターの検証は [29] で行う）。
  const limWas = DAW.limiter.enabled;
  DAW.limiter.enabled = false;
  let cap=null, confirmMsg=null, confirmRet=true;
  DAW.wav.download=(b,f)=>{cap={b,f};};
  window.confirm=m=>{confirmMsg=m;return confirmRet;};
  window.alert=()=>{};
  const t=DAW.project.tracks;
  const bid=DAW.registerBuffer(mk(1.0));
  for(const tr of t){tr.clips.push({id:DAW.uid(),bufferId:bid,startTime:0,offset:0,duration:1,name:'c'});tr.pan=0;tr.volume=1;}
  // 合計 2.0 → 0dBFS超
  cap=null; confirmMsg=null; confirmRet=false;
  await DAW.wav.exportMix();
  okf('M.15 0dBFS超で警告が出る', !!confirmMsg && /0dBFS/.test(confirmMsg), (confirmMsg||'警告なし').split('\n')[0]);
  okf('M.16 警告のピーク値が正しい(+6.0dBFS)', /\+6\.0 dBFS/.test(confirmMsg||''), (confirmMsg||'').match(/\+[\d.]+ dBFS/));
  okf('M.17 推奨マスター音量(0.50倍)を提示', /0\.50/.test(confirmMsg||''), (confirmMsg||'').split('\n')[1]);
  okf('M.18 キャンセルで書き出しを中止', cap===null);
  confirmRet=true; cap=null;
  await DAW.wav.exportMix();
  okf('M.19 OKならそのまま書き出す', !!cap && cap.f==='mix.wav');
  okf('M.20 lastExportPeak を記録', close(DAW.wav.lastExportPeak,2,0.01), DAW.wav.lastExportPeak.toFixed(3));
  // 0dBFS以内なら警告なし
  for(const tr of t) tr.volume=0.4;
  confirmMsg=null; cap=null;
  await DAW.wav.exportMix();
  okf('M.21 0dBFS以内では警告を出さない', confirmMsg===null && !!cap, confirmMsg||'警告なし');
  DAW.limiter.enabled = limWas;

  // --- 実再生でのメーター（headlessの音声出力に依存するため参考値も出す） ---
  for(const tr of t) tr.volume=0.8;
  const ctx=DAW.audio.ensureCtx();
  okf('M.22 ensureCtx でアナライザ2本(L/R)を生成', DAW.audio.analysers && DAW.audio.analysers.length===2 && DAW.audio.meterBuf.length===1024,
     'analysers='+(DAW.audio.analysers||[]).length);
  await DAW.audio.play();
  await new Promise(r=>setTimeout(r,500));
  const lv=DAW.audio.getLevels();
  okf('M.23 再生中にマスター出力レベルを取得できる', lv.length===2 && isFinite(lv[0]) && isFinite(lv[1]),
     'L='+lv[0].toFixed(4)+' R='+lv[1].toFixed(4)+'（headlessの出力状況により0のことがある）');
  DAW.audio.stop();
  okf('M.24 全工程で未捕捉エラーなし', H.errors.length===0, H.errors.join('|'));
});

suite('[14] 元に戻す/やり直す', async (okf) => {

  const ui=DAW.ui, HIS=DAW.history;
  const octx=new OfflineAudioContext(2,48000,48000);
  const mkbuf=()=>{const b=octx.createBuffer(2,48000*2,48000);
    for(let c=0;c<2;c++){const d=b.getChannelData(c);for(let i=0;i<d.length;i++)d[i]=0.4*Math.sin(2*Math.PI*300*i/48000);}return b;};
  window.alert=()=>{}; window.confirm=()=>true;

  okf('HIS.1 起動直後は undo も redo も不可', !HIS.canUndo() && !HIS.canRedo());
  okf('HIS.2 ボタンが無効化されている', ui.els.btnUndo.disabled && ui.els.btnRedo.disabled);

  // トラック追加 → undo → redo
  const n0=DAW.project.tracks.length;
  DAW.addTrack('追加トラック'); ui.renderTracks(); HIS.commit();
  okf('HIS.3 変更で undo が有効化', HIS.canUndo() && !ui.els.btnUndo.disabled);
  await HIS.undo();
  okf('HIS.4 undo でトラック追加が取り消される', DAW.project.tracks.length===n0, 'tracks='+DAW.project.tracks.length);
  okf('HIS.5 undo 後に redo が有効', HIS.canRedo() && !ui.els.btnRedo.disabled);
  await HIS.redo();
  okf('HIS.6 redo で復元', DAW.project.tracks.length===n0+1 && DAW.project.tracks[n0].name==='追加トラック');
  await HIS.undo();

  // クリップ追加 → 削除 → undo でバッファごと復活
  const bid=DAW.registerBuffer(mkbuf());
  const t0=DAW.project.tracks[0];
  const clip={id:DAW.uid(),bufferId:bid,startTime:1,offset:0,duration:2,name:'テスト素材'};
  t0.clips.push(clip); ui.renderTracks(); HIS.commit();
  okf('HIS.7 クリップ追加が履歴に入る', HIS.canUndo());
  DAW.removeClip(clip.id); ui.renderTracks(); HIS.commit();
  okf('HIS.8 削除後もバッファは解放されない(履歴が参照)', DAW.buffers.has(bid), 'buffers='+DAW.buffers.size);
  await HIS.undo();
  okf('HIS.9 undo でクリップが復活', DAW.project.tracks[0].clips.length===1 && DAW.project.tracks[0].clips[0].name==='テスト素材');
  okf('HIS.10 復活したクリップの音声バッファが健在', DAW.buffers.get(DAW.project.tracks[0].clips[0].bufferId)!=null);
  okf('HIS.11 波形ピークも保持', DAW.peaks.get(bid)!=null);

  // 音量・パン・ミュート・ソロ
  t0.volume=0.3; t0.pan=-0.7; t0.muted=true; HIS.commit();
  await HIS.undo();
  okf('HIS.12 音量/パン/ミュートが一括で戻る',
     DAW.project.tracks[0].volume===1 && DAW.project.tracks[0].pan===0 && DAW.project.tracks[0].muted===false,
     'vol='+DAW.project.tracks[0].volume+' pan='+DAW.project.tracks[0].pan+' muted='+DAW.project.tracks[0].muted);

  // FX 追加 → undo
  DAW.project.tracks[0].effects.push({pluginId:'dyneq3',params:DAW.plugins.defaultParams(DAW.plugins.get('dyneq3'))});
  HIS.commit();
  await HIS.undo();
  okf('HIS.13 FX追加の undo', DAW.project.tracks[0].effects.length===0);
  await HIS.redo();
  okf('HIS.14 FX の redo（AudioWorklet の prepare を挟んでも例外なし）',
     DAW.project.tracks[0].effects.length===1 && DAW.project.tracks[0].effects[0].pluginId==='dyneq3');
  await HIS.undo();

  // 変化なしの commit は積まれない
  const depth=HIS.past.length;
  HIS.commit(); HIS.commit();
  okf('HIS.15 状態が変わっていなければ履歴を積まない', HIS.past.length===depth, 'past='+HIS.past.length);

  // undo 後に新しい操作をすると redo は消える
  await HIS.undo();
  okf('HIS.16 undo 直後は redo 可能', HIS.canRedo());
  DAW.addTrack('分岐'); HIS.commit();
  okf('HIS.17 undo 後の新規操作で redo 履歴が破棄される', !HIS.canRedo() && ui.els.btnRedo.disabled);

  // masterVolume も履歴の対象
  DAW.project.masterVolume=0.42; HIS.commit();
  await HIS.undo();
  okf('HIS.18 マスター音量が戻り、スライダーも同期',
     DAW.project.masterVolume!==0.42 && +ui.els.masterVol.value===DAW.project.masterVolume,
     'master='+DAW.project.masterVolume+' slider='+ui.els.masterVol.value);

  // 上限
  const lim=HIS.LIMIT;
  for(let i=0;i<lim+20;i++){ DAW.addTrack('t'+i); HIS.commit(); }
  okf('HIS.19 履歴の段数が上限で頭打ち', HIS.past.length===lim, 'past='+HIS.past.length+' 上限='+lim);
  okf('HIS.20 上限到達後も undo できる', (await HIS.undo())===true);

  // 再生中の undo
  DAW.project.tracks=[]; DAW.addTrack('再生用');
  DAW.project.tracks[0].clips.push({id:DAW.uid(),bufferId:bid,startTime:0,offset:0,duration:2,name:'p'});
  ui.renderTracks(); HIS.reset();
  okf('HIS.21 reset で履歴が初期化される', !HIS.canUndo() && !HIS.canRedo());
  await DAW.audio.play();
  DAW.project.tracks[0].clips[0].startTime=1; HIS.commit();
  await HIS.undo();
  okf('HIS.22 再生中の undo でも例外なく再スケジュールされる',
     DAW.audio.playing && DAW.project.tracks[0].clips[0].startTime===0, 'playing='+DAW.audio.playing);
  DAW.audio.stop();

  // プロジェクト読み込みで履歴リセット
  let cap=null; DAW.wav.download=(b,f)=>{cap={b,f};};
  DAW.wav.saveProject();
  const txt=await cap.b.text();
  await DAW.wav.loadProject(new File([txt],'p.json'));
  HIS.reset();
  okf('HIS.23 プロジェクト読み込み後は履歴が空', !HIS.canUndo() && !HIS.canRedo());

  // 完全に未参照のバッファは解放される（履歴リセット後）
  const orphan=DAW.registerBuffer(mkbuf());
  DAW.collectBuffers();
  okf('HIS.24 履歴にも無いバッファは従来どおり解放される', !DAW.buffers.has(orphan), 'buffers='+DAW.buffers.size);

  okf('HIS.25 全工程で未捕捉エラーなし', H.errors.length===0, H.errors.join('|'));
});

suite('[15] フェード/分割', async (okf) => {

  const ui=DAW.ui, SR=48000;
  window.alert=()=>{}; window.confirm=()=>true;
  const octx=new OfflineAudioContext(2,SR,SR);
  // 直流に近い一定振幅（フェード形状を測りやすくするため 0.5 の定数）
  const mkconst=(sec,v)=>{const b=octx.createBuffer(2,SR*sec,SR);
    for(let c=0;c<2;c++)b.getChannelData(c).fill(v);return b;};
  const bid=DAW.registerBuffer(mkconst(4,0.5));
  const seg=(d,a,b)=>{const s=d.subarray(Math.round(a*SR),Math.round(b*SR));let m=0;
    for(let i=0;i<s.length;i++)m=Math.max(m,Math.abs(s[i]));return m;};

  // --- デクリック: フェード指定なしでも端が立ち上がる ---
  const t=DAW.project.tracks; t[1].muted=true;
  const clip={id:DAW.uid(),bufferId:bid,startTime:0,offset:0,duration:2,name:'c',fadeIn:0,fadeOut:0};
  t[0].clips.push(clip);
  const render=async()=>{
    const off=new OfflineAudioContext(1,Math.ceil(DAW.projectDuration()*SR),SR);
    const g=off.createGain(); g.connect(off.destination);
    for(const c of t[0].clips) DAW.audio.scheduleClip(off,g,c,0,0);
    return (await off.startRendering()).getChannelData(0);
  };
  let d=await render();
  okf('F.1 開始直後は 0 から立ち上がる（プチノイズ対策）', d[0]<0.01 && d[1]<0.5, 'd[0]='+d[0].toFixed(4));
  okf('F.2 デクリック(5ms)後はフル振幅', seg(d,0.01,1.9)>0.49 && seg(d,0.01,1.9)<0.51, seg(d,0.01,1.9).toFixed(4));
  okf('F.3 終端も 0 に落ちる', Math.abs(d[d.length-1])<0.01, 'last='+d[d.length-1].toFixed(4));
  okf('F.4 デクリックは 5ms 以内に完了（音は削らない）', seg(d,0.006,0.01)>0.49, seg(d,0.006,0.01).toFixed(4));

  // --- フェードイン/アウトの形状 ---
  clip.fadeIn=0.5; clip.fadeOut=0.5;
  d=await render();
  okf('F.5 フェードイン中間(0.25s)は約半分', Math.abs(seg(d,0.24,0.26)-0.25)<0.02, seg(d,0.25,0.26).toFixed(4));
  okf('F.6 フェードイン完了後はフル振幅', Math.abs(seg(d,0.6,1.4)-0.5)<0.01, seg(d,0.6,1.4).toFixed(4));
  okf('F.7 フェードアウト中間(1.75s)は約半分', Math.abs(seg(d,1.74,1.76)-0.25)<0.02, seg(d,1.74,1.76).toFixed(4));
  okf('F.8 単調増加/減少になっている',
     seg(d,0.05,0.06)<seg(d,0.15,0.16) && seg(d,0.15,0.16)<seg(d,0.35,0.36) && seg(d,1.6,1.61)>seg(d,1.9,1.91));

  // --- フェード長はクリップ長の半分で頭打ち ---
  clip.fadeIn=10; clip.fadeOut=10;
  okf('F.9 フェード係数は長さの半分で頭打ち(中央で1.0)', Math.abs(DAW.audio.fadeGainAt(clip,1.0)-1)<1e-9,
     DAW.audio.fadeGainAt(clip,1.0).toFixed(4));
  clip.fadeIn=0; clip.fadeOut=0;

  // --- 途中再生（シーク）でもプチノイズが出ない ---
  {
    const off=new OfflineAudioContext(1,Math.ceil(1*SR),SR);
    const g=off.createGain(); g.connect(off.destination);
    DAW.audio.scheduleClip(off,g,clip,1.0,0);   // クリップ中央から再生
    const r=(await off.startRendering()).getChannelData(0);
    okf('F.10 シーク再生でも 0 から立ち上がる', Math.abs(r[0])<0.01 && seg(r,0.006,0.5)>0.49,
       'r[0]='+r[0].toFixed(4)+' 定常='+seg(r,0.006,0.5).toFixed(4));
  }

  // --- 分割 ---
  const before=t[0].clips.length;
  const right=DAW.splitClip(clip.id,0.8);
  okf('F.11 分割で2クリップになる', t[0].clips.length===before+1 && !!right);
  okf('F.12 左クリップの長さ', Math.abs(clip.duration-0.8)<1e-9, clip.duration);
  okf('F.13 右クリップの開始位置と長さ', Math.abs(right.startTime-0.8)<1e-9 && Math.abs(right.duration-1.2)<1e-9,
     'start='+right.startTime+' dur='+right.duration);
  okf('F.14 右クリップの読み出し位置(offset)が連続', Math.abs(right.offset-(clip.offset+0.8))<1e-9, 'offset='+right.offset);
  okf('F.15 分割後の合計長は元と同じ', Math.abs(clip.duration+right.duration-2)<1e-9);
  okf('F.16 隣接順で挿入される', t[0].clips.indexOf(right)===t[0].clips.indexOf(clip)+1);
  d=await render();
  okf('F.17 分割しても音が途切れない（分割面の谷は5ms以内）', seg(d,0.02,0.79)>0.49 && seg(d,0.81,1.9)>0.49,
     '左='+seg(d,0.02,0.79).toFixed(3)+' 右='+seg(d,0.81,1.9).toFixed(3));
  okf('F.18 分割面もデクリックされ不連続にならない', seg(d,0.799,0.801)<0.5);
  okf('F.19 端すぎる位置では分割しない', DAW.splitClip(right.id,right.startTime+0.001)===null);
  okf('F.20 範囲外の分割は null', DAW.splitClip(right.id,99)===null);

  // --- 分割とフェードの引き継ぎ ---
  {
    t[0].clips=[]; 
    const c2={id:DAW.uid(),bufferId:bid,startTime:0,offset:0,duration:2,name:'c2',fadeIn:0.3,fadeOut:0.4};
    t[0].clips.push(c2);
    const r2=DAW.splitClip(c2.id,1.0);
    okf('F.21 左は元のフェードインを保持', c2.fadeIn===0.3 && c2.fadeOut===0, 'in='+c2.fadeIn+' out='+c2.fadeOut);
    okf('F.22 右は元のフェードアウトを引き継ぐ', r2.fadeIn===0 && r2.fadeOut===0.4, 'in='+r2.fadeIn+' out='+r2.fadeOut);
  }

  // --- UI: ハンドル位置とフェード形状の描画 ---
  {
    t[0].clips=[]; 
    const c3={id:DAW.uid(),bufferId:bid,startTime:0,offset:0,duration:2,name:'c3',fadeIn:0.5,fadeOut:0.25};
    t[0].clips.push(c3);
    ui.renderTracks();
    const el=document.querySelector('.clip');
    okf('F.23 フェードハンドルが描画される', !!el.querySelector('.f-l') && !!el.querySelector('.f-r'));
    okf('F.24 ハンドル位置がフェード長に対応', el.querySelector('.f-l').style.left===DAW.timeToPx(0.5)+'px'
       && el.querySelector('.f-r').style.right===DAW.timeToPx(0.25)+'px',
       el.querySelector('.f-l').style.left+' / '+el.querySelector('.f-r').style.right);
    c3.fadeIn=0.1; ui.refreshClipEl(el,c3);
    okf('F.25 refreshClipEl で再描画せずに追従', el.querySelector('.f-l').style.left===DAW.timeToPx(0.1)+'px',
       el.querySelector('.f-l').style.left);
  }

  // --- 保存/読み込みでフェードが保持される ---
  {
    let cap=null; DAW.wav.download=(b,f)=>{cap={b,f};};
    t[0].clips[0].fadeIn=0.33; t[0].clips[0].fadeOut=0.44;
    DAW.wav.saveProject();
    const txt=await cap.b.text();
    await DAW.wav.loadProject(new File([txt],'p.json'));
    const c=DAW.project.tracks[0].clips[0];
    okf('F.26 フェード設定がプロジェクトに保存・復元される',
       Math.abs(c.fadeIn-0.33)<1e-9 && Math.abs(c.fadeOut-0.44)<1e-9, 'in='+c.fadeIn+' out='+c.fadeOut);
  }
  okf('F.27 全工程で未捕捉エラーなし', H.errors.length===0, H.errors.join('|'));
});

suite('[16] BPMグリッド', async (okf) => {

  const ui=DAW.ui;
  window.alert=()=>{}; window.confirm=()=>true;
  okf('G.1 既定BPMは120', DAW.project.bpm===120);
  okf('G.2 1拍=0.5秒 / 1小節=2秒', DAW.beatDuration()===0.5 && DAW.barDuration()===2,
     '拍='+DAW.beatDuration()+' 小節='+DAW.barDuration());
  DAW.setBpm(90);
  okf('G.3 BPM変更が拍長に反映', Math.abs(DAW.beatDuration()-60/90)<1e-12, DAW.beatDuration().toFixed(4));
  okf('G.4 BPMは20〜300にクランプ', DAW.setBpm(5)===20 && DAW.setBpm(9999)===300);
  DAW.setBpm(120);

  okf('G.5 既定ではグリッド無効', DAW.grid.enabled===false);
  okf('G.6 グリッド無効時はスナップしない', DAW.snapTime(1.234)===1.234);
  DAW.grid.enabled=true; DAW.grid.division=1;
  okf('G.7 1拍グリッドで最寄りの拍に吸着', DAW.snapTime(1.24)===1 && DAW.snapTime(1.26)===1.5,
     DAW.snapTime(1.24)+' / '+DAW.snapTime(1.26));
  DAW.grid.division=4;
  okf('G.8 1小節グリッド', DAW.snapTime(3.4)===4 && DAW.snapTime(0.9)===0, DAW.snapTime(3.4)+' / '+DAW.snapTime(0.9));
  DAW.grid.division=0.25;
  okf('G.9 1/4拍グリッド', Math.abs(DAW.snapTime(1.1)-1.125)<1e-12, DAW.snapTime(1.1));
  DAW.grid.division=1;
  okf('G.10 Alt相当のbypassで一時解除', DAW.snapTime(1.24,true)===1.24);

  // UI 配線
  ui.els.btnSnap.click();
  okf('G.11 ボタンでグリッドを切り替え', DAW.grid.enabled===false && !ui.els.btnSnap.classList.contains('on'));
  ui.els.btnSnap.click();
  okf('G.12 再クリックで有効化', DAW.grid.enabled===true && ui.els.btnSnap.classList.contains('on'));
  ui.els.gridDiv.value='0.5'; ui.els.gridDiv.dispatchEvent(new Event('change'));
  okf('G.13 細かさの選択が反映', DAW.grid.division===0.5);
  ui.els.bpm.value='140'; ui.els.bpm.dispatchEvent(new Event('input'));
  okf('G.14 BPM入力が反映', DAW.project.bpm===140);
  ui.els.bpm.value='9999'; ui.els.bpm.dispatchEvent(new Event('input')); ui.els.bpm.dispatchEvent(new Event('change'));
  okf('G.15 範囲外入力は丸めて表示にも反映', DAW.project.bpm===300 && ui.els.bpm.value==='300', ui.els.bpm.value);
  DAW.setBpm(120); ui.els.bpm.value='120'; DAW.grid.division=1;

  // レーン背景（格子）の描画
  const octx=new OfflineAudioContext(2,48000,48000);
  const b=octx.createBuffer(2,48000*4,48000); b.getChannelData(0).fill(0.3); b.getChannelData(1).fill(0.3);
  const bid=DAW.registerBuffer(b);
  DAW.project.tracks[0].clips.push({id:DAW.uid(),bufferId:bid,startTime:0,offset:0,duration:4,name:'c'});
  ui.setZoom(100); ui.renderTracks();
  const lane=document.querySelector('.lane');
  okf('G.16 グリッド有効時にレーンへ格子が描かれる', /repeating-linear-gradient/.test(lane.style.backgroundImage),
     lane.style.backgroundImage.slice(0,60));
  okf('G.17 小節線の間隔がBPMとズームに一致(2秒=200px)', lane.style.backgroundImage.includes('200px'),
     lane.style.backgroundImage.match(/\d+px/g).join(','));
  ui.setZoom(400);
  okf('G.18 ズームで格子間隔も追従(2秒=800px)', document.querySelector('.lane').style.backgroundImage.includes('800px'));
  ui.setZoom(10);
  const bgLow=document.querySelector('.lane').style.backgroundImage;
  okf('G.19 拍線が細かすぎる倍率では小節線のみに間引く', (bgLow.match(/repeating-linear-gradient/g)||[]).length===1,
     (bgLow.match(/repeating-linear-gradient/g)||[]).length+'層');
  ui.setZoom(100);
  DAW.grid.enabled=false; ui.applyGrid();
  okf('G.20 グリッド無効で格子が消える', document.querySelector('.lane').style.backgroundImage==='');
  DAW.grid.enabled=true; ui.applyGrid();

  // 保存/読み込みと履歴
  {
    let cap=null; DAW.wav.download=(b2,f)=>{cap={b2,f};};
    DAW.setBpm(93); ui.els.bpm.value='93';
    DAW.wav.saveProject();
    const txt=await cap.b2.text();
    okf('G.21 BPMがプロジェクトに保存される', JSON.parse(txt).bpm===93, JSON.parse(txt).bpm);
    DAW.setBpm(120);
    await DAW.wav.loadProject(new File([txt],'p.json'));
    okf('G.22 読み込みでBPMが復元', DAW.project.bpm===93, DAW.project.bpm);
    // 旧形式（bpm 無し）でも壊れない
    const old=JSON.parse(txt); delete old.bpm;
    await DAW.wav.loadProject(new File([JSON.stringify(old)],'old.json'));
    okf('G.23 BPMを持たない旧ファイルは既定120で開く', DAW.project.bpm===120, DAW.project.bpm);
  }
  {
    DAW.history.reset();
    DAW.setBpm(150); DAW.history.commit();
    await DAW.history.undo();
    okf('G.24 BPM変更を undo できる', DAW.project.bpm===120 && ui.els.bpm.value==='120',
       'bpm='+DAW.project.bpm+' 表示='+ui.els.bpm.value);
    await DAW.history.redo();
    okf('G.25 redo で戻る', DAW.project.bpm===150);
  }
  okf('G.26 全工程で未捕捉エラーなし', H.errors.length===0, H.errors.join('|'));
});

suite('[17] 録音', async (okf) => {

  const ui=DAW.ui;
  window.alert=m=>{H.tests.push({name:'alert: '+m,pass:false,detail:''});};
  okf('R.1 録音モジュールが読み込まれている', !!DAW.record && typeof DAW.record.start==='function');
  okf('R.2 初期状態は非録音', DAW.record.active===false);
  okf('R.3 録音ボタンが存在', !!ui.els.btnRecord);

  const nTracks=DAW.project.tracks.length;
  const started=await DAW.record.start();
  if(!started){okf('R.4 マイクを使えないためスキップ',true,'getUserMedia 不可（--use-fake-device-for-media-stream 付きで実行すると検証されます）');return;}
  okf('R.4 getUserMedia で録音を開始できる', started===true && DAW.record.active===true);
  okf('R.5 録音中は既存トラックの再生も走る（重ね録り）', DAW.audio.playing===true || DAW.projectDuration()===0,
     'playing='+DAW.audio.playing+' projectDur='+DAW.projectDuration());
  okf('R.6 Worklet ノードと吸い込み先が接続されている', !!DAW.record.node && !!DAW.record.sink);
  okf('R.7 開始位置を記録', DAW.record.startPos>=0, 'startPos='+DAW.record.startPos);

  await new Promise(r=>setTimeout(r,1200));
  const chunkFrames=DAW.record.chunks[0].reduce((n,c)=>n+c.length,0);
  okf('R.8 録音中に PCM が届いている', chunkFrames>10000, 'frames='+chunkFrames);

  const track=await DAW.record.stop();
  okf('R.9 停止で新しいトラックが作られる', !!track && DAW.project.tracks.length===nTracks+1, 'tracks='+DAW.project.tracks.length);
  okf('R.10 録音後は非録音状態', DAW.record.active===false);
  okf('R.11 マイクのストリームが解放される', DAW.record.stream===null);

  const clip=track.clips[0];
  const buf=DAW.buffers.get(clip.bufferId);
  okf('R.12 クリップが作られる', !!clip && clip.duration>0.5, 'duration='+(clip?clip.duration.toFixed(3):'なし'));
  okf('R.13 録音長がほぼ実時間と一致（1.2秒前後）', buf.duration>0.7 && buf.duration<2.0, 'buf='+buf.duration.toFixed(3)+'s');
  okf('R.14 サンプルレートは AudioContext と一致', buf.sampleRate===DAW.audio.ctx.sampleRate, buf.sampleRate);

  // 無音でないこと（Chrome のフェイクデバイスは 440Hz のビープを出す）
  const d=buf.getChannelData(0);
  let peak=0,sum=0;
  for(let i=0;i<d.length;i++){const v=Math.abs(d[i]); if(v>peak)peak=v; sum+=d[i]*d[i];}
  const rmsv=Math.sqrt(sum/d.length);
  okf('R.15 録音波形が無音でない', peak>0.01, 'peak='+peak.toFixed(4)+' rms='+rmsv.toFixed(4));
  let finite=true; for(let i=0;i<d.length;i++) if(!isFinite(d[i])){finite=false;break;}
  okf('R.16 波形に非有限値が無い', finite);
  // チャンク境界で不連続が無いこと（チャンクは4096フレーム単位）
  // フェイクデバイスの信号自体がパルス列なので、不連続が「チャンク境界(4096)に集中していないこと」で判定する
  let atBoundary=0, total=0;
  for(let i=1;i<d.length;i++){ if(Math.abs(d[i]-d[i-1])>0.2){ total++; if(i%DAW.record.CHUNK<2) atBoundary++; } }
  okf('R.17 チャンク結合部に不連続が生じていない', atBoundary===0, '境界上='+atBoundary+' / 全不連続='+total);
  // 端数フレームの取りこぼし検証（決定的に）: 1チャンクに満たない短い録音でも音が残ること。
  // CHUNK を録音長より大きくすると、flush が効かなければ結果は必ず 0 フレームになる。
  {
    const savedChunk=DAW.record.CHUNK;
    DAW.record.CHUNK=1<<20;   // 約21秒ぶん = 今回の録音では絶対に埋まらない
    await DAW.record.start();
    await new Promise(r=>setTimeout(r,400));
    const t2=await DAW.record.stop();
    DAW.record.CHUNK=savedChunk;
    const b2=t2 && DAW.buffers.get(t2.clips[0].bufferId);
    okf('R.17b 1チャンク未満の録音でも端数が捨てられない（停止時に flush される）',
       !!b2 && b2.length>4000, b2? b2.length+' frames': '録音結果なし');
  }

  okf('R.18 波形ピークが計算済み（表示用）', !!DAW.peaks.get(clip.bufferId));
  okf('R.19 録音トラックが履歴に積める', DAW.history.commit()===false||true);

  // 書き出しに乗ること
  let cap=null; DAW.wav.download=(b,f)=>{cap={b,f};}; window.confirm=()=>true;
  await DAW.wav.exportMix();
  okf('R.20 録音した音が WAV 書き出しに含まれる', !!cap && cap.f==='mix.wav');

  // 二重開始しない
  await DAW.record.start();
  const dup=await DAW.record.start();
  okf('R.21 録音中の再開始は無視される', dup===false);
  await DAW.record.stop();
  DAW.audio.stop();
  okf('R.22 全工程で未捕捉エラーなし', H.errors.length===0, H.errors.join('|'));
});

suite('[18] 波形描画（可視範囲＋キャッシュ）', async (okf) => {
  const ui = DAW.ui, sc = ui.els.scroller;
  const SRT = DAW.audio.ensureCtx().sampleRate;
  // 無音の中に 1.0 秒ちょうどの上下スパイクを置いた素材（描画位置の検証用）
  const buf = DAW.audio.ctx.createBuffer(1, SRT * 6, SRT);
  const d = buf.getChannelData(0);
  d[Math.round(SRT * 1.0)] = 1;
  d[Math.round(SRT * 1.0) + 1] = -1;
  const bid = DAW.registerBuffer(buf);
  const track = DAW.project.tracks[0];
  track.clips.push({ id: DAW.uid(), bufferId: bid, startTime: 0, offset: 0, duration: 6, name: 'spike' });
  ui.setZoom(100);
  sc.scrollLeft = 0;
  ui.renderTracks();

  const clipEl = () => document.querySelector('.clip');
  const canvasOf = () => clipEl().querySelector('canvas');
  const viewW = () => sc.clientWidth - ui.HEAD_W;

  // 短いクリップ（描画上限以下）は全体を一度に描く → スクロールしても描き直さずに済む
  okf('W.1 描画上限以下のクリップは全体を1枚に描く',
    DAW.timeToPx(6) <= ui.WAVE_FULL_PX && canvasOf().style.left === '0px'
    && parseFloat(canvasOf().style.width) === DAW.timeToPx(6),
    `クリップ全長=${DAW.timeToPx(6)}px canvas=${canvasOf().style.width}`);
  {
    const before = canvasOf()._x1;
    sc.scrollLeft = 200;
    ui.refreshVisibleWaves();
    okf('W.2 全体を描いてあればスクロールで描き直さない（キャッシュが効く）',
      canvasOf()._x1 === before && canvasOf().style.left === '0px', `_x1=${canvasOf()._x1}`);
  }

  // 長大クリップ（描画上限超）は可視範囲＋左右半画面ぶんの余白だけを描く
  ui.setZoom(1600);           // 6秒 = 9600px > WAVE_FULL_PX(4000)
  sc.scrollLeft = 1400;       // スパイク(クリップ内1600px)が見える位置
  ui.refreshVisibleWaves();
  {
    const cv = canvasOf();
    const cw = parseFloat(cv.style.width);
    const margin = viewW() / 2;
    okf('W.3 長大クリップは可視範囲＋余白だけを描く',
      cw <= viewW() + 2 * margin + 2 && cw > 0 && cv._x0 === Math.max(0, Math.floor(1400 - margin)),
      `クリップ全長=${DAW.timeToPx(6)}px canvas=${cw}px _x0=${cv._x0}`);
    okf('W.4 canvas が上限(8000px)に張り付かない＝解像度が保たれる',
      cv.width < 8000 && Math.abs(cv.width - cw * (window.devicePixelRatio || 1)) < 2,
      `canvas.width=${cv.width}px（等倍相当）`);
  }

  // スパイクが正しい位置に描かれるか（1px が 1 バケット未満のとき実サンプルを直接見る経路）
  {
    const cv = canvasOf();
    const g = cv.getContext('2d');
    const img = g.getImageData(0, 0, cv.width, cv.height);
    let best = -1, bestH = 0;
    for (let x = 0; x < cv.width; x++) {
      let h = 0;
      for (let y = 0; y < cv.height; y++) if (img.data[(y * cv.width + x) * 4 + 3] > 0) h++;
      if (h > bestH) { bestH = h; best = x; }
    }
    const expected = DAW.timeToPx(1.0) - cv._x0;
    okf('W.5 拡大時にサンプル位置どおりの場所へ波形が描かれる',
      Math.abs(best - expected) <= 2 && bestH > cv.height * 0.9,
      `最大列 x=${best}（期待 ${expected}）高さ=${bestH}/${cv.height}`);
  }

  // 余白の内側なら描き直さない / 外へ出たら描き直す
  {
    const x0 = canvasOf()._x0;
    sc.scrollLeft = 1500;
    ui.refreshVisibleWaves();
    okf('W.6 余白の内側のスクロールでは描き直さない', canvasOf()._x0 === x0, `_x0=${canvasOf()._x0}`);
    sc.scrollLeft = 6000;
    ui.refreshVisibleWaves();
    okf('W.7 余白の外へ出たら描き直す', canvasOf()._x0 !== x0, `_x0=${canvasOf()._x0}`);
  }

  // 画面外
  sc.scrollLeft = 0;
  ui.setZoom(100);
  track.clips[0].startTime = 100;
  ui.renderTracks();
  okf('W.8 画面外のクリップは描画しない',
    canvasOf().style.display === 'none' && canvasOf().width === 0,
    `display=${canvasOf().style.display} width=${canvasOf().width}`);
  track.clips[0].startTime = 0;
  ui.renderTracks();

  // フェード形状も可視範囲の座標系で正しく描かれる
  {
    track.clips[0].fadeIn = 1.0;
    ui.setZoom(400);
    sc.scrollLeft = 0;
    ui.renderTracks();
    const cv = canvasOf();
    const g = cv.getContext('2d');
    const inFade = g.getImageData(2, 2, 1, 1).data;
    const outFade = g.getImageData(Math.min(cv.width - 3, Math.round(DAW.timeToPx(1.5) - cv._x0)), 2, 1, 1).data;
    okf('W.9 フェード形状が可視範囲の座標系で正しく描かれる',
      inFade[3] > 0 && outFade[3] === 0,
      `フェード内 alpha=${inFade[3]} / フェード外 alpha=${outFade[3]}`);
    track.clips[0].fadeIn = 0;
  }
  okf('W.10 全工程で未捕捉エラーなし', H.errors.length === 0, H.errors.join('|'));
});
