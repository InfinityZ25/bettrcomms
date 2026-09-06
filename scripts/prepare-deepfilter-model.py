#!/usr/bin/env python3
"""Fetch, verify, and prepare the pinned DeepFilterNet3 graph for DirectML.

Requires Python packages: onnx, numpy, onnxruntime. The generated files are
deterministic with the pinned package/tool versions recorded in
docs/AMD_MODEL_FINDINGS.md.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
import urllib.request
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnx import helper

BASE_URL = "https://github.com/wuxuedaifu/deepfilter-stream/releases/download/model-dfn3-512-v1"
SOURCE_MODEL_SHA256 = "b758c49d6708a5b7979e3de185705a8a4915076c862fb17b1b304d9a72b75cdc"
SOURCE_STATES_SHA256 = "1165503707b8859a6b650b6bb0dc5b6c55d30c2779d87502f97a77102b5d3872"
OUTPUT_MODEL_SHA256 = "41ab21252f5357d3ff29999ba37d7b529bcbbb60d3b7e2b8d720726185bb4740"
OUTPUT_STATES_SHA256 = "f430f056519c5b6ec2d949676cd2be29b62554f249f74683d681fefe6916c88c"
REFERENCE_OUTPUT_SHA256 = "76e525b399391b922bf4cc4e347af7d7d7c1fb497119a309c6e785a3d689cfab"
FUSED_CONV_COUNT = 15
FRAME_SIZE = 512
STATE_NAMES = (
    "erb_norm_state", "band_unit_norm_state", "analysis_mem", "synthesis_mem",
    "rolling_erb_buf", "rolling_feat_spec_buf", "rolling_c0_buf",
    "rolling_spec_buf_x", "rolling_spec_buf_y", "enc_hidden",
    "erb_dec_hidden", "df_dec_hidden",
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_hash(path: Path, expected: str) -> None:
    actual = sha256(path)
    if actual != expected:
        raise RuntimeError(f"SHA-256 mismatch for {path}: expected {expected}, got {actual}")


def download(name: str, destination: Path, expected: str) -> None:
    urllib.request.urlretrieve(f"{BASE_URL}/{name}", destination)
    require_hash(destination, expected)


def decompose_fused_convs(source: Path, destination: Path) -> None:
    model = onnx.load(source)
    nodes = []
    replaced = 0
    for node in model.graph.node:
        if node.op_type != "FusedConv":
            nodes.append(node)
            continue
        if node.domain != "com.microsoft":
            raise RuntimeError(f"unexpected FusedConv domain on {node.name!r}: {node.domain!r}")
        attrs = {attr.name: helper.get_attribute_value(attr) for attr in node.attribute}
        activation_bytes = attrs.pop("activation", None)
        if not isinstance(activation_bytes, bytes):
            raise RuntimeError(f"missing activation on FusedConv {node.name!r}")
        activation = activation_bytes.decode("ascii")
        if activation not in {"Relu", "Sigmoid"}:
            raise RuntimeError(f"unsupported FusedConv activation {activation!r}")
        if len(node.output) != 1:
            raise RuntimeError(f"unexpected output count on FusedConv {node.name!r}")
        final_output = node.output[0]
        conv_output = final_output + "__conv"
        nodes.append(helper.make_node(
            "Conv", list(node.input), [conv_output], name=node.name + "__standard", **attrs
        ))
        nodes.append(helper.make_node(
            activation, [conv_output], [final_output], name=node.name + "__" + activation
        ))
        replaced += 1
    if replaced != FUSED_CONV_COUNT:
        raise RuntimeError(f"expected {FUSED_CONV_COUNT} FusedConv nodes, found {replaced}")
    del model.graph.node[:]
    model.graph.node.extend(nodes)
    onnx.checker.check_model(model, full_check=True)
    onnx.save(model, destination)
    require_hash(destination, OUTPUT_MODEL_SHA256)


def write_states(source: Path, destination: Path) -> None:
    with np.load(source) as arrays:
        if tuple(arrays.files) != STATE_NAMES:
            raise RuntimeError(f"unexpected state order/names: {arrays.files}")
        document = {}
        for name in arrays.files:
            value = np.asarray(arrays[name], dtype=np.float32)
            document[name] = {
                "shape": list(value.shape),
                "values": value.reshape(-1).tolist(),
            }
    destination.write_text(json.dumps(document, separators=(",", ":")), encoding="utf-8")
    require_hash(destination, OUTPUT_STATES_SHA256)


def session(path: Path) -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.enable_mem_pattern = False
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.intra_op_num_threads = 1
    return ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])


def initial_states(model_session: ort.InferenceSession, states_path: Path) -> dict[str, np.ndarray]:
    with np.load(states_path) as arrays:
        return {
            item.name: np.array(arrays[item.name], dtype=np.float32, copy=True)
            for item in model_session.get_inputs()[1:]
        }


def reference_output(model_path: Path, states_path: Path) -> bytes:
    model_session = session(model_path)
    states = initial_states(model_session, states_path)
    output_names = [item.name for item in model_session.get_outputs()]
    state_names = [item.name for item in model_session.get_inputs()[1:]]
    rng = np.random.default_rng(20260905)
    samples = np.arange(FRAME_SIZE, dtype=np.float32)
    frame = (
        0.08 * np.sin(2 * np.pi * 220 * samples / 48000)
        + 0.04 * np.sin(2 * np.pi * 440 * samples / 48000)
        + 0.06 * rng.standard_normal(FRAME_SIZE)
    ).astype(np.float32)
    for _ in range(20):
        values = model_session.run(output_names, {"input_frame": frame, **states})
        states = dict(zip(state_names, values[1:]))
    output = []
    for _ in range(1000):
        values = model_session.run(output_names, {"input_frame": frame, **states})
        output.append(values[0])
        states = dict(zip(state_names, values[1:]))
    return np.concatenate(output).astype(np.float32, copy=False).tobytes()


def verify_output(source: Path, prepared: Path, states: Path) -> None:
    source_output = reference_output(source, states)
    prepared_output = reference_output(prepared, states)
    if source_output != prepared_output:
        raise RuntimeError("prepared graph is not bit-identical to the pinned source on CPU")
    digest = hashlib.sha256(prepared_output).hexdigest()
    if digest != REFERENCE_OUTPUT_SHA256:
        raise RuntimeError(
            f"deterministic inference mismatch: expected {REFERENCE_OUTPUT_SHA256}, got {digest}"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="deepfilter-prepare-") as temporary:
        work = Path(temporary)
        source_model = work / "denoiser_model.onnx"
        source_states = work / "initial_states.npz"
        download("denoiser_model.onnx", source_model, SOURCE_MODEL_SHA256)
        download("initial_states.npz", source_states, SOURCE_STATES_SHA256)
        output_model = args.output_dir / "denoiser_model_dml.onnx"
        output_states = args.output_dir / "initial_states.json"
        decompose_fused_convs(source_model, output_model)
        write_states(source_states, output_states)
        verify_output(source_model, output_model, source_states)
    print(json.dumps({
        "model": str(output_model), "model_sha256": sha256(output_model),
        "states": str(output_states), "states_sha256": sha256(output_states),
        "reference_output_sha256": REFERENCE_OUTPUT_SHA256,
    }, indent=2))


if __name__ == "__main__":
    main()
