#!/usr/bin/env python3
"""Compile this Dell MIB's objects, enums and compound indexes to portable JSON.

This intentionally supports the bundled MIB, not arbitrary ASN.1. Runtime polling
uses numeric OIDs and needs neither Python nor a system MIB installation.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
source = re.sub(r"--[^\n]*", "", (ROOT / "mibs/DELL-STORAGE-SC-MIB.mib").read_text())
pattern = r"(\w+)\s+(OBJECT-TYPE|OBJECT-IDENTITY|MODULE-IDENTITY)(.*?)::=\s*\{\s*(\w+)\s+(\d+)\s*\}"
nodes = {"enterprises": {"oid": ".1.3.6.1.4.1"}}
matches = list(re.finditer(pattern, source, re.S))
pending = matches[:]
while pending:
    before = len(pending)
    for match in pending[:]:
        name, kind, body, parent, number = match.groups()
        if parent not in nodes:
            continue
        nodes[name] = {"oid": nodes[parent]["oid"] + "." + number,
                       "kind": kind, "body": body, "parent": parent}
        pending.remove(match)
    if len(pending) == before:
        raise ValueError("Unresolved OID parents: " + str([m.group(1) for m in pending]))

enums = {"TruthValue": {"1": "true", "2": "false"}}
for match in re.finditer(r"(\w+)\s*::=\s*TEXTUAL-CONVENTION(.*?)SYNTAX\s+INTEGER\s*\{(.*?)\}", source, re.S):
    enums[match.group(1)] = {n: label for label, n in re.findall(r"(\w+)\s*\(\s*(-?\d+)\s*\)", match.group(3))}

table_labels = {
    "scCtlrTable": ("Controllers", "health"), "scDiskTable": ("Disks", "storage"),
    "scEnclTable": ("Enclosures", "health"), "scDiskConfigTable": ("Disk configuration", "storage"),
    "scVolumeTable": ("Volumes", "storage"), "scServerTable": ("Servers", "connectivity"),
    "scDiskFolderTable": ("Disk folders", "storage"), "scDiskFolderSUTable": ("Storage usage", "storage"),
    "scAlertTable": ("Alerts", "alerts"), "scScTable": ("Storage center", "health"),
    "scObjCntTable": ("Object counts", "storage"), "scCacheTable": ("Cache batteries", "health"),
    "scUPSTable": ("UPS", "health"),
}
tables = []
fields = []
for name, node in nodes.items():
    if node.get("kind") != "OBJECT-TYPE":
        continue
    body = node["body"]
    syntax = " ".join(re.search(r"SYNTAX\s+(.*?)\s+MAX-ACCESS", body, re.S).group(1).split())
    access = re.search(r"MAX-ACCESS\s+(\S+)", body).group(1)
    status = re.search(r"STATUS\s+(\S+)", body).group(1)
    desc = " ".join(re.search(r'DESCRIPTION\s+"(.*?)"', body, re.S).group(1).split())
    if syntax.startswith("SEQUENCE OF"):
        label, group = table_labels.get(name, (desc.replace(" Table", "s"), "health"))
        entry = next(v for v in nodes.values() if v.get("parent") == name)
        indexes = re.search(r"INDEX\s*\{(.*?)\}", entry["body"], re.S)
        tables.append({"name": name, "label": label, "group": group, "oid": node["oid"],
                       "indexes": re.findall(r"\w+", indexes.group(1))})
    if access == "not-accessible":
        continue
    parent = nodes[node["parent"]]
    table = parent["parent"] if node["parent"].endswith("Entry") else ""
    enum = {n: label for label, n in re.findall(r"(\w+)\s*\(\s*(-?\d+)\s*\)", syntax)} if "{" in syntax else enums.get(syntax.split()[0], {})
    unit = ""
    if name.startswith("scDiskFolderSU") and "Space" in name:
        unit = "GB" if name in ("scDiskFolderSUTotalSpace", "scDiskFolderSUUsedSpace") else "GiB"
    elif name == "scDiskSize":
        unit = "GB"
    elif name.endswith("Rpm"):
        unit = "RPM"
    elif re.search(r"(Current|Max|Min|Lwr|Upr)C$", name):
        unit = "°C"
    elif re.search(r"(Current|Max|Min|Lwr|Upr)V$", name):
        unit = "V"
    elif name == "scDiskFolderCapcty2":
        unit = "GiB"
    elif name == "scDiskFolderCapcty":
        unit = "GB"
    fields.append({"name": name, "oid": node["oid"], "syntax": syntax.split()[0],
                   "access": access, "status": status, "description": desc,
                   "table": table, "enums": enum, "unit": unit})

result = {"mib": "DELL-STORAGE-SC-MIB", "revision": "201401290000Z",
          "root": nodes["storageCenterObjects"]["oid"], "tables": tables, "fields": fields}
(ROOT / "mibs/schema.json").write_text(json.dumps(result, indent=2) + "\n")
print(f"Compiled {len(fields)} readable objects and {len(tables)} tables")
