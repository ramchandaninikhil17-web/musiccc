"""
Circle to Search — Actions
Google Lens (browser), Google Search, Copy to clipboard.
"""
import base64
import os
import webbrowser
import urllib.parse
import io
import threading

from PIL import Image
from config import config
from utils import (
    create_temp_file, cleanup_temp_file, save_image_temp,
    copy_image_to_clipboard, copy_text_to_clipboard,
)


def _image_to_base64(image: Image.Image, max_size=1800) -> str:
    """Convert PIL Image to base64 string, resizing if too large."""
    # Resize if needed to keep base64 data manageable
    w, h = image.size
    if w > max_size or h > max_size:
        ratio = min(max_size / w, max_size / h)
        image = image.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)

    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _generate_lens_html(image: Image.Image) -> str:
    """
    Generate HTML that auto-submits image to Google Lens via form POST.
    Uses the DataTransfer API to programmatically set a file input.
    Falls back to clipboard method if auto-submit fails.
    """
    b64 = _image_to_base64(image)
    return f'''<!DOCTYPE html>
<html>
<head>
    <title>Searching...</title>
    <style>
        body {{
            margin: 0; padding: 40px;
            font-family: 'Segoe UI', sans-serif;
            background: #1a1a2e;
            color: #e0e0e0;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
        }}
        .spinner {{
            width: 40px; height: 40px;
            border: 3px solid rgba(255,255,255,0.1);
            border-top-color: #60a5fa;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin-bottom: 20px;
        }}
        @keyframes spin {{ to {{ transform: rotate(360deg); }} }}
        .status {{ font-size: 16px; opacity: 0.8; }}
        .fallback {{
            display: none;
            margin-top: 30px;
            padding: 20px;
            background: rgba(255,255,255,0.05);
            border-radius: 12px;
            text-align: center;
            max-width: 500px;
        }}
        .fallback img {{
            max-width: 300px;
            max-height: 200px;
            border-radius: 8px;
            margin: 15px 0;
        }}
        .fallback a {{
            display: inline-block;
            margin-top: 10px;
            padding: 10px 24px;
            background: #60a5fa;
            color: white;
            text-decoration: none;
            border-radius: 8px;
            font-weight: 500;
        }}
        .fallback a:hover {{ background: #3b82f6; }}
    </style>
</head>
<body>
    <div class="spinner" id="spinner"></div>
    <div class="status" id="status">Opening Google Lens...</div>

    <div class="fallback" id="fallback">
        <p>Auto-upload wasn't possible. Use one of these options:</p>
        <img src="data:image/png;base64,{b64}" alt="Selected image">
        <br>
        <a href="https://lens.google.com/" target="_blank" id="lensLink">
            Open Google Lens &rarr;
        </a>
        <p style="font-size:13px; opacity:0.6; margin-top:15px;">
            Right-click the image above → "Search image with Google"<br>
            or drag the image to the Google Lens page.
        </p>
    </div>

    <form id="searchForm" method="POST"
          action="https://lens.google.com/v3/upload?hl=en"
          enctype="multipart/form-data" style="display:none;">
    </form>

    <script>
        const b64 = "{b64}";

        function b64ToBlob(b64Data, contentType) {{
            const byteChars = atob(b64Data);
            const byteArrays = [];
            for (let offset = 0; offset < byteChars.length; offset += 512) {{
                const slice = byteChars.slice(offset, offset + 512);
                const byteNumbers = new Array(slice.length);
                for (let i = 0; i < slice.length; i++) {{
                    byteNumbers[i] = slice.charCodeAt(i);
                }}
                byteArrays.push(new Uint8Array(byteNumbers));
            }}
            return new Blob(byteArrays, {{ type: contentType }});
        }}

        async function tryAutoSubmit() {{
            try {{
                const blob = b64ToBlob(b64, 'image/png');
                const file = new File([blob], 'search.png', {{ type: 'image/png' }});

                // Method 1: DataTransfer API (Chrome/Edge)
                if (typeof DataTransfer !== 'undefined') {{
                    const dt = new DataTransfer();
                    dt.items.add(file);

                    const fileInput = document.createElement('input');
                    fileInput.type = 'file';
                    fileInput.name = 'encoded_image';
                    fileInput.files = dt.files;

                    const form = document.getElementById('searchForm');
                    form.appendChild(fileInput);
                    form.submit();
                    return true;
                }}
            }} catch (e) {{
                console.log('DataTransfer failed:', e);
            }}

            try {{
                // Method 2: Google Search by Image endpoint
                const blob = b64ToBlob(b64, 'image/png');
                const file = new File([blob], 'search.png', {{ type: 'image/png' }});

                if (typeof DataTransfer !== 'undefined') {{
                    const dt = new DataTransfer();
                    dt.items.add(file);

                    const fileInput = document.createElement('input');
                    fileInput.type = 'file';
                    fileInput.name = 'encoded_image';
                    fileInput.files = dt.files;

                    const form = document.getElementById('searchForm');
                    form.action = 'https://www.google.com/searchbyimage/upload';
                    form.innerHTML = '';
                    form.appendChild(fileInput);
                    form.submit();
                    return true;
                }}
            }} catch (e) {{
                console.log('Search by image failed:', e);
            }}

            return false;
        }}

        async function main() {{
            const ok = await tryAutoSubmit();
            if (!ok) {{
                document.getElementById('spinner').style.display = 'none';
                document.getElementById('status').textContent = '';
                document.getElementById('fallback').style.display = 'block';
            }}
        }}

        // Small delay to ensure page is fully loaded
        setTimeout(main, 100);
    </script>
</body>
</html>'''


def search_google_lens(image: Image.Image):
    """
    Open Google Lens with the selected image.
    Primary: auto-submit via HTML form with DataTransfer API.
    Fallback: image already in clipboard + direct Lens upload link.
    """
    try:
        # Always copy the image to clipboard first for instantaneous paste fallback
        copy_image_to_clipboard(image)

        # Generate and save the HTML launcher
        html_content = _generate_lens_html(image)
        html_path = create_temp_file(suffix=".html", content=html_content)

        # Open in default browser via native Windows shell or webbrowser
        try:
            os.startfile(html_path)
        except Exception:
            webbrowser.open(f"file:///{html_path.replace(os.sep, '/')}")

        # Clean up after delay
        cleanup_temp_file(html_path, delay=config.temp_cleanup_delay)
        return True

    except Exception as e:
        print(f"[Actions] Google Lens error: {e}")
        # Fallback: copy image + open lens directly
        try:
            copy_image_to_clipboard(image)
            webbrowser.open("https://lens.google.com/")
            return True
        except Exception:
            return False


def search_google_text(text: str):
    """Open Google search with the given text."""
    try:
        query = urllib.parse.quote_plus(text.strip())
        url = f"https://www.google.com/search?q={query}"
        webbrowser.open(url)
        return True
    except Exception:
        return False


def copy_image(image: Image.Image):
    """Copy image to clipboard."""
    return copy_image_to_clipboard(image)


def copy_text(text: str):
    """Copy text to clipboard."""
    return copy_text_to_clipboard(text)
