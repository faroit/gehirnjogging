#!/usr/bin/env python3
"""Convert the ONNX Model Zoo MNIST CNN to the app's compact binary format."""

import struct
import sys

import numpy as np
import onnx
from onnx import numpy_helper


MAGIC = b"DGCNN001"


def constant(model, output_name):
    for node in model.graph.node:
        if node.op_type == "Constant" and node.output[0] == output_name:
            return numpy_helper.to_array(node.attribute[0].t)
    raise ValueError(f"Missing ONNX constant {output_name}")


def quantize_per_output(values, output_axis):
    moved = np.moveaxis(values.astype(np.float32), output_axis, 0)
    scales = np.max(np.abs(moved), axis=tuple(range(1, moved.ndim))) / 127
    scales[scales == 0] = 1
    reshape = (len(scales),) + (1,) * (moved.ndim - 1)
    packed = np.rint(moved / scales.reshape(reshape)).clip(-127, 127).astype(np.int8)
    return np.moveaxis(packed, 0, output_axis), scales.astype("<f4")


def main(source, destination):
    model = onnx.load(source)
    conv1, scale1 = quantize_per_output(constant(model, "Constant321"), 0)
    conv2, scale2 = quantize_per_output(constant(model, "Constant340"), 0)
    dense, scale3 = quantize_per_output(constant(model, "Constant312"), 3)
    bias1 = constant(model, "Constant318").astype("<f4")
    bias2 = constant(model, "Constant346").astype("<f4")
    bias3 = constant(model, "Constant367").astype("<f4").reshape(10)

    with open(destination, "wb") as output:
        output.write(MAGIC)
        output.write(struct.pack("<f", 0.9891))
        output.write(b"\0" * 4)
        for values in (scale1, scale2, scale3, conv1, bias1, conv2, bias2, dense, bias3):
            output.write(values.tobytes(order="C"))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: convert_onnx_cnn.py source.onnx destination.bin")
    main(sys.argv[1], sys.argv[2])
