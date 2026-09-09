from pathlib import Path
import shutil


repository_root = Path(__file__).resolve().parents[2]
port_directory = repository_root / "vcpkg" / "ports" / "drogon"
portfile_path = port_directory / "portfile.cmake"
source_patch = Path(__file__).with_name("drogon-websocket-keepalive.patch")
destination_patch = port_directory / source_patch.name

if not portfile_path.is_file():
    raise SystemExit("The Drogon vcpkg portfile was not found")

shutil.copyfile(source_patch, destination_patch)
portfile = portfile_path.read_text(encoding="utf-8")

if source_patch.name not in portfile:
    patches_marker = "    PATCHES\n"
    if patches_marker in portfile:
        portfile = portfile.replace(
            patches_marker,
            patches_marker + f"         {source_patch.name}\n",
            1,
        )
    else:
        head_marker = "    HEAD_REF master\n"
        if head_marker not in portfile:
            raise SystemExit("The Drogon source declaration was not recognized")
        portfile = portfile.replace(
            head_marker,
            head_marker + f"    PATCHES\n         {source_patch.name}\n",
            1,
        )

    portfile_path.write_text(portfile, encoding="utf-8")

print("Drogon WebSocket keep-alive patch registered")
