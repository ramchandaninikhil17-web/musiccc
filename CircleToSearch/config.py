"""
Circle to Search — Configuration
"""
import json
import os

# --- Paths ---
APP_NAME = "CircleToSearch"
APP_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(APP_DIR, "settings.json")
TEMP_DIR = os.path.join(os.environ.get("TEMP", APP_DIR), APP_NAME)

# --- Defaults ---
DEFAULTS = {
    "hotkey": "win+shift+q",
    "overlay_opacity": 0.4,
    "toolbar_fade_ms": 80,
    "ocr_language": "en",
    "temp_cleanup_delay_s": 30,
    "start_minimized": True,
    "google_lens_fallback": "clipboard",
}


class Config:
    """Simple JSON-backed configuration."""

    def __init__(self):
        self._data = dict(DEFAULTS)
        self._load()

    def _load(self):
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    saved = json.load(f)
                self._data.update(saved)
            except (json.JSONDecodeError, OSError):
                pass

    def save(self):
        try:
            with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                json.dump(self._data, f, indent=2)
        except OSError:
            pass

    def get(self, key, default=None):
        return self._data.get(key, default if default is not None else DEFAULTS.get(key))

    def set(self, key, value):
        self._data[key] = value
        self.save()

    @property
    def hotkey(self):
        return self._data.get("hotkey", DEFAULTS["hotkey"])

    @property
    def overlay_opacity(self):
        return self._data.get("overlay_opacity", DEFAULTS["overlay_opacity"])

    @property
    def temp_cleanup_delay(self):
        return self._data.get("temp_cleanup_delay_s", DEFAULTS["temp_cleanup_delay_s"])


# Global config instance
config = Config()
