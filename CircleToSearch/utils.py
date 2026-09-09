"""
Circle to Search — Utilities
DPI scaling, temp file management, clipboard, monitor helpers.
"""
import ctypes
import os
import threading
import time
import uuid
import io

from PIL import Image
from config import TEMP_DIR

# --- DPI Awareness ---
def enable_dpi_awareness():
    """Set process DPI awareness to Per-Monitor V2 for correct scaling."""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except (AttributeError, OSError):
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except (AttributeError, OSError):
            try:
                ctypes.windll.user32.SetProcessDPIAware()
            except (AttributeError, OSError):
                pass


def get_virtual_screen_rect():
    """Get bounding rectangle of the virtual screen (all monitors)."""
    user32 = ctypes.windll.user32
    x = user32.GetSystemMetrics(76)   # SM_XVIRTUALSCREEN
    y = user32.GetSystemMetrics(77)   # SM_YVIRTUALSCREEN
    w = user32.GetSystemMetrics(78)   # SM_CXVIRTUALSCREEN
    h = user32.GetSystemMetrics(79)   # SM_CYVIRTUALSCREEN
    return x, y, w, h


# --- Temp File Management ---
_temp_files = []
_temp_lock = threading.Lock()


def ensure_temp_dir():
    """Create temp directory if it doesn't exist."""
    os.makedirs(TEMP_DIR, exist_ok=True)


def create_temp_file(suffix=".png", content=None):
    """Create a temp file and track it for cleanup. Returns path."""
    ensure_temp_dir()
    name = f"cts_{uuid.uuid4().hex[:8]}{suffix}"
    path = os.path.join(TEMP_DIR, name)
    if content is not None:
        mode = "wb" if isinstance(content, bytes) else "w"
        with open(path, mode, encoding=None if isinstance(content, bytes) else "utf-8") as f:
            f.write(content)
    with _temp_lock:
        _temp_files.append(path)
    return path


def save_image_temp(image: Image.Image, suffix=".png") -> str:
    """Save a PIL Image to a temp file. Returns path."""
    path = create_temp_file(suffix=suffix)
    image.save(path, format="PNG", optimize=False)
    return path


def cleanup_temp_file(path, delay=0):
    """Delete a temp file, optionally after a delay."""
    def _delete():
        if delay > 0:
            time.sleep(delay)
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass
        with _temp_lock:
            if path in _temp_files:
                _temp_files.remove(path)

    if delay > 0:
        t = threading.Thread(target=_delete, daemon=True)
        t.start()
    else:
        _delete()


def cleanup_all_temp():
    """Clean up all tracked temp files and the temp directory."""
    with _temp_lock:
        files = list(_temp_files)
        _temp_files.clear()
    for path in files:
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass
    try:
        if os.path.exists(TEMP_DIR):
            if not os.listdir(TEMP_DIR):
                os.rmdir(TEMP_DIR)
    except OSError:
        pass


# --- Clipboard ---
def copy_image_to_clipboard(image: Image.Image):
    """Copy a PIL Image to the Windows clipboard as CF_DIB."""
    try:
        import win32clipboard

        output = io.BytesIO()
        if image.mode == "RGBA":
            bg = Image.new("RGB", image.size, (255, 255, 255))
            bg.paste(image, mask=image.split()[3])
            image = bg
        elif image.mode != "RGB":
            image = image.convert("RGB")

        image.save(output, format="BMP")
        bmp_data = output.getvalue()
        dib_data = bmp_data[14:]  # Strip BMP file header

        win32clipboard.OpenClipboard()
        win32clipboard.EmptyClipboard()
        win32clipboard.SetClipboardData(win32clipboard.CF_DIB, dib_data)
        win32clipboard.CloseClipboard()
        return True
    except Exception:
        return False


def copy_text_to_clipboard(text: str):
    """Copy text to clipboard."""
    try:
        import pyperclip
        pyperclip.copy(text)
        return True
    except Exception:
        try:
            import win32clipboard
            win32clipboard.OpenClipboard()
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardData(win32clipboard.CF_UNICODETEXT, text)
            win32clipboard.CloseClipboard()
            return True
        except Exception:
            return False


# --- Single Instance ---
_mutex = None

def ensure_single_instance():
    """Prevent multiple instances. Returns True if this is the only instance."""
    global _mutex
    try:
        _mutex = ctypes.windll.kernel32.CreateMutexW(None, True, "CircleToSearch_Mutex_v1")
        last_error = ctypes.windll.kernel32.GetLastError()
        if last_error == 183:  # ERROR_ALREADY_EXISTS
            return False
        return True
    except (AttributeError, OSError):
        return True


def release_single_instance():
    """Release the mutex."""
    global _mutex
    if _mutex:
        try:
            ctypes.windll.kernel32.ReleaseMutex(_mutex)
            ctypes.windll.kernel32.CloseHandle(_mutex)
        except (AttributeError, OSError):
            pass
        _mutex = None
