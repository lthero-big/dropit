#!/usr/bin/env python3
"""Synthetic-only volume rehearsal. Input is tests/admin.mjs ADMIN_FIXTURE_OUT."""
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import time
import urllib.request
import uuid

fixture = pathlib.Path(sys.argv[1]).resolve()
rust_image, ts_image = sys.argv[2:4]
prefix = "dropit-rhea246-" + uuid.uuid4().hex[:10]
volumes = [prefix + "-old", prefix + "-restore", prefix + "-history"]
containers = []
metadata = json.loads((fixture / "fixture.json").read_text())
space = metadata["aliceSpace"]
headers = {"Cookie": "dropit_session=" + metadata["oldCookie"], "Origin": "http://dropit.test"}

def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()

def helper(volume, script, *args):
    return docker("run", "--rm", "--user", "0", "--entrypoint", "sh", "-v", volume + ":/data", ts_image, "-ec", script, "sh", *args)

def start(image, volume):
    name = prefix + "-" + str(len(containers))
    containers.append(name)
    docker("run", "-d", "--name", name, "-p", "127.0.0.1::8787", "-v", volume + ":/data", "-e", "APP_ORIGIN=http://dropit.test", "-e", "UPDATE_CHECK=0", image)
    url = "http://127.0.0.1:" + docker("port", name, "8787/tcp").rsplit(":", 1)[1]
    for _ in range(200):
        try:
            with urllib.request.urlopen(url + "/healthz", timeout=1) as r:
                if r.status == 200:
                    return name, url
        except Exception:
            time.sleep(.1)
    raise RuntimeError(docker("logs", name))

def request(url, path, body=None, extra=None):
    req = urllib.request.Request(url + path, data=body, headers={**headers, **(extra or {})})
    with urllib.request.urlopen(req, timeout=10) as response:
        return response.read()

def stop(name):
    docker("stop", "-t", "15", name)
    assert docker("inspect", name, "--format", "{{.State.ExitCode}}") == "0"

def manifest(volume):
    return helper(volume, "cd /data; find . -type f -exec sha256sum {} \\; | sort")

try:
    for volume in volumes:
        docker("volume", "create", volume)
    docker("run", "--rm", "--user", "0", "--entrypoint", "sh", "-v", str(fixture / "historical15") + ":/fixture:ro", "-v", volumes[2] + ":/data", ts_image, "-ec", "cp -a /fixture/. /data/; chown -R 1000:1000 /data; chmod 700 /data")
    name, url = start(rust_image, volumes[2])
    stop(name)
    helper(volumes[2], "test -n \"$(find /data -name 'dropit.sqlite.pre-v15-*.bak')\"")
    # Reopen the migrated database with the previous TS SQLite driver and write.
    docker("run", "--rm", "--entrypoint", "node", "-v", volumes[2] + ":/data", ts_image, "-e", "const D=require('better-sqlite3'),d=new D('/data/dropit.sqlite');if(d.pragma('user_version',{simple:true})!==19||!d.prepare('SELECT roomCode FROM spaces WHERE id=?').get('legacy-room').roomCode)process.exit(1);d.prepare('INSERT INTO app_settings(key,value,updatedAt) VALUES (?,?,0)').run('rollback-check','ok');d.close()")
    print("PASS real TS schema 15 -> Rust schema 19, pre-v15 backup, historical room preserved, old TS driver write")
    # Copy the TS-created fixture, preserving old Node UID/GID and 0700 root.
    docker("run", "--rm", "--user", "0", "--entrypoint", "sh", "-v", str(fixture) + ":/fixture:ro", "-v", volumes[0] + ":/data", ts_image, "-ec", "cp -a /fixture/. /data/; chown -R 1000:1000 /data; chmod 700 /data")
    name, url = start(ts_image, volumes[0])
    old_items = json.loads(request(url, f"/api/spaces/{space}/items"))
    assert "TS 已有文本" in json.dumps(old_items, ensure_ascii=False)
    payload = b"historical upload before cutover\n"
    uploaded = json.loads(request(url, f"/api/spaces/{space}/items/file", payload, {"Content-Type": "application/octet-stream", "X-File-Name": "history.txt"}))
    item = uploaded.get("item", uploaded)
    old_id = item["id"]
    stop(name)
    before = manifest(volumes[0])
    # Full offline archive including sqlite/WAL and every storage object, stored
    # in a disposable helper container then copied into the restored volume.
    backup = prefix + "-backup"
    containers.append(backup)
    docker("create", "--name", backup, "--user", "0", "--entrypoint", "sh", "-v", volumes[0] + ":/source:ro", "-v", volumes[1] + ":/restore", ts_image, "-ec", "cd /source; tar czpf /backup.tgz .; cd /restore; tar xzpf /backup.tgz")
    docker("start", "-a", backup)
    assert docker("inspect", backup, "--format", "{{.State.ExitCode}}") == "0"
    assert manifest(volumes[1]) == before
    print("PASS complete offline backup/restore: all file SHA256 manifests identical")
    name, url = start(rust_image, volumes[1])
    assert docker("exec", name, "id", "-u") == "1000"
    assert "TS 已有文本" in request(url, f"/api/spaces/{space}/items").decode()
    assert request(url, f"/api/spaces/{space}/items/{old_id}/download") == payload
    text = json.loads(request(url, f"/api/spaces/{space}/items/text", json.dumps({"text":"Rust persisted before rollback"}).encode(), {"Content-Type":"application/json"}))
    assert "Rust persisted before rollback" in json.dumps(text)
    rust_upload = json.loads(request(url, f"/api/spaces/{space}/items/file", b"Rust upload before rollback", {"Content-Type":"application/octet-stream", "X-File-Name":"rust.txt"}))
    rust_id = rust_upload.get("item", rust_upload)["id"]
    stop(name)
    name, url = start(ts_image, volumes[1])
    assert "Rust persisted before rollback" in request(url, f"/api/spaces/{space}/items").decode()
    assert request(url, f"/api/spaces/{space}/items/{old_id}/download") == payload
    assert request(url, f"/api/spaces/{space}/items/{rust_id}/download") == b"Rust upload before rollback"
    request(url, f"/api/spaces/{space}/items/text", b'{"text":"TS write after rollback"}', {"Content-Type":"application/json"})
    request(url, f"/api/spaces/{space}/items/file", b"TS upload after rollback", {"Content-Type":"application/octet-stream", "X-File-Name":"rollback.txt"})
    stop(name)
    name, url = start(rust_image, volumes[1])
    reset = docker("exec", name, "dropit-admin", "reset-password", "ALICE@example.test")
    password = re.search(r": ([abcdefghjkmnpqrstuvwxyz23456789]{4}(?:-[abcdefghjkmnpqrstuvwxyz23456789]{4}){2})", reset).group(1)
    login = json.loads(request(url, "/api/auth/password/login", json.dumps({"email":"alice@example.test", "password":password}).encode(), {"Content-Type":"application/json"}))
    assert login["mustChangePassword"] is True
    stop(name)
    print("PASS image-installed dropit-admin reset and temporary-password login/forced-change")
    print("PASS old UID/GID 1000 volume, TS historical text/upload, Rust text/upload writes, same-volume TS rollback read/write, health and SIGTERM")
    print("images:", docker("image", "inspect", rust_image, ts_image, "--format", "{{.Id}} {{index .Config.Labels \"org.opencontainers.image.revision\"}}"))
finally:
    for name in reversed(containers):
        subprocess.run(["docker", "rm", "-fv", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for volume in volumes:
        subprocess.run(["docker", "volume", "rm", volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
