# 回帰テスト

ブラウザDAWの state / plugins / wav / audio ロジックを Headless Chrome 上で実際に走らせて検証する。

```
bash test/run.sh
```

全項目パスなら `N/N passed` と表示して exit 0、1件でも落ちれば exit 1 を返す。所要 4〜5 秒。

## この環境の前提

**node / npm / git は無い。** 使えるのは `python3` と `bash` と `google-chrome` だけ。
そのためテストランナーは npm パッケージを一切使わず、python3 の標準ライブラリと Chrome の
Headless モードだけで組んである。アプリ本体と同じく「依存ゼロ」。

- Chrome は `CHROME=/path/to/chrome bash test/run.sh` で差し替えられる（既定は
  `google-chrome` → `google-chrome-stable` → `chromium` → `chromium-browser` の順に自動検出）
- 収集ポートは `PORT=9000 bash test/run.sh` で変更できる（既定 8765）
- `bash test/run.sh --keep` で Chrome のログとプロファイルを消さずに残す

## 構成

| ファイル | 役割 |
| --- | --- |
| `run.sh` | 全体のドライバ。生成 → 収集サーバ起動 → Chrome 起動 → 結果整形 → 終了コード |
| `build-verify.py` | `index.html` からテストページ `.verify.generated.html` を生成する |
| `harness.js` | エラー収集 / alert・confirm スタブ / ウォッチドッグ / 結果送信（**アプリより前**に読み込まれる） |
| `tests.js` | テスト本体（**アプリより後**に読み込まれる） |
| `collect.py` | 127.0.0.1:8765 で結果の POST を1件受け取り `last-result.json` に保存して終了する |
| `.verify.generated.html` | 生成物。gitignore 済み |
| `last-result.json` | 直近の実行結果（生JSON）。gitignore 済み |

### テストページを「生成」する理由

verify ページを静的に持つと、`index.html` に script タグや DOM 要素が追加されるたびに
テスト側も直さないと壊れる（`DAW.ui.init()` は要素が1つでも欠けると例外になる）。
そこで `build-verify.py` が毎回 `index.html` を読み、

1. `href="style.css"` / `src="js/..."` を `../` 始まりに書き換え（`test/` から見た相対パス）
2. 最初の `<script>` の直前に `harness.js` を差し込む（アプリより先に仕掛ける必要があるため）
3. `</body>` の直前に `tests.js` を差し込む

だけを行って `.verify.generated.html` を作る。**アプリ本体は一切変更しない。**
プラグインやスクリプトを追加しても、テスト側の修正は不要。

### 結果の受け渡し

Chrome の `--dump-dom` + `--virtual-time-budget` は **使っていない**。
OfflineAudioContext のレンダリング完了より前に DOM がダンプされてしまい、結果が取れないため。
代わりにページ側から

```js
fetch('http://127.0.0.1:8765/result', { method: 'POST', mode: 'no-cors', body: json })
```

で `collect.py` に送る。`no-cors` の simple request なのでプリフライトが飛ばず、
`file://` オリジンからでも送信できる（レスポンスは opaque だが送信は成功する）。

ページには 90 秒のウォッチドッグがあり、ハングしても「そこまでの結果 + 停止したフェーズ名」を
必ず送るようになっている。

## 結果の見方

```
  PASS  [7] masterVolume 0.5 で振幅がちょうど半分   rms比=0.5000, peak比=0.5000（…）
  FAIL  [8] lowpass: 8kHz を 500Hz 設定で減衰させる  アサート失敗: 減衰不足: 比=8.1e-1  << at ...

95/95 passed   (3.8s, page 3122ms)
```

- 左が `PASS` / `FAIL`、中央がテスト名、右が詳細（PASS でも実測値が出るので回帰の傾向が見える）
- `[1]`〜`[11]` はグループ番号（下表）
- 未捕捉エラーがあれば一覧の下に「収集されたエラー」として出る
- ウォッチドッグが発火した場合は停止したフェーズ名が出る
- 生の JSON は `test/last-result.json` に残るので、CI や差分比較にも使える

