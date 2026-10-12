#!/usr/bin/env python3
"""Create a runtime-only bootstrap Secret without printing or saving its value."""
import argparse
import json
import secrets
import subprocess

from storage_deployment_io import kubectl_args, resource_name


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kubeconfig", required=True)
    parser.add_argument("--context", required=True)
    parser.add_argument("--namespace", required=True, type=resource_name)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if not args.execute:
        parser.error("Execution must be explicitly assigned; pass --execute only for that action.")
    base = kubectl_args(args.kubeconfig, args.context, args.namespace)
    existing = subprocess.run(
        base + ["get", "secret", "postgres-runtime", "--ignore-not-found", "-o", "name"],
        capture_output=True, text=True,
    )
    if existing.returncode:
        raise SystemExit("Cannot verify Secret absence; no credential generated or logged.")
    if existing.stdout.strip():
        raise SystemExit("postgres-runtime already exists; leave it unchanged.")
    payload = {
        "apiVersion": "v1", "kind": "Secret", "type": "Opaque",
        "metadata": {"namespace": args.namespace, "name": "postgres-runtime"},
        "stringData": {"superuser-password": secrets.token_urlsafe(32)},
    }
    created = subprocess.run(
        base + ["create", "-f", "-"], input=json.dumps(payload),
        capture_output=True, text=True,
    )
    if created.returncode:
        raise SystemExit("Runtime Secret creation failed; credential details were not logged.")
    print("Runtime Secret created; value excluded from source, output and evidence.")


if __name__ == "__main__":
    main()
