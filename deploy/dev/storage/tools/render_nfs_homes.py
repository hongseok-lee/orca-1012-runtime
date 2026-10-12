#!/usr/bin/env python3
"""Read the new NFS Service ClusterIP and render the RWX pair; never apply."""
import argparse
import ipaddress
import json
from pathlib import Path
import subprocess

from storage_deployment_io import kubectl_args, private_output, resource_name
from render_storage import substitute


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kubeconfig", required=True)
    parser.add_argument("--context", required=True)
    parser.add_argument("--namespace", required=True, type=resource_name)
    parser.add_argument("--dataset", required=True, type=resource_name)
    parser.add_argument("--home-pv-name", required=True, type=resource_name)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    base = kubectl_args(args.kubeconfig, args.context, args.namespace)
    response = subprocess.run(base + ["get", "service", "nfs", "-o", "json"],
                              capture_output=True, text=True)
    if response.returncode:
        raise SystemExit("Could not read the designated NFS Service; no file applied.")
    service = json.loads(response.stdout)
    if (service.get("kind") != "Service" or service["metadata"]["namespace"] != args.namespace
            or service["metadata"].get("labels", {}).get("orca.dev/dataset") != args.dataset
            or service["spec"].get("type") != "ClusterIP"):
        raise SystemExit("NFS Service identity/dataset/type does not match the explicit target.")
    address = str(ipaddress.IPv4Address(service["spec"]["clusterIP"]))
    values = {"NAMESPACE": args.namespace, "DATASET": args.dataset,
              "HOME_PV_NAME": args.home_pv_name, "NFS_SERVICE_IP": address}
    source = Path(__file__).resolve().parents[1] / "templates/30-agent-dev-homes.yaml.in"
    target = private_output(args.output, substitute(source.read_text(encoding="utf-8"), values))
    print("Rendered " + target.name + "; no Kubernetes resource was created.")


if __name__ == "__main__":
    main()
