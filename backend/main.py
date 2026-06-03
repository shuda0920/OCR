import copy
import io
import os
import json
import base64
import logging
import asyncio
import csv
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageOps
import httpx
import fitz  # PyMuPDF — PDF → PIL Image

# ── Template / Classic-OCR helpers (opencv.py) ──────────────────────────────
from opencv import router as opencv_router

# ── Bill / Invoice detection (bill.py) ─────────────────────────────────────────
from bill import router as bill_router

# Load .env file
load_dotenv()

# Set up logging so all errors are visible in the terminal
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

# Allow requests from all origins (dev mode)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(opencv_router)
app.include_router(bill_router)

# ── Google Gemini Configuration ──────────────────────────────────────────────
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL   = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
GEMINI_TIMEOUT = 600.0  # seconds

GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

logger.info(f"Configured Google Gemini: model={GEMINI_MODEL}  endpoint={GEMINI_URL}")

# ── gemma / Ollama Configuration ──────────────────────────────────────────────
gemma_BASE_URL = os.getenv("gemma_BASE_URL", "http://172.16.36.75:5000")
gemma_MODEL    = os.getenv("gemma_MODEL", "gemma3.5:35b")
gemma_TIMEOUT  = 70600.0  # seconds

gemma_CHAT_URL = f"{gemma_BASE_URL.rstrip('/')}/api/chat"

logger.info(f"Configured gemma/Ollama: model={gemma_MODEL}  endpoint={gemma_CHAT_URL}")

# ── GLM-OCR / Ollama Configuration ───────────────────────────────────────────
GLM_BASE_URL = os.getenv("GLM_BASE_URL", "http://172.16.36.75:5000")
GLM_MODEL    = os.getenv("GLM_MODEL", "glm-ocr")
GLM_TIMEOUT  = 600.0  # seconds

GLM_CHAT_URL = f"{GLM_BASE_URL.rstrip('/')}/api/chat"

logger.info(f"Configured GLM-OCR/Ollama: model={GLM_MODEL}  endpoint={GLM_CHAT_URL}")

# ── Configuration ─────────────────────────────────────────────────────────────
MAX_OCR_WIDTH        = 2000
PDF_RENDER_DPI       = 200
SLICE_MAX_HEIGHT     = 1500   # px；一般模式超過此高度才切割
SLICE_OPTIMIZED_HEIGHT = 800  # px；優化模式強制切片的區塊高度
SLICE_OVERLAP        = 150    # px；相鄰切片的重疊量，避免切割線截斷文字
GLM_MAX_LONG_SIDE    = 1120   # px；GLM-OCR 安全輸入長邊上限 (448 tile × 2.5)
LOGS_DIR = Path(__file__).parent / "logs"
LOGS_DIR.mkdir(exist_ok=True)
CSV_DIR = LOGS_DIR / "csv"
CSV_DIR.mkdir(exist_ok=True)

# ── Load prompts from files (edit prompts/*.txt to change behaviour) ──────────
_prompts_dir_env = os.getenv("PROMPTS_DIR", "")
PROMPTS_DIR = Path(_prompts_dir_env) if _prompts_dir_env else Path(__file__).parent / "prompts"

# ── OCR-prompt directory (used by GLM-OCR → Gemini two-stage pipeline) ────────
# Files are named  p_<mode>.txt  inside prompts/ocr_prompt/
OCR_PROMPT_DIR = PROMPTS_DIR / "ocr_prompt"


def _load_prompt(name: str) -> str:
    """Read a prompt text file from PROMPTS_DIR. Raises on missing file."""
    path = PROMPTS_DIR / f"{name}.txt"
    if not path.exists():
        raise FileNotFoundError(f"Prompt file not found: {path}")
    text = path.read_text(encoding="utf-8").strip()
    logger.info(f"Loaded prompt '{name}' from {path}")
    return text


def _load_ocr_prompt(mode: str) -> str:
    """Read a post-OCR prompt (p_<mode>.txt) from OCR_PROMPT_DIR."""
    path = OCR_PROMPT_DIR / f"p_{mode}.txt"
    if not path.exists():
        raise FileNotFoundError(f"OCR prompt file not found: {path}")
    text = path.read_text(encoding="utf-8").strip()
    logger.info(f"Loaded OCR prompt '{mode}' from {path}")
    return text


