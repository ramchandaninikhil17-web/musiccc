"""
Circle to Search — Windows Native OCR
Uses Windows.Media.Ocr via PowerShell (zero extra dependencies).
"""
import subprocess
import os
import json
import threading
from utils import save_image_temp, cleanup_temp_file


def _build_ps_script(image_path, language="en"):
    """Build PowerShell script to run Windows native OCR."""
    # Normalize path for PowerShell
    ps_path = image_path.replace("\\", "\\\\")
    return f'''
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# Helper to await WinRT async operations
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {{ $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' }})[0]

Function Await($WinRtTask, $ResultType) {{
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}}

Function AwaitAction($WinRtTask) {{
    $asTaskMethod = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {{ $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' }})[0]
    $netTask = $asTaskMethod.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
}}

# Load WinRT types
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.RandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

try {{
    # Open image file
    $stream = [System.IO.File]::OpenRead("{ps_path}")
    $randomStream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($stream)

    # Decode image
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($randomStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

    # Run OCR
    $ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($ocrEngine -eq $null) {{
        $ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage("en-US")
    }}

    if ($ocrEngine -ne $null) {{
        $ocrResult = Await ($ocrEngine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        $text = $ocrResult.Text
        Write-Output $text
    }} else {{
        Write-Output "OCR_ENGINE_UNAVAILABLE"
    }}

    $stream.Close()
    $stream.Dispose()
}} catch {{
    Write-Error $_.Exception.Message
    exit 1
}}
'''


class OcrEngine:
    """Windows native OCR wrapper."""

    def __init__(self):
        self._available = None

    def is_available(self):
        """Check if Windows OCR is available."""
        if self._available is None:
            try:
                result = subprocess.run(
                    ["powershell", "-Command",
                     "[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null; "
                     "$e = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages(); "
                     "if ($e) { Write-Output 'YES' } else { Write-Output 'NO' }"],
                    capture_output=True, text=True, timeout=10,
                    creationflags=subprocess.CREATE_NO_WINDOW
                )
                self._available = "YES" in result.stdout
            except Exception:
                self._available = False
        return self._available

    def recognize(self, image, callback=None):
        """
        Run OCR on a PIL Image.
        If callback is provided, runs async: callback(text, error)
        Otherwise runs synchronously and returns (text, error).
        """
        if callback:
            t = threading.Thread(target=self._run_ocr, args=(image, callback), daemon=True)
            t.start()
            return None, None
        else:
            result = [None, None]
            def _cb(text, error):
                result[0] = text
                result[1] = error
            self._run_ocr(image, _cb)
            return result[0], result[1]

    def _run_ocr(self, image, callback):
        """Internal OCR execution."""
        temp_path = None
        try:
            # Save image to temp file
            temp_path = save_image_temp(image)

            # Build and run PowerShell script
            script = _build_ps_script(temp_path)
            result = subprocess.run(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
                capture_output=True, text=True, timeout=15,
                creationflags=subprocess.CREATE_NO_WINDOW
            )

            if result.returncode == 0:
                text = result.stdout.strip()
                if text == "OCR_ENGINE_UNAVAILABLE":
                    callback(None, "Windows OCR engine not available. Install an OCR language pack in Windows Settings.")
                elif text:
                    callback(text, None)
                else:
                    callback("", None)  # No text detected (image has no text)
            else:
                error_msg = result.stderr.strip() if result.stderr else "OCR failed"
                callback(None, error_msg)

        except subprocess.TimeoutExpired:
            callback(None, "OCR timed out")
        except Exception as e:
            callback(None, str(e))
        finally:
            if temp_path:
                cleanup_temp_file(temp_path, delay=2)


# Global instance
ocr_engine = OcrEngine()
