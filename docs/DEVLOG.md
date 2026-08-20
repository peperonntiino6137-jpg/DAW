# 開発ログ / 知見

このプロジェクトで得た判断理由と再利用可能な知見を残す。新しい作業を始める前にここを読むこと。

## 検証環境の制約（重要）

この開発環境には **git / gh / node / npm が無い**。使えるのは `python3`、`bash`、`google-chrome`（Headless）、`curl`、`unzip`。
そのため:

- リポジトリの取得は `curl https://codeload.github.com/<owner>/<repo>/zip/refs/heads/main` + `unzip` で行う。
- テストランナーは **node に依存させない**。Headless Chrome + python3 の簡易 HTTP サーバで完結させる。

## Headless Chrome でのテストで踏んだ罠

1. **`--dump-dom` + `--virtual-time-budget` は使えない。**
   OfflineAudioContext のレンダリング完了を待たずに DOM がダンプされ、テスト結果が `RUNNING` のまま取れなかった。
   → ページ側から `fetch('http://127.0.0.1:<port>/result', {method:'POST', mode:'no-cors', body: json})` で結果を送り、
   python3 の簡易サーバで受ける方式に変更した。`file://` オリジンからでも simple request なので送信できる。
   （スクリーンショット用途に限れば `--virtual-time-budget` + `--screenshot` は問題なく使える。）
2. **テストページの DOM を手書きすると本体と乖離する。**
   `DAW.ui.init()` は index.html にある要素が揃っている前提なので、UI を追加するたびにテストページが壊れた。
   → テストページは **index.html から生成**する（`href`/`src` を書き換え、`</body>` の直前にテストを差し込む）。
   スクリプトの追加・DOM の追加に自動追従する。
3. 起動フラグは `--headless=new --disable-gpu --no-sandbox --autoplay-policy=no-user-gesture-required --allow-file-access-from-files --user-data-dir=<一時ディレクトリ>`。
   `--autoplay-policy` を付けると AudioContext が `running` になり、実再生のレベル計測まで headless で確認できる。
4. ページ側にウォッチドッグ（一定時間で途中結果を送る）を必ず入れる。入れないとハング時に何も分からない。

## Web Audio 仕様で誤判定しやすい点

- **StereoPannerNode をハードパン（pan=±1）すると、ステレオ素材の L+R が片側に合算されて +6dB になる。**
  これは仕様どおりの挙動でバグではない。テストの期待値を「絶対値」で書くと誤検知する。
  音量やマスターの検証は **1.0 のときとの比** で判定すること。
- 合計が 0dBFS ちょうどのときサンプルが ±1.0 に触れるのは正常。クリップ判定のしきい値には余裕を持たせる。

## 設計上の判断

- **ズーム**: `DAW.PPS`（px/秒）を可変にし、`DAW.setPPS()` で 4〜1600 にクランプ。
  拡大縮小時は「画面上のアンカー位置にある時刻」を固定して `scrollLeft` を再計算する（Ctrl+ホイールでポインタ位置が動かない）。
  ルーラーは倍率に応じてラベル間隔を候補列（0.01〜1800 秒）から選び、常に 64px 以上・補助目盛りは 7px 以上を保つ。
- **メーター**: マスター後段に ChannelSplitter + AnalyserNode 2 本を分岐させて覗く（音の経路は変えない）。
  立ち上がりは即時、戻りは 1 フレームあたり 0.94 倍（約 -32dB/秒）。CLIP はラッチして、クリックするまで消えない（見逃し防止）。
- **書き出しのクリップ警告**: 16bit WAV 化で ±1.0 にクランプされるため、無警告で歪むのが最大の落とし穴だった。
  レンダリング後にピークを測り、超えていれば推奨マスター音量とともに `confirm()` で確認する。
- **Undo/Redo**: プロジェクト状態（masterVolume + tracks）の JSON スナップショット方式。音声バッファはコピーせず id 参照のみ。
  ただし `collectBuffers()` が履歴参照中のバッファを解放すると「削除 → 元に戻す」でバッファを失うため、
  `DAW.history.referencedBuffers()` を見て残すようにした。スライダー類は `input` ではなく `change` で 1 回だけ積む。

- **フェード / デクリック**: クリップごとに GainNode を挟み、`scheduleClip` の中でエンベロープを組む。
  ライブ再生と書き出しが同じ関数を通るので、聞こえ方が必ず一致する。
  端には常に最低 5ms のフェード（デクリック）を入れる。波形の途中で切ると必ず「プチッ」と鳴るため、
  ユーザーがフェード 0 を指定していても 5ms は残す。シークで途中から再生する場合も同様に立ち上げる。
  フェード長はクリップ長の半分で頭打ち（フェードイン/アウトが重ならないようにするため）。
- **分割**: `DAW.splitClip(clipId, t)` は同じ bufferId を共有したまま offset/duration を割るだけ（音声はコピーしない）。
  元のフェードアウトは右側が引き継ぎ、分割面は既定のデクリックに任せる。

- **録音**: MediaRecorder ではなく AudioWorklet で生 PCM を受ける。圧縮往復の劣化とエンコーダ起動分の頭ズレを避けるため。
  Worklet は出力が引かれないと `process()` が回らないので、ゲイン 0 のノード経由で destination に繋ぐ（モニタ音は返さない）。
  **停止時は Worklet に溜まった端数フレーム（最大 CHUNK-1 ≒ 85ms）が捨てられる**という不具合を実測で発見した。
  停止時に `port.postMessage('flush')` を送り、端数を吐き出させてから止めるように修正済み（応答が無い場合の 300ms タイムアウト付き）。
  headless テストは `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` で可能。
  ただしフェイクデバイスの信号は 97% が無音のパルス列なので、「サンプル間の不連続が無いこと」を素朴に assert すると誤検知する。
  チャンク境界（CHUNK の倍数）に不連続が集中していないか、で判定すること。

- **BPM グリッド**: 格子は canvas ではなくレーンの `background-image`（repeating-linear-gradient）で描く。
  DOM を増やさず、ズーム時も `renderTracks()` の中で再適用するだけで済む。
  拍線が細かすぎる倍率（6px 未満）では小節線だけに間引く。
  スナップはドラッグ処理の中で `DAW.snapTime()` を通すだけ。Alt 押下で一時解除できるようにした。
  BPM は `project.bpm` に持ち、保存・履歴の対象に含める（旧形式のファイルは既定 120 で開く）。

- **波形描画は「可視範囲だけ」を実サイズで描く**。クリップ全体を1枚の canvas に収める方式だと、
  高倍率では横幅が数万pxに達して上限（8000px）で潰れ、拡大しても波形がぼやけて編集の役に立たなかった。
  可視部だけなら常に等倍で描けるうえ、長いクリップでも描画量が画面幅で頭打ちになる。
  1px が 1 ピークバケット（512サンプル）未満まで拡大されたときは、ピーク配列ではなく実サンプルを直接見る。
  canvas はクリップ内 px の x0..x1 だけを覆うので、フェード形状の描画もその座標系へ変換する必要がある。

## テストの運用

- `bash test/run.sh` で全件実行（現在 254 項目 / 約5秒 / 失敗時 exit 1）。
- `test/tests.js` が中核ロジック、`test/tests-features.js` が機能テスト（ズーム/メーター/履歴/フェード・分割/グリッド/録音/波形描画）。
  `test/build-verify.py` は `tests.js` のあとに `tests-*.js` を名前順で差し込むので、スイートを増やすときは `test/tests-<名前>.js` を置くだけでよい。
- `tests.js` はテスト1件 = `T()` 1つ。`tests-features.js` は状態を積み上げる性質のため、グループ単位で 1 つの `T()` に載せ、
  個々の判定は `H.tests` へ直接積んでいる。グループ実行前に `resetToStartupState()` で起動直後の状態へ戻す。
- **注意**: `tests.js` と `tests-features.js` は同じグローバル空間を共有する（classic script）。
  同名の関数を定義すると後から読まれた方が勝ち、静かに壊れる（`resetProject` で実際に踏んだ）。ヘルパ名は必ず変えること。
- **`tests-*.js` は名前順に読み込まれる**。あるファイルで定義したヘルパを別のファイルから使うと、
  名前順によっては未定義で落ちる（`tests-edit.js` が `tests-features.js` の `suite()` を参照して実際に踏んだ）。
  共有ヘルパは `tests.js`（必ず最初に読まれる）に置くか、各ファイルで自己完結させること。
- 録音テストには `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` が必要（run.sh に組み込み済み）。
  マイクが使えない環境ではスキップ扱いになる。

- **クリップボード**: コピーは音声を複製せず `bufferId` を参照する。そのため履歴と同じ問題があり、
  `collectBuffers()` はクリップボードが参照するバッファも解放しないようにしている
  （全クリップを消してもコピー済みのものは貼り付けで復活できる）。

- **メトロノーム**: 再生開始時にクリック音（OscillatorNode + 短いエンベロープ）をまとめて予約する方式。
  rAF や setInterval で鳴らすとタイミングが揺れるため、Web Audio のスケジューラに任せる。
  マスターとは別のゲート（`metroGain` → destination）に出すので、マスター音量にも WAV 書き出しにも影響しない。
  クリップが 0 本でも `play()` するようにした（録音時にクリックだけ鳴らせないと使い物にならないため）。
  予約は再生位置から 5 分先まで（`METRO_HORIZON`）。120BPM で約600個の Oscillator を予約する程度なので実用上は問題ない。

## 性能（実測。`bash test/run.sh --bench` で再測定できる）

20トラック × 40クリップ = 800クリップ / 全長約3分のプロジェクトでの実測値（Headless Chrome）:

| 項目 | 実測 |
| --- | --- |
| 全描画 `renderTracks` | 約 44ms |
| スクロール追従（波形再描画） | 平均 2.0ms/フレーム |
| 再生開始（800クリップのスケジューリング） | 約 19ms |
| WAV 書き出し | 実時間の約 18 倍速 |
| プロジェクト保存 / 読み込み | 5ms / 20ms |
| 履歴スナップショット | 0.14ms（1件あたり約 99KB） |

改善の経緯（同じ罠を繰り返さないために）:

1. **`refreshVisibleWaves()` が O(クリップ数²) だった**。要素からクリップを引くのに `DAW.findClip()`（全走査）を
   使っていたため、800クリップでスクロール1フレーム 21ms。要素に `el._clip` を持たせて O(n) にした。
2. **クリップ全体を毎フレーム描き直していた**。描画上限（`WAVE_FULL_PX` = 4000px）以下のクリップは全体を一度に描いて
   キャッシュし、スクロールでは描き直さない。上限を超える長大クリップだけ「可視範囲＋左右半画面の余白」を描く。
   キャッシュの判定は「いま見えている範囲が描画済み範囲に収まっているか」で行う（描画予定範囲と比べると毎フレーム
   ずれて再描画されてしまう）。
