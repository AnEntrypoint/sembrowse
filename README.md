# Sembrowse

Sembrowse runs Jev Ultrafast browser decisions through a local SemIf-OpenJev scorer. It never needs a hosted choice-model API key. Model files stay on the machine you choose.

## Install

Install [uv](https://docs.astral.sh/uv/) and Python 3.12 or 3.13 on Windows, macOS, or Linux. Python 3.14 is not supported by SemIf's pinned numerical stack. Install the package directly from a release source archive or a clone:

```text
uv sync
```

Choose a local model directory or a Hugging Face model identifier with an exact 40-character commit revision. Start the local loopback service:

```text
uv run sembrowse-server --model /absolute/path/to/model --revision local-manifest-v1 --device auto
```

For a remote Hugging Face model, replace `--model` with its identifier and `--revision` with the model commit SHA. SemIf requires a CUDA GPU by default; Apple Silicon users can select the upstream MLX backend separately. CPU operation depends on SemIf's optional llama.cpp backend and is not the default path.

In a second terminal, start the Jev demo through the local decision adapter:

```text
uv run sembrowse-jev
```

The included browser extension only reaches `http://127.0.0.1:8787`. Download the Chromium or Firefox zip from a GitHub release, extract it, and load the extracted directory as an unpacked extension. Open its popup to check the local service.

## Releases

Every push creates or updates a prerelease named `snapshot-<commit-sha>` with Chromium and Firefox MV3 archives plus `SHA256SUMS`. Release artifacts contain the extension and source only; model weights are fetched or selected locally at runtime.

## Design

Jev's operation and target questions become SemIf choice rows. SemIf scores two to sixteen options at once. Larger target sets use a deterministic tournament: each group is scored, every group winner advances, and the final winner is one original target. Returned probability values are normalized from the complete tournament trace, so no candidate disappears silently.

`sembrowse-server` exposes `GET /health` and `POST /v1/choose` on loopback. The latter accepts Jev-shaped `state` and `questions` data and returns answer objects containing `choice`, normalized `probabilities`, and `confidence`.