# ── Prompt registry by mode ──────────────────────────────────────────────────
# Keys must match the filenames in PROMPTS_DIR (without .txt extension).
# Add a new mode by dropping a new <key>.txt file — no code changes needed.
_PROMPT_KEYS = ["business_card", "general", "credit_card_auth", "medical_record", "handwriting", "complex_form", "cheque", "car_and_insurance", "id_and_license"]
PROMPT_REGISTRY: dict[str, str] = {}
for _key in _PROMPT_KEYS:
    try:
        PROMPT_REGISTRY[_key] = _load_prompt(_key)
    except FileNotFoundError as _e:
        logger.warning(str(_e))

logger.info(f"Registered prompt modes: {list(PROMPT_REGISTRY.keys())}")

# ── OCR-prompt registry (p_<mode>.txt) ────────────────────────────────────────
_OCR_PROMPT_KEYS = ["general", "general2", "credit_card_auth", "medical_record", "handwriting", "complex_form", "cheque", "car_and_insurance", "id_and_license", "business_card"]
OCR_PROMPT_REGISTRY: dict[str, str] = {}
for _key in _OCR_PROMPT_KEYS:
    try:
        OCR_PROMPT_REGISTRY[_key] = _load_ocr_prompt(_key)
    except FileNotFoundError as _e:
        logger.warning(str(_e))

logger.info(f"Registered OCR prompt modes: {list(OCR_PROMPT_REGISTRY.keys())}")


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def prepare_image(pil_img: Image.Image) -> Image.Image:
    """Normalise orientation, convert to RGB, and downscale if too wide."""
    try:
        pil_img = ImageOps.exif_transpose(pil_img)
    except Exception:
        pass

    if pil_img.mode not in ("RGB",):
        pil_img = pil_img.convert("RGB")

    w, h = pil_img.size
    if w > MAX_OCR_WIDTH:
        scale = MAX_OCR_WIDTH / w
        pil_img = pil_img.resize((MAX_OCR_WIDTH, int(h * scale)), Image.LANCZOS)
        logger.info(f"  Downscaled from {w}x{h} → {MAX_OCR_WIDTH}x{int(h * scale)}")
    else:
        logger.info(f"  Image size {w}x{h} — no downscaling needed")

    return pil_img