3. **画面外スキップを消してしまい 4 倍遅くなった**（44ms → 313ms）。全体描画へ切り替えた際に可視判定を落としたのが原因。
   ベンチを回していなければ気付けなかった。性能に触る変更のあとは必ず `--bench` を回すこと。

- **ループ再生**: タイマーで折り返すと必ず継ぎ目が揺れるので、**区間の繰り返しを60秒先まで事前予約**する。
  そのために `scheduleClip` に打ち切り位置 `until` を足した。打ち切り時はデクリック（5ms）で落としてから切るので、
  継ぎ目にプチノイズも無音の穴も出ない（実測: 段差 0.0017 未満 / 無音 1.25ms）。
  再生位置は `getPos()` で区間内へ剰余を取って折り返す。ループ区間は Undo の対象にしない（ズームと同じ表示側の設定）。

## サブエージェントのレビューで見つかった実バグ（すべて修正済み・回帰テスト `test/tests-regress.js` で固定）

既存テストを全部パスしたまま入り込んでいた不具合。同じ種類のミスを繰り返さないために原因を残す。

1. **クリップ先頭 5ms 以内へシークすると、クリップ全体が減衰したまま鳴り、終端で不連続に飛ぶ**（最重要）。
   `scheduleClip` でデクリック用ランプとフェードインランプの**終点時刻が逆転**していた。
   AudioParam は自動化イベントを時刻順にソートするため、順序が入れ替わるとゲインが山なりに暴れて段差が残る。
   → イベントは必ず `last = Math.max(last, t)` で単調非減少に積む。ランプの目標値は「その終点時刻のエンベロープ値」にする。
   拡大表示でクリップ左端の数px右をクリックすると踏むので、実用上も頻発しうる経路だった。
2. **ズームのたびにイベントリスナが増殖**し、グリッド/メトロノームのトグルが効かなくなり Undo が多重実行された。
   原因は **Python の `str.replace()` を件数指定なしで使ったこと**。`this.updateZoomLabel();` が init/setZoom/zoomToFit の
   3箇所にあり、リスナ登録ブロックが全部にコピーされていた。
   → コード編集を一括置換で行うときは、置換対象が一意か必ず確認する（`count=1` を付けるか、前後の文脈込みで一意にする）。
3. **分割・トリムでフェード長がクリップ長の半分を超えたまま残り、表示と音が食い違う**。
   音側だけ `duration/2` にクランプしていた。→ `DAW.audio.fadeLengths(clip, withDeclick)` に規則を集約し、
   描画・ハンドル・再生が全部それを通るようにした。長さを変える経路では `DAW.clampFades(clip)` を呼ぶ。
4. **クリップ右端が画面外だとフェードアウトの陰影が描かれない**。可視範囲だけ描く方式にしたとき、
   canvas 幅 `w` とクリップ右端の canvas 座標 `right` を混同していた（`x1 === cssW` のときだけ偶然一致していた）。
5. **録音の頭が約50ms 前へずれる**。`play()` は `ctx.currentTime + 0.05` から鳴らし始めるのに、
   録音の取り込みはその前から始まっているため。→ 録音1フレーム目のタイムライン位置を
   `playStartPos + (取り込み開始 ctx 時刻 - playStartCtxTime)` で逆算し、負の分は `offset` で読み飛ばす。

**教訓**: 5件とも「既存テストが素通りする領域」に潜んでいた。テストが緑であることは正しさの証明にならない。
敵対的に「どう壊れるか」を先に考えてから検証コードを書くこと。

## オブジェクトベース音響（3Dパンナー）

仕様は「ADM (ITU-R BS.2076) 準拠の極座標をそのまま保持し、直交座標への変換はレンダラー層だけで行う」。
将来 ADM で書き出すときに変換が要らないようにするため、UI も保存形式も極座標のままにしてある。

- **座標規約**: azimuth 0°=正面、**正=左回り**、elevation 正=上、distance 0〜1。
  `x = -sin(az)cos(el)d, y = sin(el)d, z = -cos(az)cos(el)d`（Web Audio のリスナーは -z を向く）。
- **正規化**: |el| > 90 は「頭の裏へ回り込んだ」と解釈して `el' = 180-el, az' = az+180`。
  az は **(-180, 180]** に畳む（`180` を `-180` にしない。受け入れ条件が (az=180, el=40) を期待するため）。
- **オブジェクトと音源の対応**: 仕様のデータモデルには音源への参照が無いが、音を出すには必要なので
  `trackId` を追加した（仕様のフィールドは変更せず追加のみ）。`DAW.audio.trackDest()` が
  「オブジェクト割り当て済みならオブジェクトパンナー、未割り当てなら従来の StereoPanner」を返す。
  ライブ再生と書き出しが同じ関数を通るので、聞いた音と書き出した音が必ず一致する。
- **オブジェクトは点音源**なので、入口の GainNode で `channelCount=1, channelCountMode='explicit'` にして
  モノラルへ畳む（ステレオ素材の L/R を持ったまま定位させない）。
- **等パワーパン**: `p = -sin(az)cos(el)`（-1=左〜+1=右）から `L=cos((p+1)π/4), R=sin(...)`。
  仰角が上がるほど左右差が減る（真上の音は中央に聞こえる）。パワー保存 L²+R²=1。
- **HRTF 自動切替**: 「編集中は等パワー・試聴時のみ HRTF」を `wantedMode(playing)` に集約。
  ドラッグ中は `beginEdit()/endEdit()` で明示的に落とす。
- **落とし穴**: `seek()` は一度 `playing=false` にしてから非同期に `play()` し直すため、
  再スケジュール中に `playing` を読むと止まっているように見える。意図を知りたい側は
  **`DAW.audio.isPlaying()`（`playing || restarting`）** を使うこと。モード自動切替で実際に踏んだ。
- **lock の抜け道**: `lock='all'` のときに lock 自体まで変更禁止にすると、二度と解除できなくなる。
  `set()` は lock だけ許可判定の前に処理する（テストが検出した）。

### レンダラー: リミッターとスピーカー出力

- **リミッターは「先読み＋必要ゲインの最小値」で作る**。入力ごとに必要ゲイン `r[n]=min(1, ceiling/|x[n]|)` を出し、
  直近 L+1 サンプルの **最小値** を単調デックで求め、L サンプル遅れた信号に掛ける。
  掛けるゲインは必ず `r[n-L]` 以下なので、**シーリング超過が1サンプルも出ない**ことを保証できる。
  リリース（戻す方向）を緩やかにしても保証は壊れない。
- **書き出しでは AudioWorklet を使わない**。ライブの Worklet が生きている状態で HRTF を含む
  オフラインレンダリングを走らせると、レンダリングが極端に遅くなる現象を実測した（8秒でも終わらず、
  テストのウォッチドッグ90秒に到達）。書き出しにリアルタイム制約は無いので、レンダリング後に
  メインスレッドで同じ DSP を流す。**DSP 本体は `coreSource()` の1か所だけ**に持ち、
  Worklet 用モジュールもメインスレッド用クラスもそこから生成する（実装が割れると
  「聞いた音と書き出した音が違う」という最悪の不具合になる）。
- 先読みぶん出力が遅れるので、書き出しは長めにレンダリングして頭を捨てて整列させ、
  再生ヘッド表示は `DAW.audio.displayPos()` で同じだけ戻す。メーターはリミッター前から分岐している
  （どれだけ突っ込んでいるかが見えるほうが有用で、表示の遅延補正も要らない）。
- **0dBFS 警告はリミッターを切っているときだけ**出す。有効ならシーリングで抑えられるので警告は無意味。
- **VBAP は層構造で近似する**。正確な3D VBAP は三角形分割が要るが、実運用の配置（5.1 / 7.1.4）は
  水平層と上層に分かれているので「層内はペアVBAP、層間は仰角で等パワークロスフェード」で十分。
  パワー和は必ず 1 に正規化する。LFE へは送らない。
  スピーカー出力時は書き出しも配置のチャンネル数（5.1=6ch、7.1.4=12ch）になる。
  WAV エンコーダはチャンネル数をバッファから読むので、多チャンネル化は自然に通った。

### オブジェクトの width（MDAP / 2ソース化）

- width(%) → 広がり角は `|width|/100 × 90°`（100% で ±45°、200% で ±90°）。
- 入力の L/R を別々の方位へ振り分ける。**負の width は L/R を入れ替える**（仕様どおり）。
  モノラル素材なら同じ音が両側に出る（＝MDAP のスプレッド）。
- **落とし穴1**: `ChannelSplitter` は既定が `discrete` 解釈なので、**モノラル入力だと ch1 が無音**になり、
  片側だけ鳴る。`channelInterpretation='speakers'` の GainNode を挟んでから分けること。
- **落とし穴2**: 各ソースを単純に 0.5 倍にすると、モノラル素材（2ソースが同相で足し合わさる）の音量が
  width を広げるほど下がる（±90° で -3dB）。**両ソースのゲインを足したベクトルのパワーが 1 になるように正規化**する。
  width=0 の点音源（各ch 0.707）と連続的につながり、モノラルでもステレオでも音量が跳ねない。

### 出力形式の切り替え（UI ↔ レンダラー層の結線）

RENDERER 画面の「出力形式」ボタンが `DAW.objaudio.setMode()` を呼ぶ。配置ボタン（5.1 / 7.1.4）は
`setLayout()` を呼ぶだけなので、**出力形式がバイノーラルのままだと配置を変えても音は変わらない**。
そこを繋いでいないと「配置ボタンが効かない」ように見えるため、出力形式の選択を明示的に置いた。
UI は `objaudio.mode` を毎フレームの署名（`stateSig`）に含めて追従するので、
レンダラー層側から切り替えても表示がずれない。

### 受け入れ条件と対応するテスト（追跡用）

| # | 受け入れ条件 | 対応するテスト |
| --- | --- | --- |
| 1 | 保存→復元で全パラメータ一致（旧プロジェクト読込含む） | `[26] O.34〜O.37`（往復一致・objects 無しの旧形式・壊れたデータ） |
| 2 | az=±90°の書き出し波形で L/R 振幅差を数値検証（等パワー・HRTF両方） | `[27] A.13〜A.20`（等パワーは片側 231dB 差、HRTF は 4.9dB 差で左右対称） |
| 3 | (az=0, el=140) → (az=180, el=40) に正規化 | `[26] O.9〜O.15` |
| 4 | シーリング超過サンプルが書き出しに無い／遅延補正後の波形整列 | `[29] C.17〜C.21` |
| 5 | ドラッグ一連が Undo 1回で戻る | `[28]`（トップビュー）／`[32]`（3D球ビュー） |
| 6 | 128オブジェクト時の描画・音声負荷を --bench に追加 | `test/bench.js` の `[BENCH] OB.1〜OB.10` |

### オブジェクトノードの解放

`DAW.objaudio.reset()` は Map を空にするだけでは足りない。ノードはマスターに繋がったまま残って
処理され続けるので（モード切替のたびに積み上がる）、**必ず disconnect してから捨てる**こと。
モード切替を20回繰り返しても live が 0/1 に収まることをテストで固定した。

