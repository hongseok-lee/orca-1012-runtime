#!/usr/bin/env python3
"""Render fixed foundation shapes to private files; performs no cloud mutation."""
import argparse
import base64
import hashlib
import ipaddress
from pathlib import Path
import re

from storage_deployment_io import private_output, resource_name


def image_reference(value):
    if "://" in value or not re.fullmatch(
        r"[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}", value
    ):
        raise ValueError("UNFS_IMAGE must be an operator-selected repository@sha256 digest.")
    return value


def node_ipv4_cidr(value):
    network = ipaddress.IPv4Network(value, strict=True)
    if network.prefixlen == 0 or str(network) != value:
        raise ValueError("NFS node subnet must be a canonical IPv4 CIDR other than /0.")
    return str(network)


def substitute(text, values):
    tokens = set(re.findall(r"\$\{([A-Z_][A-Z0-9_]*)\}", text))
    missing = tokens - values.keys()
    if missing:
        raise ValueError("Missing template inputs: " + ", ".join(sorted(missing)))
    return re.sub(r"\$\{([A-Z_][A-Z0-9_]*)\}", lambda match: values[match[1]], text)


SAFE_TO_EVICT_FALSE = 'cluster-autoscaler.kubernetes.io/safe-to-evict: "false"'
AUTOPILOT_SAFE_TO_EVICT_MIN_CPU_MILLI = 500


def cpu_milli(value):
    return int(value[:-1]) if value.endswith("m") else int(float(value) * 1000)


def check_autoscaler_eviction(name, text):
    """About one Pod runs per Autopilot node, so a scale-down only moves a live
    Pod. A regular (on-demand) Pod of 500m CPU or more must opt out; Autopilot
    rejects the opt-out on Spot Pods and below 500m."""
    for doc in re.split(r"(?m)^---$", text):
        if not re.search(r"(?m)^kind: (Deployment|StatefulSet|Pod)$", doc):
            continue
        spot = "cloud.google.com/gke-spot" in doc
        pinned = SAFE_TO_EVICT_FALSE in doc
        cpu = max((cpu_milli(v) for v in re.findall(r"(?m)^ +cpu: ([0-9.]+m?)\b", doc)), default=0)
        eligible = not spot and cpu >= AUTOPILOT_SAFE_TO_EVICT_MIN_CPU_MILLI
        if pinned != eligible:
            raise ValueError(f"{name}: safe-to-evict=false is required exactly for non-Spot Pods of >=500m CPU.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--namespace", required=True, type=resource_name)
    parser.add_argument("--dataset", required=True, type=resource_name)
    parser.add_argument("--pg-storage-class", required=True, type=resource_name)
    parser.add_argument("--nfs-storage-class", required=True, type=resource_name)
    parser.add_argument("--home-pv-name", required=True, type=resource_name)
    parser.add_argument("--unfs-image", required=True, type=image_reference)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--nfs-service-ip", type=ipaddress.IPv4Address)
    parser.add_argument("--nfs-node-cidr", type=node_ipv4_cidr)
    args = parser.parse_args()
    values = {
        "NAMESPACE": args.namespace, "DATASET": args.dataset,
        "PG_STORAGE_CLASS": args.pg_storage_class,
        "NFS_STORAGE_CLASS": args.nfs_storage_class,
        "HOME_PV_NAME": args.home_pv_name, "UNFS_IMAGE": args.unfs_image,
    }
    if args.nfs_service_ip:
        values["NFS_SERVICE_IP"] = str(args.nfs_service_ip)
    if args.nfs_node_cidr:
        values["NFS_NODE_CIDR"] = args.nfs_node_cidr
    templates = Path(__file__).resolve().parents[1] / "templates"
    nfs_template = templates / "20-nfs.yaml.in"
    nfs_text = nfs_template.read_text(encoding="utf-8")
    export_block = re.search(r"(?m)^  exports: \|\n((?:    [^\n]*\n)+)", nfs_text)
    if export_block is None:
        raise ValueError("NFS exports literal block is missing.")
    exports = "".join(line[4:] for line in export_block[1].splitlines(keepends=True))
    exports = substitute(exports, values)
    helper = Path(__file__).with_name("managed_storage.sh").read_bytes()
    helper_hash = hashlib.sha256(helper).hexdigest()
    values.update({
        "NFS_EXPORTS_SHA256": hashlib.sha256(exports.encode("utf-8")).hexdigest(),
        "MANAGED_STORAGE_SHA256": helper_hash,
        "MANAGED_STORAGE_CONFIGMAP": "nfs-managed-storage-" + helper_hash[:16],
        "MANAGED_STORAGE_BASE64": base64.b64encode(helper).decode("ascii"),
    })
    selected = sorted(templates.glob("*.yaml.in"))
    for source in selected:
        if source.name == "25-nfs-kernel-clients.yaml.in" and not args.nfs_node_cidr:
            continue
        if source.name.startswith("30-") and not args.nfs_service_ip:
            continue
        text = nfs_text if source == nfs_template else source.read_text(encoding="utf-8")
        rendered = substitute(text, values)
        check_autoscaler_eviction(source.name, rendered)
        target = private_output(args.output_dir / source.name.removesuffix(".in"), rendered)
        print(target.name)


if __name__ == "__main__":
    main()
