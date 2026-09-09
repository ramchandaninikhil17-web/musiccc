"""
Circle to Search — Selection Overlay
Full-screen transparent overlay with frozen screenshot background.
Handles mouse selection, DPI scaling, multi-monitor support.
"""
import tkinter as tk
from PIL import Image, ImageTk, ImageDraw
import ctypes
import threading

from capture import screen_capture
from toolbar import ActionToolbar, OcrResultPanel
from ocr_engine import ocr_engine
from config import config
from utils import get_virtual_screen_rect
import actions


class SelectionOverlay:
    """
    Full-screen overlay that allows the user to select a region.
    Uses a frozen screenshot as background with a dark tint.
    """

    DIM_ALPHA = 0.4
    SELECTION_BORDER_COLOR = "#60a5fa"
    SELECTION_BORDER_WIDTH = 2
    MIN_SELECTION_SIZE = 10

    def __init__(self):
        self._root = None
        self._canvas = None
        self._screenshot = None
        self._monitor_info = None

        # Image references (prevent GC)
        self._bg_photo = None
        self._original_photo = None
        self._bg_image = None
        self._original_image = None
        self._selection_photo = None

        # Selection state
        self._start_x = 0
        self._start_y = 0
        self._end_x = 0
        self._end_y = 0
        self._is_selecting = False
        self._selection_made = False

        # UI elements
        self._toolbar = ActionToolbar()
        self._ocr_panel = OcrResultPanel()
        self._cropped_image = None

        # State
        self._on_complete = None
        self._active = False
        self._initialized = False
        self._vw = 0
        self._vh = 0

    def initialize(self):
        """Pre-create the tkinter root (call from main thread)."""
        if self._initialized:
            return

        self._root = tk.Tk()
        self._root.withdraw()
        self._root.title("Circle to Search")
        self._root.overrideredirect(True)
        self._root.attributes("-topmost", True)
        self._root.configure(cursor="crosshair", bg="black")

        # Bind keys
        self._root.bind("<Escape>", self._on_escape)
        self._root.bind("<Key>", self._on_key)

        # Canvas
        self._canvas = tk.Canvas(
            self._root,
            highlightthickness=0,
            cursor="crosshair",
            bg="black",
        )
        self._canvas.pack(fill=tk.BOTH, expand=True)

        # Mouse bindings
        self._canvas.bind("<ButtonPress-1>", self._on_mouse_down)
        self._canvas.bind("<B1-Motion>", self._on_mouse_drag)
        self._canvas.bind("<ButtonRelease-1>", self._on_mouse_up)
        self._canvas.bind("<ButtonPress-3>", self._on_right_click)  # Right-click = cancel

        self._initialized = True

    def activate(self, on_complete=None):
        """
        Activate the overlay: capture screen → show overlay → selection mode.
        on_complete(): called when overlay is dismissed.
        """
        if self._active:
            return

        self._on_complete = on_complete
        self._active = True
        self._selection_made = False
        self._cropped_image = None

        # Reset selection
        self._start_x = self._start_y = 0
        self._end_x = self._end_y = 0
        self._is_selecting = False

        # Capture screen BEFORE showing overlay
        self._screenshot, self._monitor_info = screen_capture.capture_all()
        if self._screenshot is None:
            print("[Overlay] Screen capture failed")
            self._active = False
            if on_complete:
                on_complete()
            return

        # Get virtual screen geometry
        vx, vy, vw, vh = get_virtual_screen_rect()
        self._vw = vw
        self._vh = vh

        # Position window to cover all monitors
        self._root.geometry(f"{vw}x{vh}+{vx}+{vy}")

        # Create dimmed background
        self._create_background(vw, vh)

        # Show the overlay
        self._root.deiconify()
        self._root.attributes("-topmost", True)
        self._root.focus_force()
        self._root.lift()
        self._root.update_idletasks()

        # Force topmost via Win32 API
        self._force_topmost()

    def _force_topmost(self):
        """Use Win32 to ensure overlay is truly topmost."""
        try:
            # Get the HWND from tkinter
            hwnd = self._root.winfo_id()
            HWND_TOPMOST = -1
            SWP_SHOWWINDOW = 0x0040
            ctypes.windll.user32.SetWindowPos(
                hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                0x0002 | 0x0001 | SWP_SHOWWINDOW  # NOMOVE | NOSIZE | SHOW
            )
            # Also set foreground
            ctypes.windll.user32.SetForegroundWindow(hwnd)
        except Exception:
            pass

    def _create_background(self, width, height):
        """Create the dimmed screenshot background."""
        try:
            bg = self._screenshot.copy()
            if bg.size != (width, height):
                bg = bg.resize((width, height), Image.LANCZOS)

            # Keep original for selection reveal
            self._original_image = bg

            # Create dimmed version
            bg_rgba = bg.convert("RGBA")
            dim = Image.new("RGBA", (width, height), (0, 0, 0, int(255 * self.DIM_ALPHA)))
            composited = Image.alpha_composite(bg_rgba, dim)

            # Convert to PhotoImages
            self._bg_image = composited
            self._bg_photo = ImageTk.PhotoImage(composited)
            self._original_photo = ImageTk.PhotoImage(bg)

            # Draw on canvas
            self._canvas.delete("all")
            self._canvas.config(width=width, height=height)
            self._canvas.create_image(0, 0, anchor=tk.NW, image=self._bg_photo, tags="bg")

        except Exception as e:
            print(f"[Overlay] Background error: {e}")

    def _on_mouse_down(self, event):
        """Start selection or dismiss if selection already made."""
        if self._selection_made:
            # Clicking again → dismiss (user clicked outside toolbar)
            self._dismiss()
            return

        self._start_x = event.x
        self._start_y = event.y
        self._end_x = event.x
        self._end_y = event.y
        self._is_selecting = True

        # Clean up previous selection visuals
        self._canvas.delete("selection_clear")
        self._canvas.delete("selection_border")

    def _on_mouse_drag(self, event):
        """Update selection rectangle during drag."""
        if not self._is_selecting:
            return

        self._end_x = event.x
        self._end_y = event.y

        x1 = min(self._start_x, self._end_x)
        y1 = min(self._start_y, self._end_y)
        x2 = max(self._start_x, self._end_x)
        y2 = max(self._start_y, self._end_y)

        # Remove old visuals
        self._canvas.delete("selection_clear")
        self._canvas.delete("selection_border")

        # Show bright (non-dimmed) region inside selection
        if x2 - x1 > 3 and y2 - y1 > 3:
            try:
                crop = self._original_image.crop((x1, y1, x2, y2))
                self._selection_photo = ImageTk.PhotoImage(crop)
                self._canvas.create_image(
                    x1, y1, anchor=tk.NW,
                    image=self._selection_photo,
                    tags="selection_clear"
                )
            except Exception:
                pass

        # Selection border
        self._canvas.create_rectangle(
            x1, y1, x2, y2,
            outline=self.SELECTION_BORDER_COLOR,
            width=self.SELECTION_BORDER_WIDTH,
            tags="selection_border"
        )

    def _on_mouse_up(self, event):
        """Complete selection → show toolbar."""
        if not self._is_selecting:
            return

        self._is_selecting = False
        self._end_x = event.x
        self._end_y = event.y

        x1 = min(self._start_x, self._end_x)
        y1 = min(self._start_y, self._end_y)
        x2 = max(self._start_x, self._end_x)
        y2 = max(self._start_y, self._end_y)

        # Too small → ignore
        if (x2 - x1) < self.MIN_SELECTION_SIZE or (y2 - y1) < self.MIN_SELECTION_SIZE:
            self._canvas.delete("selection_clear")
            self._canvas.delete("selection_border")
            return

        self._selection_made = True

        # Crop selected area from original screenshot
        try:
            img_w, img_h = self._screenshot.size
            scale_x = img_w / self._vw if self._vw > 0 else 1
            scale_y = img_h / self._vh if self._vh > 0 else 1

            cx1 = max(0, min(int(x1 * scale_x), img_w))
            cy1 = max(0, min(int(y1 * scale_y), img_h))
            cx2 = max(0, min(int(x2 * scale_x), img_w))
            cy2 = max(0, min(int(y2 * scale_y), img_h))

            self._cropped_image = self._screenshot.crop((cx1, cy1, cx2, cy2))
        except Exception as e:
            print(f"[Overlay] Crop error: {e}")
            self._cropped_image = None
            self._dismiss()
            return

        # Position toolbar beside selection
        toolbar_x = x2 + 10
        toolbar_y = y1
        if toolbar_x + 330 > self._vw:
            toolbar_x = max(10, x1 - 330)

        self._toolbar.show(
            toolbar_x, toolbar_y,
            self._vw, self._vh,
            self._on_toolbar_action,
            parent_root=self._canvas,
        )

    def _on_toolbar_action(self, action):
        """Handle toolbar button click."""
        if action == "close":
            self._dismiss()
            return

        if self._cropped_image is None:
            self._dismiss()
            return

        if action == "search":
            img = self._cropped_image.copy()
            self._dismiss()
            # Run after dismiss so overlay is hidden before browser opens
            self._root.after(50, lambda: actions.search_google_lens(img))

        elif action == "text":
            self._toolbar.hide()
            x1 = min(self._start_x, self._end_x)
            y1 = min(self._start_y, self._end_y)
            x2 = max(self._start_x, self._end_x)

            panel_x = x2 + 10
            panel_y = y1
            if panel_x + 360 > self._vw:
                panel_x = max(10, x1 - 360)

            # Show loading
            self._ocr_panel.show_loading(panel_x, panel_y, parent_root=self._canvas)
            self._root.update_idletasks()

            # Run OCR async
            img_copy = self._cropped_image.copy()
            px, py = panel_x, panel_y

            def on_ocr_done(text, error):
                try:
                    self._root.after(0, lambda: self._show_ocr_result(px, py, text, error))
                except Exception:
                    pass

            ocr_engine.recognize(img_copy, callback=on_ocr_done)

        elif action == "copy":
            actions.copy_image(self._cropped_image)
            self._dismiss()

    def _show_ocr_result(self, x, y, text, error):
        """Display OCR result panel."""
        self._ocr_panel.hide()

        if error:
            self._ocr_panel.show_error(
                x, y, error,
                on_close=self._dismiss,
                parent_root=self._canvas,
            )
        elif text and text.strip():
            self._ocr_panel.show(
                x, y, text, self._vw, self._vh,
                on_action=self._on_ocr_action,
                parent_root=self._canvas,
            )
        else:
            self._ocr_panel.show_error(
                x, y, "No text detected in the selected area.",
                on_close=self._dismiss,
                parent_root=self._canvas,
            )

    def _on_ocr_action(self, action, text):
        """Handle OCR panel button click."""
        if action == "copy_text":
            actions.copy_text(text)
            self._dismiss()
        elif action == "search_text":
            self._dismiss()
            self._root.after(50, lambda: actions.search_google_text(text))
        elif action == "close":
            self._dismiss()

    def _on_escape(self, event=None):
        """ESC → dismiss immediately."""
        self._dismiss()

    def _on_key(self, event=None):
        """Handle other key presses."""
        pass  # Reserved for future shortcuts

    def _on_right_click(self, event=None):
        """Right-click → cancel."""
        self._dismiss()

    def _dismiss(self):
        """Hide the overlay and clean up."""
        if not self._active:
            return

        self._active = False
        self._selection_made = False
        self._is_selecting = False

        # Hide UI
        self._toolbar.hide()
        self._ocr_panel.hide()

        # Hide window
        try:
            self._root.withdraw()
        except tk.TclError:
            pass

        # Clear canvas
        try:
            self._canvas.delete("all")
        except tk.TclError:
            pass

        # Release heavy image references
        self._bg_photo = None
        self._original_photo = None
        self._bg_image = None
        self._original_image = None
        self._selection_photo = None
        self._cropped_image = None
        self._screenshot = None

        # Callback
        if self._on_complete:
            try:
                self._on_complete()
            except Exception:
                pass

    def process_events(self):
        """Process pending tkinter events (call from main loop)."""
        if self._root:
            try:
                self._root.update()
            except tk.TclError:
                pass

    @property
    def is_active(self):
        return self._active

    def destroy(self):
        """Fully destroy the overlay."""
        self._dismiss()
        if self._root:
            try:
                self._root.destroy()
            except tk.TclError:
                pass
            self._root = None
            self._initialized = False