## 現状の未対応（次の候補）

- クロスフェード（クリップを重ねたときの自動処理）
- オブジェクトの位置オートメーション（キーフレーム → AudioParam のランプ変換）
- ADM (BS.2076) メタデータの書き出し
- 拍子の変更 / テンポチェンジ
- マスターリミッタ
- 録音の入力レイテンシ補正（再生基準とのズレは補正済みだが、マイク自体の遅延は未補正）
- 複数クリップの選択

## オブジェクトベース音響のUI（PANNER画面 / `js/objui.js`）

トップビュー（真上から）とオブジェクトストリップ。state は `DAW.objects` 一本で、
**ビュー側に値を複製して持たない**（トップビューとストリップで値がずれる事故を根絶するため）。
再描画の入口は **`DAW.objui.render()` の1つ**に集約してあるので、3D球ビューなどを足すときはここに並べる。

- **画面座標への変換**（`posToXY` / `xyToPos`）: `x = cx - R·d·sin(az)`, `y = cy - R·d·cos(az)`。
  画面の y は下向きなので **両方とも符号が反転する**。ここを素直に書くと鏡像（時計回りが正）になり、
  ADM の規約が崩れる。テストで4方位（上=0°・左=+90°・下=180°・右=-90°）を数値で固定してある。
- **undo 1エントリ**: ドラッグ中は `DAW.history.commit()` を呼ばず、**pointerup で1回だけ**呼ぶ
  （`js/ui.js` の `startClipDrag` と同じ方式）。`commit()` は差分が無ければ積まないので、
  移動を伴わない選択クリックでは履歴が増えない。
- **undo 後にオブジェクト実体が入れ替わる**: `DAW.history.apply()` は `DAW.objects.load()` を通るので
  配列の中身が作り直される。ストリップの DOM もイベントハンドラも **id で引く**こと。
  オブジェクト参照を握ったままだと、undo 後に「もう state に居ない実体」を書き換えて無反応になる。
- **ストリップの仮想化**: 1本 92px の絶対配置。`visibleRange()` が可視範囲（±1本）を返し、
  範囲外の DOM は捨てる。128本ぶん常に置くと入力欄が 128×6 個になり、生成もレイアウトも重い。
  実測: 1440px 幅で DOM 上のストリップは 11本（128個作っても）。
- **外部変更の検知**: undo やプロジェクト読み込みは `DAW.objui` を経由しないので、
  rAF で state の**数値ハッシュ署名**（`stateSig()`）を見て変わっていたら描き直す。
  フックを他ファイルに埋めずに同期が取れる（`js/ui.js` / `js/main.js` を触らずに済む）。
- **メーターは更新関数を分けてある**（`setPeak()` / `updateMeters()`、既定 30fps）。
  値はまだ 0（= -∞ 表示）。後日オブジェクトごとの実測ピークを流し込むだけで動く。
- **落とし穴**: body は `display:flex; column` なので、下にドックを足すだけでは
  `#scroller` の `min-height:auto`（中身より縮まない）に阻まれてドックが画面外へ押し出される。
  `#scroller { min-height: 0; }` が要る。
- **落とし穴**: 合成 PointerEvent では `setPointerCapture()` が NotFoundError で落ちる。
  実運用では必要なので try/catch で包む（テスト側でスタブを強要しない）。

## 3D球ビュー / RENDERER / メータリング（`js/objui.js` 続き・テスト `test/tests-objui2.js`）

PANNER の左に **3D球ビュー**（自前の透視投影）、RENDERER に **スピーカー配置の選択とマスターリミッターの自作ノブ**、
ストリップのピーク表示を **実測メーター** に接続した。スクリーンショット: `docs/img/obj-panner-3d.png` /
`docs/img/obj-renderer-3d.png`。

### 3D球ビュー

- **カメラはリスナーの「真後ろやや上」**（world `(0, D·sinφ, D·cosφ)`、φ=22°、D=3.2、球半径=1）から原点を見る。
  front が -z なので +z 側＝背後であり、**リスナーと同じ向きを見る**配置になる。これで ADM の +az（左）が
  そのまま画面の左に出る。カメラを正面（-z 側）に置くと左右が反転するので注意。
  - az=0（正面）… 画面中央のやや上・カメラから最も遠い / az=180（背後）… 中央のやや下・最も近い
  - φ=0 にすると正面と背面が画面上で重なって見分けられなくなる。仰角は必須。
- **極座標→直交座標は `DAW.objaudio.toCartesian()` を呼ぶだけ**にした。ビュー側に変換式を書くと
  規約が二重になり、片方だけ直すと鏡像になる（トップビューで一度踏んでいる轍）。逆変換 `fromCartesian()` は
  objui 側に置いた（レンダラー層は逆変換を必要としないため）。
- **描画は必ず奥行きの降順**（`sphereOrder()` が depth 降順の配列を返す）。選択中を最後に描く方式にすると
  奥の点が手前を上書きするので、**選択の強調も深度順のまま**にして、名前ラベルだけ最後に重ねている。
- **ドラッグは「掴んだ半球」を保持する**（`sdrag.near`）。画面→球面はレイと単位球の交点なので解が2つあり、
  常に手前を採ると**前半球へ行けなくなる**。pointerdown 時点の側（depth ≤ D か）を覚えて同じ根を選ぶ。
  球を外したら最接近点を球面へ正規化して輪郭に貼り付ける（角度が NaN にならない）。
- Undo は トップビューと同じく **pointerup で `commit()` 1回**。距離は変えない（トップビューの担当）。
- **落とし穴**: 260px 幅のペインでは「左 +90°」ラベルを輪郭の外側に出すと必ず見切れる。輪郭の内側に描く。
- **落とし穴**: ワイヤーフレームを線分ごとに `stroke()` すると 300回/フレーム走る。
  手前/奥の2本のパスにまとめて **stroke は2回**にした（128オブジェクトで render 全体 1.2ms）。

### RENDERER

- **スピーカー配置の定義は `DAW.objaudio.LAYOUTS` が正**。objui は `layoutTable()` 経由で参照し、
  無い場合だけ `FALLBACK_LAYOUTS` を使う。定義が二重にあると「画面の番号と実際の出力チャンネルが違う」
  という最悪の不具合になる。`renderRenderer()` は毎回 `DAW.objaudio.layoutName` を見て追従する
  （VBAP 側から配置を変えても表示がずれない）。
- **ノブは自作**（48px の canvas に 270° の円弧）。縦ドラッグ 170px でフルレンジ、Shift で 1/5、
  ダブルクリックで既定値。値は `DAW.limiter.set()` に渡すだけで範囲外は向こうが丸める。
- **リミッターの設定は履歴のスナップショットに入っていない**ので `commit()` は呼ばない（呼んでも
  差分ゼロで積まれないが、意図を明示するためコメントを残した）。プロジェクトに保存するようになったら
  `onKnobUp()` で1回だけ commit する。
- ヘッダーの `#obj-bypass` は枠のまま（既存テストが disabled を固定している）。リミッターのバイパスは
  RENDERER 内の `#obj-lim-byp` に置いた。

### メータリング

- `DAW.objaudio.peakDb(objId)` は**呼ばれたときだけ解析する**ので、**可視ストリップぶんだけ**呼ぶ
  （`this.strips` を回す = 仮想化の恩恵がそのままメーターにも効く。128個でも実測は 3〜11本ぶん）。
- **rAF は 30fps に間引く**（`updateMeters(now)` が更新したかを返すのでテストで間引きを確認できる）。
- ピークは **線形のまま** `peaks` に持つ（0 = -∞）。dB で持つと「既定値 0」が 0dBFS を意味してしまう。
- ヘッダーのドック側マスターメーターは `DAW.audio.getLevels()`（線形ピーク）を dB 目盛（-72dB=0%）で表示。
  タイムライン側のメーター（`js/ui.js`）とは独立に更新する。

### 検証

`test/tests-objui2.js` に 77 項目。投影の ADM 規約（az=0 が正面/az=+90 が左/el=+90 が上）を**画面座標の数値**で
固定し、描画順は `drawSphereObject` を差し替えて**実際の呼び出し順**を記録して確認している。
`requestAnimationFrame` は headless=new で発火しないので、rAF に依存せず更新関数を直接呼ぶこと。

## Windows (Git Bash) 対応（`test/run.sh`・2026-08-20）

Windows 11 + Git Bash で `bash test/run.sh` がタイムアウトしていた問題を修正。原因は3つ:

1. **file:// URL のパス形式**: chrome.exe（Windows ネイティブ）は Git Bash の POSIX パス
   `file:///c/Users/...` を `ERR_FILE_NOT_FOUND` にする。テストページが一切ロードされず、
   収集サーバが 180 秒待ってタイムアウトしていた。→ `cygpath -m` で `file:///C:/Users/...`
   形式に変換（`native_path()` ヘルパー。cygpath が無い Linux では無変換）。
   `--user-data-dir` も同様に変換。
2. **python3 が Microsoft Store のスタブ**: PATH 上の `python3` は実行すると Store 誘導で
   失敗する（rc=49）。→ `python3` → `python` の順に実際に `-c ''` を走らせて動くものを
   `$PYTHON` に採用。
3. **stdout が cp932**: Windows の python は標準出力エンコーディングが cp932 になり、
   テスト結果内の `≈` などで `UnicodeEncodeError`（表示も文字化け）。→ `PYTHONUTF8=1` を export。

ほか、CHROME 未指定時に Windows 標準のインストール先（`/c/Program Files/Google/Chrome/...`）も
探すようにした。Linux での挙動は不変。Windows 実測: 738/738 passed（約 7 秒）。

## オブジェクト⇔トラック割り当ての編集UI（`js/objui.js` ほか・2026-08-20）

ストリップに音源トラックのセレクタ（`os-track`）を追加し、追加時に自動で結ばれた割り当てを
後から付け替えられるようにした。選択肢は「(未割り当て)」+ 全トラック（名前で表示）。

### 重複割り当ては「奪い取り」方式

同じトラックを複数のオブジェクトへ割り当てることは**許さない**。既に他のオブジェクトが
使用中のトラックを選んだら、そちらを未割り当てへ外す（`DAW.objects.assignTrack()` が
不変条件「1トラック = 最大1オブジェクト」を守る）。理由:

- ルーティングの正は `audio.trackDest()` → `DAW.objaudio.forTrack()` で、`find` が
  **最初の1個しか返さない**。重複を許すと2個目以降は「割り当て済みに見えるのに鳴らない・
  メーターも振れない・位置を動かしても何も起きない」死にオブジェクトになる。
  二重に鳴る事故はないが、無音で気づけない事故のほうがタチが悪い。
- `forTrack` 側を「複数返す」に変えるとトラック1本のソースを複数チェーンへ分配することに
  なり、音量規約（何個に増やしたら何dB落とすか）の設計が要る。UI の都合で音の仕様を
  変えないため、モデル側で1対1を保証する方が筋がよい。
