"""FastAPI app 入口。"""

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from epub_backend.api.books import router as books_router
from epub_backend.config import get_settings
from epub_backend.reader.errors import DuplicateFileError, EpubReaderError


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="EPUB Reader Backend",
        version="0.1.0",
        description="解析 EPUB 3 + 书籍库 API",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(books_router)

    @app.exception_handler(EpubReaderError)
    async def epub_reader_error_handler(_request: Request, exc: EpubReaderError) -> JSONResponse:
        """统一领域错误响应格式：{ error: { code, message, phase, existing_book_id } }。"""
        code_to_status = {
            "INVALID_CONTAINER": 422,
            "INCOMPLETE_METADATA": 422,
            "DRM_DETECTED": 422,
            "CORRUPT_EPUB": 422,
            "DUPLICATE_FILE": 409,
        }
        status_code = code_to_status.get(exc.code, 422)
        body: dict = {
            "code": exc.code,
            "message": str(exc),
            "phase": exc.phase,
        }
        if isinstance(exc, DuplicateFileError) and exc.existing_book_id:
            body["existing_book_id"] = exc.existing_book_id
        return JSONResponse(status_code=status_code, content={"error": body})

    @app.exception_handler(HTTPException)
    async def http_exception_handler(_request: Request, exc: HTTPException) -> JSONResponse:
        """统一 HTTPException 也用 {error: {...}} 格式。"""
        # exc.detail 可能是 dict（我们传的）或 str（FastAPI 默认）
        if isinstance(exc.detail, dict):
            return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": "HTTP_ERROR", "message": str(exc.detail)}},
        )

    return app


app = create_app()
