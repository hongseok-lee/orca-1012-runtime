"""Explicit Kubernetes context and safe names for storage deployment commands."""
import os
from pathlib import Path
import re


def resource_name(value):
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", value):
        raise ValueError("Expected a DNS-1123 resource name (maximum 63 characters).")
    return value


def kubectl_args(kubeconfig, context, namespace):
    config = Path(kubeconfig).expanduser().resolve(strict=True)
    if not config.is_file() or not context.strip():
        raise ValueError("Supply the dedicated kubeconfig and exact target context.")
    return ["kubectl", "--kubeconfig", str(config), "--context", context,
            "--namespace", resource_name(namespace)]


def private_output(path, content):
    target = Path(path).expanduser().resolve()
    checkout = Path(__file__).resolve().parents[4]
    if target == checkout or checkout in target.parents:
        raise ValueError("Keep rendered operational values outside the checkout.")
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with target.open("x", encoding="utf-8") as output:
        os.chmod(target, 0o600)
        output.write(content)
    return target