| グループ | 内容 |
| --- | --- |
| `[1]` | スクリプトのロード順、`DAW` 名前空間と各 API の存在 |
| `[2]` | `main.js` の初期化（初期トラック2本、`#tracks` への描画、`ui.els` の解決） |
| `[3]` | プラグイン登録（`lowpass` / `delay` / `geq7` / `dyneq3`）、params の妥当性 |
| `[4]` | state ロジック（ソロ/ミュート、projectDuration、findClip、バッファGC、peaks） |
| `[5]` | `wav.encodeWav16`（ヘッダ、量子化、base64 往復、decodeAudioData 往復） |
| `[6]` | `audio.scheduleClip`（開始/終了時刻、fromPos のオフセット補正、offset トリム） |
| `[7]` | `wav.exportMix` の実経路（長さ、パン、masterVolume、ミュート、0dBFS ガード） |
| `[8]` | 4プラグインを exportMix 経路に通す（AudioWorklet が file:// で動くことを含む） |
| `[9]` | プロジェクト保存/読み込み往復、未登録プラグイン、不正ファイルの拒否 |
| `[10]` | ライブ再生グラフ（play/pause/seek/stop、trackNodes、メーター、ノード解放） |
| `[11]` | 全工程を通じて未捕捉エラー・想定外のモーダルが無いこと |

## テストの追加方法

`test/tests.js` に1行足すだけ。

```js
T('[4] 新しい検証の名前', async () => {
  resetProject();
  const t = DAW.addTrack();
  eq(DAW.projectDuration(), 0, 'クリップ0本');
  return '詳細に出したい文字列';   // 返した文字列が結果一覧の右側に出る
});
```

- 例外を投げれば FAIL。`ok(cond, msg)` / `eq(a, b, msg)` / `near(a, b, eps, msg)` が使える
- 登録順に **直列** で実行される。前のテストの状態を引き継ぐので、状態を変えるなら
  先頭で `resetProject()` を呼ぶ（`[10]` グループのように意図して引き継ぐ書き方もある）
- 便利関数: `makeBuffer(ch, 秒, fill)` / `sineFill(freq, amp)` / `rampFill(秒, amp)` /
  `rms()` / `peakAbs()` / `firstNonFinite()` / `addClip()` / `fx(pluginId, 上書き)` /
  `renderMix()`（exportMix を実行して WAV をデコードして返す） /
  `renderSchedule()`（scheduleClip 単体を OfflineAudioContext でレンダリング）
- `alert` / `confirm` / `DAW.wav.download` はスタブ済み。意図して発生させたら
  `takeAlerts()` / `takeConfirms()` で消化すること。消化し忘れは `[11]` で FAIL になる
- `confirm` の戻り値は `H.confirmResult` で切り替える（既定 true）。
  0dBFS を超えるミックスを書き出すテストでは明示的に指定する

### 書かないこと

- **ピクセル計算に依存するテスト**。`DAW.PPS` はズームで可変なので `timeToPx` の
  絶対値に依存させない。DOM は「初期描画されたか」程度に留める
- **ハードパン（pan=±1）でステレオ素材が +6dB になることをバグ扱いする期待値**。
  L+R が片側に合算されるのは Web Audio の仕様どおり。分離の検証はモノラル素材で行う
- **クリップ判定のきつすぎるしきい値**。合計が 0dBFS ちょうどでサンプルが ±1.0 に
  触れるのは正常。余裕を持たせる

## トラブルシューティング

- `ERROR: テスト結果を受信できませんでした` … Chrome が起動していないか、ポートが塞がっている。
  `bash test/run.sh --keep` で Chrome のログを残して確認する
- `[2] DAW.ui.els が全て解決している` が FAIL … `index.html` に無い id を `ui.js` が
  参照している（本体側のバグ。テスト側の追従は不要）
- ウォッチドッグ発火 … 表示されるフェーズ名が停止箇所。`OfflineAudioContext` の
  `startRendering()` が返ってこないケースが多い
