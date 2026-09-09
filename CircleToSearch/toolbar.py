"""
Circle to Search — Floating Action Toolbar
Windows 11-style mini toolbar that appears after selection.
"""
import tkinter as tk
import threading


class ActionToolbar:
    """
    A tiny floating toolbar that appears beside the selection area.
    Provides: Search (Lens), Text (OCR), Copy, Close actions.
    """

    # Windows 11-style colors
    BG_COLOR = "#2d2d30"
    BG_HOVER = "#3e3e42"
    FG_COLOR = "#e0e0e0"
    ACCENT = "#60a5fa"
    BORDER_COLOR = "#404045"

    BUTTON_WIDTH = 72
    BUTTON_HEIGHT = 36
    PADDING = 6
    ICON_SIZE = 18

    def __init__(self):
        self._root = None
        self._buttons = []
        self._on_action = None
        self._visible = False

    def show(self, x, y, screen_w, screen_h, on_action, parent_root=None):
        """
        Show the toolbar at position (x, y).
        on_action(action_name): callback when a button is clicked.
        action_name is one of: "search", "text", "copy", "close"
        """
        self._on_action = on_action

        # Calculate toolbar dimensions
        buttons = [
            ("🔍", "Search", "search"),
            ("📝", "Text", "text"),
            ("📋", "Copy", "copy"),
            ("✕", "", "close"),
        ]

        total_w = (self.BUTTON_WIDTH * len(buttons)) + (self.PADDING * (len(buttons) + 1))
        total_h = self.BUTTON_HEIGHT + (self.PADDING * 2)

        # Adjust position to stay on screen
        if x + total_w > screen_w:
            x = screen_w - total_w - 10
        if x < 10:
            x = 10
        if y + total_h > screen_h:
            y = y - total_h - 10
        if y < 10:
            y = 10

        # Create the toolbar as a frame within the parent overlay
        if parent_root is None:
            return

        self._frame = tk.Frame(
            parent_root,
            bg=self.BG_COLOR,
            highlightbackground=self.BORDER_COLOR,
            highlightthickness=1,
            padx=self.PADDING,
            pady=self.PADDING,
        )

        # Create buttons
        self._buttons = []
        for icon, label, action in buttons:
            btn_text = f"{icon} {label}" if label else icon
            btn = tk.Label(
                self._frame,
                text=btn_text,
                bg=self.BG_COLOR,
                fg=self.FG_COLOR,
                font=("Segoe UI", 10),
                padx=8,
                pady=4,
                cursor="hand2",
                width=7 if label else 2,
            )
            btn.pack(side=tk.LEFT, padx=2)
            btn.bind("<Button-1>", lambda e, a=action: self._handle_click(a))
            btn.bind("<Enter>", lambda e, b=btn: b.configure(bg=self.BG_HOVER))
            btn.bind("<Leave>", lambda e, b=btn: b.configure(bg=self.BG_COLOR))
            self._buttons.append(btn)

        self._frame.place(x=x, y=y)
        self._visible = True

    def hide(self):
        """Hide and destroy the toolbar."""
        if self._visible and hasattr(self, '_frame') and self._frame:
            try:
                self._frame.place_forget()
                self._frame.destroy()
            except tk.TclError:
                pass
        self._visible = False
        self._buttons = []

    def _handle_click(self, action):
        """Handle button click."""
        if self._on_action:
            self._on_action(action)

    @property
    def is_visible(self):
        return self._visible


