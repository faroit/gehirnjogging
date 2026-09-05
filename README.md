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

Recognition stays entirely on the device. `public/model/digits.json` is a **66.8 KiB int8-quantized neural network** with this architecture:

```text
28 × 28 grayscale input → 64 ReLU units → 10 digit probabilities
```

The model was trained on MNIST and reaches 97.0% on the MNIST test set. The runtime is handwritten in browser-native JavaScript with typed arrays, so there is no TensorFlow or other ML runtime to download. The pad never recognizes while the player is writing: pressing **Submit answer** segments the finished ink and classifies one or two digits.

To retrain it, download the standard `mnist.npz` dataset and run:

```bash
/path/to/python-with-numpy tools/train_digit_model.py mnist.npz public/model/digits.json
```

MNIST is available under CC BY-SA 3.0. The exported file records the dataset attribution and measured test accuracy.

## iOS path

The game rules, preprocessing pipeline, and compact dense-network weights are framework-independent. A later iOS version can reuse the same JSON weights directly in Swift or convert the two dense layers to Core ML. The PWA can already be added to the iPad or iPhone Home Screen for a standalone full-screen experience.
