"""Export VietOCR (vgg_seq2seq) PyTorch weights to quantized pure-ONNX models."""

import json
import os
from pathlib import Path
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
import onnxruntime as ort
from onnxruntime.quantization import QuantType, quantize_dynamic
from PIL import Image
import torch
import torch.nn as nn
import yaml

# Pillow >= 10 compatibility for older VietOCR modules
if not hasattr(Image, "ANTIALIAS"):
    Image.ANTIALIAS = Image.Resampling.LANCZOS  # type: ignore[attr-defined]

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from vietocr.tool.translate import build_model  # noqa: E402


class EncoderWrapper(nn.Module):
    """Wraps VietOCR VGG backbone + Seq2Seq BiGRU encoder with explicit axes and h0."""

    def __init__(self, cnn: nn.Module, seq_encoder: nn.Module) -> None:
        super().__init__()
        self.features = cnn.model.features
        self.last_conv_1x1 = cnn.model.last_conv_1x1
        self.rnn = seq_encoder.rnn
        self.fc = seq_encoder.fc
        self.enc_hid = int(seq_encoder.rnn.hidden_size)

    def forward(self, img: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        conv = self.features(img)
        conv = self.last_conv_1x1(conv)
        conv = conv.transpose(2, 3).flatten(2)
        src = conv.permute(2, 0, 1)  # explicit non-negative perm for ONNX: (T, B, 256)

        h0 = torch.zeros(2, img.shape[0], self.enc_hid, dtype=src.dtype, device=src.device)
        encoder_outputs, hidden = self.rnn(src, h0)
        hidden_fc = torch.tanh(self.fc(torch.cat((hidden[-2, :, :], hidden[-1, :, :]), dim=1)))
        return encoder_outputs, hidden_fc


class DecoderStepWrapper(nn.Module):
    """Wraps a single autoregressive Seq2Seq decoder step cleanly for ONNX export."""

    def __init__(self, decoder: nn.Module) -> None:
        super().__init__()
        self.embedding = decoder.embedding
        self.attention = decoder.attention
        self.rnn = decoder.rnn
        self.fc_out = decoder.fc_out

    def forward(
        self,
        tgt: torch.Tensor,
        hidden: torch.Tensor,
        encoder_outputs: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        inp = tgt.unsqueeze(0)  # (1, B)
        embedded = self.embedding(inp)  # (1, B, emb_dim)

        src_len = encoder_outputs.shape[0]
        bsz = hidden.shape[0]
        dec_hid = hidden.shape[1]
        hid_exp = hidden.unsqueeze(1).expand(bsz, src_len, dec_hid)  # (B, T, dec_hid)
        enc_perm = encoder_outputs.permute(1, 0, 2)  # (B, T, enc_hid*2)
        energy = torch.tanh(self.attention.attn(torch.cat((hid_exp, enc_perm), dim=2)))
        attn_weights = torch.softmax(self.attention.v(energy).squeeze(2), dim=1)  # (B, T)

        weighted = torch.bmm(attn_weights.unsqueeze(1), enc_perm).permute(1, 0, 2)  # (1, B, enc_hid*2)
        rnn_input = torch.cat((embedded, weighted), dim=2)
        output, next_hidden = self.rnn(rnn_input, hidden.unsqueeze(0))

        logits = self.fc_out(
            torch.cat((output.squeeze(0), weighted.squeeze(0), embedded.squeeze(0)), dim=1)
        )
        return logits, next_hidden.squeeze(0)


def _convert_weights_to_fp16_cast(src_onnx: Path, dst_onnx: Path) -> None:
    """Compress large float32 initializers (>=4K elements) to float16 + Cast nodes, keeping FP32 I/O."""
    model = onnx.load(str(src_onnx))
    graph = model.graph

    large_fp32_inits: dict[str, onnx.TensorProto] = {}
    for init in graph.initializer:
        if init.data_type == TensorProto.FLOAT:
            arr = numpy_helper.to_array(init)
            if arr.size >= 4096:
                large_fp32_inits[init.name] = init

    for idx, name in enumerate(list(large_fp32_inits.keys())):
        orig_init = large_fp32_inits[name]
        arr_f16 = numpy_helper.to_array(orig_init).astype(np.float16)
        f16_name = f"{name}__fp16_w"
        f16_init = numpy_helper.from_array(arr_f16, name=f16_name)
        graph.initializer.remove(orig_init)
        graph.initializer.append(f16_init)

        cast_node = helper.make_node(
            "Cast",
            inputs=[f16_name],
            outputs=[name],
            to=TensorProto.FLOAT,
            name=f"fp16_cast_{idx}",
        )
        graph.node.insert(0, cast_node)

    onnx.checker.check_model(model)
    onnx.save(model, str(dst_onnx))


def _verify_fp32_parity(
    enc_pt: EncoderWrapper,
    dec_pt: DecoderStepWrapper,
    enc_fp32_path: Path,
    dec_fp32_path: Path,
) -> None:
    enc_sess = ort.InferenceSession(str(enc_fp32_path), providers=["CPUExecutionProvider"])
    dec_sess = ort.InferenceSession(str(dec_fp32_path), providers=["CPUExecutionProvider"])

    rng = np.random.default_rng(42)
    max_enc_diff = 0.0
    max_dec_diff = 0.0

    for batch_size, width in [(1, 60), (1, 160), (4, 320)]:
        x_np = rng.random((batch_size, 3, 32, width), dtype=np.float32)
        x_pt = torch.from_numpy(x_np)
        with torch.inference_mode():
            pt_out, pt_hid = enc_pt(x_pt)

        ort_out, ort_hid = enc_sess.run(None, {"img": x_np})
        diff_out = float(np.max(np.abs(pt_out.numpy() - ort_out)))
        diff_hid = float(np.max(np.abs(pt_hid.numpy() - ort_hid)))
        max_enc_diff = max(max_enc_diff, diff_out, diff_hid)

        tgt_np = np.ones((batch_size,), dtype=np.int64)
        cur_hid_pt = pt_hid
        cur_hid_ort = ort_hid
        for step in range(4):
            tgt_pt = torch.from_numpy(tgt_np)
            with torch.inference_mode():
                logits_pt, next_hid_pt = dec_pt(tgt_pt, cur_hid_pt, pt_out)
            logits_ort, next_hid_ort = dec_sess.run(
                None,
                {
                    "tgt": tgt_np,
                    "hidden": cur_hid_ort,
                    "encoder_outputs": ort_out,
                },
            )
            diff_l = float(np.max(np.abs(logits_pt.numpy() - logits_ort)))
            diff_h = float(np.max(np.abs(next_hid_pt.numpy() - next_hid_ort)))
            max_dec_diff = max(max_dec_diff, diff_l, diff_h)

            cur_hid_pt = next_hid_pt
            cur_hid_ort = next_hid_ort
            tgt_np = np.argmax(logits_ort, axis=-1).astype(np.int64)

    print(
        f"FP32 parity verified: max_enc_diff={max_enc_diff:.2e}, max_dec_diff={max_dec_diff:.2e}",
        flush=True,
    )
    assert max_enc_diff < 1e-4, f"Encoder parity diff too high: {max_enc_diff}"
    assert max_dec_diff < 1e-4, f"Decoder parity diff too high: {max_dec_diff}"


def main() -> None:
    models_src_dir = BACKEND_DIR / "storage" / "ocr_models"
    cfg_path = models_src_dir / "vgg_seq2seq_config.yaml"
    weights_path = models_src_dir / "vgg_seq2seq.pth"

    assert cfg_path.is_file(), f"Missing {cfg_path}"
    assert weights_path.is_file(), f"Missing {weights_path}"

    cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
    cfg["device"] = "cpu"
    cfg.setdefault("cnn", {})["pretrained"] = False

    model, _vocab = build_model(cfg)
    state = torch.load(weights_path, map_location="cpu", weights_only=False)
    model.load_state_dict(state)
    model.eval()

    enc_pt = EncoderWrapper(model.cnn, model.transformer.encoder).eval()
    dec_pt = DecoderStepWrapper(model.transformer.decoder).eval()

    enc_fp32 = models_src_dir / "vietocr_encoder_fp32.onnx"
    dec_fp32 = models_src_dir / "vietocr_decoder_fp32.onnx"

    dummy_img = torch.randn(2, 3, 32, 160, dtype=torch.float32)
    with torch.inference_mode():
        torch.onnx.export(
            enc_pt,
            (dummy_img,),
            str(enc_fp32),
            dynamo=False,
            opset_version=17,
            do_constant_folding=True,
            input_names=["img"],
            output_names=["encoder_outputs", "hidden"],
            dynamic_axes={
                "img": {0: "batch_size", 3: "width"},
                "encoder_outputs": {0: "src_len", 1: "batch_size"},
                "hidden": {0: "batch_size"},
            },
        )
        sample_enc_out, sample_hid = enc_pt(dummy_img)
        dummy_tgt = torch.ones((2,), dtype=torch.int64)
        torch.onnx.export(
            dec_pt,
            (dummy_tgt, sample_hid, sample_enc_out),
            str(dec_fp32),
            dynamo=False,
            opset_version=17,
            do_constant_folding=True,
            input_names=["tgt", "hidden", "encoder_outputs"],
            output_names=["logits", "next_hidden"],
            dynamic_axes={
                "tgt": {0: "batch_size"},
                "hidden": {0: "batch_size"},
                "encoder_outputs": {0: "src_len", 1: "batch_size"},
                "logits": {0: "batch_size"},
                "next_hidden": {0: "batch_size"},
            },
        )

    _verify_fp32_parity(enc_pt, dec_pt, enc_fp32, dec_fp32)

    out_dir = BACKEND_DIR / "models" / "vietocr_onnx"
    out_dir.mkdir(parents=True, exist_ok=True)
    enc_out_path = out_dir / "vietocr_encoder.onnx"
    dec_out_path = out_dir / "vietocr_decoder.onnx"
    cfg_out_path = out_dir / "vietocr_config.json"

    # Quantize decoder dynamically (Linear/MatMul/GRU friendly)
    quantize_dynamic(
        model_input=str(dec_fp32),
        model_output=str(dec_out_path),
        weight_type=QuantType.QUInt8,
    )
    ort.InferenceSession(str(dec_out_path), providers=["CPUExecutionProvider"])

    # Quantize encoder: try full QUInt8 first; if ORT load or ConvInteger fails, fall back cleanly
    try:
        quantize_dynamic(
            model_input=str(enc_fp32),
            model_output=str(enc_out_path),
            weight_type=QuantType.QUInt8,
        )
        sess_test = ort.InferenceSession(str(enc_out_path), providers=["CPUExecutionProvider"])
        test_x = np.random.default_rng(1).random((1, 3, 32, 120), dtype=np.float32)
        sess_test.run(None, {"img": test_x})
        enc_mode = "QUInt8_all"
    except Exception as exc:
        print(f"Full QUInt8 encoder failed ORT check ({type(exc).__name__}), using MatMul/Gemm + FP16 fallback", flush=True)
        tmp_mm = models_src_dir / "vietocr_encoder_mm.onnx"
        quantize_dynamic(
            model_input=str(enc_fp32),
            model_output=str(tmp_mm),
            weight_type=QuantType.QUInt8,
            op_types_to_quantize=["MatMul", "Gemm"],
        )
        _convert_weights_to_fp16_cast(tmp_mm, enc_out_path)
        sess_test = ort.InferenceSession(str(enc_out_path), providers=["CPUExecutionProvider"])
        test_x = np.random.default_rng(1).random((1, 3, 32, 120), dtype=np.float32)
        sess_test.run(None, {"img": test_x})
        enc_mode = "MatMul_QUInt8+FP16_Conv"
        tmp_mm.unlink(missing_ok=True)

    ds = cfg["dataset"]
    config_payload = {
        "vocab": cfg["vocab"],
        "image_height": int(ds["image_height"]),
        "image_min_width": int(ds["image_min_width"]),
        "image_max_width": int(ds["image_max_width"]),
        "sos_token": 1,
        "eos_token": 2,
    }
    cfg_out_path.write_text(json.dumps(config_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    mb = 1024 * 1024
    print(f"FP32 encoder: {enc_fp32.stat().st_size / mb:.2f} MB", flush=True)
    print(f"FP32 decoder: {dec_fp32.stat().st_size / mb:.2f} MB", flush=True)
    print(f"Quantized encoder ({enc_mode}): {enc_out_path.stat().st_size / mb:.2f} MB", flush=True)
    print(f"Quantized decoder (QUInt8): {dec_out_path.stat().st_size / mb:.2f} MB", flush=True)
    print(f"Config saved: {cfg_out_path}", flush=True)


if __name__ == "__main__":
    main()