def prepare_image_for_glm(pil_img: Image.Image) -> Image.Image:
    """
    Resize an image to GLM-OCR-compatible dimensions.

    GLM-OCR (GLM-4V-based) uses 448×448 tiles internally; the long side must
    stay within GLM_MAX_LONG_SIDE (1120 px) to avoid GPU OOM and the
    GGML_ASSERT tensor-dimension error.  Both axes are rounded to the nearest
    multiple of 14 (ViT patch size) to prevent alignment failures.
    """
    w, h = pil_img.size
    long_side = max(w, h)
    if long_side <= GLM_MAX_LONG_SIDE:
        # Round to multiples of 28 to prevent GGML_ASSERT 2x2 pooling mismatch
        new_w = max((w // 28) * 28, 28)
        new_h = max((h // 28) * 28, 28)
        if new_w != w or new_h != h:
            pil_img = pil_img.resize((new_w, new_h), Image.LANCZOS)
            logger.info(f"  GLM align: {w}×{h} → {new_w}×{new_h} (patch alignment only)")
        return pil_img

    scale   = GLM_MAX_LONG_SIDE / long_side
    new_w   = max(int(w * scale // 28) * 28, 28)
    new_h   = max(int(h * scale // 28) * 28, 28)
    resized = pil_img.resize((new_w, new_h), Image.LANCZOS)
    logger.info(f"  GLM resize: {w}×{h} → {new_w}×{new_h} (long side ≤ {GLM_MAX_LONG_SIDE}px)")
    return resized


def pil_to_base64(pil_img: Image.Image) -> str:
    """Convert a PIL image to a base64-encoded PNG string."""
    buf = io.BytesIO()
    pil_img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def pdf_to_pil_images(pdf_bytes: bytes) -> list[Image.Image]:
    """Render every page of a PDF to a PIL Image (RGB) at PDF_RENDER_DPI."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    pages: list[Image.Image] = []
    matrix = fitz.Matrix(PDF_RENDER_DPI / 72, PDF_RENDER_DPI / 72)

    for page_num in range(len(doc)):
        page = doc.load_page(page_num)
        pix = page.get_pixmap(matrix=matrix, colorspace=fitz.csRGB)
        pil_img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        pages.append(pil_img)
        logger.info(f"  PDF page {page_num + 1}/{len(doc)}: {pix.width}x{pix.height}px")

    doc.close()
    return pages


async def call_gemini_vision(base64_img: str, prompt: str) -> str:
    """Send an image to Google Gemini vision model and return its reply."""
    payload = {
        "contents": [{
            "parts": [
                {"text": prompt},
                {
                    "inline_data": {
                        "mime_type": "image/png",
                        "data": base64_img,
                    }
                }
            ]
        }],
        "generationConfig": {
            "temperature": 0.3,
        }
    }

    logger.info(f"Calling Google Gemini ({GEMINI_MODEL}) …")
    async with httpx.AsyncClient(timeout=httpx.Timeout(GEMINI_TIMEOUT)) as client:
        resp = await client.post(GEMINI_URL, json=payload, params={"key": GEMINI_API_KEY})
        resp.raise_for_status()
        data = resp.json()
        content = data["candidates"][0]["content"]["parts"][0]["text"]
        logger.info(f"Gemini responded: {len(content)} chars")
        return content


async def call_gemma_vision(base64_img: str, prompt: str) -> str:
    """Send an image to gemma via Ollama /api/chat and return its reply."""
    payload = {
        "model": gemma_MODEL,
        "messages": [
            {
                "role": "user",
                "content": prompt,
                "images": [base64_img],
            }
        ],
        "stream": False,
    }

    logger.info(f"Calling gemma/Ollama ({gemma_MODEL}) at {gemma_CHAT_URL} …")
    async with httpx.AsyncClient(timeout=httpx.Timeout(gemma_TIMEOUT)) as client:
        resp = await client.post(gemma_CHAT_URL, json=payload)
        resp.raise_for_status()
        data = resp.json()
        content = data["message"]["content"]
        logger.info(f"gemma responded: {len(content)} chars")
        return content


async def call_glm_vision(base64_img: str, prompt: str) -> str:
    """Send an image to GLM-OCR via Ollama /api/generate and return its reply.

    GLM-OCR uses TEMPLATE {{ .Prompt }} in its Modelfile, so it must be called
    via /api/generate (not /api/chat).  The image is passed in the top-level
    `images` list alongside the `prompt` field.
    """
    GLM_GENERATE_URL = f"{GLM_BASE_URL.rstrip('/')}/api/generate"
    payload = {
        "model": GLM_MODEL,
        "prompt": prompt,
        "images": [base64_img],
        "stream": False,
        "options": {
            "num_ctx": 8192,   # required for glm-ocr to load successfully
        },
    }

    logger.info(f"Calling GLM ({GLM_MODEL}) at {GLM_GENERATE_URL} …")
    
    max_retries = 3
    for attempt in range(1, max_retries + 1):
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(GLM_TIMEOUT)) as client:
                resp = await client.post(GLM_GENERATE_URL, json=payload)
                if not resp.is_success:
                    # Surface the Ollama server error body for easier debugging
                    try:
                        err_body = resp.json()
                    except Exception:
                        err_body = resp.text
                    logger.error(f"GLM /api/generate error {resp.status_code}: {err_body}")
                    resp.raise_for_status()
                data = resp.json()
                content = data.get("response", "")
                logger.info(f"GLM responded: {len(content)} chars")
                return content
        except (httpx.ConnectError, httpx.TimeoutException, httpx.ReadError, httpx.HTTPStatusError) as e:
            logger.warning(f"GLM connection issue (attempt {attempt}/{max_retries}): {e}")
            if attempt == max_retries:
                logger.error("All retries to GLM-OCR failed.")
                raise
            # Wait 5 seconds before retrying to allow Ollama to restart if it crashed
            logger.info("Waiting 5 seconds before retrying...")
            await asyncio.sleep(5.0)


async def call_vision(base64_img: str, prompt: str, provider: str) -> str:
    """Route to the correct vision model based on provider."""
    if provider == "gemma":
        return await call_gemma_vision(base64_img, prompt)
    if provider in ("glm-ocr", "pure-glm"):
        return await call_glm_vision(base64_img, prompt)
    return await call_gemini_vision(base64_img, prompt)


async def call_glm_then_gemma(base64_img: str, mode: str) -> tuple[str, str]:
    """
    Two-stage pipeline for glm-ocr provider:
      Stage 1 — GLM-OCR  : extract raw text from the image (no structured prompt).
      Stage 2 — gemma    : feed the raw text + ocr_prompt/p_<mode>.txt to produce
                           a structured JSON result identical to other providers.

    The OCR prompt (p_<mode>.txt) must already be loaded in OCR_PROMPT_REGISTRY.
    Falls back to the raw GLM text if the mode's ocr_prompt is unavailable.
    """
    # ── Stage 1: GLM-OCR image → raw text ────────────────────────────────────
    logger.info(f"[GLM→gemma] Stage 1: GLM-OCR image extraction (mode={mode})")
    glm_raw_text = await call_glm_vision(base64_img, "請辨識圖片中的所有文字內容，逐字輸出，不要做任何格式化或摘要。")
    logger.info(f"[GLM→gemma] Stage 1 done: {len(glm_raw_text)} chars")

    # ── Stage 2: gemma text → structured JSON ────────────────────────────────
    ocr_prompt = OCR_PROMPT_REGISTRY.get(mode)
    if not ocr_prompt:
        logger.warning(f"[GLM→gemma] No ocr_prompt found for mode '{mode}', returning raw GLM text.")
        return glm_raw_text, glm_raw_text

    # Compose the gemma text-only prompt: inject GLM output into the template
    combined_prompt = (
        f"{ocr_prompt}\n\n"
        f"以下是從文件圖片中辨識出的原始文字（由 GLM-OCR 提取）：\n"
        f"---\n{glm_raw_text}\n---\n"
        f"請依照上述格式要求，將以上文字結構化為 JSON 輸出。"
    )

    logger.info(f"[GLM→gemma] Stage 2: gemma structuring (prompt={len(combined_prompt)} chars)")
    # Call gemma with text-only (no image needed at this stage)
    logger.info(f'gemma_MODEL: {gemma_MODEL}')
    payload = {
        "model": gemma_MODEL,
        "messages": [
            {
                "role": "user",
                "content": combined_prompt,
            }
        ],
        "stream": False,
        "options": {"temperature": 0.2},
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(gemma_TIMEOUT)) as client:
        resp = await client.post(gemma_CHAT_URL, json=payload)
        resp.raise_for_status()
        data = resp.json()
        structured = data["message"]["content"]
    logger.info(f"[GLM→gemma] Stage 2 done: {len(structured)} chars")
    return glm_raw_text, extract_html(structured)

    # payload = {
    #     "contents": [{
    #         "parts": [
    #             {"text": combined_prompt},
    #         ]
    #     }],
    #     "generationConfig": {
    #         "temperature": 0.3,
    #     }
    # }

    # logger.info(f"Calling Google Gemini ({GEMINI_MODEL}) …")
    # async with httpx.AsyncClient(timeout=httpx.Timeout(GEMINI_TIMEOUT)) as client:
    #     resp = await client.post(GEMINI_URL, json=payload, params={"key": GEMINI_API_KEY})
    #     resp.raise_for_status()
    #     data = resp.json()
    #     structured = data["candidates"][0]["content"]["parts"][0]["text"]
    #     logger.info(f"Gemini responded: {len(structured)} chars")
    #     return glm_raw_text, extract_html(structured)


def extract_html(raw: str) -> str:
    """Strip markdown code fences (```html … ```) that the model may wrap around the HTML."""
    text = raw.strip()
    # Remove ```html ... ``` wrapper
    if text.startswith("```"):
        # Find end of first line
        first_nl = text.find("\n")
        if first_nl != -1:
            text = text[first_nl + 1:]
        # Remove trailing ```
        if text.endswith("```"):
            text = text[:-3].rstrip()
    return text


# ─────────────────────────────────────────────────────────────────────────────
# Slice-based OCR helpers
# ─────────────────────────────────────────────────────────────────────────────

def slice_image(
    pil_img: Image.Image,
    max_height: int = SLICE_MAX_HEIGHT,
    force: bool = False,
) -> list[Image.Image]:
    """
    Split a prepared image into horizontal strips.
    - max_height : max px per slice
    - force      : True = always slice even if h <= max_height
    Adjacent slices overlap by SLICE_OVERLAP px.
    Returns a single-element list when no slicing is needed.
    """
    w, h = pil_img.size
    if not force and h <= max_height:
        return [pil_img]

    slices: list[Image.Image] = []
    step = max_height - SLICE_OVERLAP  # net vertical advance per slice
    y = 0
    while y < h:
        y_end = min(y + max_height, h)
        slices.append(pil_img.crop((0, y, w, y_end)))
        if y_end >= h:
            break
        y += step

    logger.info(f"  Image {w}\u00d7{h} \u2192 {len(slices)} slice(s) "
                f"of \u2264{max_height}px (overlap={SLICE_OVERLAP}px, force={force})")
    return slices


def merge_general_json(parts: list[str]) -> str:
    """
    Merge JSON strings from general-mode slices.
    document_info : first non-empty wins.
    blocks        : all blocks from every slice are appended in order
                    (no dedup by block_id — each slice covers a different area).
    """
    if len(parts) == 1:
        return parts[0]

    def _strip(raw: str) -> str:
        s = raw.strip()
        if s.startswith("```"):
            nl = s.find("\n")
            if nl != -1:
                s = s[nl + 1:]
            if s.endswith("```"):
                s = s[:-3].rstrip()
        return s

    merged_doc_info: dict | None = None
    all_blocks: list[dict] = []
    any_parsed = False

    for raw in parts:
        try:
            obj = json.loads(_strip(raw))
        except json.JSONDecodeError:
            continue
        any_parsed = True
        if merged_doc_info is None and obj.get("document_info"):
            merged_doc_info = obj["document_info"]
        all_blocks.extend(obj.get("blocks", []))

    if not any_parsed:
        return "\n".join(parts)

    result: dict = {}
    if merged_doc_info:
        result["document_info"] = merged_doc_info
    result["blocks"] = all_blocks
    return json.dumps(result, ensure_ascii=False, indent=2)


def merge_json_parts(parts: list[str]) -> str:
    """
    Deep-merge JSON strings from multiple slices.

    Merging strategy
    ─────────────────
    document_info   : first non-empty value wins.
    blocks          : matched by block_id across slices.  Within each block,
                      elements are matched by label:
                        field          → first non-null value wins
                        checkbox_group → union of selected options (any slice
                                         marking an option selected keeps it)

    Falls back to raw string concatenation when no slice parses as valid JSON.
    """
    if len(parts) == 1:
        return parts[0]

    def _strip_fences(raw: str) -> str:
        s = raw.strip()
        if s.startswith("```"):
            nl = s.find("\n")
            if nl != -1:
                s = s[nl + 1:]
            if s.endswith("```"):
                s = s[:-3].rstrip()
        return s

    merged_doc_info: dict | None = None
    # ordered dict: block_id → merged block (deep copy of first occurrence)
    block_map: dict[str, dict] = {}
    any_parsed = False

    for raw in parts:
        try:
            obj = json.loads(_strip_fences(raw))
        except json.JSONDecodeError:
            continue
        any_parsed = True

        if merged_doc_info is None and obj.get("document_info"):
            merged_doc_info = obj["document_info"]

        for block in obj.get("blocks", []):
            bid = str(block.get("block_id") or "")

            if bid not in block_map:
                # First time seeing this block — deep-copy as the base
                block_map[bid] = copy.deepcopy(block)
                continue

            # Subsequent slices → merge elements into the existing base block
            existing = block_map[bid]
            # Build label → index map once for the base block's elements
            label_idx: dict[str, int] = {
                el.get("label", ""): i
                for i, el in enumerate(existing.get("elements", []))
                if el.get("label")
            }

            for new_el in block.get("elements", []):
                lbl = new_el.get("label", "")
                if not lbl or lbl not in label_idx:
                    continue
                ex_el = existing["elements"][label_idx[lbl]]

                if new_el.get("type") == "field":
                    # First non-null value wins
                    if ex_el.get("value") is None and new_el.get("value") is not None:
                        ex_el["value"] = new_el["value"]

                elif new_el.get("type") == "checkbox_group":
                    # Union: if any slice marks an option selected, keep it selected
                    ex_opt_idx: dict[str, int] = {
                        o["text"]: i for i, o in enumerate(ex_el.get("options", []))
                    }
                    for new_opt in new_el.get("options", []):
                        if new_opt.get("selected") and new_opt["text"] in ex_opt_idx:
                            ex_el["options"][ex_opt_idx[new_opt["text"]]]["selected"] = True

    if not any_parsed:
        return "\n".join(parts)

    result: dict = {}
    if merged_doc_info:
        result["document_info"] = merged_doc_info
    result["blocks"] = list(block_map.values())
    return json.dumps(result, ensure_ascii=False, indent=2)


async def ocr_image(
    pil_img: Image.Image,
    prompt: str,
    filename: str,
    mode: str,
    page: int | str | None = None,
    force_slice: bool = False,
    provider: str = "gemini",
) -> str:
    """
    OCR one prepared image, slicing it if it is tall.
    Each slice is sent to Azure OpenAI independently.
    Merge strategy by mode:
      - 'general'        : JSON blocks appended in order
      - structured modes : JSON fields deep-merged by block_id / label
    force_slice=True : 優化模式 — 強制以 SLICE_OPTIMIZED_HEIGHT 切片（所有模式均適用）
    """
    is_general = mode in ("general", "complex_form")

    # ── 切片決策 ──────────────────────────────────────────────────────────────
    # glm-ocr 固定強制切片（SLICE_OPTIMIZED_HEIGHT），避免整頁大圖送進模型
    # 導致 GPU OOM 或 GGML tensor 維度斷言失敗（ConnectError / 500）。
    if provider == "glm-ocr":
        slices = slice_image(pil_img, max_height=SLICE_OPTIMIZED_HEIGHT, force=True)
    elif force_slice:
        slices = slice_image(pil_img, max_height=SLICE_OPTIMIZED_HEIGHT, force=True)
    else:
        slices = slice_image(pil_img)
    total = len(slices)

    if total == 1:
        s_img = prepare_image_for_glm(slices[0]) if provider == "glm-ocr" else slices[0]
        b64 = pil_to_base64(s_img)
        if provider == "glm-ocr":
            glm_raw, cleaned = await call_glm_then_gemma(b64, mode)
        else:
            raw = await call_vision(b64, prompt, provider)
            cleaned = extract_html(raw)
        return cleaned

    # ── Multiple slices ────────────────────────────────────────────────────
    parts: list[str] = []
    for idx, s_img in enumerate(slices, start=1):
        logger.info(f"  \u2500\u2500 Slice {idx}/{total} \u2026")
        p_label = f"{page}_s{idx}" if page is not None else f"s{idx}"

        if provider == "glm-ocr":
            glm_img = prepare_image_for_glm(s_img)
            b64 = pil_to_base64(glm_img)
            glm_raw, cleaned = await call_glm_then_gemma(b64, mode)
        else:
            b64 = pil_to_base64(s_img)
            if is_general:
                slice_hint = (
                    f"\n\n[系統提示：此圖已切割為 {total} 個水平切片以提升辨識品質，"
                    f"目前為第 {idx}/{total} 個切片，請辨識此切片中的全部內容。]"
                )
            else:
                slice_hint = (
                    f"\n\n[系統提示：此圖已切割為 {total} 個水平切片以提升辨識品質，"
                    f"目前為第 {idx}/{total} 個切片。"
                    f"請只填入你在此切片畫面中能清楚看到的欄位值；"
                    f"無法看到或不在此切片範圍內的欄位請填入 null，"
                    f"不要推測或捏造任何資料。]"
                )
            slice_prompt = prompt + slice_hint
            raw = await call_vision(b64, slice_prompt, provider)
            cleaned = extract_html(raw)

        if cleaned:
            parts.append(cleaned)

    if not parts:
        return ""
    if is_general:
        return merge_general_json(parts)
    else:
        return merge_json_parts(parts)


def append_to_csv(filename: str, mode: str, provider: str, result_text: str):
    try:
        parsed = json.loads(result_text)
    except Exception:
        parsed = {"raw_text": result_text}

    model_name = provider
    if provider == "gemini":
        model_name = GEMINI_MODEL
    elif provider == "gemma":
        model_name = gemma_MODEL
    elif provider == "glm-ocr":
        model_name = f"{GLM_MODEL} + {gemma_MODEL}"

    flat_data = {
        "Time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "Filename": filename or "unknown",
        "Model": model_name,
    }
    
    if isinstance(parsed, dict):
        if "document_info" in parsed and isinstance(parsed["document_info"], dict):
            for k, v in parsed["document_info"].items():
                flat_data[f"doc_{k}"] = str(v)
                
        if "blocks" in parsed and isinstance(parsed["blocks"], list):
            for block in parsed.get("blocks", []):
                if isinstance(block, dict):
                    if "elements" in block and isinstance(block["elements"], list):
                        for el in block.get("elements", []):
                            label = el.get("label", "")
                            if not label:
                                continue
                            t = el.get("type", "field")
                            if t == "field":
                                flat_data[label] = str(el.get("value", ""))
                            elif t == "checkbox_group":
                                selected = [opt.get("text", "") for opt in el.get("options", []) if opt.get("selected")]
                                flat_data[label] = ", ".join(selected)
                    else:
                        for k, v in block.items():
                            if k not in ("block_id", "elements"):
                                flat_data[f"block_{k}"] = str(v)
        
        for k, v in parsed.items():
            if k not in ("document_info", "blocks"):
                if isinstance(v, (str, int, float, bool)):
                    flat_data[k] = str(v)
                else:
                    flat_data[k] = json.dumps(v, ensure_ascii=False)
                    
    csv_path = CSV_DIR / f"{mode}.csv"
    
    file_exists = csv_path.exists()
    existing_headers = []
    
    if file_exists:
        try:
            with open(csv_path, "r", encoding="utf-8-sig") as f:
                reader = csv.reader(f)
                existing_headers = next(reader, [])
        except Exception:
            file_exists = False

    all_keys = list(existing_headers)
    for k in flat_data.keys():
        if k not in all_keys:
            all_keys.append(k)
            
    if file_exists and len(all_keys) > len(existing_headers):
        rows = []
        try:
            with open(csv_path, "r", encoding="utf-8-sig") as f:
                reader = csv.DictReader(f)
                rows = list(reader)
        except Exception:
            pass
        rows.append(flat_data)
        try:
            with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=all_keys)
                writer.writeheader()
                writer.writerows(rows)
            logger.info(f"CSV updated (columns added) for mode '{mode}'")
        except Exception as e:
            logger.warning(f"Failed to rewrite CSV {csv_path}: {e}")
    else:
        try:
            with open(csv_path, "a", encoding="utf-8-sig", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=all_keys)
                if not file_exists:
                    writer.writeheader()
                writer.writerow(flat_data)
            logger.info(f"CSV appended for mode '{mode}'")
        except Exception as e:
            logger.warning(f"Failed to append to CSV {csv_path}: {e}")

def save_log(
    filename: str,
    mode: str,
    provider: str,
    result_text: str,
) -> str:
    """Save the final OCR result to a timestamped log file under logs/."""
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    # Sanitise the original filename for use in path
    safe_name = "".join(c if c.isalnum() or c in "._-" else "_" for c in (filename or "unknown"))
    log_filename = f"{ts}_{mode}_{safe_name}.json"
    log_path = LOGS_DIR / log_filename

    try:
        parsed = json.loads(result_text)
        content = json.dumps(parsed, ensure_ascii=False, indent=2)
    except Exception:
        content = result_text

    try:
        log_path.write_text(content, encoding="utf-8")
        logger.info(f"Complete log saved: {log_path.name}")
    except Exception as exc:
        logger.warning(f"Failed to save log: {exc}")

    # ====== Create or append to CSV ======
    append_to_csv(filename, mode, provider, result_text)

    return str(log_path)


# ─────────────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {"message": "OCR Backend is running!"}


@app.get("/api/health")
async def health():
    """Liveness probe."""
    return {"status": "ok"}


@app.post("/api/recognize-text")
async def recognize_text(
    image: UploadFile = File(...),
    mode: str = Form("general"),
    optimized: str = Form("false"),
    provider: str = Form("gemini"),
):
    force_slice = optimized.lower() in ("true", "1", "yes")
    logger.info(f"Received: {image.filename}  content_type={image.content_type}  mode={mode}  optimized={force_slice}  provider={provider}")

    # Resolve the prompt for the requested mode
    prompt = PROMPT_REGISTRY.get(mode)
    if prompt is None:
        raise HTTPException(status_code=400, detail=f"不支援的辨識模式: {mode}")

    content_type = (image.content_type or "").lower()
    filename_lower = (image.filename or "").lower()

    is_pdf = content_type == "application/pdf" or filename_lower.endswith(".pdf")
    is_image = content_type.startswith("image/")

    if not is_pdf and not is_image:
        raise HTTPException(
            status_code=400,
            detail="僅接受圖片 (JPG/PNG/…) 或 PDF 檔案。"
        )

    file_bytes = await image.read()
    logger.info(f"File size: {len(file_bytes):,} bytes")

    try:
        # ── PDF path ──────────────────────────────────────────────────────────
        if is_pdf:
            pages = pdf_to_pil_images(file_bytes)
            if not pages:
                raise HTTPException(status_code=400, detail="PDF 沒有可辨識的頁面。")

            results_parts: list[str] = []
            for page_num, page_img in enumerate(pages):
                logger.info(f"── Processing PDF page {page_num + 1}/{len(pages)} ──")
                page_img = prepare_image(page_img)
                cleaned = await ocr_image(
                    page_img, prompt, image.filename, mode,
                    page=page_num + 1, force_slice=force_slice, provider=provider,
                )
                if cleaned:
                    results_parts.append(cleaned)

            if not results_parts:
                final_result = ""
            elif mode in ("general", "complex_form", "business_card"):
                final_result = merge_general_json(results_parts)
            else:
                final_result = merge_json_parts(results_parts)
            logger.info(f"PDF done. Total pages={len(pages)}, json_len={len(final_result)}")
            
            if final_result:
                save_log(image.filename, mode, provider, final_result)

            # If business_card mode, restructure JSON for front-end compatibility
            if mode == "business_card":
                try:
                    data_obj = json.loads(final_result)
                    if "elements" in data_obj and "blocks" not in data_obj:
                        data_obj["blocks"] = [{
                            "block_id": "",
                            "block_title": "",
                            "elements": data_obj.pop("elements")
                        }]
                        final_result = json.dumps(data_obj, ensure_ascii=False)
                except Exception as e:
                    logger.warning(f"Failed to wrap business_card result: {e}")
            return {"json_text": final_result, "pages": len(pages), "mode": mode}

        # ── Image path ────────────────────────────────────────────────────────
        else:
            pil_img = Image.open(io.BytesIO(file_bytes))
            pil_img = prepare_image(pil_img)
            cleaned = await ocr_image(pil_img, prompt, image.filename, mode, force_slice=force_slice, provider=provider)
            logger.info(f"Image done. result_len={len(cleaned)}")
            
            if cleaned:
                save_log(image.filename, mode, provider, cleaned)

            # If business_card mode, restructure JSON for front-end compatibility
            if mode == "business_card":
                try:
                    data_obj = json.loads(cleaned)
                    if "elements" in data_obj and "blocks" not in data_obj:
                        data_obj["blocks"] = [{
                            "block_id": "",
                            "block_title": "",
                            "elements": data_obj.pop("elements")
                        }]
                        cleaned = json.dumps(data_obj, ensure_ascii=False)
                except Exception as e:
                    logger.warning(f"Failed to wrap business_card result: {e}")

            return {"json_text": cleaned, "mode": mode}

    except HTTPException:
        raise
    except httpx.HTTPStatusError as e:
        logger.error(f"Vision API HTTP error: {e.response.status_code} {e.response.text}", exc_info=True)
        raise HTTPException(status_code=502, detail=f"Vision API 回傳錯誤: {e.response.status_code}")
    except httpx.ConnectError:
        logger.error("Cannot connect to Vision API", exc_info=True)
        raise HTTPException(status_code=502, detail="無法連線到 AI 服務，請確認網路與設定。")
    except httpx.TimeoutException:
        logger.error("Vision API request timed out", exc_info=True)
        raise HTTPException(status_code=504, detail="AI 辨識逾時，請稍後再試。")
    except Exception as e:
        logger.error(f"Unexpected error: {type(e).__name__}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"系統發生錯誤: {type(e).__name__}: {str(e)}")

@app.get("/api/logs")
async def get_logs():
    """List all available logs."""
    logs = []
    if LOGS_DIR.exists():
        for file in LOGS_DIR.glob("*.json"):
            parts = file.stem.split("_", 2)
            ts = parts[0] + "_" + parts[1] if len(parts) > 1 else ""
            mode = parts[2] if len(parts) > 2 else "unknown"
            origin_name = parts[3] if len(parts) > 3 else ("_".join(parts[2:]) if len(parts) > 2 else file.stem)
            logs.append({
                "filename": file.name,
                "timestamp": ts,
                "mode": mode,
                "origin_name": origin_name,
                "created_at": file.stat().st_mtime
            })
    logs.sort(key=lambda x: x["created_at"], reverse=True)
    return logs


@app.get("/api/logs/{filename}")
async def get_log(filename: str):
    """Retrieve a specific log file."""
    log_path = LOGS_DIR / filename
    if not log_path.exists() or not log_path.is_file():
        raise HTTPException(status_code=404, detail="Log not found")
    content = log_path.read_text(encoding="utf-8")
    try:
        data = json.loads(content)
        return {"json_text": json.dumps(data, ensure_ascii=False), "filename": filename}
    except Exception:
        return {"json_text": content, "filename": filename}


