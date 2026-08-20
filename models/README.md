# models/ — ステム分離用モデル

AI ステム分離（drums / bass / other / vocals）で使う htdemucs の ONNX モデルを、
`file://` でも読み込めるよう **base64 を代入するだけの classic script** に変換して置いてある。
読み込みは `js/stems.js` が `<script>` の動的注入で行う（起動時には読まない。分離を実行した時だけ読む）。

```
models/htdemucs/
  manifest.js          チャンク一覧とサイズ（読み込みの入口）
  model-000.b64.js …   モデル本体を 24MB ごとに分割して base64 化したもの（計 8 ファイル）
vendor/
  ort.wasm.min.js              onnxruntime-web 1.27.0 の wasm 専用ビルド（原本・再生成用）
  ort-wasm-simd-threaded.mjs   wasm ローダ glue（原本・再生成用）
  ort-wasm-simd-threaded.wasm  wasm 本体（原本・再生成用）
  ort-js.b64.js / ort-mjs.b64.js / ort-wasm.b64.js   上記3つの base64 版（実行時はこちらを読む）
```

グローバルは `self.DAW_STEMS_ASSETS` の1名前空間だけを使う。
展開後は base64 文字列を破棄してメモリを返す（js/stems.js の ensureAssets 参照）。

## 入手元とサイズ

| ファイル | 入手元 | サイズ |
| --- | --- | --- |
| htdemucs_embedded.onnx | https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx | 180,534,758 bytes（fp32 / STFT 外出し / 重み埋込） |
| onnxruntime-web 1.27.0 | https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.27.0.tgz | ort.wasm.min.js 50KB / .mjs 24KB / .wasm 13.5MB |

注意: **wasm 専用ビルド `ort.wasm.min.js` を使うこと。** フルビルド `ort.min.js` は
file:// 環境で jsep（WebGPU 用モジュール）を要求して初期化に失敗する（実証済み）。

## 再生成手順

`htdemucs_embedded.onnx`（172MB）はリポジトリに含めていない。b64 チャンクを作り直すときは:

```bash
curl -L -o htdemucs_embedded.onnx \
  https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx
python3 models/gen_b64.py --onnx htdemucs_embedded.onnx
```

ort ランタイムを更新するときは、npm の tgz から
`dist/ort.wasm.min.js` / `dist/ort-wasm-simd-threaded.{mjs,wasm}` を `vendor/` に置いてから
同じコマンドを実行する（`--skip-vendor` で vendor 側だけ省略もできる）。

チャンクは 24MB 区切り。base64 で 1.33 倍になっても 1 ファイル 100MB 未満に収まり、
GitHub のファイルサイズ上限（100MB/ファイル）にかからない。

## ライセンスと重み配布の注意

- **Demucs（モデル構造・学習コード）**: MIT（facebookresearch/demucs）。htdemucs の
  公開チェックポイントも同リポジトリの一部として配布されている。
- **timcsy/demucs-web-onnx / demucs-web**: MIT。ONNX 変換（STFT 外出し）と
  ブラウザ用 DSP 実装の由来。`js/stems.js` の DSP はこの実装の移植。
- **onnxruntime-web**: MIT（Microsoft）。
- 重み（モデル本体）は学習済みニューラルネットであり、上記ライセンスの下で再配布している。
  ただし **分離結果の音源の権利は元の楽曲に従う**。市販楽曲を分離した結果の公開・利用は
  元楽曲の権利者の許諾範囲でしか行えない。この機能はあくまで個人の制作・練習・
  権利処理済み素材の編集を想定している。
