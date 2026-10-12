#!/usr/bin/env python3
"""Render fixed foundation shapes to private files; performs no cloud mutation."""
import argparse
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


def substitute(text, values):
    tokens = set(re.findall(r"\$\{([A-Z_]+)\}", text))
    missing = tokens - values.keys()
    if missing:
        raise ValueError("Missing template inputs: " + ", ".join(sorted(missing)))
    return re.sub(r"\$\{([A-Z_]+)\}", lambda match: values[match[1]], text)


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
    args = parser.parse_args()
    values = {
        "NAMESPACE": args.namespace, "DATASET": args.dataset,
        "PG_STORAGE_CLASS": args.pg_storage_class,
        "NFS_STORAGE_CLASS": args.nfs_storage_class,
        "HOME_PV_NAME": args.home_pv_name, "UNFS_IMAGE": args.unfs_image,
    }
    if args.nfs_service_ip:
        values["NFS_SERVICE_IP"] = str(args.nfs_service_ip)
    templates = Path(__file__).resolve().parents[1] / "templates"
    selected = sorted(templates.glob("*.yaml.in"))
    for source in selected:
        if source.name.startswith("30-") and not args.nfs_service_ip:
            continue
        rendered = substitute(source.read_text(encoding="utf-8"), values)
        target = private_output(args.output_dir / source.name.removesuffix(".in"), rendered)
        print(target.name)


if __name__ == "__main__":
    main()
