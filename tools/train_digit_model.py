#!/usr/bin/env python3
"""Train and export the tiny, dependency-light digit recognizer used by Dr. Stöter's Gehirnjogging.

The exported model is an int8-quantized 784 -> 64 -> 10 MLP. It is deliberately
small enough to ship with the web app and simple enough to run with a few loops
and typed arrays in any browser (and, later, in a native iOS target).
"""

from __future__ import annotations

import argparse
import struct
from pathlib import Path

import numpy as np


def one_hot(labels: np.ndarray, classes: int = 10) -> np.ndarray:
    encoded = np.zeros((labels.size, classes), dtype=np.float32)
    encoded[np.arange(labels.size), labels] = 1.0
    return encoded


def quantize(values: np.ndarray) -> tuple[np.ndarray, float]:
    scale = float(np.max(np.abs(values)) / 127.0) or 1.0
    packed = np.clip(np.round(values / scale), -127, 127).astype(np.int8)
    return packed, scale


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path, help="Path to keras-compatible mnist.npz")
    parser.add_argument("output", type=Path, help="Destination binary model")
    parser.add_argument("--epochs", type=int, default=14)
    args = parser.parse_args()

    rng = np.random.default_rng(20260905)
    with np.load(args.dataset) as data:
        x_train = data["x_train"].reshape(-1, 784).astype(np.float32) / 255.0
        y_train = data["y_train"].astype(np.int64)
        x_test = data["x_test"].reshape(-1, 784).astype(np.float32) / 255.0
        y_test = data["y_test"].astype(np.int64)

    # The recognizer receives already-cropped digits. Mild pixel jitter and
    # noise make it more tolerant of mouse and pencil input than plain MNIST.
    x_train = np.clip(x_train + rng.normal(0.0, 0.012, x_train.shape), 0.0, 1.0)
    y_encoded = one_hot(y_train)

    hidden = 64
    w1 = (rng.standard_normal((784, hidden)) * np.sqrt(2 / 784)).astype(np.float32)
    b1 = np.zeros(hidden, dtype=np.float32)
    w2 = (rng.standard_normal((hidden, 10)) * np.sqrt(2 / hidden)).astype(np.float32)
    b2 = np.zeros(10, dtype=np.float32)

    params = [w1, b1, w2, b2]
    moments = [np.zeros_like(param) for param in params]
    velocities = [np.zeros_like(param) for param in params]
    step = 0
    batch_size = 256

    for epoch in range(args.epochs):
        order = rng.permutation(x_train.shape[0])
        for start in range(0, x_train.shape[0], batch_size):
            step += 1
            indices = order[start : start + batch_size]
            x = x_train[indices]
            targets = y_encoded[indices]

            hidden_linear = x @ w1 + b1
            hidden_values = np.maximum(hidden_linear, 0)
            logits = hidden_values @ w2 + b2
            logits -= np.max(logits, axis=1, keepdims=True)
            probabilities = np.exp(logits)
            probabilities /= np.sum(probabilities, axis=1, keepdims=True)

            d_logits = (probabilities - targets) / x.shape[0]
            gradients = [
                x.T @ ((d_logits @ w2.T) * (hidden_linear > 0)),
                np.sum((d_logits @ w2.T) * (hidden_linear > 0), axis=0),
                hidden_values.T @ d_logits,
                np.sum(d_logits, axis=0),
            ]

            learning_rate = 0.0015 * (0.9 ** epoch)
            for i, (param, gradient) in enumerate(zip(params, gradients)):
                moments[i] = 0.9 * moments[i] + 0.1 * gradient
                velocities[i] = 0.999 * velocities[i] + 0.001 * (gradient * gradient)
                m_hat = moments[i] / (1 - 0.9**step)
                v_hat = velocities[i] / (1 - 0.999**step)
                param -= learning_rate * m_hat / (np.sqrt(v_hat) + 1e-8)

        sample_logits = np.maximum(x_test @ w1 + b1, 0) @ w2 + b2
        accuracy = float(np.mean(np.argmax(sample_logits, axis=1) == y_test))
        print(f"epoch {epoch + 1}/{args.epochs}: test accuracy {accuracy:.4%}")

    w1_data, w1_scale = quantize(w1)
    w2_data, w2_scale = quantize(w2)
    header = struct.pack(
        "<8sIIIfff",
        b"DGMLP001",
        784,
        hidden,
        10,
        round(accuracy, 6),
        w1_scale,
        w2_scale,
    )
    payload = b"".join(
        [
            header,
            w1_data.tobytes(order="C"),
            np.asarray(b1, dtype="<f4").tobytes(),
            w2_data.tobytes(order="C"),
            np.asarray(b2, dtype="<f4").tobytes(),
        ]
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(payload)
    print(f"wrote {args.output} ({args.output.stat().st_size / 1024:.1f} KiB)")


if __name__ == "__main__":
    main()
