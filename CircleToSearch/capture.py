"""
Circle to Search — Screen Capture
Fast multi-monitor capture using mss (DXGI-based).
"""
import mss
from PIL import Image


class ScreenCapture:
    """Captures the entire virtual desktop (all monitors) as a single image."""

    def capture_all(self):
        """
        Capture the entire virtual desktop.
        Returns: (PIL.Image, monitor_info_dict) or (None, None) on failure.
        """
        try:
            with mss.MSS() as sct:
                monitor = sct.monitors[0]  # 0 = entire virtual screen
                screenshot = sct.grab(monitor)
                img = Image.frombytes(
                    "RGB",
                    (screenshot.width, screenshot.height),
                    screenshot.rgb,
                )
                info = {
                    "left": monitor["left"],
                    "top": monitor["top"],
                    "width": monitor["width"],
                    "height": monitor["height"],
                }
                return img, info
        except Exception as e:
            print(f"[Capture] Error: {e}")
            # Fallback: try PIL ImageGrab
            try:
                from PIL import ImageGrab
                img = ImageGrab.grab(all_screens=True)
                if img:
                    info = {
                        "left": 0, "top": 0,
                        "width": img.width, "height": img.height,
                    }
                    return img, info
            except Exception as e2:
                print(f"[Capture] Fallback also failed: {e2}")
            return None, None

    def get_monitors(self):
        """Return list of monitor geometries."""
        try:
            with mss.MSS() as sct:
                return list(sct.monitors[1:])
        except Exception:
            return []


# Global instance
screen_capture = ScreenCapture()
