#!/usr/bin/env python3
"""Run the local rembg segmentation model for a single static image."""

from pathlib import Path
import sys

from PIL import Image, ImageSequence
from rembg import new_session, remove


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: remove_background_ai.py INPUT OUTPUT", file=sys.stderr)
        return 2

    source = Path(sys.argv[1]).expanduser().resolve()
    target = Path(sys.argv[2]).expanduser().resolve()
    if not source.is_file():
        print(f"Không tìm thấy ảnh đầu vào: {source}", file=sys.stderr)
        return 2

    session = new_session("birefnet-general-lite")
    if source.suffix.lower() == ".gif":
        animation = Image.open(source)
        frames = []
        durations = []
        total_frames = animation.n_frames
        for index, frame in enumerate(ImageSequence.Iterator(animation), start=1):
            durations.append(frame.info.get("duration", animation.info.get("duration", 100)))
            result = remove(frame.convert("RGBA"), session=session, decontaminate=True)
            frames.append(result.convert("RGBA"))
            print(f"PROGRESS {index} {total_frames}", flush=True)
        frames[0].save(
            target,
            save_all=True,
            append_images=frames[1:],
            duration=durations,
            loop=animation.info.get("loop", 0),
            disposal=2,
            optimize=False,
        )
    else:
        result = remove(source.read_bytes(), session=session, decontaminate=True)
        target.write_bytes(result)
    print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