- 奪い取りは undo 1エントリ（change で `commit()` 1回）なので、意図しない奪い取りは
  undo すれば両方のオブジェクトが元へ戻る。

`lock` は割り当てには効かせない。割り当てはルーティングであって位置/パラメータの編集では
ないし、`lock='all'` のオブジェクトから奪えないと付け替えが永久にできなくなる。

### グラフの組み直し

どのトラックがオブジェクト行きかは `trackDest()` が**ノード生成時**に決めて固定するので、
割り当て変更はパラメータ更新では反映できない。`objui.setTrack()` で
`resetNodes()` + `reschedule()`（width の点音源⇔2ソース切り替えと同じ扱い）。停止中は
`reschedule()` が何もしないのでコストはかからない。

### トラックヘッダのバッジは ui.js をフックしない

タイムライン側にも「このトラックはオブジェクト行き」を出したいが、`renderTracks()` は
DOM を丸ごと作り直すので、ui.js に手を入れてもバッジの寿命は次の再描画まで。代わりに
objui 側の `syncTrackBadges()` が `render()` と 30fps のメーター更新のたびに貼り直す
（既存の `stateSig()` 同期と同じ「rAF で追従する」方式。**ui.js は 1 行も変えていない**）。
トラックヘッダは id を持たないので、隣の `.lane[data-track-id]` の
`previousElementSibling` で辿る。`renderTracks()` の直後は最大 33ms バッジが消えるが、
目視では分からない。

### トラック削除・保存・読み込み

- **トラック削除時は未割り当てへフォールバック**（`DAW.removeTrack()` で解除）。残すと
  「割り当て済みに見えるのに鳴らない」死に参照が保存ファイルへ残る。ui.js の削除ハンドラが
  直後に commit するので削除と解除は undo 1エントリ = undo で割り当てごと復活する。
- 手で編集されたファイルで trackId が重複していても、`DAW.objects.load()` が**先勝ちで
  解消**する（undo のスナップショットは常に不変条件を満たすので、undo 経路では no-op）。
- 表示側（`syncStrip`）は参照先が無い trackId を「(未割り当て)」表示に落とすだけで
  **state は書き換えない**。rAF から勝手に state を触ると履歴の署名とずれる。

### 落とし穴

- **ストリップは仮想化**なので、セレクタの options を「作った時点のトラック一覧」で
  持ち続けることはできない。`syncStrip` が毎回 `tracksSig()`（id+名前の署名）を見て、
  変わったときだけ options を作り直す（毎フレーム DOM を組み直さない）。
- `stateSig()` に **trackId とトラックの id/名前を混ぜ忘れない**こと。忘れると undo・
  奪い取りの巻き添え・トラック改名にセレクタとバッジが追従しない。
- undo 後はオブジェクトの実体が入れ替わるので、テストも UI と同じく **id で引き直す**
  （既知の轍。`sel(a.id)` のように毎回 DOM から引く）。
- バッジの色比較は `style.color` が正規化された `rgb()` を返すため素で比較すると毎回
  不一致になる。元の色文字列を `dataset` に控えて比較する。

### 検証

`test/tests-objlink.js` に 34 項目（グループ `[34]`）: セレクタの生成と現在値 / 変更で
state・`forTrack`・グラフ組み直し・commit 1回 / 奪い取りと undo/redo / トラック削除の
フォールバックと undo での同時復活 / 保存往復と重複 trackId の補正 / バッジの表示・
再描画後の復活・名前追従 / 仮想化スクロール後の選択状態。

## テストのライブ再生を sinkId:'none' で消音（`test/harness.js`・2026-08-20）

Chrome 151 (headless=new) / Windows で `[10]` の再生位置系テスト
（`再生中に再生位置が進む` / `pause で停止し位置を保持`）が (0 -> 0) で落ちるようになった。
原因はテストコードではなく **消音の方法**:

- `--mute-audio` を付けると、リアルタイム AudioContext の **currentTime が 0 のまま進まない**
  （レンダリングごと止まる）。位置は `ctx.currentTime` 由来なので 0 に張り付く。
- ならばとフラグを外して実デバイスへ出すと今度は**デバイス確保でハングすることがあり**、
  90 秒ウォッチドッグに達して 400 項目しか走らない回が出た（フレーキー）。
- destination の手前に gain=0（や -100dB）を挟む案も試したが、出力が無音だと同じく
  クロックが止まる。**無音検知は最終出力のサンプル値ではなくストリーム側で起きている**。

正解は Web Audio 仕様にある: **`new AudioContext({ sinkId: 'none' })`**。
「デバイスを開かずにレンダリングだけ続ける」モードで、クロックは進み・音は出ず・
デバイスにも触らない。harness.js（アプリより先に読まれる）が `window.AudioContext` を
包んで sinkId を固定するので、アプリ本体は無改造。`--mute-audio` は保険として残した
（sinkId:'none' が効いていればどのみち音は出ない）。OfflineAudioContext は無関係なので
触らない。3 連続 773/773 で安定（約 7 秒）。

**教訓**: headless でライブ再生の時間経過を検証するなら、消音は Chrome のフラグではなく
`sinkId: 'none'` で行う。フラグ消音はクロックごと止める。

### レビューで見つかった落とし穴（フォーカスと再描画）

- **フォーカス中の欄は syncStrip が書き換えない**（入力の邪魔をしない仕様）ため、セレクタに
  フォーカスを残したまま undo すると表示だけ古い値で残る。しかも `_sig` は render() で更新済みに
  なるので rAF 同期は二度と拾わない。`stripScroll` の focusout で一度 render() して取り返す。
- **focusout → render() は再入する**: renderStrips がフォーカス中のストリップを DOM から外すと
  focusout が同期発火し、ハンドラの render() が外側の renderStrips の DOM 操作と衝突して
  NotFoundError になる。render() に再入ガード（`_rendering`）を入れた。外側の render が最後まで
  流すので、再入時に何もしなくても表示は正しくなる。
- テストでは `dispatchEvent(new Event('focusout'))` ではなく **`blur()` を使う**こと。手動発火では
  activeElement が元のままなので「フォーカス中は書き換えない」ガードに当たり、実挙動と食い違う。

### 「立体音響になっていない」問題（width の初期値）

ユーザーから「オブジェクトに繋いだのに立体音響に聞こえない」という報告。調査の結果、
定位も HRTF 切替（再生時 hrtf / 編集中 equalpower）も正常に動いていたが、
**新規オブジェクトの width が 0 のため、ステレオ素材が (L+R)/2 のモノラル1点に畳まれて**
元のステレオより平坦に聞こえていた。az=0（正面）既定と合わさると「繋いだら音場が消えた」体験になる。

対処: **UI の「＋」で作るオブジェクトだけ width=100（±45°）を初期値にした**（objui.addObject）。
`objects.defaults()` は ADM 準拠の点音源（width=0）のまま変えない。モデル既定を 100 にすると
点音源前提の受入テスト（等パワー/VBAP の「az=+90 は L のみ」等）が軒並み崩れることからも、
モデル層の意味論と UI の使い勝手は別レイヤーで扱うのが正しい。
モノラル素材は widthGain のパワー正規化で音量が変わらないので width=100 でも無害。

計測メモ: L=440Hz / R=660Hz のステレオ素材で、width=100 + HRTF の実出力は
L チャンネルで 440 が +6dB 優勢、R チャンネルで 660 が +3dB 優勢（±45° の自然な漏れ込み）。
width=0 だと両チャンネルが完全に同一（分離 0dB）になる。

## 正面ビュー（FRONT VIEW / 高さ方向の編集・`js/objui.js`・2026-08-20）

PANNER の TOP VIEW の隣に **正面ビュー**（`#obj-frontview` / canvas `#obj-front`）を追加した。
トップビューは高さ（el）を点の大きさ・明るさでしか示せないので、縦軸で直接編集できるビューを足した。

### ビュー形式は「正面（リスナーを背後から見る）」を採用

側面ビュー（横から）も検討したが正面にした。理由:

- **3D球ビューと同じ向き**になり、+az（ADM の左）がそのまま画面の左に出る。側面だと
  「どちらを向いた側面か」の規約が新たに要り、左右の対応も球ビューとずれる。
- ユーザーが最も直感で読めるのは「ステージを客席から見た配置」＝正面。横=左右、縦=高さ。
- 正射影（前後 z は画面に出ない）なので投影が線形で、ドラッグの逆変換も閉じた式になる。

### 投影の規約

- `frontXY(az, el, dist)` は **`DAW.objaudio.toCartesian()` を呼ぶだけ**: 画面 x = cx + R·c.x、
  画面 y = cy − R·c.y（y は下向きなので反転）。式をビュー側に複製しない（鏡像事故の轍）。
  - az=+90 → c.x=−1 → **画面の左いっぱい**、el=+90 → c.y=1 → **上いっぱい**、el=0 → 縦中央。
  - dist はそのまま縮尺になる（円の輪郭 = dist 1。トップビューの同心円と同じ読み方）。
- **前後（z の符号）は画面に出ない**ので `back`（z>0 = リスナーの後方）フラグで描き分ける:
  後方は少し小さく・薄く描き、後方 → 前方の順に描いて前方が上書きする（実際の見え方と一致）。

### ドラッグ

- 縦=el / 横=az（正確には「dist の円上で az/el を復元」）。**dist は変えない**（トップビューの担当。
  3D球ビューと同じ分担）。undo は既存どおり **pointerup で `commit()` 1回**。
- **掴んだ時点の半球（前/後）を `fdrag.back` に保持する**。正射影では前後が決められないので、
  復元する z の符号はこれで選ぶ（3D球ビューの `sdrag.near` と同じ理屈。無いと後方の
  オブジェクトを掴んだ瞬間に前方へ跳ぶ）。半球は**移動前の位置**から決めること。
- 円の外は方向を正規化して縁（el=0 なら az=±90）へ貼り付ける。**dist=0 は向きが定まらない**ので
  逆変換のスケールに下限（0.05）を敷き、角度だけ拾って NaN を出さない。
- lock（'pos'/'all'）は `DAW.objects.setPosition()` が false を返すので UI 側は何もしない（既存どおり）。

### レイアウトの落とし穴（ストリップ帯が幅0に潰れる）

ペインを1枚足したら headless の既定幅 800px で `#obj-strip-area` が幅0になり、
**仮想化がストリップを1本も作らなくなって** [28]/[32]/[34] が軒並み落ちた。対処:

- `#obj-strip-area` に **min-width: 190px**（ストリップ1本 + マスター）を敷いて潰れなくした。
- `#obj-topview` を固定 340px → `flex: 0 1 340px; min-width: 190px` にして、狭い画面では
  ビュー側（球/トップ/正面）が縮んでストリップ帯を守る。広い画面では従来どおり 340px。

### 検証

