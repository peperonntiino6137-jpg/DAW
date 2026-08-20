'use strict';

// AI ステム分離エンジン（drums / bass / other / vocals の4ステム）。
//
// モデルは htdemucs（Demucs v4, hybrid transformer）を STFT 外出し・重み埋込で
// ONNX 化したもの（timcsy/demucs-web-onnx 由来）。推論は onnxruntime-web の
// wasm 専用ビルドを Blob Worker 内で回す。フルビルド ort.min.js は jsep を
// 要求して失敗するので使わないこと（スパイクで実証済み）。
//
// file:// で動かすための搬入経路（これもスパイクで実証済み）:
//   - ort ランタイム・wasm・モデルはすべて「base64 を代入するだけの classic script」
//     （vendor/*.b64.js, models/htdemucs/*.b64.js）にしてあり、<script> の動的注入で読む。
//     fetch はローカルファイルに使えないが、script タグなら file:// でも読める。
//   - Worker は Blob URL から生成し、中で importScripts(blobURL) → ort を読み込む。
//     ort.env.wasm.wasmPaths = {mjs: blobURL} + wasmBinary = ArrayBuffer で
//     ランタイム内部の fetch を完全に回避する。
//
// UI スレッドでは推論しない。分離の実処理（STFT → 推論 → iSTFT）は全部 Worker 内。
// メインスレッドはセグメント切り出しと窓合成（オーバーラップ加算）だけを行う。
DAW.stems = {
  TRACKS: ['drums', 'bass', 'other', 'vocals'],
  STEM_LABELS: { drums: 'Drums', bass: 'Bass', other: 'Other', vocals: 'Vocals' },
  SAMPLE_RATE: 44100,   // モデルの学習サンプルレート。入力はここへ変換してから分離する

  // アセット（vendor/, models/）の場所。テストページは test/ から読むので、
  // index.html からの相対ではなく stems.js 自身の位置から解決する。
  BASE: (function () {
    const s = document.currentScript;
    return s && s.src ? s.src.replace(/js\/stems\.js.*$/, '') : '';
  })(),

  running: null,   // 実行中ハンドル（null なら待機中）。二重起動はここで防ぐ

  // 分離バックエンド。separate(buffer, opts, handle) を実装したオブジェクトを
  // 登録する形にしてある。抽象はこの1点だけ（過剰設計はしない）。
  //   onnx   … ブラウザ内処理（既定のフォールバック）
  //   python … ローカルの Python サイドカー（tools/stems-sidecar/。数倍速い）
  backend: 'onnx',
  backends: {},

  // クリップ（AudioBuffer の一部）を4ステムに分離する。
  // opts: { offset, duration            … buffer 内の分離対象範囲（秒）
  //         onProgress(p)               … p = {phase:'load'|'separate', done, total}
  //                                       （python は {phase:'separate', unit:'percent', done:0..100, total:100}）
  //         onBackend(name)             … 使用バックエンド確定時に 'python'|'onnx' で呼ぶ（UI 表示用）
  //         backend                     … バックエンドの明示指定（自動検出を飛ばす）
  //         workers                     … Worker 数の明示指定（既定は autoWorkers()）
  //         infer(left, right, seg)     … テスト用: 推論だけ差し替える（Worker を使わない） }
  // 戻り値: { drums, bass, other, vocals } … 各 44.1kHz/2ch の AudioBuffer
  // キャンセルは DAW.stems.cancel()。reject の err.code は 'cancelled'。
  async separate(buffer, opts) {
    if (this.running) throw this.error('busy', 'ステム分離は既に実行中です');
    opts = opts || {};
    // バックエンド確定前（サイドカー検出中）のキャンセルはフラグだけ立てて直後に拾う
    const handle = { cancelled: false, cancel: () => { handle.cancelled = true; } };
    this.running = handle;
    try {
      // 明示指定・テスト経路（infer）以外は Python サイドカーを検出して優先する。
      // 検出は /ping 1発（タイムアウト1.5秒）。居なければ従来のブラウザ内処理へ。
      let name = opts.backend || (opts.infer ? 'onnx' : null);
      if (!name) name = (await this.backends.python.detect()) ? 'python' : this.backend;
      const backend = this.backends[name];
      if (!backend) throw this.error('backend', '分離バックエンドがありません: ' + name);
      if (handle.cancelled) throw this.error('cancelled', 'キャンセルされました');
      if (opts.onBackend) opts.onBackend(name);
      return await backend.separate(buffer, opts, handle);
    } finally {
      this.running = null;
    }
  },

  // 実行中の分離を即時中断する。Worker は terminate されるので推論も即座に止まる。
  cancel() {
    if (this.running && this.running.cancel) this.running.cancel();
  },

  // ドロップ等で受け取ったモデル（htdemucs_embedded.onnx の中身）を使う。
  // models/htdemucs/ が未配置の環境向け。
  setModelData(arrayBuffer) {
    this.backends.onnx.setModelData(arrayBuffer);
  },

  error(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  },

  // ---- 入力変換 -----------------------------------------------------------

  // buffer の offset..offset+duration（秒）を 44.1kHz/2ch へ変換する。
  // リサンプリングとチャンネル数合わせ（モノ→ステレオ等）は OfflineAudioContext に任せる。
  async toStereo44k(buffer, offset, duration) {
    const off = Math.max(0, offset || 0);
    const dur = duration == null ? Math.max(0, buffer.duration - off) : duration;
    const len = Math.max(1, Math.round(dur * this.SAMPLE_RATE));
    const ctx = new OfflineAudioContext(2, len, this.SAMPLE_RATE);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(0, off, dur);
    const rendered = await ctx.startRendering();
    return { left: rendered.getChannelData(0), right: rendered.getChannelData(1) };
  },

  // Worker 並列数。1 Worker あたり実測 ≈2.7GB 使うので、コア数だけでなく
  // メモリの当たりも見て 1〜4 に丸める（スパイク実測: 4 Worker で 3.7 倍スケール）。
  autoWorkers() {
    const hc = navigator.hardwareConcurrency || 4;
    let n = Math.max(1, Math.min(4, Math.floor(hc / 4)));
    const dm = navigator.deviceMemory;                       // GB（Chrome は最大 8 と申告）
    if (dm) n = Math.max(1, Math.min(n, Math.floor(dm / 3)));
    const pm = performance.memory;                           // JS ヒープ上限が小さい環境は控えめに
    if (pm && pm.jsHeapSizeLimit < 2.5e9) n = Math.min(n, 2);
    return n;
  },

  // ---- DSP ----------------------------------------------------------------
  //
  // STFT/iSTFT と Demucs 固有の前後処理。timcsy/demucs-web（MIT）の実装を移植したもの。
  // Worker へは dspFactory.toString() で丸ごと搬入するため、この関数は外側を一切
  // 参照しない完全自己完結で書く（DAW も document も触らない）。
  dspFactory: function () {
    const CONSTANTS = {
      SAMPLE_RATE: 44100,
      FFT_SIZE: 4096,
      HOP_SIZE: 1024,
      TRAINING_SAMPLES: 343980,    // モデル固定の入力長（≈7.8秒）
      MODEL_SPEC_BINS: 2048,       // FFT4096 の 2049 ビンから Nyquist を落とした数
      MODEL_SPEC_FRAMES: 336,
      SEGMENT_OVERLAP: 0.25,       // セグメントのオーバーラップ率（ストライド 257,985）
      TRACKS: ['drums', 'bass', 'other', 'vocals'],
    };
    const { FFT_SIZE, HOP_SIZE, TRAINING_SAMPLES, MODEL_SPEC_BINS, MODEL_SPEC_FRAMES } = CONSTANTS;

    // ---- FFT（Cooley-Tukey radix-2。twiddle と Hann 窓はキャッシュ）----
    const fftTw = new Map(), ifftTw = new Map(), hannWin = new Map();
    function twiddles(map, n, sign) {
      let t = map.get(n);
      if (t) return t;
      const real = new Float32Array(n / 2), imag = new Float32Array(n / 2);
      for (let k = 0; k < n / 2; k++) {
        const a = sign * 2 * Math.PI * k / n;
        real[k] = Math.cos(a);
        imag[k] = Math.sin(a);
      }
      map.set(n, t = { real, imag });
      return t;
    }
    function hann(size) {
      let w = hannWin.get(size);
      if (w) return w;
      w = new Float32Array(size);
      for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / size));
      hannWin.set(size, w);
      return w;
    }
    function bitReverse(n, bits) {
      let r = 0;
      for (let i = 0; i < bits; i++) { r = (r << 1) | (n & 1); n >>= 1; }
      return r;
    }
    function butterfly(realOut, imagOut, tw, n) {
      for (let size = 2; size <= n; size *= 2) {
        const half = size / 2, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = 0; j < half; j++) {
            const k = j * step;
            const tr = tw.real[k], ti = tw.imag[k];
            const i1 = i + j, i2 = i + j + half;
            const er = realOut[i1], ei = imagOut[i1];
            const or_ = realOut[i2] * tr - imagOut[i2] * ti;
            const oi = realOut[i2] * ti + imagOut[i2] * tr;
            realOut[i1] = er + or_; imagOut[i1] = ei + oi;
            realOut[i2] = er - or_; imagOut[i2] = ei - oi;
          }
        }
      }
    }
    function fft(realOut, imagOut, realIn, n) {
      const bits = Math.log2(n) | 0;
      for (let i = 0; i < n; i++) {
        realOut[i] = realIn[bitReverse(i, bits)];
        imagOut[i] = 0;
      }
      butterfly(realOut, imagOut, twiddles(fftTw, n, -1), n);
    }
    function ifft(realOut, imagOut, realIn, imagIn, n) {
      const bits = Math.log2(n) | 0;
      for (let i = 0; i < n; i++) {
        const j = bitReverse(i, bits);
        realOut[i] = realIn[j];
        imagOut[i] = imagIn[j];
      }
      butterfly(realOut, imagOut, twiddles(ifftTw, n, 1), n);
      for (let i = 0; i < n; i++) { realOut[i] /= n; imagOut[i] /= n; }
    }

    // ---- STFT / iSTFT（torch.stft(normalized=True) と同じ 1/sqrt(n) スケール）----
    function stft(signal, fftSize, hopSize) {
      const numFrames = Math.floor((signal.length - fftSize) / hopSize) + 1;
      const numBins = fftSize / 2 + 1;
      const win = hann(fftSize);
      const scale = 1.0 / Math.sqrt(fftSize);
      const specReal = new Float32Array(numFrames * numBins);
      const specImag = new Float32Array(numFrames * numBins);
      const fr = new Float32Array(fftSize), fi = new Float32Array(fftSize);
      const frame = new Float32Array(fftSize);
      for (let f = 0; f < numFrames; f++) {
        const start = f * hopSize;
        for (let i = 0; i < fftSize; i++) frame[i] = signal[start + i] * win[i];
        fft(fr, fi, frame, fftSize);
        const o = f * numBins;
        for (let k = 0; k < numBins; k++) {
          specReal[o + k] = fr[k] * scale;
          specImag[o + k] = fi[k] * scale;
        }
      }
      return { real: specReal, imag: specImag, numFrames, numBins };
    }
    function istft(specReal, specImag, numFrames, numBins, fftSize, hopSize, length) {
      const outLen = length || (numFrames - 1) * hopSize + fftSize;
      const output = new Float32Array(outLen);
      const winSum = new Float32Array(outLen);
      const win = hann(fftSize);
      const scale = Math.sqrt(fftSize);
      const fullR = new Float32Array(fftSize), fullI = new Float32Array(fftSize);
      const outR = new Float32Array(fftSize), outI = new Float32Array(fftSize);
      for (let f = 0; f < numFrames; f++) {
        fullR.fill(0); fullI.fill(0);
        for (let k = 0; k < numBins; k++) {
          fullR[k] = specReal[f * numBins + k];
          fullI[k] = specImag[f * numBins + k];
        }
        for (let k = 1; k < numBins - 1; k++) {   // 実信号なので上半分は共役対称
          fullR[fftSize - k] = fullR[k];
          fullI[fftSize - k] = -fullI[k];
        }
        ifft(outR, outI, fullR, fullI, fftSize);
        const start = f * hopSize;
        for (let i = 0; i < fftSize && start + i < outLen; i++) {
          output[start + i] += outR[i] * win[i] * scale;
          winSum[start + i] += win[i] * win[i];
        }
      }
      for (let i = 0; i < outLen; i++) if (winSum[i] > 1e-8) output[i] /= winSum[i];
      return output;
    }
    function reflectPad(signal, padLeft, padRight) {
      const n = signal.length;
      const out = new Float32Array(padLeft + n + padRight);
      for (let i = 0; i < padLeft; i++) out[i] = signal[Math.min(padLeft - i, n - 1)];
      out.set(signal, padLeft);
      for (let i = 0; i < padRight; i++) out[padLeft + n + i] = signal[Math.max(0, n - 2 - i)];
      return out;
    }

    // ---- Demucs 固有の前後処理 ----
    // モデル入力を作る。padding は PyTorch 実装（standalone_spec + center=True）に厳密一致:
    //   reflect pad 1536 + 右端の端数、さらに center 2048。STFT 後は Nyquist ビンと
    //   前後 2 フレームずつを捨てて 2048×336 に揃える。
    function prepareModelInput(leftChannel, rightChannel) {
      const inputLength = TRAINING_SAMPLES;
      const padL = new Float32Array(inputLength);
      const padR = new Float32Array(inputLength);
      const copyLen = Math.min(leftChannel.length, inputLength);
      padL.set(leftChannel.subarray(0, copyLen));
      padR.set(rightChannel.subarray(0, copyLen));

      const le = Math.ceil(inputLength / HOP_SIZE);
      const pad = Math.floor(HOP_SIZE / 2) * 3;                 // 1536
      const padRight = pad + le * HOP_SIZE - inputLength;
      const centerPad = FFT_SIZE / 2;                           // 2048

      const stftL = stft(reflectPad(reflectPad(padL, pad, padRight), centerPad, centerPad), FFT_SIZE, HOP_SIZE);
      const stftR = stft(reflectPad(reflectPad(padR, pad, padRight), centerPad, centerPad), FFT_SIZE, HOP_SIZE);

      const numBins = MODEL_SPEC_BINS, numFrames = MODEL_SPEC_FRAMES;
      const frameOffset = 2;
      // magSpec のチャンネル順: [L実, L虚, R実, R虚]
      const magSpec = new Float32Array(4 * numBins * numFrames);
      for (let f = 0; f < numFrames; f++) {
        const srcFrame = f + frameOffset;
        for (let b = 0; b < numBins; b++) {
          const srcIdx = srcFrame * stftL.numBins + b;
          magSpec[0 * numBins * numFrames + b * numFrames + f] = stftL.real[srcIdx];
          magSpec[1 * numBins * numFrames + b * numFrames + f] = stftL.imag[srcIdx];
          magSpec[2 * numBins * numFrames + b * numFrames + f] = stftR.real[srcIdx];
          magSpec[3 * numBins * numFrames + b * numFrames + f] = stftR.imag[srcIdx];
        }
      }
      const waveform = new Float32Array(2 * inputLength);
      waveform.set(padL, 0);
      waveform.set(padR, inputLength);
      return { waveform, magSpec };
    }

    // モデルの周波数出力 [1,4,4,2048,336] をトラック別の複素スペクトログラムへ
    function standaloneMask(freqOutput) {
      const numBins = MODEL_SPEC_BINS, numFrames = MODEL_SPEC_FRAMES;
      const result = [];
      for (let t = 0; t < 4; t++) {
        const spec = {
          leftReal: new Float32Array(numBins * numFrames),
          leftImag: new Float32Array(numBins * numFrames),
          rightReal: new Float32Array(numBins * numFrames),
          rightImag: new Float32Array(numBins * numFrames),
        };
        const base = t * 4 * numBins * numFrames;
        for (let f = 0; f < numFrames; f++) {
          for (let b = 0; b < numBins; b++) {
            const src = b * numFrames + f;
            const out = b * numFrames + f;
            spec.leftReal[out] = freqOutput[base + 0 * numBins * numFrames + src];
            spec.leftImag[out] = freqOutput[base + 1 * numBins * numFrames + src];
            spec.rightReal[out] = freqOutput[base + 2 * numBins * numFrames + src];
            spec.rightImag[out] = freqOutput[base + 3 * numBins * numFrames + src];
          }
        }
        result.push(spec);
      }
      return result;
    }

    // 複素スペクトログラム → 時間領域。PyTorch istft(center=True) が暗黙に行う
    // n_fft/2 の相殺と standalone_ispec の pad を合わせた offset 3584 から切り出すのが肝
    //（ここを外すと先頭が無音になり全体がずれる。スパイクで実測確認済み）。
    function standaloneIspec(trackSpec, targetLength) {
      const numBins = MODEL_SPEC_BINS, numFrames = MODEL_SPEC_FRAMES;
      const paddedBins = numBins + 1;      // Nyquist ビンを 0 で戻す
      const paddedFrames = numFrames + 4;  // 前後 2 フレームずつ 0 で戻す
      const padChannel = (real, imag) => {
        const pr = new Float32Array(paddedFrames * paddedBins);
        const pi = new Float32Array(paddedFrames * paddedBins);
        for (let f = 0; f < numFrames; f++) {
          for (let b = 0; b < numBins; b++) {
            const src = b * numFrames + f;
            const dst = (f + 2) * paddedBins + b;
            pr[dst] = real[src];
            pi[dst] = imag[src];
          }
        }
        return { real: pr, imag: pi };
      };
      const L = padChannel(trackSpec.leftReal, trackSpec.leftImag);
      const R = padChannel(trackSpec.rightReal, trackSpec.rightImag);
      const istftLength = (paddedFrames - 1) * HOP_SIZE + FFT_SIZE;
      const lo = istft(L.real, L.imag, paddedFrames, paddedBins, FFT_SIZE, HOP_SIZE, istftLength);
      const ro = istft(R.real, R.imag, paddedFrames, paddedBins, FFT_SIZE, HOP_SIZE, istftLength);
      const offset = FFT_SIZE / 2 + Math.floor(HOP_SIZE / 2) * 3;   // 2048 + 1536 = 3584
      return {
        left: new Float32Array(lo.subarray(offset, offset + targetLength)),
        right: new Float32Array(ro.subarray(offset, offset + targetLength)),
      };
    }

    // モデルの2出力を合成して最終ステムにする: 最終 = 時間出力(add_67) + iSTFT(周波数出力)。
    // 時間出力だけだとステム間の分離が甘くなる（周波数分岐が主役）。
    // 戻り値は [drumsL, drumsR, bassL, bassR, otherL, otherR, vocalsL, vocalsR]。
    function combineOutputs(timeData, timeShape, freqData) {
      const samples = timeShape[3];
      const numCh = timeShape[2];
      const specs = standaloneMask(freqData);
      const out = [];
      for (let t = 0; t < 4; t++) {
        const fq = standaloneIspec(specs[t], samples);
        const L = new Float32Array(samples), R = new Float32Array(samples);
        const baseL = t * numCh * samples, baseR = baseL + samples;
        for (let i = 0; i < samples; i++) {
          L[i] = timeData[baseL + i] + (fq.left[i] || 0);
          R[i] = timeData[baseR + i] + (fq.right[i] || 0);
        }
        out.push(L, R);
      }
      return out;
    }

    return { CONSTANTS, stft, istft, reflectPad, prepareModelInput, standaloneMask, standaloneIspec, combineOutputs };
  },
  dsp: null,   // ページ側インスタンス（末尾で生成。テストからも直接使う）

  // ---- セグメント分割と窓合成 ---------------------------------------------

  // セグメントの開始位置一覧（サンプル）。ストライドはオーバーラップ25%ぶん短い。
  segmentStarts(totalSamples) {
    const C = this.dsp.CONSTANTS;
    const stride = Math.floor(C.TRAINING_SAMPLES * (1 - C.SEGMENT_OVERLAP));
    const starts = [];
    for (let s = 0; s === 0 || s < totalSamples; s += stride) starts.push(s);
    return { starts, stride };
  },

  // 線形クロスフェード窓。オーバーラップ区間（ストライドの半分）で立ち上げ/落とす。
  // 後で重み合計で正規化するので、単独区間では実質 1 になる。
  overlapWindow(segLen, stride) {
    const w = new Float32Array(segLen);
    for (let i = 0; i < segLen; i++) {
      const fadeIn = Math.min(i / (stride * 0.5), 1);
      const fadeOut = Math.min((segLen - i) / (stride * 0.5), 1);
      w[i] = Math.min(fadeIn, fadeOut);
    }
    return w;
  },

  // セグメントごとの結果（[{left,right}×4]）を窓合成して 4 AudioBuffer にする
  mergeSegments(results, starts, stride, totalSamples) {
    const C = this.dsp.CONSTANTS;
    const outs = this.TRACKS.map(() => ({
      left: new Float32Array(totalSamples),
      right: new Float32Array(totalSamples),
    }));
    const weights = new Float32Array(totalSamples);
    for (let k = 0; k < starts.length; k++) {
      const start = starts[k];
      const segLen = Math.min(C.TRAINING_SAMPLES, totalSamples - start);
      const win = this.overlapWindow(segLen, stride);
      for (let t = 0; t < 4; t++) {
        const st = results[k][t];
        const ol = outs[t].left, orr = outs[t].right;
        for (let i = 0; i < segLen; i++) {
          ol[start + i] += st.left[i] * win[i];
          orr[start + i] += st.right[i] * win[i];
        }
      }
      for (let i = 0; i < segLen; i++) weights[start + i] += win[i];
    }
    const stems = {};
    this.TRACKS.forEach((name, t) => {
      const buf = new AudioBuffer({ numberOfChannels: 2, length: totalSamples, sampleRate: this.SAMPLE_RATE });
      const L = outs[t].left, R = outs[t].right;
      for (let i = 0; i < totalSamples; i++) {
        if (weights[i] > 0) { L[i] /= weights[i]; R[i] /= weights[i]; }
      }
      buf.copyToChannel(L, 0);
      buf.copyToChannel(R, 1);
      stems[name] = buf;
    });
    return stems;
  },
};

