#!/usr/bin/env python3
"""Expand fixed DeepFilterNet3 GRUs for a future strict WebGPU runtime.

Source: deepfilter-stream model-dfn3-512-v1 at commit
be1a989760c93f3107c0c39a6d866df8d6bd40b2, after Bettercomms' documented
FusedConv rewrite. DeepFilterNet and deepfilter-stream license/notice files live
beside the native model and must accompany any future browser distribution.
"""
from pathlib import Path
import argparse
import hashlib
import onnx
import numpy as np
from onnx import TensorProto, helper, numpy_helper

SOURCE_SHA256 = "41ab21252f5357d3ff29999ba37d7b529bcbbb60d3b7e2b8d720726185bb4740"
OUTPUT_SHA256 = "4da0d5c1c79bac9fa32b4b747658a2b34ae1166060277ea8cfa7ab9833d952b2"


def expand_gru(node: onnx.NodeProto, index: int, graph: onnx.GraphProto):
    attrs = {item.name: helper.get_attribute_value(item) for item in node.attribute}
    if attrs.get("direction", b"forward") != b"forward" or attrs.get("layout", 0) != 0:
        raise ValueError(f"{node.name}: only forward layout-0 GRUs are supported")
    if attrs.get("linear_before_reset", 0) != 1 or attrs.get("hidden_size") != 256:
        raise ValueError(f"{node.name}: unexpected DeepFilterNet GRU contract")
    if len(node.input) < 6 or node.input[4]:
        raise ValueError(f"{node.name}: sequence lengths are not supported")
    prefix = f"webgpu_gru_{index}"
    hidden = 256
    axes0 = f"{prefix}_axes0"
    split3 = f"{prefix}_split3"
    split6 = f"{prefix}_split6"
    graph.initializer.extend([
        helper.make_tensor(axes0, TensorProto.INT64, [1], [0]),
        helper.make_tensor(split3, TensorProto.INT64, [3], [hidden] * 3),
        helper.make_tensor(split6, TensorProto.INT64, [6], [hidden] * 6),
    ])
    made = []
    def op(kind, inputs, outputs, **attrs):
        made.append(helper.make_node(kind, inputs, outputs, name=f"{prefix}_{len(made)}_{kind}", **attrs))
    x, w, r, b, _, initial = node.input
    op("Squeeze", [x, axes0], [f"{prefix}_x"])
    op("Squeeze", [initial, axes0], [f"{prefix}_h0"])
    op("Squeeze", [w, axes0], [f"{prefix}_w"])
    op("Squeeze", [r, axes0], [f"{prefix}_rweights"])
    op("Squeeze", [b, axes0], [f"{prefix}_b"])
    op("Transpose", [f"{prefix}_w"], [f"{prefix}_wt"], perm=[1, 0])
    op("Transpose", [f"{prefix}_rweights"], [f"{prefix}_rt"], perm=[1, 0])
    op("MatMul", [f"{prefix}_x", f"{prefix}_wt"], [f"{prefix}_xw"])
    op("MatMul", [f"{prefix}_h0", f"{prefix}_rt"], [f"{prefix}_hr"])
    op("Split", [f"{prefix}_xw", split3], [f"{prefix}_xz", f"{prefix}_xr", f"{prefix}_xh"], axis=1)
    op("Split", [f"{prefix}_hr", split3], [f"{prefix}_hz", f"{prefix}_hrgate", f"{prefix}_hh"], axis=1)
    op("Split", [f"{prefix}_b", split6], [f"{prefix}_wbz", f"{prefix}_wbr", f"{prefix}_wbh", f"{prefix}_rbz", f"{prefix}_rbr", f"{prefix}_rbh"], axis=0)
    for gate in ("z", "r"):
        op("Add", [f"{prefix}_x{gate}", f"{prefix}_h{gate if gate == 'z' else 'rgate'}"], [f"{prefix}_{gate}0"])
        op("Add", [f"{prefix}_{gate}0", f"{prefix}_wb{gate}"], [f"{prefix}_{gate}1"])
        op("Add", [f"{prefix}_{gate}1", f"{prefix}_rb{gate}"], [f"{prefix}_{gate}2"])
        op("Sigmoid", [f"{prefix}_{gate}2"], [f"{prefix}_{gate}"])
    op("Add", [f"{prefix}_hh", f"{prefix}_rbh"], [f"{prefix}_recurrent_h"])
    op("Mul", [f"{prefix}_r", f"{prefix}_recurrent_h"], [f"{prefix}_reset_h"])
    op("Add", [f"{prefix}_xh", f"{prefix}_wbh"], [f"{prefix}_candidate0"])
    op("Add", [f"{prefix}_candidate0", f"{prefix}_reset_h"], [f"{prefix}_candidate1"])
    op("Tanh", [f"{prefix}_candidate1"], [f"{prefix}_candidate"])
    one = f"{prefix}_one"
    graph.initializer.append(helper.make_tensor(one, TensorProto.FLOAT, [1], [1.0]))
    op("Sub", [one, f"{prefix}_z"], [f"{prefix}_one_minus_z"])
    op("Mul", [f"{prefix}_one_minus_z", f"{prefix}_candidate"], [f"{prefix}_new0"])
    op("Mul", [f"{prefix}_z", f"{prefix}_h0"], [f"{prefix}_new1"])
    op("Add", [f"{prefix}_new0", f"{prefix}_new1"], [f"{prefix}_new"])
    op("Unsqueeze", [f"{prefix}_new", axes0], [node.output[1]])
    op("Unsqueeze", [node.output[1], axes0], [node.output[0]])
    return made


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if hashlib.sha256(args.source.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise ValueError("source is not the pinned Bettercomms DeepFilterNet graph")
    model = onnx.load(args.source)
    nodes = []
    count = 0
    for node in model.graph.node:
        if node.op_type == "GRU":
            nodes.extend(expand_gru(node, count, model.graph)); count += 1
        else:
            nodes.append(node)
    if count != 5:
        raise ValueError(f"expected 5 GRUs, found {count}")
    del model.graph.node[:]
    model.graph.node.extend(nodes)
    # ORT WebGPU 1.29 does not normalize negative axes in every kernel.
    # Canonicalize them from inferred static ranks without changing semantics.
    inferred = onnx.shape_inference.infer_shapes(model)
    inferred_values = list(inferred.graph.input) + list(inferred.graph.value_info) + list(inferred.graph.output)
    shapes = {value.name: len(value.type.tensor_type.shape.dim) for value in inferred_values}
    dimensions = {value.name: [dimension.dim_value for dimension in value.type.tensor_type.shape.dim] for value in inferred_values}
    initializers = {item.name: item for item in model.graph.initializer}
    for node in model.graph.node:
      rank = shapes.get(node.input[0]) if node.input else None
      if rank is None:
        continue
      for attribute in node.attribute:
        if attribute.name == "axis" and attribute.i < 0:
          attribute.i += rank
        elif attribute.name == "axes" and attribute.ints:
          values = [axis + rank if axis < 0 else axis for axis in attribute.ints]
          del attribute.ints[:]
          attribute.ints.extend(values)
      if node.op_type in {"ReduceSum", "Squeeze", "Unsqueeze"} and len(node.input) > 1:
        axes_tensor = initializers.get(node.input[1])
        if axes_tensor is not None:
          axes = numpy_helper.to_array(axes_tensor)
          if (axes < 0).any():
            axis_rank = rank + (len(axes) if node.op_type == "Unsqueeze" else 0)
            normalized = np.asarray([axis + axis_rank if axis < 0 else axis for axis in axes], dtype=np.int64)
            name = f"{node.name}_webgpu_axes"
            model.graph.initializer.append(numpy_helper.from_array(normalized, name))
            node.input[1] = name
      if node.op_type == "Reshape" and len(node.input) > 1:
        shape_tensor = initializers.get(node.input[1])
        output_shape = dimensions.get(node.output[0])
        if shape_tensor is not None and output_shape and all(output_shape):
          requested = numpy_helper.to_array(shape_tensor)
          if (requested < 0).any():
            name = f"{node.name}_webgpu_shape"
            model.graph.initializer.append(numpy_helper.from_array(np.asarray(output_shape, dtype=np.int64), name))
            node.input[1] = name
    onnx.checker.check_model(model, full_check=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, args.output)
    if hashlib.sha256(args.output.read_bytes()).hexdigest() != OUTPUT_SHA256:
        raise ValueError("generated WebGPU research graph is not deterministic")
    print(f"expanded {count} GRUs -> {args.output} ({args.output.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