`test/tests-objelev.js` に 33 項目（グループ `[35]`）: DOM が PANNER にだけ出る / 投影の規約を
**画面座標の数値**で固定（az=+90 が左・el=±90 が上下・el=0 が中央・dist の縮尺・球ビューとの
左右一致） / `toCartesian` 経由であること（スパイで呼び出し回数を確認） / 縦=el・横=az・複合 /
dist 不変 / 半球の保持 / undo 1エントリ / lock / 選択クリック / dist=0 の NaN ガード。
rAF は headless で発火しないので `render()` を直接呼ぶ。812/812 passed。

## クリップ編集の右クリックメニューとツールバーボタン（`js/ui.js`・2026-08-20）

カット/コピー/複製/分割/削除はショートカットとして実装済みだったが「見つけにくい」との
指摘を受け、**クリップの右クリックメニュー**・**レーン空白部の右クリック（貼り付け）**・
**ツールバーのカット/分割/削除ボタン**として見える形にした。

### 入口は増やすが経路は1本

main.js のキーハンドラに書かれていた処理を `DAW.ui` の共通メソッド
（`cutSelectedClip` / `copySelectedClip` / `duplicateSelectedClip` / `splitSelectedClip` /
`deleteSelectedClip` / `pasteClipAt`）へ移し、**キーボード・メニュー・ボタンの三者が同じ関数を
呼ぶ**構成にした。挙動の二重実装をしないため、undo 粒度（各操作 = commit 1回）も自動的に揃う。

- **分割は常に再生ヘッド位置**。当初は「右クリックした時刻で割る」案だったが、ユーザーから
  「選択している赤い線（再生ヘッド）の場所で分割して」との指示があり、S キー・分割ボタン・
  メニューの三者を再生ヘッド位置に統一した。ヘッドがクリップ外なら項目を disabled にする
  （判定は `splitClip` と同じ端マージン。`state.js` に `SPLIT_MIN: 0.02` として定数化）。
- **貼り付けだけは右クリックした時刻・レーンのトラック**へ置く（グリッド有効なら吸着、
  Alt で一時解除）。`pasteClip(time, trackId)` は既に位置とトラックを取れたので拡張不要。
- クリップボードが空なら貼り付けは disabled。ツールバーの編集ボタンはクリップ選択中のみ有効
  （`updateEditButtons` を `selectClip` と `renderTracks` から呼ぶ）。

### メニューの作法

`#ctx-menu`（z-index 30 = fx-panel より手前）は常に1個。閉じる仕掛けは init に集約:
外側 pointerdown / Escape / スクロール / 他所への contextmenu。クリップ・レーンのハンドラは
`stopPropagation()` するので、document まで届いた contextmenu は「対象外の場所での右クリック」
だけになり、開く処理と閉じる処理が衝突しない。画面端では fx-panel と同じ流儀で内側へ補正。
レーンの pointerdown に `e.button !== 0` ガードを足した（右クリック貼り付けのたびに
シークが走ると、貼りたい位置とヘッドが同時に動いて紛らわしい）。

### テストの落とし穴（`test/tests-clipmenu.js`・グループ `[36]`・44項目）

- レーンのハンドラは `e.offsetX` を見るので、合成 MouseEvent には `Object.defineProperty` で
  offsetX を足す（tests-nudge の U.18 と同じ）。
- undo すると `history.apply` が tracks を JSON から作り直すため、**トラック/クリップの参照は
  毎回 `DAW.project.tracks` から取り直す**。古い参照への検証は必ず空振りする。
- disabled なボタンは `.click()` してもイベントが飛ばない。これ自体を「無効項目は押しても
  何も起きない」の検証に使える。
- **スイートは自分のバッファを片付けてから終わること**。tests-clipmenu は名前順で tests-edit より
  先に走るが、editSuite は `collectBuffers()` を `history.reset()` より先に呼ぶので、履歴が
  参照したままのバッファは回収されず、バッファ数を数える E.7 が 2 になって落ちた。
  finally でクリップ削除 → `history.reset()` → `collectBuffers()` の順に掃除して解決。

856/856 passed。

## 経路（位置オートメーション）（`js/objects.js` / `js/objaudio.js` / `js/objui.js`・2026-08-20）

オブジェクトが時間とともに空間を移動する「経路」を実装した。データは
`obj.path = { enabled, points: [{ t, az, el, dist, ease }] }` で、`t` は**プロジェクト絶対時間**（秒）。
拍ではなく秒にしたのは、ADM のオブジェクトオートメーション（blockFormat の rtime/duration）が
時間ベースであり、将来 ADM 書き出しへ変換するときに BPM 依存の再計算が要らないため。

### モデル（`js/objects.js`）

- 補間はモデル層に一本化: `pathPosAt(obj, t)`（セグメント検索 + ease）、`azLerp(a, b, u)`
  （±180 折り畳みの**最短弧**。+170 → -170 は 180 経由の 20° しか動かない）、`pathSegPos(p0, p1, u)`
  （az 最短弧 / el・dist 線形）。描画のポリラインも書き出しの焼き込みも全部これを通すので、
  「見えた軌跡」と「鳴った軌跡」がずれない。
- **範囲外はホールド**: 最初の点より前・最後の点より後は端の位置に留まる。ゼロへ戻る等の
  暗黙の動きを入れると「イントロでは正面に置きたいだけ」という使い方が壊れる。
- ease は「その点から次の点へ向かう」セグメントに付く: linear（等速）/ in（加速 u²）/
  out（減速 u(2−u)）/ inout（S字 u²(3−2u)）。
- 編集 API（add/move/setTime/remove/cycleEase/setEnabled）はすべて normalize/clamp/changed() を通し、
  lock は位置編集と同じ `canEditPosition()`（'none' のみ可）。同時刻の点は最小間隔 0.05s を強制し、
  時刻変更は前後の点 ±0.05s でクランプするので順序が入れ替わらない。
- 保存は toJSON/load に載せるだけで undo も自動で対応（履歴は toJSON スナップショット方式のため）。
  load は欠落を `{enabled:false, points:[]}` で補い、不正 ease→linear、t 昇順ソート + 間隔強制。

### レンダラー: ライブ = rAF 追従、書き出し = ランプ焼き込み（`js/objaudio.js`）

- update() から位置反映部を `applyObjPosition(nodes, obj, pos, t)` に抽出した（width 2ソースの
  widthAzimuths/widthGain 分岐込み）。update() / followPaths() が同じ関数を通り、実装が割れない。
- **ライブ**は `followPaths()`（objui.tick から毎フレーム1行）。`isPlaying()` でなければ no-op、
  再生中は `getPos()` の時刻で pathPosAt → applyObjPosition。setTargetAtTime(0.02s) で寄せるので
  フレーム量子化はならされる。**ループ折り返し時の 〜20ms のグライドは仕様**（ジャンプを
  即値で反映するとクリックノイズが出る方が害が大きい）。
- **書き出し**は rAF が無いので `bakePath()` がランプ列を焼き込む: 移動区間だけ 20ms 固定
  ステップ（`PATH_BAKE_DT`）+ 各 waypoint 時刻でサンプリングし、HRTF は positionX/Y/Z、
  等パワーは gl/gr、VBAP は spk[i].gain へ setValueAtTime + linearRampToValueAtTime を予約する。
  width ≠ 0 は2点それぞれに加えて **src.gain（widthGain）も焼く**: widthGain は方位で変わる正規化
  係数なので、固定値のままだと経路の途中でライブと書き出しの音量がずれる（設計からの最小限の追加）。
  前後のホールド区間は値が変わらないのでイベント2個に省略（60秒ホールドに3000イベントを
  積まない）。刻みは `m0 + k*DT` で計算し、加算の誤差蓄積で waypoint 時刻と紛れるのを防ぐ。
- **フックは exportRange 方式**: `wav.js` の exportMix がグラフを組む間だけ
  `DAW.objaudio.exportRange = {from, until}` を立て、オフライン ctx での create() が
  「live ctx でない ∧ exportRange あり ∧ path 有効」で bakePath を呼ぶ。trackDest() の
  シグネチャを増やさずに済み、ライブ経路には一切影響しない（finally で必ず null へ戻す）。

### UI（`js/objui.js`）

- TOP VIEW ヘッダに「経路」（path.enabled）と「編集」（objui.pathEdit）のトグル。選択オブジェクト
  の経路だけをトップ/正面ビューに描く: 半透明ポリライン（セグメントを約2°刻みでサンプリング
  するので最短弧が曲線に見える）+ 始点▶ + 菱形 waypoint + 番号 + セグメント中点の緩急グリフ
  （= / ↗ / ↘ / ~）+ 選択 waypoint 下の時間チップ「@2.0s」。
- 操作は pathEdit ON のとき onTopDown/onFrontDown の先頭で分岐（pdrag を第4のドラッグ状態に）:
  空きクリック = 追加（時刻は max(再生ヘッド, 最終点+0.1s)、ヘッドが 0 のままなら 1s 間隔）、
  waypoint ドラッグ = 移動（TOP: az/dist、FRONT: az/el。半球保持は fdrag と同じ理屈）、
  中点クリック = ease 循環、時間チップ左右ドラッグ = 時刻（8px=0.1s）、右クリック = 削除。
  undo はドラッグ系 = pointerup で 1回、クリック系 = 直後に 1回（既存の流儀）。
- 現在位置の点は `posAt(displayPos())` で描き、再生中は tick から canvas だけ再描画する
  （ストリップは値が変わらないので触らない）。path 有効オブジェクトは通常モードでドラッグ不可
  （選択のみ・破線輪郭）、ストリップの Az/El は disabled + title で理由を出す。
- **stateSig() に path（enabled + 各点の t/az/el/dist/ease）を必ず混ぜる**。忘れると undo で
  経路だけ戻ってもビューが追従しない（既存の「署名への混ぜ忘れ」と同じ罠。今回はテスト U.15 で
  undo → ビュー復元まで固定した）。

### 検証

`test/tests-objpath.js` に 84 項目（グループ `[37]`）: ease の u=0.5 値 / 最短弧 / ホールド /
最小間隔とクランプ / load の防御 / toJSON 往復 / lock / undo 粒度、書き出しは az +90→-90 の
全長移動を renderMix して前半 L 優勢・後半 R 優勢を数値検証（等パワー / VBAP のパワー和 /
width の2ソース追従 / ホールド定常値）、ライブは followPaths を applyObjPosition のスパイで、
UI はトグル / 追加 / ドラッグ / ease / 削除 / lock / 通常ドラッグ不可まで。940/940 passed。
`test/bench.js` に OB.11（128個 × 8点 × 300フレームの補間）を追加した。

## AI ステム分離（`js/stems.js` / `vendor/` / `models/`・2026-08-20）

クリップ右クリック →「ステム分離」で htdemucs（Demucs v4）による 4 ステム分離
（drums / bass / other / vocals）を実装した。純 vanilla JS・ビルド不要・file:// で動く。

### アーキテクチャ