// ---- onnx バックエンド（既定） --------------------------------------------
DAW.stems.backends.onnx = {
  assets: null,          // 展開済みアセット { ortJs, ortMjs, wasm(U8), model(U8) }
  modelOverride: null,   // ドロップ等で受け取ったモデル（models/ 未配置環境向け）

  setModelData(arrayBuffer) {
    this.modelOverride = new Uint8Array(arrayBuffer);
    if (this.assets) this.assets.model = this.modelOverride;
  },

  // ---- アセット搬入 ----
  // classic script（base64 代入）を動的注入して読む。file:// でも動く。
  // http(s) では script が読めなかったとき fetch → Function 実行のフォールバックも試す。
  loadScript(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.dataset.stemsAsset = '1';
      s.onload = () => resolve(s);
      s.onerror = async () => {
        s.remove();
        if (/^https?:$/.test(location.protocol)) {
          try {
            const res = await fetch(url);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            new Function(await res.text())();
            return resolve(null);
          } catch (e) { /* 下の reject に落とす */ }
        }
        reject(DAW.stems.error('asset', 'アセットを読み込めません: ' + url));
      };
      document.head.appendChild(s);
    });
  },

  removeAssetScripts() {
    for (const s of document.querySelectorAll('script[data-stems-asset]')) s.remove();
  },

  b64ToU8(str) {
    const bin = atob(str);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  },

  // ランタイムとモデルを読み込んで展開する。初回のみ重い（モデル 172MB）。
  // 展開後は base64 文字列と script タグを破棄してメモリを返す。
  // 展開済みバイト列は再実行に備えてキャッシュする（Worker へはコピーで渡すため使い回せる）。
  async ensureAssets(progress) {
    if (this.assets && this.assets.model) return this.assets;
    const NS = self.DAW_STEMS_ASSETS = self.DAW_STEMS_ASSETS || {};
    const base = DAW.stems.BASE;

    // モデルを先に確認する（無いなら 18MB のランタイムを読む前に誘導を返す）
    let model = this.modelOverride;
    if (!model) {
      if (!NS.manifest) {
        try {
          await this.loadScript(base + 'models/htdemucs/manifest.js');
        } catch (e) {
          throw DAW.stems.error('model-missing',
            'モデルが見つかりません。models/htdemucs/ を配置するか、' +
            'htdemucs_embedded.onnx をタイムラインへドロップしてください。');
        }
      }
      const man = NS.manifest;
      for (let i = 0; i < man.files.length; i++) {
        if (NS.modelParts[i] == null) await this.loadScript(base + 'models/htdemucs/' + man.files[i]);
        if (progress) progress({ phase: 'load', done: i + 1, total: man.parts });
      }
      // base64 → バイト列。チャンクを順に詰める
      model = new Uint8Array(man.bytes);
      let off = 0;
      for (let i = 0; i < man.parts; i++) {
        const part = this.b64ToU8(NS.modelParts[i]);
        model.set(part, off);
        off += part.length;
      }
      if (off !== man.bytes) throw DAW.stems.error('model-broken', `モデルのサイズが合いません（${off} / ${man.bytes} バイト）`);
      NS.modelParts = [];   // base64 文字列（240MB）を解放
    }

    // ort ランタイム（vendor/）
    if (!(NS.ortJs && NS.ortMjs && NS.ortWasm) && !this.runtime) {
      await this.loadScript(base + 'vendor/ort-js.b64.js');
      await this.loadScript(base + 'vendor/ort-mjs.b64.js');
      await this.loadScript(base + 'vendor/ort-wasm.b64.js');
    }
    if (!this.runtime) {
      const dec = new TextDecoder();
      this.runtime = {
        ortJs: dec.decode(this.b64ToU8(NS.ortJs)),
        ortMjs: dec.decode(this.b64ToU8(NS.ortMjs)),
        wasm: this.b64ToU8(NS.ortWasm),
      };
      delete NS.ortJs; delete NS.ortMjs; delete NS.ortWasm;
    }
    this.removeAssetScripts();
    this.assets = { ortJs: this.runtime.ortJs, ortMjs: this.runtime.ortMjs, wasm: this.runtime.wasm, model };
    return this.assets;
  },

  // ---- Worker ----
  // Blob Worker のソース。DSP は dspFactory.toString() で埋め込む（file:// では
  // Worker から外部ファイルを importScripts できないため）。ort とその wasm も
  // postMessage で受け取った実体から Blob URL を作って読む。fetch はゼロ。
  workerSource() {
    return [
      "'use strict';",
      'const DSP = (' + DAW.stems.dspFactory.toString() + ')();',
      'let session = null;',
      'self.onmessage = async (e) => {',
      '  const d = e.data;',
      '  try {',
      "    if (d.type === 'init') {",
      "      importScripts(URL.createObjectURL(new Blob([d.ortJs], { type: 'text/javascript' })));",
      '      ort.env.wasm.numThreads = 1;',
      "      ort.env.wasm.wasmPaths = { mjs: URL.createObjectURL(new Blob([d.ortMjs], { type: 'text/javascript' })) };",
      '      ort.env.wasm.wasmBinary = d.wasm.buffer;',
      "      ort.env.logLevel = 'warning';",
      "      session = await ort.InferenceSession.create(d.model, { executionProviders: ['wasm'] });",
      "      postMessage({ type: 'ready' });",
      '      return;',
      '    }',
      "    if (d.type === 'segment') {",
      '      const C = DSP.CONSTANTS;',
      '      const input = DSP.prepareModelInput(new Float32Array(d.left), new Float32Array(d.right));',
      '      const feeds = {};',
      "      feeds[session.inputNames[0]] = new ort.Tensor('float32', input.waveform, [1, 2, C.TRAINING_SAMPLES]);",
      "      feeds[session.inputNames[1]] = new ort.Tensor('float32', input.magSpec, [1, 4, C.MODEL_SPEC_BINS, C.MODEL_SPEC_FRAMES]);",
      '      const out = await session.run(feeds);',
      '      let timeData = null, timeShape = null, freqData = null;',
      '      for (const n of session.outputNames) {',
      '        const t = out[n];',
      '        if (t.dims.length === 4 && t.dims[2] === 2) { timeData = t.data; timeShape = t.dims; }',
      '        else if (t.dims.length === 5) { freqData = t.data; }',
      '      }',
      "      if (!timeData || !freqData) throw new Error('モデル出力の形が想定と違います');",
      '      const stems = DSP.combineOutputs(timeData, timeShape, freqData);',
      "      postMessage({ type: 'done', seg: d.seg, stems: stems.map(a => a.buffer) }, stems.map(a => a.buffer));",
      '    }',
      '  } catch (err) {',
      "    postMessage({ type: 'error', seg: d && d.seg, error: String(err && (err.stack || err.message) || err) });",
      '  }',
      '};',
    ].join('\n');
  },

  // ---- 分離本体 ----
  async separate(buffer, opts, handle) {
    const S = DAW.stems;
    // キャンセルは「どの await 中でも」即座に効かせたいので、reject するだけの
    // Promise を作って各段階と race する。Worker は terminate で推論ごと止める。
    let onCancel = () => {};
    const cancelPromise = new Promise((resolve, reject) => {
      handle.cancel = () => {
        if (handle.cancelled) return;
        handle.cancelled = true;
        onCancel();
        reject(S.error('cancelled', 'キャンセルされました'));
      };
    });
    cancelPromise.catch(() => {});   // 未キャンセル時に unhandledrejection にしない
    const raced = p => Promise.race([p, cancelPromise]);
    const progress = p => { if (opts.onProgress && !handle.cancelled) opts.onProgress(p); };

    // 1) 44.1kHz/2ch へ変換
    const { left, right } = await raced(S.toStereo44k(buffer, opts.offset, opts.duration));
    const total = left.length;
    const { starts, stride } = S.segmentStarts(total);
    const SEG = S.dsp.CONSTANTS.TRAINING_SAMPLES;
    const results = new Array(starts.length);
    let done = 0;
    progress({ phase: 'separate', done: 0, total: starts.length });

    const sliceSeg = start => {
      const len = Math.min(SEG, total - start);
      return { left: left.slice(start, start + len), right: right.slice(start, start + len) };
    };

    if (opts.infer) {
      // テスト用経路: 推論だけ差し替え。Worker もモデルも使わない
      for (let k = 0; k < starts.length; k++) {
        const seg = sliceSeg(starts[k]);
        results[k] = await raced(Promise.resolve(opts.infer(seg.left, seg.right, k)));
        done++;
        progress({ phase: 'separate', done, total: starts.length });
      }
    } else {
      const assets = await raced(this.ensureAssets(progress));
      const nWorkers = Math.max(1, Math.min(opts.workers || S.autoWorkers(), starts.length));
      const url = URL.createObjectURL(new Blob([this.workerSource()], { type: 'text/javascript' }));
      const workers = [];
      onCancel = () => { for (const w of workers) w.terminate(); };
      try {
        const queue = starts.map((start, k) => ({ k, start }));
        const runWorker = async () => {
          const w = new Worker(url);
          workers.push(w);
          const call = (msg, transfer) => new Promise((resolve, reject) => {
            w.onmessage = e => e.data.type === 'error'
              ? reject(S.error('inference', e.data.error))
              : resolve(e.data);
            w.onerror = e => reject(S.error('worker', 'Worker エラー: ' + (e.message || e)));
            w.postMessage(msg, transfer || []);
          });
          // モデルと wasm は postMessage のコピーで渡す（transfer できるのは1本だけなので）
          await call({ type: 'init', ortJs: assets.ortJs, ortMjs: assets.ortMjs, wasm: assets.wasm, model: assets.model });
          while (queue.length && !handle.cancelled) {
            const job = queue.shift();
            const seg = sliceSeg(job.start);
            const r = await call({ type: 'segment', seg: job.k, left: seg.left.buffer, right: seg.right.buffer },
              [seg.left.buffer, seg.right.buffer]);
            // Worker からは [L,R,L,R,...] の 8 本。マージ用の [{left,right}×4] へ
            results[job.k] = [0, 1, 2, 3].map(t => ({
              left: new Float32Array(r.stems[t * 2]),
              right: new Float32Array(r.stems[t * 2 + 1]),
            }));
            done++;
            progress({ phase: 'separate', done, total: starts.length });
          }
          w.terminate();
        };
        await raced(Promise.all(Array.from({ length: nWorkers }, runWorker)));
      } finally {
        for (const w of workers) w.terminate();
        URL.revokeObjectURL(url);
      }
    }
    if (handle.cancelled) throw S.error('cancelled', 'キャンセルされました');

    // 3) 窓合成（線形クロスフェード + 重み正規化）→ 4 AudioBuffer
    return S.mergeSegments(results, starts, stride, total);
  },
};

