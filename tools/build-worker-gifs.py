from collections import deque
from math import cos, pi, sin
from pathlib import Path
from PIL import Image, ImageDraw, ImageEnhance


ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / "manager" / "src" / "assets"
SOURCE = ASSET_DIR / "worker-status-sheet.png"
WORKING_SOURCE = ASSET_DIR / "worker-working-source.png"
WORKING_CYCLE_SOURCE = ASSET_DIR / "worker-working-cycle.png"
CANVAS_SIZE = 128
CONTENT_SIZE = 116


def normalized_cell(source: Image.Image, index: int, cell_count: int = 3) -> Image.Image:
    cell_width = source.width // cell_count
    left = index * cell_width
    right = source.width if index == cell_count - 1 else (index + 1) * cell_width
    cell = source.crop((left, 0, right, source.height))
    return normalized_image(cell)


def normalized_image(image: Image.Image) -> Image.Image:
    bounds = image.getbbox()
    if bounds:
        image = image.crop(bounds)
    scale = min(CONTENT_SIZE / image.width, CONTENT_SIZE / image.height)
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    return image.resize(size, Image.Resampling.NEAREST)


def clear_light_edge_background(source: Image.Image) -> Image.Image:
    image = source.convert("RGBA")
    pixels = image.load()
    width, height = image.size
    queue = deque()
    visited = set()

    def is_background(x: int, y: int) -> bool:
        red, green, blue, _ = pixels[x, y]
        return min(red, green, blue) >= 225 and max(red, green, blue) - min(red, green, blue) <= 18

    for x in range(width):
        queue.append((x, 0))
        queue.append((x, height - 1))
    for y in range(height):
        queue.append((0, y))
        queue.append((width - 1, y))

    while queue:
        x, y = queue.popleft()
        if (x, y) in visited or not is_background(x, y):
            continue
        visited.add((x, y))
        pixels[x, y] = (0, 0, 0, 0)
        if x > 0:
            queue.append((x - 1, y))
        if x + 1 < width:
            queue.append((x + 1, y))
        if y > 0:
            queue.append((x, y - 1))
        if y + 1 < height:
            queue.append((x, y + 1))
    return image


def frame(base: Image.Image, dx: int = 0, dy: int = 0, brightness: float = 1.0) -> Image.Image:
    image = ImageEnhance.Brightness(base).enhance(brightness) if brightness != 1 else base
    canvas = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
    x = (CANVAS_SIZE - image.width) // 2 + dx
    y = (CANVAS_SIZE - image.height) // 2 + dy
    canvas.alpha_composite(image, (x, y))
    return canvas


def save_gif(name: str, base: Image.Image, poses: list[tuple[int, int, float]], duration: int) -> None:
    frames = [frame(base, *pose) for pose in poses]
    save_frames(name, frames, duration)


def save_frames(name: str, frames: list[Image.Image], duration: int) -> None:
    frames[0].save(
        ASSET_DIR / f"worker-{name}.gif",
        save_all=True,
        append_images=frames[1:],
        duration=duration,
        loop=0,
        disposal=2,
        transparency=0,
        optimize=True,
    )


def star_points(center_x: float, center_y: float, outer: float = 5, inner: float = 2.2) -> list[tuple[float, float]]:
    points = []
    for point in range(10):
        angle = -pi / 2 + point * pi / 5
        radius = outer if point % 2 == 0 else inner
        points.append((center_x + cos(angle) * radius, center_y + sin(angle) * radius))
    return points


def dizzy_frame(base: Image.Image, index: int) -> Image.Image:
    smaller = base.resize((round(base.width * 0.9), round(base.height * 0.9)), Image.Resampling.NEAREST)
    canvas = frame(smaller, dx=(-1, 0, 1, 0)[index % 4], dy=9, brightness=(0.88, 0.96, 1.02, 0.96)[index % 4])
    draw = ImageDraw.Draw(canvas)
    phase = index * pi / 4
    colors = [(255, 219, 80, 255), (255, 164, 48, 255), (255, 242, 153, 255)]
    stars = []
    for star_index in range(3):
        angle = phase + star_index * 2 * pi / 3
        x = CANVAS_SIZE / 2 + cos(angle) * 27
        y = 15 + sin(angle) * 7
        stars.append((y, x, colors[star_index]))
    for y, x, color in sorted(stars):
        radius = 5 if y >= 15 else 4
        draw.polygon(star_points(x, y, radius, radius * 0.44), fill=color)
    return canvas


def main() -> None:
    source = Image.open(SOURCE).convert("RGBA")
    hung, idle = (normalized_cell(source, index) for index in range(2))
    working_cycle = clear_light_edge_background(Image.open(WORKING_CYCLE_SOURCE))
    working_frames = [frame(normalized_cell(working_cycle, index, 4)) for index in range(4)]
    save_frames("hung", [dizzy_frame(hung, index) for index in range(8)], 115)
    save_gif("idle", idle, [(0, 1, 0.98), (0, 0, 1.0), (0, -1, 1.03), (0, -1, 1.03), (0, 0, 1.0), (0, 1, 0.98)], 260)
    save_frames("working", working_frames + working_frames[-2:0:-1], 135)


if __name__ == "__main__":
    main()