```
UI (ui.js)                    メインスレッド (stems.js)             Blob Worker ×1〜4
  右クリック → separateClipStems   OfflineAudioContext で 44.1kHz/2ch 化
  進捗ダイアログ / キャンセル    →  セグメント切り出し（343,980 spl,      importScripts(ort blob)
  完了で4トラック配置 + commit1回    ストライド 257,985 = 25% 重なり）  →  STFT → ONNX 推論 → iSTFT
                                窓合成（線形クロスフェード+重み正規化）←  = 全 DSP は Worker 内
```

- モデル: `htdemucs_embedded.onnx`（fp32 172MB、STFT 外出し・重み埋込。timcsy/demucs-web-onnx 由来、MIT）。
- ランタイム: onnxruntime-web 1.27.0 の **wasm 専用ビルド `ort.wasm.min.js`**。
  フルビルド `ort.min.js` は file:// で jsep（WebGPU モジュール）を要求して失敗する（スパイクで実証）。
- 性能実測: 1 Worker で実時間の 1.76 倍速、4 Worker で 3.7 倍スケール。メモリ ≈2.7GB/Worker なので
  並列数は hardwareConcurrency / deviceMemory / performance.memory から 1〜4 に自動調整（`autoWorkers()`）。

### file:// で AI モデルを動かす方法（重要・再利用可）

fetch/XHR はローカルファイルに使えないが、`<script src>` は file:// でも読める。そこで:

1. モデル・ort ランタイム・wasm を **base64 を代入するだけの classic script** に変換して
   `vendor/*.b64.js`・`models/htdemucs/model-*.b64.js`（24MB 分割 ×8、base64 後も 100MB 未満/ファイル）に置く。
   グローバルは `DAW_STEMS_ASSETS` の1名前空間のみ。再生成は `models/gen_b64.py`（手順は models/README.md）。
2. 分離実行時に **script タグを動的注入**して読み、デコード後は base64 文字列と script タグを捨てる
   （デコード実測 0.5s / ピーク時ヒープ +1.2GB → 解放後 ≈0.6GB）。起動時には一切読まないので通常利用に影響なし。
3. Worker は Blob URL から生成。中で `importScripts(blobURL)` → `ort.env.wasm.wasmPaths={mjs: blobURL}` +
   `ort.env.wasm.wasmBinary=ArrayBuffer` で **ランタイム内部の fetch を完全回避**。
4. DSP（STFT 等）は ES module にできない（file:// の Worker では import 不可）ので、
   `dspFactory.toString()` で Worker ソースへ文字列として埋め込む自己完結関数にした。
   ページ側でも同じ factory から `DAW.stems.dsp` を作るのでテストは Worker 無しで数値検証できる。
5. モデルの Worker への受け渡しは postMessage の**コピー**（transfer は1本にしか渡せない）。

### モデル I/O と DSP の落とし穴

- 入力: `input` [1,2,343980] 波形 + `x` [1,4,2048,336] スペクトログラム（ch 順 = L実/L虚/R実/R虚）。
- 出力: `output` [1,4,4,2048,336]（周波数分岐）+ `add_67` [1,4,2,343980]（時間分岐）。
  **最終ステム = add_67 + iSTFT(output)**。時間分岐だけだと分離が甘い（周波数分岐が主役）。
- STFT: FFT4096 / hop1024 / hann / 1/√n 正規化。pad は reflect 1536 + 右端数、さらに center 2048。
  STFT 後は Nyquist ビンと前後 2 フレームを捨てて 2048×336 に揃える。
- iSTFT 後は **offset 3584（= 2048 + 1536）から切り出す**。PyTorch istft(center=True) の暗黙オフセット。
  ここを外すと先頭が無音になり全体がずれる。テスト S.6 が spec→ispec 往復（誤差 2e-7）で固定している。
- 窓合成: 線形クロスフェード窓（ストライドの半分で立ち上げ/落とし）を掛けて加算し、最後に重み和で正規化。
  恒等推論なら入力が復元される（S.11。ただし weights=0 になる先頭 1 サンプルだけは 0）。

### UI / 履歴

- 実行中はモーダル進捗ダイアログ（% とセグメント数、キャンセルボタン）。二重起動は
  `DAW.stems.running` で防ぎ、メニュー項目も実行中は disabled。
- キャンセルは `worker.terminate()` 即時。エンジンは各 await と「reject するだけの cancelPromise」を
  race させているので、どの段階でも即座に戻る（err.code='cancelled'）。
- 完了で元トラックの直下に「(クリップ名) Drums/Bass/Other/Vocals」の4トラックを挿し、同じ startTime に
  クリップを置く。元クリップはそのまま。**commit は最後に1回**（undo 1発で4トラックまとめて消える）。
- モデル未配置なら err.code='model-missing' と「htdemucs_embedded.onnx をドロップ」誘導。
  タイムラインへの .onnx ドロップで `DAW.stems.setModelData()` に搬入できる。
- バックエンドは `DAW.stems.backends` に `separate(buffer, opts, handle)` を登録する形で差し替え可能
  （将来の Python サイドカー連携用の最小の抽象。現状は 'onnx' のみ）。

### exe 同梱の結論

`build/build-exe.ps1` を拡張し、`vendor/*.b64.js` + `models/**/*.js` も `/resource` で埋め込むようにした。
**csc は 247MB の埋め込みでも約 1 秒で成功**（.NET リソースは 2GB まで）。ランチャー（launcher.cs）は
無変更で動く（起動時に全リソースを %LOCALAPPDATA%\DAW\app へ展開する方式なので、models/ も一緒に出てくる。
展開が毎回 250MB になる点だけ留意）。`-NoModels` でモデル抜きのスリム exe も作れる
（その場合は .onnx ドロップで供給）。DAW.exe 本体は Windows のアプリ制御でブロック中のため実行確認は保留。

### 検証

`test/tests-stems.js`（グループ [38]・38 項目）: STFT/iSTFT 往復（2.4e-7）/ spec→ispec 往復
（offset 3584 の検証）/ 恒等モック推論でセグメント分割+窓合成の恒等性 / offset・duration /
トラック配置・命名・undo/redo 粒度 / UI 経路（ダイアログ・エラー表示）/ キャンセル / 二重起動 /
model-missing 誘導 / .onnx ドロップ。実モデルは重いので既定スイートでは走らせず、
**`--bench` 時のみスモーク 1 本**（2 秒素材 → 実推論 16s、4 ステムとも有限・非無音を確認済み）。
978/978 passed（--bench 時 1007/1007）。

## ステム分離の Python サイドカー高速化（`tools/stems-sidecar/` / `js/stems.js`・2026-08-20）

ステム分離をローカルの Python サイドカー（demucs 4.1.0 / htdemucs / CPU）へ委譲できるようにした。
実測: 30 秒 WAV → 約 14 秒、3〜4 分曲 ≈1.5〜2.5 分（ブラウザ内処理の数分の一）。ピークメモリ約 1.2GB。

### 構成

- `tools/stems-sidecar/sidecar.py` — stdlib のみの HTTP サーバ（http://127.0.0.1:8787、CORS `*`、
  127.0.0.1 バインド）。demucs は subprocess 呼び出しで、tqdm の stderr から進捗をパースする。
  API: `GET /ping` / `GET /progress` / `POST /separate`（409=実行中、499=キャンセル）/ `POST /cancel`。
  レスポンスは "DAWS" フレーミング（magic 4B + uint32LE ヘッダ長 + JSON + int16 WAV 連結、
  ステム順 drums/bass/other/vocals）。レスポンスサイズは入力の約 4 倍。
- `js/stems.js` の `DAW.stems.backends.python` — 既存のバックエンド差し替え口
  （`separate(buffer, opts, handle)`）に登録。分離開始時に `/ping`（タイムアウト 1.5 秒）で検出し、
  居れば python を既定で使用（ダイアログに「Python 高速処理」）、居なければ従来の onnx
  （「ブラウザ内処理」）へフォールバック。WAV 化は `DAW.wav.encodeWav16` を再利用
  （`getChannelData` 互換オブジェクトを渡すだけでよい）。進捗は `/progress` を 1 秒ポーリングして
  `{phase:'separate', unit:'percent', done:0..100}` に変換。キャンセルは fetch abort +
  `POST /cancel` の併用（abort だけだとサーバ側 demucs が回り続ける）。ステム WAV のデコードは
  自前パーサ（`decodeAudioData` は ctx のレートへ勝手にリサンプルするので使わない。int16/float32 対応）。
  分離結果の後段（4 トラック配置・undo 1 回）は既存経路をそのまま使う。

### MAX_PATH の罠（重要・再利用可）

torch を含む venv は内部パスが非常に深く、長いディレクトリ配下に作ると Windows の
MAX_PATH（260 文字）を超えて**作成も import も失敗する**。検証時はジャンクションで
短縮したが、統合版では最初から短い実パス `%LOCALAPPDATA%\daw-stems-venv` に venv を
作る方式にした（ジャンクションの作成・張り替えが不要で単純）。また demucs 4.1.0 は
numpy を依存宣言していないため `pip install demucs numpy` と**両方明示**が必要。
モデル htdemucs（80MB）は初回分離時に HuggingFace から自動 DL される
（`%USERPROFILE%\.cache\huggingface\hub`）。`start-sidecar.bat` が venv 作成〜起動まで自己完結。

### 検証

`test/tests-stems.js` にグループ「[38] Python サイドカー」を追加（P.1〜P.20）。実サーバは
既定スイートでは起動せず、fetch を `DAW.stems.backends.python._fetch` の 1 点に集約して
モックする（window.fetch を差し替えるとハーネスの結果送信が壊れる）。検出成功→python 選択 /
検出失敗→ブラウザ内フォールバック / DAWS フレーミングの往復パース / abort+`/cancel` 併用の
キャンセル / 499・500・409・ネットワーク断のエラー表示 / UI 完了経路（4 トラック配置・undo 1 回）
をカバー。S.33 は実サーバが居ても壊れないよう `backend:'onnx'` を明示するようにした。
DAW.exe（build-exe.ps1）へは同梱しない（開発者向けオプション）。

## FL 流エフェクトホスト フェーズ1（`js/wrapper.js` / `js/knob.js` / FXラック UI・2026-08-20）

スロット enable/wet・共通ノブ・FXラック・ヒントバーを実装した（PDC 配線・send/サイドチェイン・
モジュレータ・可視化はフェーズ2/3）。1089/1089 passed（--bench 込み。既定スイートは 1057/1057）。

### 移行アダプタ方式を採った理由（全面書き換えの却下）

既存プラグイン契約（`DAW.plugins.register` / `create(ctx,params)→{input,output,set}`）は一切変えず、
ホスト所有の Gain ノードで外側から包む `DAW.wrapper.createSlot()` を新設した。契約を変える全面
書き換えは、既存 6 プラグイン + テスト群（def.create 直呼び）を同時に書き換えるリスクに対して
得るものが無い。スロットは旧インスタンスと同じ `input/output/set` を持つので、
`removeTrackNodes` 等の後始末コードも無傷。`connectChain` はシグネチャ・呼び出し3箇所を変えずに
中身だけ `wrapper.buildChain` へ委譲した。

### スロットグラフと線形クロスフェード（等パワーの却下）