// ---- python バックエンド（ローカルサイドカー） -----------------------------
// tools/stems-sidecar/ の demucs サーバ（http://127.0.0.1:8787）へ委譲する。
// CPU ネイティブ推論なのでブラウザ内処理の数倍速い（30秒 WAV ≈14秒）。
// 起動していれば separate() の自動検出（/ping）で優先的に選ばれる。
// プロトコルの詳細（DAWS フレーミング等）は tools/stems-sidecar/README.md。
DAW.stems.backends.python = {
  URL: 'http://127.0.0.1:8787',
  PING_TIMEOUT: 1500,          // 検出タイムアウト（ms）。ローカルなので短くてよい
  POLL_INTERVAL: 1000,         // /progress のポーリング間隔（ms）

  // fetch はテストでモックできるよう1点に集約する（window.fetch 全体は差し替えない）
  _fetch: (url, init) => fetch(url, init),

  // サイドカーが居るか /ping で確かめる。落ちている・応答しない・不正応答は全て false
  //（呼び出し側がブラウザ内処理へフォールバックする）。
  async detect() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.PING_TIMEOUT);
    try {
      const res = await this._fetch(this.URL + '/ping', { signal: ctrl.signal });
      if (!res.ok) return false;
      const j = await res.json();
      return !!(j && j.ok);
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  },

  // /progress を1秒ごとにポーリングして進捗を流す。戻り値は停止関数。
  // 応答は {running, progress:0..1, stage} なので percent 表示用の形へ変換する。
  pollProgress(handle, progress) {
    let stopped = false, timer = 0;
    const tick = async () => {
      try {
        const res = await this._fetch(this.URL + '/progress');
        const j = await res.json();
        if (!stopped && j && j.running) {
          progress({ phase: 'separate', unit: 'percent',
                     done: Math.max(0, Math.min(100, Math.round((j.progress || 0) * 100))), total: 100 });
        }
      } catch (e) { /* 一時的な失敗は無視（本体の fetch 側でエラーになる） */ }
      if (!stopped) timer = setTimeout(tick, this.POLL_INTERVAL);
    };
    timer = setTimeout(tick, this.POLL_INTERVAL);
    return () => { stopped = true; clearTimeout(timer); };
  },

  async separate(buffer, opts, handle) {
    const S = DAW.stems;
    const ctrl = new AbortController();
    // キャンセルは fetch の abort（即座に戻る）と POST /cancel（サーバ側の demucs を
    // kill する）の併用。abort だけだとサーバが最後まで無駄に回り続ける。
    handle.cancel = () => {
      if (handle.cancelled) return;
      handle.cancelled = true;
      ctrl.abort();
      this._fetch(this.URL + '/cancel', { method: 'POST' }).catch(() => {});
    };
    const progress = p => { if (opts.onProgress && !handle.cancelled) opts.onProgress(p); };
    const cancelledErr = () => S.error('cancelled', 'キャンセルされました');

    // 1) 44.1kHz/2ch へ変換して 16bit WAV にエンコード（既存エンコーダを再利用）
    const { left, right } = await S.toStereo44k(buffer, opts.offset, opts.duration);
    if (handle.cancelled) throw cancelledErr();
    // サイドカーの入力は 16bit 固定（書き出しオプションのビット深度とは無関係）
    const wav = DAW.wav.encodeWav({
      numberOfChannels: 2, sampleRate: S.SAMPLE_RATE, length: left.length,
      getChannelData: c => (c ? right : left),
    }, { bitDepth: 16 });
    progress({ phase: 'separate', unit: 'percent', done: 0, total: 100 });

    // 2) /separate へ POST。待っている間は /progress ポーリングで進捗を流す
    const stopPoll = this.pollProgress(handle, progress);
    let res;
    try {
      res = await this._fetch(this.URL + '/separate', {
        method: 'POST', body: wav, signal: ctrl.signal,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    } catch (e) {
      if (handle.cancelled) throw cancelledErr();
      throw S.error('network',
        'サイドカーと通信できません（サーバ停止の可能性）: ' + ((e && e.message) || e));
    } finally {
      stopPoll();
    }
    if (handle.cancelled || res.status === 499) throw cancelledErr();
    if (res.status === 409) throw S.error('busy', 'サイドカーが別の分離を実行中です。完了を待ってから再試行してください');
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error || ''; } catch (e) { /* 本文が JSON でない場合 */ }
      throw S.error('sidecar', `サイドカーがエラーを返しました（HTTP ${res.status}）` + (detail ? ': ' + detail : ''));
    }
    const body = await res.arrayBuffer();
    if (handle.cancelled) throw cancelledErr();
    progress({ phase: 'separate', unit: 'percent', done: 100, total: 100 });

    // 3) DAWS フレーミングをパースして4ステムを取り出す
    const parsed = this.parseFrame(body);
    const stems = {};
    for (const name of S.TRACKS) {
      if (!parsed[name]) throw S.error('sidecar', 'サイドカーの応答にステムがありません: ' + name);
      stems[name] = parsed[name];
    }
    return stems;
  },

  // "DAWS" フレーミング（magic 4B + uint32LE ヘッダ長 + JSON + WAV 連結）をパースして
  // { name: AudioBuffer } を返す。WAV は自前デコード（decodeAudioData は ctx の
  // サンプルレートへ勝手にリサンプルするので使わない）。
  parseFrame(ab) {
    const S = DAW.stems;
    const dv = new DataView(ab);
    const bad = msg => S.error('sidecar', 'サイドカーの応答形式が不正です' + (msg ? `（${msg}）` : ''));
    if (ab.byteLength < 8 || dv.getUint32(0, false) !== 0x44415753) throw bad('magic');   // "DAWS"
    const n = dv.getUint32(4, true);
    if (8 + n > ab.byteLength) throw bad('ヘッダ長');
    let hdr;
    try { hdr = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 8, n))); }
    catch (e) { throw bad('JSON'); }
    if (!hdr || !Array.isArray(hdr.stems)) throw bad('stems');
    const base = 8 + n;
    const out = {};
    for (const s of hdr.stems) {
      if (base + s.offset + s.length > ab.byteLength) throw bad(s.name + ' の範囲');
      out[s.name] = this.decodeWav(new DataView(ab, base + s.offset, s.length));
    }
    return out;
  },

  // WAV（RIFF）→ AudioBuffer。16bit PCM（format 1）と float32（format 3）に対応。
  // チャンクを順に歩くので、fmt/data 以外のチャンク（LIST 等）が挟まっても壊れない。
  decodeWav(dv) {
    const S = DAW.stems;
    const bad = msg => S.error('sidecar', 'ステム WAV をデコードできません（' + msg + '）');
    const tag = o => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    if (dv.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw bad('RIFF ではない');
    let pos = 12, fmt = null, dataOff = -1, dataLen = 0;
    while (pos + 8 <= dv.byteLength) {
      const id = tag(pos), size = dv.getUint32(pos + 4, true);
      if (id === 'fmt ') {
        fmt = {
          format: dv.getUint16(pos + 8, true),
          channels: dv.getUint16(pos + 10, true),
          sampleRate: dv.getUint32(pos + 12, true),
          bits: dv.getUint16(pos + 22, true),
        };
      } else if (id === 'data') {
        dataOff = pos + 8;
        dataLen = Math.min(size, dv.byteLength - dataOff);
      }
      pos += 8 + size + (size & 1);   // チャンクは2バイト境界に揃う
    }
    if (!fmt || dataOff < 0) throw bad('fmt/data チャンクがない');
    const isFloat = fmt.format === 3 && fmt.bits === 32;
    const isPcm16 = fmt.format === 1 && fmt.bits === 16;
    if (!isFloat && !isPcm16) throw bad(`未対応フォーマット format=${fmt.format} bits=${fmt.bits}`);
    if (fmt.channels < 1) throw bad('チャンネル数 0');
    const bytesPer = fmt.bits / 8;
    const frames = Math.floor(dataLen / (fmt.channels * bytesPer));
    if (frames < 1) throw bad('データが空');
    const buf = new AudioBuffer({ numberOfChannels: fmt.channels, length: frames, sampleRate: fmt.sampleRate });
    for (let c = 0; c < fmt.channels; c++) {
      const d = buf.getChannelData(c);
      if (isFloat) {
        for (let i = 0; i < frames; i++) d[i] = dv.getFloat32(dataOff + (i * fmt.channels + c) * 4, true);
      } else {
        for (let i = 0; i < frames; i++) d[i] = dv.getInt16(dataOff + (i * fmt.channels + c) * 2, true) / 32768;
      }
    }
    return buf;
  },
};

DAW.stems.dsp = DAW.stems.dspFactory();
