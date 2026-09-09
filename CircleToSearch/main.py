"""
Circle to Search — Main Entry Point
System tray icon, global hotkey, application lifecycle.

Usage:
    python main.py
    
Press Win+Shift+Q (or configured hotkey) to activate.
"""
import sys
import os
import threading
import time
import ctypes
import atexit

# Ensure this script's directory is on the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from utils import enable_dpi_awareness, ensure_single_instance, release_single_instance, cleanup_all_temp
from config import config
from overlay import SelectionOverlay

# Enable DPI awareness BEFORE any window creation
enable_dpi_awareness()


class CircleToSearchApp:
    """Main application controller."""

    def __init__(self):
        self._overlay = None
        self._tray_icon = None
        self._running = False
        self._hotkey_registered = False
        self._hotkey_hook = None

    def run(self):
        """Start the application."""
        # Single instance check
        if not ensure_single_instance():
            print("[CircleToSearch] Already running. Exiting.")
            try:
                ctypes.windll.user32.MessageBoxW(
                    0,
                    "Circle to Search is already running.\nCheck your system tray.",
                    "Circle to Search",
                    0x40  # MB_ICONINFORMATION
                )
            except Exception:
                pass
            return

        print("[CircleToSearch] Starting...")
        self._running = True

        # Register cleanup
        atexit.register(self._cleanup)

        # Initialize the overlay (must be on main thread for tkinter)
        self._overlay = SelectionOverlay()
        self._overlay.initialize()

        # Register hotkey
        self._register_hotkey()

        # Start system tray in a thread
        tray_thread = threading.Thread(target=self._start_tray, daemon=True)
        tray_thread.start()

        print(f"[CircleToSearch] Ready! Press {config.hotkey} to search.")
        print("[CircleToSearch] Right-click tray icon for options.")

        # Main loop (tkinter event processing)
        self._main_loop()

    def _main_loop(self):
        """Main event loop — processes tkinter events and stays responsive."""
        while self._running:
            try:
                self._overlay.process_events()
                time.sleep(0.01)  # ~100 FPS event processing
            except KeyboardInterrupt:
                break
            except Exception as e:
                # Don't crash on transient errors
                time.sleep(0.1)

    def _register_hotkey(self):
        """Register the global hotkey."""
        try:
            import keyboard

            hotkey = config.hotkey
            print(f"[CircleToSearch] Registering hotkey: {hotkey}")

            keyboard.add_hotkey(hotkey, self._on_hotkey, suppress=True)
            self._hotkey_registered = True
            print(f"[CircleToSearch] Hotkey registered: {hotkey}")

        except Exception as e:
            print(f"[CircleToSearch] Hotkey registration failed: {e}")
            # Try fallback hotkey
            try:
                fallback = "ctrl+shift+q"
                print(f"[CircleToSearch] Trying fallback: {fallback}")
                import keyboard
                keyboard.add_hotkey(fallback, self._on_hotkey, suppress=True)
                self._hotkey_registered = True
                print(f"[CircleToSearch] Fallback hotkey registered: {fallback}")
            except Exception as e2:
                print(f"[CircleToSearch] Fallback also failed: {e2}")

    def _on_hotkey(self):
        """Hotkey pressed → activate overlay."""
        if self._overlay and not self._overlay.is_active:
            try:
                self._overlay.activate(on_complete=self._on_overlay_complete)
            except Exception as e:
                print(f"[CircleToSearch] Activation error: {e}")

    def _on_overlay_complete(self):
        """Overlay dismissed."""
        pass  # Ready for next activation

    def _start_tray(self):
        """Start the system tray icon."""
        try:
            import pystray
            from PIL import Image as PILImage

            # Create a simple icon
            icon_image = self._create_tray_icon()

            menu = pystray.Menu(
                pystray.MenuItem(
                    f"🔍 Search ({config.hotkey})",
                    self._on_tray_search,
                    default=True,
                ),
                pystray.Menu.SEPARATOR,
                pystray.MenuItem("⚙ Change Hotkey", pystray.Menu(
                    pystray.MenuItem("Win+Shift+Q", lambda: self._change_hotkey("win+shift+q")),
                    pystray.MenuItem("Ctrl+Shift+Q", lambda: self._change_hotkey("ctrl+shift+q")),
                    pystray.MenuItem("Win+Shift+S", lambda: self._change_hotkey("win+shift+s")),
                    pystray.MenuItem("Ctrl+Shift+S", lambda: self._change_hotkey("ctrl+shift+s")),
                    pystray.MenuItem("F9", lambda: self._change_hotkey("f9")),
                )),
                pystray.Menu.SEPARATOR,
                pystray.MenuItem("❌ Exit", self._on_tray_exit),
            )

            self._tray_icon = pystray.Icon(
                "CircleToSearch",
                icon_image,
                "Circle to Search",
                menu,
            )

            self._tray_icon.run()

        except Exception as e:
            print(f"[CircleToSearch] Tray icon error: {e}")
            print("[CircleToSearch] Running without tray icon.")

    def _create_tray_icon(self):
        """Create a simple tray icon programmatically."""
        from PIL import Image as PILImage, ImageDraw

        # Check for custom icon file
        icon_path = os.path.join(os.path.dirname(__file__), "assets", "icon.png")
        if os.path.exists(icon_path):
            try:
                return PILImage.open(icon_path).resize((64, 64))
            except Exception:
                pass

        # Generate a clean icon: circle with magnifying glass
        size = 64
        img = PILImage.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)

        # Background circle
        draw.ellipse([4, 4, size - 4, size - 4], fill="#3b82f6")

        # Magnifying glass (circle + line)
        glass_cx, glass_cy, glass_r = 24, 24, 12
        draw.ellipse(
            [glass_cx - glass_r, glass_cy - glass_r,
             glass_cx + glass_r, glass_cy + glass_r],
            outline="white", width=3,
        )
        # Handle
        draw.line(
            [glass_cx + glass_r - 2, glass_cy + glass_r - 2, size - 14, size - 14],
            fill="white", width=3,
        )

        return img

    def _on_tray_search(self, icon=None, item=None):
        """Tray: activate search."""
        self._on_hotkey()

    def _change_hotkey(self, new_hotkey):
        """Change the active hotkey."""
        try:
            import keyboard
            # Remove old hotkey
            keyboard.unhook_all_hotkeys()

            # Register new one
            keyboard.add_hotkey(new_hotkey, self._on_hotkey, suppress=True)
            config.set("hotkey", new_hotkey)
            print(f"[CircleToSearch] Hotkey changed to: {new_hotkey}")

            # Update tray tooltip
            if self._tray_icon:
                self._tray_icon.title = f"Circle to Search ({new_hotkey})"
        except Exception as e:
            print(f"[CircleToSearch] Failed to change hotkey: {e}")

    def _on_tray_exit(self, icon=None, item=None):
        """Tray: exit application."""
        self._running = False
        if self._tray_icon:
            try:
                self._tray_icon.stop()
            except Exception:
                pass

    def _cleanup(self):
        """Clean up resources on exit."""
        print("[CircleToSearch] Shutting down...")
        self._running = False

        # Unregister hotkey
        try:
            import keyboard
            keyboard.unhook_all_hotkeys()
        except Exception:
            pass

        # Destroy overlay
        if self._overlay:
            try:
                self._overlay.destroy()
            except Exception:
                pass

        # Clean temp files
        cleanup_all_temp()

        # Release mutex
        release_single_instance()

        print("[CircleToSearch] Goodbye.")


def main():
    """Entry point."""
    # Hide console window if launched from .pyw or frozen
    if hasattr(sys, 'frozen') or sys.argv[0].endswith('.pyw'):
        try:
            ctypes.windll.user32.ShowWindow(
                ctypes.windll.kernel32.GetConsoleWindow(), 0
            )
        except Exception:
            pass

    app = CircleToSearchApp()
    try:
        app.run()
    except KeyboardInterrupt:
        pass
    except Exception as e:
        print(f"[CircleToSearch] Fatal error: {e}")
        import traceback
        traceback.print_exc()
    finally:
        app._cleanup()


if __name__ == "__main__":
    main()