`slotIn(Gain) ─┬─ dryGain(1-wet) ─┐ / └─ inst → wetGain(wet) ─┴→ slotOut(Gain)`。
dry と wet は同一信号由来（相関）なので**線形和（dry=1-w, wet=w）が振幅一定**。等パワー（√w）は
無相関信号用で、相関信号では中間に約+3dBの山が出るため却下。切替・ドラッグは
setTargetAtTime（時定数10ms）でクリック防止。**構築時（オフライン書き出し含む）は値を直接入れる**
（ランプの過渡が書き出しに混ざらない）。テストは wet=0/0.5/1・enable=false を WAV バイト列一致 /
サンプル単位の線形合成で固定した（F.2〜F.7）。

### enable の非破棄・latency・互換方針

- enable=false は `slotIn→inst.input` の切断 + dry=1。**インスタンスは破棄しない**（再 enable 即時、
  リバーブの尾・コンプの状態も残る）。ライブの切断は wet ランプが落ちてから（60ms 後）行い、
  切断そのものの段差を出さない。
- インスタンス契約に `latencySamples`（任意・既定0）を追加。latency>0 のスロットは dry 枝に同量の
  DelayNode（コム防止）。トラック間 PDC は**読み取り（`chainLatency`、enable 中のみ合算）まで**。
- スロットデータは track.effects への**追加フィールドのみ** `{enabled(省略時true), wet(省略時1)}`。
  保存は version:1 据え置き。loadProject のデフォルトマージで補完するので旧ファイルは従来出力と
  サンプル一致（F.6）。
- パラメータ記述子の任意拡張 `{unit, digits, curve:'lin'|'log', format}` と
  `norm/denorm/formatValue`（"8,000 Hz" 形式・log は step へ量子化して往復一致）を wrapper に集約。

### 共通ノブ（js/knob.js）

objui のリミッターノブ（canvas・縦ドラッグ KNOB_PX=170・ダブルクリック既定値・pointer capture
try/catch・move/up は window で受ける）を `DAW.knob.create()` に汎用化し、リミッターノブを乗せ替えた
（tests-objui2 の W.30〜W.38 は無変更で通る = 挙動互換）。追加挙動: **Ctrl 微調整（Shift も互換・
0.2倍）** / ホイール1ステップ（Ctrl で 0.2 ステップ）/ 右クリック→ui.showMenu 流用で
「値を入力…（body 直下のインライン input。blur 確定・再入ガード）」「デフォルトに戻す」
「オートメーション化 / リンク…（disabled でフェーズ2/3 予告）」。undo 粒度は set（音のみ）/
commit（pointerup で1回）の分離で、既存の input/change 分離と同じ。ドラッグは正規化空間で
動かすので log カーブも自然な効きになる。

### FXラック UI とヒントバー

- fx-chip 列を廃止し「FX ボタン + 使用中スロット数バッジ」に置換。ラック（#fx-panel）は常に10行
  `[enable LED] [スロット名 or 空(クリックで showMenu のプラグイン選択)] [MIX ノブ]`、行クリックで
  下部にエディタ（共通ノブ自動生成 or `def.buildUI(container, inst, host)`。契約定義のみ、実装
  プラグインはまだ無い）。「開くたび作り直し・外側クリックで閉じる」を踏襲しつつ、右クリック
  メニューとインライン入力は閉じる対象から除外。**undo でトラック実体が差し替わるため、ラックは
  trackId で引き直し、renderTracks から再描画して追従する**（F.49 が固定）。
- `#hint-bar`（最下部固定）+ `DAW.ui.setHint/clearHint`。ノブの hover/drag 中は
  「パラメータ名: 現在値」を wrapper.formatValue と同一文字列で表示。

### 設計からの逸脱（最小限）

- `DAW.audio.setEffectEnabled / setEffectWet` を追加（設計の wrapper API 一覧には無いが、UI から
  state+ライブノードへ届く経路が必要で、既存 setEffectParam と同じ形に揃えた。逸脱ではなく補完）。

### 検証

`test/tests-wrapper.js`（グループ [39]・57項目）: enable=false / wet=0 が dry と**バイト列一致**、
wet=0.5/1 の線形合成、旧形式互換、exportMix 反映、latencySamples/chainLatency、undo/redo、
10スロット上限、norm/denorm（log 往復・クランプ）、formatValue、ノブ（ドラッグ/Ctrl/Shift/
ホイール/ダブルクリック/右クリックメニュー/値入力/ヒントバー/update）、ラック UI 一式。
ベンチ（--bench）に「FXラッパー 20tr×10slot」を追加: ライブチェーン構築 200 スロット 34ms、
書き出し 200 スロット経由で実時間の 1.6 倍速（lowpass×200 の処理コストが支配的）。

## 7バンド パラメトリックEQ（`js/plugins/paraeq.js`・2026-08-20）

FL Studio「Parametric EQ 2」の DSP 部分に相当する内蔵プラグイン `paraeq` を追加した
（UI はフェーズ3で別途。今回は既存の自動生成スライダーのみ）。

### 構成

- 7つの `BiquadFilterNode` を常時直列。再配線は一切しない。
- 各バンド 5 パラメータ × 7 バンド = 35 個: `onN`（0/1）/ `tyN`（0〜6 =
  bell / low-shelf / high-shelf / lowpass / highpass / notch / bandpass）/
  `fqN`（20〜20k）/ `gnN`（±18dB）/ `qN`（0.1〜10）。ラベルは「B1型」「B1周波」等で簡潔に。
- **バイパス = peaking + ゲイン 0dB**。peaking の 0dB は伝達関数が厳密に 1 なので、
  ノードを外さず（= 再配線クリックなしで）バンドを無効化できる。型切替は瞬時、
  周波数・ゲイン・Q のライブ変更は `setTargetAtTime`（時定数 0.01s）でなめす。
  bell バンドの on/off は型が変わらずゲインのフェードだけになる。
- 既定値は「挿した瞬間に音が変わらない」: B1=highpass 30Hz（無効）、B7=lowpass 18kHz（無効）、
  B2〜B6=bell 0dB（100/315/1k/3.15k/8kHz の log 配置）。
- 戻り値に `getFrequencyResponse(freqArray) → magArray` を追加
  （各 `BiquadFilter.getFrequencyResponse` の振幅の積。無効バンドは振幅 1 なので影響しない）。
  フェーズ3のスペクトラム表示 UI がこれを使う想定。
- ctx はライブ / オフライン両対応（`create(ctx, params)` 時は `.value` 直接代入なので
  オフライン書き出しは先頭サンプルから設定どおり・決定的）。

### 検証

`test/tests-paraeq.js` にグループ「[41] パラメトリックEQ」（Q.1〜Q.15）を追加。
既定値の素通し（サンプル最大差 <1e-4）/ bell +12dB の増幅と隣接帯域の不変 /
highpass の低域減衰と通過帯域の素通し / `getFrequencyResponse` 合成値と単体フィルタの積の一致 /
set() での型切替・on/off 後の出力有限性 / 決定性（2回レンダリングが同一サンプル）/
実トラックでの `exportMix` とライブ変更、をカバー。全スイート 1073/1073 pass を確認
（`PORT=8804 bash test/run.sh`、本体最新コード + 本プラグインの統合コピーで実行）。

# 開発ログ

（この worktree ではテンポ同期ディレイの節のみ。統合時に本体の DEVLOG へ追記マージする）

## テンポ同期ディレイ delay3（Fruity Delay 3 風）

`js/plugins/delay3.js`。音価（1/16〜1/2、付点含む）× `DAW.project.bpm` でディレイタイムを決め、
同期 OFF なら ms 指定。帰還経路に LPF と WaveShaper のソフトクリップ
（`tanh(kx)/k` — 小信号ゲイン1なのでループゲインが 1 を超えず発振しない。amount=0 は
`curve=null` で素通し）。dry/wet はホストの FX スロット（wrapper.js の MIX）に任せ、
出力はウェットのみ。

### タイム変更の2モード（本体の核）

- **クロスフェード**: チャンネルごとに DelayNode を2系統持ち、待機側（出力ゲイン0）へ
  新しい delayTime を直接セットしてから、出力ゲインを linearRamp（80ms）で入れ替える。
  ゲイン0側の delayTime ジャンプは聞こえないため、クリックなしで即座に切り替わる。
- **テープ風**: 稼働中ラインの `delayTime` を `linearRampToValueAtTime`（250ms）でスライド。
  読み出し速度が変わるあいだピッチが滑る（バリスピ挙動）。

ピンポンは「入力を (L+R)/2 で L ループへだけ入れ、帰還を反対チャンネルへ振り分ける」
配線切替（ゲイン8個のルーティング）で実現。各ホップでフィルタと帰還量を1回ずつ通る。

### BPM 追従

既存プラグインは BPM を参照していないため、delay3.js が `DAW.setBpm` を一度だけ包み、
生存中のライブインスタンスへ再計算を促す update フック方式にした。コールバックは
WeakRef で持ち、インスタンス破棄で自然に外れる。オフライン書き出しは create 時点の
BPM を読む（レンダリング中に BPM は変わらない）。

### 検証

`test/tests-delay3.js` にグループ「[40] テンポ同期ディレイ」（D.1〜D.23）。
音価→秒換算 / setBpm ライブ追従 / 帰還減衰比 / クロスフェード中の隣接サンプル差上限
（クリック検出）/ テープ風の実効遅延を「直線ランプ入力 x(t)=t → d(t)=t−y(t)」で逐次測定して
滑らかさを確認 / ピンポンの L→R→L 交互 / 決定性（2回レンダリング完全一致）/ exportMix 経路。
レンダリング途中のタイム変更は `OfflineAudioContext.suspend()` で再現する（再利用可の知見）。

## マルチバンドコンプレッサー / グッダイザー（`js/plugins/multiband.js` / `js/plugins/goodizer.js`・2026-08-20）

FL Studio の Maximus 風 3バンドコンプレッサーと、その 1 ノブ版（Soundgoodizer 風）を
内蔵プラグインとして追加。どちらもネイティブノードのみで構成しているので
`AudioContext` / `OfflineAudioContext` の両方でそのまま動く（prepare 不要・書き出し一致）。

### クロスオーバー方式（Linkwitz-Riley 4次 + 位相合わせオールパス）

BiquadFilter の lowpass / highpass（Butterworth Q）を 2 段カスケードすると LR4
（24dB/oct）になる。LR4 の LP+HP の和は「2次オールパス」（振幅 1・位相のみ回転）に
なることを利用し、3 バンドを次のツリーにすると再合算が振幅フラットに戻る:

- 低 = LP4(f1) → **AP2(f2)**（位相合わせ用の 2 次オールパス）
- 中 = HP4(f1) → LP4(f2)
- 高 = HP4(f1) → HP4(f2)
- 和 = AP2(f1)·AP2(f2) …… 振幅 1

