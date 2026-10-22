#!/usr/bin/env python3
"""Render a compose file's mcp-server environment the way `docker compose config` would.

argv: <compose file> <.env file>
Resolves ${VAR}, ${VAR:-default} and ${VAR-default} from the .env file (the shell environment is
deliberately NOT consulted: tests must not depend on the operator's own exports). A null value
(`KEY:`) is compose's pass-through: set only when .env sets it. Prints a minimal rendered config
(`services: / mcp-server: / environment:`) to stdout — the shape install.sh parses. Values are
printed (they are the point), so callers must only feed it fixture secrets.
"""
import re
import sys
import yaml

compose_path, env_path = sys.argv[1], sys.argv[2]
env = {}
with open(env_path) as fh:
    for raw in fh:
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", raw.rstrip("\n"))
        if m:
            env[m.group(1)] = m.group(2)

REF = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-|-)([^}]*))?\}")


def interp(text):
    def sub(m):
        name, op, default = m.group(1), m.group(2), m.group(3) or ""
        val = env.get(name)
        if op == ":-":
            return val if val else default
        if op == "-":
            return default if val is None else val
        return val or ""
    return REF.sub(sub, text)


with open(compose_path) as fh:
    doc = yaml.safe_load(fh) or {}
svc_env = (doc.get("services", {}).get("mcp-server", {}) or {}).get("environment", {}) or {}
if isinstance(svc_env, list):
    svc_env = {(e.split("=", 1)[0]): (e.split("=", 1)[1] if "=" in e else None) for e in svc_env}

print("services:")
print("  mcp-server:")
print("    environment:")
for key, val in svc_env.items():
    if val is None:
        if key not in env:
            continue  # pass-through of an unset variable: absent from the container
        val = env[key]
    else:
        val = interp(str(val))
    print(f"      {key}: {yaml.safe_dump(val, default_style=chr(34)).splitlines()[0]}")