class OcrResultPanel:
    """
    A panel that shows OCR results with Copy and Search buttons.
    Appears in place of / beside the toolbar.
    """

    BG_COLOR = "#2d2d30"
    FG_COLOR = "#e0e0e0"
    ACCENT = "#60a5fa"
    BORDER_COLOR = "#404045"
    TEXT_BG = "#1e1e1e"

    def __init__(self):
        self._frame = None
        self._visible = False

    def show(self, x, y, text, screen_w, screen_h, on_action, parent_root=None):
        """
        Show OCR results panel.
        on_action(action, data): callback.
          action: "copy_text", "search_text", "close"
          data: the text content
        """
        if parent_root is None:
            return

        panel_w = 340
        panel_h = 200

        # Adjust position
        if x + panel_w > screen_w:
            x = screen_w - panel_w - 10
        if x < 10:
            x = 10
        if y + panel_h > screen_h:
            y = y - panel_h - 10
        if y < 10:
            y = 10

        self._frame = tk.Frame(
            parent_root,
            bg=self.BG_COLOR,
            highlightbackground=self.BORDER_COLOR,
            highlightthickness=1,
        )

        # Header
        header = tk.Frame(self._frame, bg=self.BG_COLOR)
        header.pack(fill=tk.X, padx=8, pady=(8, 4))

        tk.Label(
            header, text="📝 Detected Text", bg=self.BG_COLOR, fg=self.ACCENT,
            font=("Segoe UI Semibold", 10), anchor="w"
        ).pack(side=tk.LEFT)

        close_btn = tk.Label(
            header, text="✕", bg=self.BG_COLOR, fg="#888",
            font=("Segoe UI", 10), cursor="hand2", padx=4,
        )
        close_btn.pack(side=tk.RIGHT)
        close_btn.bind("<Button-1>", lambda e: on_action("close", text))

        # Text display
        text_frame = tk.Frame(self._frame, bg=self.TEXT_BG, padx=2, pady=2)
        text_frame.pack(fill=tk.BOTH, expand=True, padx=8, pady=4)

        text_display = tk.Text(
            text_frame, bg=self.TEXT_BG, fg=self.FG_COLOR,
            font=("Segoe UI", 10), wrap=tk.WORD,
            height=5, width=38, borderwidth=0,
            selectbackground=self.ACCENT,
            selectforeground="white",
            insertbackground=self.FG_COLOR,
        )
        text_display.insert("1.0", text if text else "(No text detected)")
        text_display.config(state=tk.NORMAL)  # Allow selection/copy
        text_display.pack(fill=tk.BOTH, expand=True)

        # Action buttons
        btn_frame = tk.Frame(self._frame, bg=self.BG_COLOR)
        btn_frame.pack(fill=tk.X, padx=8, pady=(4, 8))

        for btn_text, action in [("📋 Copy", "copy_text"), ("🔍 Search", "search_text")]:
            btn = tk.Label(
                btn_frame, text=btn_text, bg="#3e3e42", fg=self.FG_COLOR,
                font=("Segoe UI", 10), padx=12, pady=4, cursor="hand2",
            )
            btn.pack(side=tk.LEFT, padx=4)
            btn.bind("<Button-1>", lambda e, a=action: on_action(a, text))
            btn.bind("<Enter>", lambda e, b=btn: b.configure(bg=self.ACCENT))
            btn.bind("<Leave>", lambda e, b=btn: b.configure(bg="#3e3e42"))

        self._frame.place(x=x, y=y)
        self._visible = True

    def show_loading(self, x, y, parent_root=None):
        """Show a loading indicator."""
        if parent_root is None:
            return

        self._frame = tk.Frame(
            parent_root, bg=self.BG_COLOR,
            highlightbackground=self.BORDER_COLOR,
            highlightthickness=1,
        )
        tk.Label(
            self._frame, text="📝 Recognizing text...",
            bg=self.BG_COLOR, fg=self.FG_COLOR,
            font=("Segoe UI", 10), padx=16, pady=12,
        ).pack()
        self._frame.place(x=x, y=y)
        self._visible = True

    def show_error(self, x, y, error_msg, on_close, parent_root=None):
        """Show an error message."""
        if parent_root is None:
            return

        self._frame = tk.Frame(
            parent_root, bg=self.BG_COLOR,
            highlightbackground="#e74c3c",
            highlightthickness=1,
        )
        tk.Label(
            self._frame, text=f"⚠ {error_msg}",
            bg=self.BG_COLOR, fg="#e74c3c",
            font=("Segoe UI", 10), padx=16, pady=12, wraplength=300,
        ).pack()
        close_btn = tk.Label(
            self._frame, text="OK", bg="#3e3e42", fg=self.FG_COLOR,
            font=("Segoe UI", 10), padx=16, pady=4, cursor="hand2",
        )
        close_btn.pack(pady=(0, 8))
        close_btn.bind("<Button-1>", lambda e: on_close())
        self._frame.place(x=x, y=y)
        self._visible = True

    def hide(self):
        """Hide the panel."""
        if self._visible and self._frame:
            try:
                self._frame.place_forget()
                self._frame.destroy()
            except tk.TclError:
                pass
        self._visible = False

    @property
    def is_visible(self):
        return self._visible