数学的根拠: LR4 では LP(s)+HP(s) = (s²−√2s+1)/(s²+√2s+1)（Q=1/√2 の 2 次 AP）。
テスト M.7 で 60Hz〜6kHz（交差周波数ちょうどを含む）の再合算比が全点 1.000 になることを確認。

**Web Audio の罠（重要・再利用可）**: BiquadFilter の Q は lowpass/highpass だけ
「dB」解釈、allpass などは線形。Butterworth にするには LP/HP へ
`20*log10(1/√2) ≈ -3.0103`、AP へ `0.7071` を渡す必要がある。ここを間違えると
再合算にリップルが出る（フラットさのテストで検出できる）。

### 帯域コンプと 1 ノブ化

各バンドは 分割フィルタ → DynamicsCompressorNode（threshold/ratio/attack/release、knee 6 固定）
→ バンドゲイン(dB)、合算後にマスターゲイン(dB)。パラメータは 17 個
（交差 2 + 5×3 バンド + マスター）。

`goodizer.js` は multiband の `create()` をそのまま呼び出す「パッケージング」プラグイン。
amount(0..1) から 3 バンドの thr（-30a/-22a/-26a dB）・ratio（1+3a/1+2a/1+2.5a）を導出し、
下げた分を自動メイクアップ `-thr·(1-1/ratio)·0.4` で持ち上げ、低・高域に +1.5a/+1.0a dB の
チルト（スマイルカーブ）を足す。amount 0 は thr 0 / ratio 1 / gain 0 になり、
振幅フラットな帯域分割を通るだけのほぼ素通し（M.16 で倍率 1.000 を確認）。

### DynamicsCompressorNode の決定性（重要・再利用可）

Chrome の DynamicsCompressorNode は同一入力・同一設定でもレンダリングごとに
float 1ULP 程度（実測 max ~2.4e-7 ≈ -132dBFS、出現もランダム）のビット差が出ることがある
（ヒープ配置による SIMD/スカラ経路の揺れとみられる。BiquadFilter や ConvolverNode では
観測されない）。挙動としては同一なので、決定性テストはビット一致ではなく
「2回レンダリングの最大差 < 1e-5（-100dBFS）」で判定する（M.14 / M.18）。

### 検証

`test/tests-multiband.js` にグループ「[40] マルチバンド/グッダイザー」を追加（M.1〜M.22、22 件）。
帯域分割（バンドソロで正弦波の行き先を確認）/ 交差周波数変更の反映 / 再合算フラット /
圧縮・レシオ・ダイナミックレンジ縮小 / 帯域独立性 / バンド・マスターゲイン / 決定性 /
goodizer の素通し・音圧・決定性 / トラック載せ書き出し / ライブ変更 をカバー。全 1022 件パス。
## タイムFX（Gross Beat 風グリッチ / スタッター）（`js/plugins/timefx.js`・2026-08-20）

FL Studio の Gross Beat の中核（テンポ同期のタイム / ボリュームカーブ）を最小構成で実装した
内蔵プラグイン。AudioWorklet 内に**直近2小節ぶんのリングバッファを常時録音**し、
`readPos = playPos - f(phase)`（f はタイムカーブ・単位は拍、phase は小節内位相 0..1）で読み出す。

- タイムカーブ8種: 素通し / ハーフスピード / 1拍リピート / 1/2拍リピート / 1/4拍スタッター /
  逆再生風（各拍で直前1拍を等倍逆走）/ テープストップ（d = tb²/8）/ シャッフル（半拍スロットの
  並べ替え。未来は読めないので写像は j 以下限定）
- ボリュームカーブ4種: 素通し / 4分ゲート / 8分ゲート / サイドチェイン風デューク
- パラメータは タイム / ゲート / 深さ(mix) の3つ。深さは「カーブの効き量」
  （遅延は mix 倍・ゲインは 1 と g(phase) の補間）で、原音との dry/wet はホスト
  （wrapper のスロット MIX）に任せて持たない

### 位相同期の方式（ライブと書き出しで同じ音にする肝）

Worklet には「タイムライン位置 tl = pos0 + (ctx時刻 − ctxTime0) の線形対応」だけを教える。

- **ライブ**: `DAW.audio.play()` が確定させる `playStartPos` / `playStartCtxTime` がそのまま
  (pos0, ctxTime0)。プラグイン側から play() を後付けフックでラップし、再生開始のたびに全ライブ
  インスタンスへ transport メッセージ（pos0 / ctxTime0 / bpm）を送り直す。seek / reschedule も
  play() を通るので拾える。インスタンス一覧は trackNodes のスロットを辿る（登録簿を持たない =
  破棄済みノードへの参照が残らない）。再生中のチェーン組み直しは create() がその時点の値を
  processorOptions で渡す
- **書き出し**: OfflineAudioContext は currentTime=0 起点なので、exportMix() が設定する
  `DAW.objaudio.exportRange.from` を pos0 に渡すだけ（ctxTime0=0）。**再生開始 / 書き出し範囲が
  小節の途中でも位相はタイムライン基準で一致する**
- BPM は processorOptions で渡し、transport メッセージ / `set('bpm', v)` で更新。リングは
  2小節ぶんを拡張のみで確保し直す

### クリック回避

- タイムカーブの不連続（セグメント境界・小節の折り返し・パターン切替・transport 再同期）は
  読み出しヘッド2本の**約5ms 等ゲインクロスフェード**で乗り換える。旧ヘッドは直前の傾きのまま
  走らせる。不連続の判定しきい値は max(64, 0.05拍) サンプル（連続変化の最大 = 逆走の
  2サンプル/サンプル + 深さスルーの掃引より大きく、最小セグメント 1/4拍 の跳びより小さい）
- ボリュームエッジは約3ms・深さ変更は約10msのスルーレート制限。ゲート閉区間は完全な無音に到達する

割り切り: ループ再生の折り返しは線形対応のままなので、ループ長が小節の整数倍でないと折り返し後の
位相はタイムライン基準になる。Worklet モジュールは data: URL でロード（blob: は file:// で不可、
`js/limiter.js` と同じ理由）。

### 検証（`test/tests-timefx.js`・グループ [TFX]・16項目）

素通し / 深さ0 が入力と一致（最大差 2e-13）、ハーフスピードのゼロ交差比 0.500、逆走の周波数保存、
テープストップの減速、1拍リピートの内容検証（拍別振幅入力）、ゲートの完全無音区間、
セグメント境界+レンダリング途中のパターン切替（OfflineAudioContext.suspend 使用）で
最大段差 0.039（連続正弦波の 0.038 とほぼ同等。フェード無しなら約 1.2）、オフライン2回
レンダリングのサンプル完全一致、書き出し開始が拍の途中の場合のゲート位相、exportMix 経由、
途中位置からのライブ再生 + ライブ変更。

## オブジェクトベースのルームリバーブ（`js/objects.js` / `js/objaudio.js` / `js/objui.js`・2026-08-20）

オブジェクトごとの `revSend`（0〜1・既定 0.25）を共有の「ルームリバーブバス」へ送る空間側の機構。
トラック FX のリバーブ（インサート）とは独立。

- **距離式（objaudio.revSendLevel に1箇所）**: 実効センド量 = revSend × (0.25 + 0.75 × dist)。
  近くでも 0.25 倍は湿らせ、遠いほど残響が増える＝距離が耳で分かる
- **経路**: センドはゲイン後・定位前のタップ。dist が経路で動く場合、ライブは
  applyObjPosition（update / followPaths）、書き出しは bakePath がセンドゲインもランプで焼く
- **IR**: 固定シード LCG ノイズ（reverb.js と同方式・シード別）。damp（明るさ）は
  ノイズへ掛ける1次ローパス係数、減衰エンベロープは (1-i/len)^2.5 固定、長さは decay
- **VBAP 分配**: リバーブ L → 左側スピーカー群（az>0・LFE除く）へ 1/√n、R → 右側（az<0）へ
  1/√n。C / LFE には送らない。チャンネル数は配置と一致する
- **回帰**: level（リターン量）の既定は 0。level=0 / 全 revSend=0 のとき wet が正確な 0.0 を
  足すだけなので既存出力とバイナリ一致（テストで検証）。旧プロジェクトの音は変わらない
- 保存は `roomReverb`（version 1 のまま・欠落補完）。revSend は履歴スナップショット
  （objects.toJSON）に入り undo 対象。マスターパラメータはリミッター同様に履歴外

### 検証（`test/tests-objreverb.js`・グループ [42]・64件）
データモデル往復・undo・lock / 距離式 / センド0のバイナリ一致 / 残響尾 / 経路 dist 追従 /
5.1 の 6ch 維持と分配 / RENDERER・ストリップのノブ。全 1202 件パス。

## マスター設定のプロジェクト保存（`js/wav.js` / `js/limiter.js` / `js/objaudio.js` / `js/history.js`・2026-08-20）

QA スイープで確定した「JSON 1ファイル完全復元」の穴を塞いだ。saveProject が
マスターリミッター（`limiter: { enabled, params }`）・出力形式（`output: { mode, layout }`）・
メトロノーム（`metronome`）・グリッド（`grid`）を保存する。いずれも追加フィールドのみで
**version は 1 のまま**。欠落時は既定値フォールバック（`limiter.load` / `objaudio.loadOutput` が
補完）なので旧プロジェクトは従来どおり開ける。roomReverb は実装済みだったことを確認。

- **出力形式は「ユーザーの明示選択」だけを保存する**: `output.mode` は `binaural` / `speakers` の
  2値（UI の OUT_MODES と同じ粒度）。equalpower / hrtf の別は autoHrtf の自動切替
  （試聴中だけ HRTF）が決める**一時状態**なので保存しない。HRTF 試聴中に保存しても
  `binaural` として残り、復元は等パワーから始めて自動切替に任せる。生の `mode` を保存すると
  「保存した瞬間のモードが固定され、復元直後に wantedMode() と食い違う」ため
- **履歴にも入れた**: リミッターとルームリバーブのマスターパラメータは保存対象になったので
  履歴スナップショット（history.snapshot）へ追加し、RENDERER のノブの commit を no-op から
  `DAW.history.commit()` に変更（ドラッグ全体 = pointerup で undo 1エントリ、以前の布石どおり）。
  バイパスボタンも click 1回 = undo 1回。stateSig には limiter / revParams が既に混ざっていたので
  undo 後のノブ追従はそのまま効く
- **出力形式・メトロノーム・グリッドは履歴に入れない**（ループ・ズームと同じ「表示・再生側の
  設定」の扱い。undo で出力チャンネル数が変わるのは驚きが大きい）
- 読み込み後の UI 追従: main.js がメトロノーム/グリッドボタン・グリッド分割セレクタ・BPM 欄を
  state へ同期し applyGrid() する

### 検証（`test/tests-mastersave.js`・グループ [43][44]・37件）
save→load 往復で全設定一致 / HRTF 中の保存が binaural になる / 欠落フィールドの既定値
フォールバック / 最小構成の旧形式が開ける / ノブのドラッグ・ダブルクリック・バイパスが
undo 1エントリで表示も追従。
