from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from semif_phase1.core import load_causal_model
from semif_phase1.direct import score


def normalize(values: dict[str, float]) -> dict[str, float]:
    total = sum(values.values())
    if not math.isfinite(total) or total <= 0:
        raise ValueError("Decision probabilities are not normalizable")
    return {key: value / total for key, value in values.items()}


@dataclass
class SemIfEngine:
    source: str
    revision: str
    device: str = "auto"
    dtype: str = "bfloat16"
    max_tokens: int = 4096

    def __post_init__(self) -> None:
        self.model, self.tokenizer, self.metadata = load_causal_model(
            self.source, self.revision, self.device, self.dtype
        )

    def decide(self, state: Any, question: str, options: list[dict[str, str]], identifier: str) -> dict[str, Any]:
        if not 2 <= len(options) <= 16:
            raise ValueError("SemIf decisions need between 2 and 16 options")
        result = score(
            self.model,
            self.tokenizer,
            {"id": identifier, "state": state, "question": question, "options": options},
            self.metadata,
            self.max_tokens,
        )
        probabilities = dict(zip(result["option_ids"], result["probabilities"], strict=True))
        choice = max(probabilities, key=probabilities.__getitem__)
        return {"choice": choice, "probabilities": probabilities, "trace": result}

    def choose(self, state: Any, question: str, options: list[dict[str, str]], identifier: str) -> dict[str, Any]:
        if len(options) < 2:
            raise ValueError("A choice needs at least two options")
        if len({option["id"] for option in options}) != len(options):
            raise ValueError("Choice option IDs must be unique")
        frontier = [{"id": option["id"], "description": option["description"], "weight": 1.0} for option in options]
        trace: list[dict[str, Any]] = []
        round_number = 0
        while len(frontier) > 1:
            next_frontier: list[dict[str, Any]] = []
            for offset in range(0, len(frontier), 16):
                group = frontier[offset : offset + 16]
                if len(group) == 1:
                    next_frontier.extend(group)
                    continue
                decision = self.decide(state, question, group, f"{identifier}-r{round_number}-g{offset // 16}")
                for candidate in group:
                    candidate["weight"] *= decision["probabilities"][candidate["id"]]
                winner = next(candidate for candidate in group if candidate["id"] == decision["choice"])
                next_frontier.append(winner)
                trace.append(decision["trace"])
            frontier = next_frontier
            round_number += 1
        probabilities = normalize({candidate["id"]: candidate["weight"] for candidate in options_to_candidates(options, trace)})
        winner = frontier[0]["id"]
        return {
            "choice": winner,
            "probabilities": probabilities,
            "confidence": probabilities[winner],
            "model": self.metadata,
            "rounds": trace,
        }


def options_to_candidates(options: list[dict[str, str]], trace: list[dict[str, Any]]) -> list[dict[str, Any]]:
    weights = {option["id"]: 1.0 for option in options}
    for result in trace:
        for option_id, probability in zip(result["option_ids"], result["probabilities"], strict=True):
            weights[option_id] *= probability
    return [{"id": option_id, "weight": weight} for option_id, weight in weights.items()]
