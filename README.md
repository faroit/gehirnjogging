# Dr. Stöter's Gehirnjogging

Dr. Stöter's Gehirnjogging is a standalone, touch-first web version of the **Calculations ×20** exercise: twenty single-digit addition, subtraction, and multiplication problems answered by handwriting.

It is an original, unofficial implementation and is not affiliated with Nintendo, Brain Age, or Dr. Ryuta Kawashima. It uses no original game code, artwork, audio, or branding.

## Run it

The app has no package dependencies. Serve the folder with any static HTTP server:

```bash
python3 -m http.server 4173
```

Then open [http://localhost:4173](http://localhost:4173). After the first load it is cached for offline use and can be installed as a PWA.

## Static build and deployment

```bash
npm run check
npm run build
```

The production-ready static site is written to `dist/`. Relative asset URLs and the service worker make the build suitable for the GitHub Pages project path.

Pushes to `main` run [the Pages workflow](./.github/workflows/deploy-pages.yml), which verifies the app, builds it, uploads the static artifact, and deploys it to GitHub Pages.

## Rules and scoring

- Exactly 20 problems using single-digit operands and `+`, `−`, or `×`.
- Subtraction answers are non-negative; the maximum possible answer is `81`.
- The final score is elapsed time plus **5 seconds for every incorrect answer**.
- A recognized answer advances immediately, whether correct or incorrect, matching the original exercise behavior.
- The original game's documented top rank is under 12 seconds. The remaining result copy in this implementation is descriptive rather than a claim of exact original rank thresholds.

References: the [official Nintendo DS manual](https://www.nintendo.com/eu/media/downloads/games_8/emanuals/nintendo_ds_21/Manual_NintendoDS_DrKawashimasBrainTraining_EN.pdf), [Nintendo's arithmetic tips](https://www.nintendo.com/en-gb/News/2008/Improve-your-maths-speed-in-Brain-Training-250457.html), and the [Calculations guide](https://strategywiki.org/wiki/Brain_Age/Calculations).

## Handwriting model

Recognition stays entirely on the device. `public/model/digits-cnn.bin` is a **6.1 KiB int8-quantized convolutional neural network** converted from the ONNX Model Zoo MNIST model:

```text
28 × 28 input → 8-channel convolution → max pool → 16-channel convolution → max pool → 10 digits
```

The source model reports 98.9% accuracy on the MNIST test set. The runtime is handwritten in browser-native JavaScript with typed arrays, so there is no TensorFlow, ONNX Runtime, or other ML runtime to download. The binary is preloaded while the page opens, and inference reuses its working buffers. The pad never recognizes while the player is writing: pressing **Submit answer** evaluates several low-resolution split candidates and classifies one or two digits. For two-digit answers it combines blank-space and low-ink valleys with the order and geometry of the user's strokes, including whole-stroke grouping when digits touch or overlap.

The little-endian binary starts with the 8-byte magic `DGCNN001`, test accuracy, per-output-channel quantization scales, and the three layers' int8 weights and float32 biases. Run `npm run benchmark` to measure inference on the current machine. See [`public/model/MNIST-CNN-LICENSE.txt`](public/model/MNIST-CNN-LICENSE.txt) for source-model attribution.

To reproduce the compact file, download `mnist-1.onnx` from the model card and run:

```bash
uv run --with onnx python tools/convert_onnx_cnn.py mnist-1.onnx public/model/digits-cnn.bin
```

The source-model license and attribution are bundled with the weights.

## iOS path

The game rules, preprocessing pipeline, and compact CNN weights are framework-independent. A later iOS version can read the same documented weights directly in Swift, convert the layers to Core ML, or use a native online-handwriting recognizer. The PWA can already be added to the iPad or iPhone Home Screen for a standalone full-screen experience.
