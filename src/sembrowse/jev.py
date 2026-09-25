from __future__ import annotations

import argparse
import os

import httpx


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", default="http://127.0.0.1:8787/v1/choose")
    arguments, remaining = parser.parse_known_args()
    import jev_ultrafast.agent as agent
    import jev_ultrafast.model as model

    def choose(state, goal, history):
        elements, targets, controls = model.action_space(state["actions"])
        operations = {key: key for key in targets}
        operations.update({key: value["label"] for key, value in controls.items()})
        operations.update(DONE="Every requirement is visibly satisfied.", BLOCKED="No supported operation can progress.")
        questions = {"operation": {"criteria": operations, "instructions": {"goal": goal}}}
        for operation, candidates in targets.items():
            questions[f"{operation.lower()}_target"] = {
                "criteria": {key: {"element": value["label"]} for key, value in candidates.items()},
                "instructions": {"goal": goal, "operation": operation},
            }
        response = httpx.post(arguments.endpoint, json={"state": {"page": state, "history": history}, "questions": questions}, timeout=120).json()
        operation_answer = response["answers"]["operation"]
        operation = operation_answer["choice"]
        target_answer = response["answers"].get(f"{operation.lower()}_target", {})
        target = target_answer.get("choice")
        choice = targets[operation][target]["id"] if operation in targets else controls[operation]["id"] if operation in controls else operation
        probabilities = {targets[operation][key]["id"]: value for key, value in target_answer.get("probabilities", {}).items()} if operation in targets else {choice: operation_answer["probabilities"][operation]}
        return {"choice": choice, "operation": operation, "target": target, "confidence": operation_answer["confidence"], "probabilities": probabilities, "operation_probabilities": operation_answer["probabilities"], "target_probabilities": target_answer.get("probabilities", {}), "target_confidence": target_answer.get("confidence"), "raw_answers": response["answers"], "model": response["model"], "usage": {}, "latency_ms": 0, "request": questions}

    model.choose = choose
    agent.choose = choose
    os.environ["TYPESAFE_API_KEY"] = "local"
    from jev_ultrafast.demo import main as demo

    os.sys.argv = [os.sys.argv[0], *remaining]
    demo()
