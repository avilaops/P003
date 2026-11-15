"""Read-only checks of browser-generated commercial PDFs (PyMuPDF required)."""
import argparse
import json
from pathlib import Path
import fitz


def inspect(path: Path, identity: str, pages: int | None, expected: list[str], title: str = "Proposta comercial") -> dict:
    document = fitz.open(path)
    if pages is not None:
        assert len(document) == pages, f"expected {pages} pages, got {len(document)}"
    full_text = ""
    for index, page in enumerate(document):
        assert abs(page.rect.width - 595.2756) < 1
        assert abs(page.rect.height - 841.8898) < 1
        text = page.get_text()
        full_text += text
        assert identity in text, (index + 1, "missing repeated identity")
        assert f"Página {index + 1} de {len(document)}" in text, "missing page counter"
        headers = page.search_for(title)
        assert any(rect.y0 < 65 for rect in headers), (index + 1, "missing repeated header")
        for word in page.get_text("words"):
            assert word[0] >= 35 and word[2] <= 560, (index + 1, "horizontal clipping", word)
            assert word[1] >= 15 and word[3] <= 830, (index + 1, "vertical clipping", word)
    for value in expected:
        assert value in full_text, f"missing {value}"
    return {"file": str(path), "pages": len(document), "a4": True, "bounds": True, "identity": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--identity", required=True)
    parser.add_argument("--title", default="Proposta comercial")
    parser.add_argument("--pages", type=int)
    parser.add_argument("--expect", action="append", default=[])
    args = parser.parse_args()
    print(json.dumps(inspect(args.pdf, args.identity, args.pages, args.expect, args.title), ensure_ascii=False))
